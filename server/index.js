/**
 * CodeLink Chat — Signaling Server
 * ---------------------------------
 * What this server DOES:
 *   - Serves the static frontend (public/).
 *   - Generates short-lived room codes.
 *   - Relays WebRTC handshake data (SDP offers/answers + ICE candidates)
 *     between exactly two browsers so they can open a direct
 *     peer-to-peer connection.
 *
 * What this server NEVER does:
 *   - It never sees chat messages or file bytes. Those travel only over
 *     the encrypted WebRTC DataChannel, directly between the two peers.
 *   - It never writes anything to disk or a database. All room state
 *     lives in memory and is wiped the moment a room closes or expires.
 *
 * Rooms are deleted when:
 *   - Both sides disconnect, or
 *   - No one joins within ROOM_JOIN_TIMEOUT_MS of hosting, or
 *   - The room sits idle (no socket activity) past ROOM_IDLE_TIMEOUT_MS.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

// Characters chosen to avoid visual ambiguity (no 0/O, 1/I/L).
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROOM_JOIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 min to wait for a peer
const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min of silence -> expire
const HEARTBEAT_INTERVAL_MS = 25 * 1000;

/** @type {Map<string, Room>} */
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 8 }, () =>
      CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    ).join("");
    code = code.slice(0, 4) + "-" + code.slice(4);
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code, hostSocket) {
    this.code = code;
    this.host = hostSocket;
    this.peer = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.joinTimer = setTimeout(() => {
      if (!this.peer) this.destroy("expired_unjoined");
    }, ROOM_JOIN_TIMEOUT_MS);
  }

  touch() {
    this.lastActivity = Date.now();
  }

  destroy(reason) {
    clearTimeout(this.joinTimer);
    rooms.delete(this.code);
    for (const sock of [this.host, this.peer]) {
      if (sock && sock.readyState === sock.OPEN) {
        send(sock, { type: "room-closed", reason });
        sock.roomCode = null;
      }
    }
  }
}

function send(socket, message) {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    /* socket already closing — ignore */
  }
}

function otherSide(room, socket) {
  return socket === room.host ? room.peer : room.host;
}

// ---------------------------------------------------------------------------
// HTTP + static frontend
// ---------------------------------------------------------------------------

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

// Lightweight health/metrics endpoint — counts only, no content.
app.get("/healthz", (req, res) => {
  res.json({ ok: true, activeRooms: rooms.size });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.roomCode = null;

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(socket, { type: "error", message: "Malformed message." });
    }

    switch (msg.type) {
      case "host": {
        const code = generateRoomCode();
        const room = new Room(code, socket);
        rooms.set(code, room);
        socket.roomCode = code;
        send(socket, { type: "hosted", code });
        break;
      }

      case "join": {
        const code = String(msg.code || "").toUpperCase().trim();
        const room = rooms.get(code);

        if (!room) {
          return send(socket, { type: "error", message: "Room code not found or expired." });
        }
        if (room.peer) {
          return send(socket, { type: "error", message: "That room already has two people in it." });
        }
        if (room.host === socket) {
          return send(socket, { type: "error", message: "You can't join your own room." });
        }

        room.peer = socket;
        room.touch();
        clearTimeout(room.joinTimer);
        socket.roomCode = code;

        send(socket, { type: "joined", code });
        send(room.host, { type: "peer-joined" });
        break;
      }

      case "signal": {
        const room = rooms.get(socket.roomCode);
        if (!room) return send(socket, { type: "error", message: "No active room." });
        const target = otherSide(room, socket);
        if (!target) return;
        room.touch();
        send(target, { type: "signal", payload: msg.payload });
        break;
      }

      case "leave": {
        const room = rooms.get(socket.roomCode);
        if (room) room.destroy("peer_left");
        break;
      }

      case "ping": {
        send(socket, { type: "pong" });
        break;
      }

      default:
        send(socket, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  socket.on("close", () => {
    const room = rooms.get(socket.roomCode);
    if (room) room.destroy("disconnected");
  });
});

// Drop dead sockets and expire idle rooms.
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }

  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.lastActivity > ROOM_IDLE_TIMEOUT_MS) {
      room.destroy("idle_timeout");
    }
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`CodeLink Chat signaling server listening on :${PORT}`);
});
