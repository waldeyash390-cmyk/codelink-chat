// filetransfer.js — splits files into chunks, encrypts each chunk, and
// streams them over the dedicated "file" DataChannel with backpressure
// handling and basic resume support if the channel re-opens mid-transfer.
//
// Wire format on the "file" channel:
//   JSON string frames  -> control messages: meta / resume / complete / cancel
//   ArrayBuffer frames   -> [4-byte chunk index][AES-GCM encrypted chunk]
// Only one outbound and one inbound transfer are active at a time, which
// keeps the protocol simple while still letting users queue many files.

import { CryptoModule } from "./crypto.js";

const CHUNK_SIZE = 16 * 1024; // bytes, pre-encryption
const BUFFERED_AMOUNT_HIGH = 1 * 1024 * 1024; // pause sending above this
const BUFFERED_AMOUNT_LOW = 256 * 1024; // resume sending below this

function genId() {
  return crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
}

export class FileTransferManager extends EventTarget {
  constructor(peerLink, cryptoKey) {
    super();
    this.peerLink = peerLink;
    this.key = cryptoKey;

    this.outQueue = [];
    this.outActive = null; // { id, file, chunkIndex, totalChunks, resolveDrain }
    this.inActive = null; // { id, name, size, mime, chunks: [], received, total }

    peerLink.addEventListener("data", (e) => {
      if (e.detail.kind === "file") this._onFileData(e.detail.data);
    });
  }

  /** Queue one or more File objects for sending. */
  enqueue(files) {
    for (const file of files) {
      const id = genId();
      this.outQueue.push({ id, file });
      this.dispatchEvent(new CustomEvent("queued", { detail: { id, name: file.name, size: file.size } }));
    }
    this._pump();
  }

  async _pump() {
    if (this.outActive || this.outQueue.length === 0) return;
    const job = this.outQueue.shift();
    this.outActive = {
      id: job.id,
      file: job.file,
      chunkIndex: 0,
      totalChunks: Math.ceil(job.file.size / CHUNK_SIZE) || 1,
    };

    this.peerLink.send(
      "file",
      JSON.stringify({
        t: "meta",
        id: job.id,
        name: job.file.name,
        size: job.file.size,
        mime: job.file.type || "application/octet-stream",
        totalChunks: this.outActive.totalChunks,
      })
    );

    await this._sendChunksFrom(0);
  }

  async _sendChunksFrom(startChunk) {
    const active = this.outActive;
    if (!active) return;
    active.chunkIndex = startChunk;

    while (active.chunkIndex < active.totalChunks) {
      // Backpressure: wait for the channel buffer to drain before continuing.
      if (this.peerLink.bufferedAmount("file") > BUFFERED_AMOUNT_HIGH) {
        await this._waitForDrain();
      }

      const start = active.chunkIndex * CHUNK_SIZE;
      const slice = await active.file.slice(start, start + CHUNK_SIZE).arrayBuffer();
      const encrypted = await CryptoModule.encryptBytes(this.key, slice);

      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, active.chunkIndex, false);
      const frame = new Uint8Array(header.length + encrypted.length);
      frame.set(header, 0);
      frame.set(encrypted, header.length);

      this.peerLink.send("file", frame.buffer);

      active.chunkIndex++;
      this.dispatchEvent(
        new CustomEvent("send-progress", {
          detail: { id: active.id, sent: active.chunkIndex, total: active.totalChunks },
        })
      );
    }

    this.peerLink.send("file", JSON.stringify({ t: "complete", id: active.id }));
    this.dispatchEvent(new CustomEvent("send-complete", { detail: { id: active.id } }));
    this.outActive = null;
    this._pump();
  }

  _waitForDrain() {
    return new Promise((resolve) => {
      const channel = this.peerLink.fileChannel;
      if (!channel) return resolve();
      channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
      const handler = () => {
        channel.removeEventListener("bufferedamountlow", handler);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", handler);
    });
  }

  /** Called if the file channel re-opens while a send was in progress. */
  resumeIfNeeded() {
    if (this.outActive) {
      this._sendChunksFrom(this.outActive.chunkIndex);
    }
  }

  async _onFileData(data) {
    if (typeof data === "string") {
      const msg = JSON.parse(data);
      if (msg.t === "meta") {
        this.inActive = {
          id: msg.id,
          name: msg.name,
          size: msg.size,
          mime: msg.mime,
          total: msg.totalChunks,
          chunks: new Array(msg.totalChunks),
          received: 0,
        };
        this.dispatchEvent(
          new CustomEvent("receive-start", { detail: { id: msg.id, name: msg.name, size: msg.size } })
        );
      } else if (msg.t === "complete") {
        await this._finishIncoming();
      } else if (msg.t === "cancel") {
        this.inActive = null;
        this.dispatchEvent(new CustomEvent("receive-cancelled", { detail: { id: msg.id } }));
      }
      return;
    }

    // Binary chunk frame.
    const bytes = new Uint8Array(data);
    const chunkIndex = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const encrypted = bytes.slice(4);
    const plain = await CryptoModule.decryptBytes(this.key, encrypted);

    const active = this.inActive;
    if (!active) return; // stray chunk, ignore
    active.chunks[chunkIndex] = plain;
    active.received++;

    this.dispatchEvent(
      new CustomEvent("receive-progress", {
        detail: { id: active.id, received: active.received, total: active.total },
      })
    );
  }

  async _finishIncoming() {
    const active = this.inActive;
    if (!active) return;
    const blob = new Blob(active.chunks, { type: active.mime });
    this.dispatchEvent(
      new CustomEvent("receive-complete", {
        detail: { id: active.id, name: active.name, size: active.size, blob },
      })
    );
    this.inActive = null;
  }
}
