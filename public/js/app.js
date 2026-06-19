// app.js — entry point. Plain DOM, no framework: keeps the page light
// and the behavior easy to trace end to end.

import { CryptoModule } from "./crypto.js";
import { Signaling } from "./signaling.js";
import { PeerLink } from "./webrtc.js";
import { FileTransferManager } from "./filetransfer.js";

// ---------------------------------------------------------------- DOM refs
const $ = (id) => document.getElementById(id);

const els = {
  roomTag: $("roomTag"),
  sessionTimer: $("sessionTimer"),
  quality: $("quality"),
  statusDot: $("statusDot"),
  settingsBtn: $("settingsBtn"),

  screenHome: $("screenHome"),
  hostBtn: $("hostBtn"),
  joinForm: $("joinForm"),
  joinCodeInput: $("joinCodeInput"),
  homeError: $("homeError"),

  screenWaiting: $("screenWaiting"),
  waitingLabel: $("waitingLabel"),
  roomCodeBlock: $("roomCodeBlock"),
  roomCodeText: $("roomCodeText"),
  copyCodeBtn: $("copyCodeBtn"),
  qrImg: $("qrImg"),
  waitingHint: $("waitingHint"),
  cancelWaitBtn: $("cancelWaitBtn"),

  screenChat: $("screenChat"),
  messages: $("messages"),
  fileDrop: $("fileDrop"),
  fileInput: $("fileInput"),
  fileList: $("fileList"),
  composerForm: $("composerForm"),
  attachBtn: $("attachBtn"),
  messageInput: $("messageInput"),
  typingIndicator: $("typingIndicator"),

  settingsOverlay: $("settingsOverlay"),
  settingsConnState: $("settingsConnState"),
  settingsRoomCode: $("settingsRoomCode"),
  settingsTimer: $("settingsTimer"),
  leaveBtn: $("leaveBtn"),
  closeSettingsBtn: $("closeSettingsBtn"),

  leaveConfirmOverlay: $("leaveConfirmOverlay"),
  leaveCancelBtn: $("leaveCancelBtn"),
  leaveConfirmBtn: $("leaveConfirmBtn"),

  toast: $("toast"),
};

// ---------------------------------------------------------------- state
const state = {
  roomCode: null,
  isHost: false,
  signaling: null,
  peerLink: null,
  cryptoKey: null,
  fileTransfer: null,
  connectedAt: null,
  timerHandle: null,
  myMsgCount: 0,
};

// ---------------------------------------------------------------- helpers
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

function showScreen(name) {
  hide(els.screenHome);
  hide(els.screenWaiting);
  hide(els.screenChat);
  if (name === "home") show(els.screenHome);
  if (name === "waiting") show(els.screenWaiting);
  if (name === "chat") show(els.screenChat);
}

function setStatus(stateName, label) {
  els.statusDot.dataset.state = stateName;
  els.statusDot.querySelector(".status-text").textContent = label;
  els.settingsConnState.textContent = label;
}

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  show(els.toast);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(els.toast), ms);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function normalizeCode(raw) {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function resetToHome() {
  showScreen("home");
  setStatus("offline", "Offline");
  hide(els.roomTag);
  hide(els.sessionTimer);
  hide(els.quality);
  hide(els.settingsBtn);
  els.messages.innerHTML = "";
  els.fileList.innerHTML = "";
  els.joinCodeInput.value = "";
  hide(els.homeError);
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.roomCode = null;
  state.peerLink = null;
  state.cryptoKey = null;
  state.fileTransfer = null;
  state.connectedAt = null;
}

// ---------------------------------------------------------------- host flow
async function startHosting() {
  state.isHost = true;
  showScreen("waiting");
  els.waitingLabel.textContent = "Setting up your room…";
  hide(els.roomCodeBlock);
  hide(els.qrImg);
  els.waitingHint.textContent = "Generating a secure room code…";
  setStatus("connecting", "Connecting…");

  state.signaling = new Signaling();
  state.signaling.addEventListener("open", () => state.signaling.send({ type: "host" }));
  state.signaling.addEventListener("message", (e) => handleSignalingMessage(e.detail));
  state.signaling.connect();
}

async function startJoining(code) {
  state.isHost = false;
  state.roomCode = code;
  showScreen("waiting");
  els.waitingLabel.textContent = `Joining ${code}…`;
  hide(els.roomCodeBlock);
  hide(els.qrImg);
  els.waitingHint.textContent = "Connecting to the host…";
  setStatus("connecting", "Connecting…");

  state.signaling = new Signaling();
  state.signaling.addEventListener("open", () => state.signaling.send({ type: "join", code }));
  state.signaling.addEventListener("message", (e) => handleSignalingMessage(e.detail));
  state.signaling.connect();
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {
    case "hosted": {
      state.roomCode = msg.code;
      els.roomCodeText.textContent = msg.code;
      show(els.roomCodeBlock);
      els.waitingLabel.textContent = "Waiting for the other person to join…";
      els.waitingHint.textContent = "Share this code with them. The room expires automatically if no one joins.";
      const shareUrl = `${location.origin}${location.pathname}?code=${encodeURIComponent(msg.code)}`;
      els.qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&qzone=1&data=${encodeURIComponent(shareUrl)}`;
      show(els.qrImg);
      await setupPeerLink();
      break;
    }

    case "joined": {
      els.waitingLabel.textContent = "Connected to room. Establishing direct link…";
      await setupPeerLink();
      break;
    }

    case "error": {
      toast(msg.message);
      els.homeError.textContent = msg.message;
      show(els.homeError);
      cleanupConnection();
      showScreen("home");
      break;
    }

    case "room-closed": {
      if (els.screenChat.hidden === false || els.screenWaiting.hidden === false) {
        toast("Session ended — room closed.");
        cleanupConnection();
        showScreen("home");
      }
      break;
    }

    default:
      break; // "signal" / "peer-joined" / "pong" are consumed by PeerLink/Signaling internals
  }
}

async function setupPeerLink() {
  state.cryptoKey = await CryptoModule.deriveKeyFromRoomCode(state.roomCode);
  state.peerLink = new PeerLink(state.signaling, state.isHost);

  state.peerLink.addEventListener("state", (e) => {
    if (e.detail === "connected") onConnected();
    else if (["failed", "disconnected", "closed"].includes(e.detail)) onDisconnected();
  });

  state.peerLink.addEventListener("rtt", (e) => updateQuality(e.detail));

  state.peerLink.addEventListener("channel-open", (e) => {
    if (e.detail === "file" && state.fileTransfer) state.fileTransfer.resumeIfNeeded();
  });

  state.peerLink.addEventListener("data", (e) => {
    if (e.detail.kind === "chat") onChatData(e.detail.data);
  });

  await state.peerLink.start();
}

function onConnected() {
  state.connectedAt = Date.now();
  state.fileTransfer = new FileTransferManager(state.peerLink, state.cryptoKey);
  wireFileTransferEvents();

  showScreen("chat");
  els.roomTag.textContent = state.roomCode;
  show(els.roomTag);
  show(els.sessionTimer);
  show(els.quality);
  show(els.settingsBtn);
  els.settingsRoomCode.textContent = state.roomCode;
  setStatus("online", "Connected");
  addSystemMessage("Direct encrypted connection established.");

  state.timerHandle = setInterval(() => {
    const secs = Math.floor((Date.now() - state.connectedAt) / 1000);
    const clock = formatClock(secs);
    els.sessionTimer.textContent = clock;
    els.settingsTimer.textContent = clock;
  }, 1000);
}

function onDisconnected() {
  setStatus("offline", "Disconnected");
  addSystemMessage("Connection lost. The other person may have left.");
}

function cleanupConnection() {
  if (state.peerLink) state.peerLink.close();
  if (state.signaling) state.signaling.close();
  if (state.timerHandle) clearInterval(state.timerHandle);
}

function updateQuality(rttMs) {
  let level = 1;
  if (rttMs < 100) level = 4;
  else if (rttMs < 250) level = 3;
  else if (rttMs < 500) level = 2;
  els.quality.dataset.level = String(level);
}

// ---------------------------------------------------------------- chat
function addMessage({ text, mine, ts, read }) {
  const div = document.createElement("div");
  div.className = `msg ${mine ? "me" : ""}`;
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = text;
  const meta = document.createElement("span");
  meta.className = "meta";
  const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.textContent = mine ? `${time}${read ? " · read" : ""}` : time;
  div.append(body, meta);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

const sentMessageEls = new Map();

async function sendChatPayload(obj) {
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.peerLink.send("chat", encrypted.buffer.slice(0));
}

async function onChatData(rawArrayBuffer) {
  const msg = await CryptoModule.decryptJSON(state.cryptoKey, rawArrayBuffer);

  if (msg.t === "msg") {
    addMessage({ text: msg.text, mine: false, ts: msg.ts });
    hide(els.typingIndicator);
    sendChatPayload({ t: "read", id: msg.id });
  } else if (msg.t === "typing") {
    els.typingIndicator.hidden = !msg.state;
  } else if (msg.t === "read") {
    const el = sentMessageEls.get(msg.id);
    if (el) {
      const meta = el.querySelector(".meta");
      if (!meta.textContent.includes("read")) meta.textContent += " · read";
    }
  }
}

let typingTimeout = null;
els.messageInput.addEventListener("input", () => {
  if (!state.peerLink) return;
  sendChatPayload({ t: "typing", state: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => sendChatPayload({ t: "typing", state: false }), 1500);

  // auto-grow textarea, capped by CSS max-height
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${els.messageInput.scrollHeight}px`;
});

els.composerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text || !state.peerLink) return;

  const id = `${Date.now()}-${state.myMsgCount++}`;
  const ts = Date.now();
  await sendChatPayload({ t: "msg", id, text, ts });

  const el = addMessage({ text, mine: true, ts, read: false });
  sentMessageEls.set(id, el);

  els.messageInput.value = "";
  els.messageInput.style.height = "auto";
  clearTimeout(typingTimeout);
  sendChatPayload({ t: "typing", state: false });
});

els.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composerForm.requestSubmit();
  }
});

// ---------------------------------------------------------------- files
function wireFileTransferEvents() {
  const ft = state.fileTransfer;

  ft.addEventListener("queued", (e) => {
    const { id, name, size } = e.detail;
    const li = document.createElement("li");
    li.className = "file-item";
    li.id = `file-${id}`;
    li.innerHTML = `
      <span class="fname">↑ ${escapeHtml(name)}</span>
      <progress max="100" value="0"></progress>
      <span class="fmeta">${formatBytes(size)}</span>`;
    els.fileList.appendChild(li);
  });

  ft.addEventListener("send-progress", (e) => {
    const { id, sent, total } = e.detail;
    const li = document.getElementById(`file-${id}`);
    if (li) li.querySelector("progress").value = Math.round((sent / total) * 100);
  });

  ft.addEventListener("send-complete", (e) => {
    const li = document.getElementById(`file-${e.detail.id}`);
    if (li) li.querySelector("progress").remove();
  });

  ft.addEventListener("receive-start", (e) => {
    const { id, name, size } = e.detail;
    const li = document.createElement("li");
    li.className = "file-item";
    li.id = `file-${id}`;
    li.innerHTML = `
      <span class="fname">↓ ${escapeHtml(name)}</span>
      <progress max="100" value="0"></progress>
      <span class="fmeta">${formatBytes(size)}</span>`;
    els.fileList.appendChild(li);
  });

  ft.addEventListener("receive-progress", (e) => {
    const { id, received, total } = e.detail;
    const li = document.getElementById(`file-${id}`);
    if (li) li.querySelector("progress").value = Math.round((received / total) * 100);
  });

  ft.addEventListener("receive-complete", (e) => {
    const { id, name, blob } = e.detail;
    const li = document.getElementById(`file-${id}`);
    if (!li) return;
    const url = URL.createObjectURL(blob);
    li.innerHTML = `
      <span class="fname">↓ ${escapeHtml(name)}</span>
      <a href="${url}" download="${escapeHtml(name)}">Download</a>`;
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files.length && state.fileTransfer) {
    state.fileTransfer.enqueue([...els.fileInput.files]);
  }
  els.fileInput.value = "";
});

["dragover", "dragenter"].forEach((evt) =>
  els.fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    els.fileDrop.classList.add("dragover");
  })
);
["dragleave", "dragend"].forEach((evt) =>
  els.fileDrop.addEventListener(evt, () => els.fileDrop.classList.remove("dragover"))
);
els.fileDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  els.fileDrop.classList.remove("dragover");
  if (e.dataTransfer.files.length && state.fileTransfer) {
    state.fileTransfer.enqueue([...e.dataTransfer.files]);
  }
});

// Paste images directly into the chat.
els.messageInput.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imageItem = items.find((i) => i.type.startsWith("image/"));
  if (imageItem && state.fileTransfer) {
    const file = imageItem.getAsFile();
    if (file) state.fileTransfer.enqueue([file]);
  }
});

// ---------------------------------------------------------------- home UI
els.hostBtn.addEventListener("click", startHosting);

els.joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const code = normalizeCode(els.joinCodeInput.value.trim());
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    els.homeError.textContent = "Enter a code in the format XXXX-XXXX.";
    show(els.homeError);
    return;
  }
  hide(els.homeError);
  startJoining(code);
});

els.joinCodeInput.addEventListener("input", () => {
  els.joinCodeInput.value = normalizeCode(els.joinCodeInput.value);
});

els.copyCodeBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomCode);
  toast("Room code copied.");
});

els.cancelWaitBtn.addEventListener("click", () => {
  cleanupConnection();
  resetToHome();
});

// Prefill join code from a shared QR/link (?code=XXXX-XXXX), no auto-submit.
const prefillCode = new URLSearchParams(location.search).get("code");
if (prefillCode) els.joinCodeInput.value = normalizeCode(prefillCode);

// ---------------------------------------------------------------- settings & leave
els.settingsBtn.addEventListener("click", () => show(els.settingsOverlay));
els.closeSettingsBtn.addEventListener("click", () => hide(els.settingsOverlay));
els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) hide(els.settingsOverlay);
});

els.leaveBtn.addEventListener("click", () => {
  hide(els.settingsOverlay);
  show(els.leaveConfirmOverlay);
});
els.leaveCancelBtn.addEventListener("click", () => hide(els.leaveConfirmOverlay));
els.leaveConfirmBtn.addEventListener("click", () => {
  state.signaling?.send({ type: "leave" });
  cleanupConnection();
  hide(els.leaveConfirmOverlay);
  resetToHome();
  toast("Session ended.");
});

window.addEventListener("beforeunload", () => {
  state.signaling?.send({ type: "leave" });
});

// ---------------------------------------------------------------- init
resetToHome();
