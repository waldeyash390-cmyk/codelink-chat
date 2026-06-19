// webrtc.js — establishes the direct peer-to-peer link. The signaling
// server only ever sees SDP/ICE metadata here, passed through verbatim.

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export class PeerLink extends EventTarget {
  constructor(signaling, isHost) {
    super();
    this.signaling = signaling;
    this.isHost = isHost;
    this.pc = null;
    this.chatChannel = null;
    this.fileChannel = null;
    this._statsTimer = null;

    signaling.addEventListener("message", (e) => this._onSignal(e.detail));
  }

  async start() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.send({ type: "signal", payload: { candidate: e.candidate } });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.dispatchEvent(new CustomEvent("state", { detail: state }));
      if (state === "connected") this._startStatsLoop();
      if (["failed", "disconnected", "closed"].includes(state)) this._stopStatsLoop();
    };

    if (this.isHost) {
      // Host owns channel creation; negotiation happens once a peer joins
      // (see _onSignal -> "peer-joined").
      this.chatChannel = this.pc.createDataChannel("chat", { ordered: true });
      this.fileChannel = this.pc.createDataChannel("file", { ordered: true });
      this._wireChannel(this.chatChannel, "chat");
      this._wireChannel(this.fileChannel, "file");
    } else {
      this.pc.ondatachannel = (e) => {
        if (e.channel.label === "chat") {
          this.chatChannel = e.channel;
          this._wireChannel(e.channel, "chat");
        } else if (e.channel.label === "file") {
          this.fileChannel = e.channel;
          this._wireChannel(e.channel, "file");
        }
      };
    }
  }

  _wireChannel(channel, kind) {
    channel.binaryType = "arraybuffer";
    channel.onopen = () => this.dispatchEvent(new CustomEvent("channel-open", { detail: kind }));
    channel.onclose = () => this.dispatchEvent(new CustomEvent("channel-close", { detail: kind }));
    channel.onmessage = (e) =>
      this.dispatchEvent(new CustomEvent("data", { detail: { kind, data: e.data } }));
  }

  async _makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send({ type: "signal", payload: { sdp: this.pc.localDescription } });
  }

  async _onSignal(msg) {
    if (msg.type === "peer-joined" && this.isHost) {
      await this._makeOffer();
      return;
    }

    if (msg.type !== "signal") return;
    const { sdp, candidate } = msg.payload || {};

    if (sdp) {
      await this.pc.setRemoteDescription(sdp);
      if (sdp.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.send({ type: "signal", payload: { sdp: this.pc.localDescription } });
      }
    } else if (candidate) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        /* benign — candidate arrived before remote description was set */
      }
    }
  }

  send(kind, data) {
    const channel = kind === "chat" ? this.chatChannel : this.fileChannel;
    if (channel && channel.readyState === "open") channel.send(data);
  }

  bufferedAmount(kind) {
    const channel = kind === "chat" ? this.chatChannel : this.fileChannel;
    return channel ? channel.bufferedAmount : 0;
  }

  _startStatsLoop() {
    this._stopStatsLoop();
    this._statsTimer = setInterval(async () => {
      if (!this.pc) return;
      const stats = await this.pc.getStats();
      let rttMs = null;
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime != null) {
          rttMs = report.currentRoundTripTime * 1000;
        }
      });
      if (rttMs != null) this.dispatchEvent(new CustomEvent("rtt", { detail: rttMs }));
    }, 3000);
  }

  _stopStatsLoop() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  close() {
    this._stopStatsLoop();
    if (this.chatChannel) this.chatChannel.close();
    if (this.fileChannel) this.fileChannel.close();
    if (this.pc) this.pc.close();
  }
}
