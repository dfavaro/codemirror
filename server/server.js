const { WebSocketServer, WebSocket } = require("ws");
const http = require("http");

const FRAME_TYPE_DELTA = 0x01;
const FRAME_TYPE_SNAPSHOT = 0x02;
const FRAME_TYPE_DESTROY = 0x03;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_PEERS_PER_ROOM = 100;
const MAX_PENDING_DELTAS = 500;
const MAX_PROXY_BODY_BYTES = 256 * 1024;

const ALLOWED_AI_HOSTS = new Set([
  "opencode.ai",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "api.groq.com",
  "api.deepseek.com",
  "api.x.ai",
  "api.mistral.ai"
]);

/**
 * Creates a storage adapter backed by Google Cloud Firestore when available,
 * with a transparent in-memory fallback for local development and tests.
 */
function createRoomStore(options = {}) {
  const memoryDocs = new Map();

  if (options.inMemory || process.env.USE_IN_MEMORY_STORE === "true") {
    return {
      mode: "memory",
      async getRoom(roomId) {
        return memoryDocs.get(roomId) || null;
      },
      async saveRoom(roomId, data) {
        const existing = memoryDocs.get(roomId) || {};
        const merged = { ...existing, ...data };
        memoryDocs.set(roomId, merged);
        return merged;
      },
      async deleteRoom(roomId) {
        memoryDocs.delete(roomId);
      }
    };
  }

  let firestore = null;
  let Timestamp = null;
  try {
    const firestorePkg = require("@google-cloud/firestore");
    Firestore = firestorePkg.Firestore;
    Timestamp = firestorePkg.Timestamp;
    firestore = new Firestore();
  } catch (err) {
    console.warn("Firestore SDK unavailable, falling back to in-memory store:", err.message);
  }

  let useFallback = !firestore;

  return {
    get mode() {
      return useFallback ? "memory-fallback" : "firestore";
    },
    async getRoom(roomId) {
      if (useFallback) {
        return memoryDocs.get(roomId) || null;
      }
      try {
        const docRef = firestore.collection("rooms").doc(roomId);
        const doc = await docRef.get();
        if (!doc.exists) return null;
        const raw = doc.data();
        return {
          createdAt: raw.createdAt?.toMillis ? raw.createdAt.toMillis() : raw.createdAt,
          expiresAt: raw.expiresAt?.toMillis ? raw.expiresAt.toMillis() : raw.expiresAt,
          snapshot: raw.snapshot
            ? Buffer.isBuffer(raw.snapshot)
              ? raw.snapshot
              : typeof raw.snapshot.toBuffer === "function"
              ? raw.snapshot.toBuffer()
              : Buffer.from(raw.snapshot)
            : null
        };
      } catch (err) {
        console.warn("Firestore read failed (switching to local memory store for dev):", err.message);
        useFallback = true;
        return memoryDocs.get(roomId) || null;
      }
    },
    async saveRoom(roomId, { createdAt, expiresAt, snapshot }) {
      const prev = memoryDocs.get(roomId) || {};
      const record = {
        createdAt: createdAt ?? prev.createdAt ?? Date.now(),
        expiresAt: expiresAt ?? prev.expiresAt ?? Date.now() + ROOM_TTL_MS,
        snapshot: snapshot !== undefined ? snapshot : prev.snapshot ?? null
      };
      memoryDocs.set(roomId, record);

      if (useFallback) {
        return record;
      }

      try {
        const docRef = firestore.collection("rooms").doc(roomId);
        const payload = {
          createdAt: Timestamp.fromMillis(record.createdAt),
          expiresAt: Timestamp.fromMillis(record.expiresAt)
        };
        if (record.snapshot) {
          payload.snapshot = Buffer.from(record.snapshot);
        }
        await docRef.set(payload, { merge: true });
      } catch (err) {
        console.warn("Firestore write failed (continuing with local memory store):", err.message);
        useFallback = true;
      }
      return record;
    },
    async deleteRoom(roomId) {
      memoryDocs.delete(roomId);
      if (useFallback) {
        return;
      }
      try {
        await firestore.collection("rooms").doc(roomId).delete();
      } catch (err) {
        console.warn("Firestore delete failed:", err.message);
        useFallback = true;
      }
    }
  };
}

/**
 * Creates the HTTP + WebSocket zero-knowledge relay server.
 */
function createRelayServer(options = {}) {
  const store = options.store || createRoomStore(options);
  const fetchFn = options.fetchImpl || globalThis.fetch;

  // Map<roomId, { clients: Set<WebSocket>, createdAt: number, expiresAt: number, snapshot: Buffer | null, pendingDeltas: Buffer[], initPromise: Promise<void> | null }>
  const rooms = new Map();

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "codemirror-relay",
          storeMode: store.mode,
          activeRooms: rooms.size
        })
      );
      return;
    }

    if (req.url === "/api/ai-proxy") {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        });
        res.end();
        return;
      }

      if (req.method === "POST") {
        handleAiProxyRequest(req, res, fetchFn);
        return;
      }
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ server });

  async function ensureRoomLoaded(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        clients: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + ROOM_TTL_MS,
        snapshot: null,
        pendingDeltas: [],
        initPromise: null
      };
      rooms.set(roomId, room);
    }

    if (!room.initPromise) {
      room.initPromise = (async () => {
        const stored = await store.getRoom(roomId);
        if (stored) {
          room.createdAt = stored.createdAt || room.createdAt;
          room.expiresAt = stored.expiresAt || room.createdAt + ROOM_TTL_MS;
          if (stored.snapshot && !room.snapshot) {
            room.snapshot = Buffer.from(stored.snapshot);
          }
        } else {
          await store.saveRoom(roomId, {
            createdAt: room.createdAt,
            expiresAt: room.expiresAt,
            snapshot: null
          });
        }
      })();
    }

    await room.initPromise;
    return room;
  }

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url || "/", "http://localhost");
    const roomId = url.searchParams.get("room");

    if (!roomId || roomId.length > 128) {
      ws.close(4000, "Missing or invalid room ID");
      return;
    }

    let room;
    try {
      room = await ensureRoomLoaded(roomId);
    } catch (err) {
      console.error("Failed to initialize room:", err);
      ws.close(1011, "Room initialization error");
      return;
    }

    if (Date.now() >= room.expiresAt) {
      ws.close(4004, "Room session has expired");
      return;
    }

    if (room.clients.size >= MAX_PEERS_PER_ROOM) {
      ws.close(4003, "Room capacity reached (max 100 peers)");
      return;
    }

    // Buffer messages arriving while initial snapshot catch-up is being sent
    let isReady = false;
    const earlyMessages = [];

    room.clients.add(ws);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed && parsed.type === "destroy_room") {
            void destroyRoomSession(roomId, room);
          }
        } catch {
          // Ignore malformed text message
        }
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length === 1 && buf[0] === FRAME_TYPE_DESTROY) {
        void destroyRoomSession(roomId, room);
        return;
      }
      if (buf.length < 13) return; // Minimum: 12-byte IV + at least 1 byte payload

      if (!isReady) {
        earlyMessages.push(buf);
        return;
      }
      handleClientFrame(ws, roomId, room, buf);
    });

    ws.on("close", () => {
      room.clients.delete(ws);
      if (room.clients.size === 0 && room.pendingDeltas.length === 0) {
        rooms.delete(roomId);
      }
    });

    // 1. Send room metadata (createdAt / expiresAt) for synchronized 24h countdown
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "room_meta",
          roomId,
          createdAt: room.createdAt,
          expiresAt: room.expiresAt
        })
      );
    }

    // 2. Send latest encrypted snapshot if present
    if (room.snapshot && ws.readyState === WebSocket.OPEN) {
      const snapshotFrame = Buffer.concat([Buffer.from([FRAME_TYPE_SNAPSHOT]), room.snapshot]);
      ws.send(snapshotFrame, { binary: true });
    }

    // 3. Stream any uncommitted encrypted deltas since the last snapshot
    if (room.pendingDeltas.length > 0 && ws.readyState === WebSocket.OPEN) {
      for (const deltaPayload of room.pendingDeltas) {
        const deltaFrame = Buffer.concat([Buffer.from([FRAME_TYPE_DELTA]), deltaPayload]);
        ws.send(deltaFrame, { binary: true });
      }
    }

    isReady = true;
    for (const queuedBuf of earlyMessages) {
      handleClientFrame(ws, roomId, room, queuedBuf);
    }
  });

  function handleClientFrame(senderWs, roomId, room, buf) {
    const firstByte = buf[0];

    if (firstByte === FRAME_TYPE_DESTROY) {
      void destroyRoomSession(roomId, room);
      return;
    }

    if (firstByte === FRAME_TYPE_SNAPSHOT) {
      // Encrypted full-document snapshot: [0x02][12-byte IV][Ciphertext + Auth Tag]
      const encryptedSnapshot = buf.subarray(1);
      if (encryptedSnapshot.length < 13) return;

      room.snapshot = Buffer.from(encryptedSnapshot);
      room.pendingDeltas = [];

      // Persist encrypted snapshot blob to Firestore asynchronously
      store
        .saveRoom(roomId, {
          createdAt: room.createdAt,
          expiresAt: room.expiresAt,
          snapshot: room.snapshot
        })
        .catch((err) => {
          console.error(`Failed to persist snapshot for room ${roomId}:`, err);
        });

      // Also broadcast to connected peers so any peer missing state catches up
      broadcastBinary(senderWs, room, buf);
      return;
    }

    if (firstByte === FRAME_TYPE_DELTA) {
      // Encrypted incremental delta: [0x01][12-byte IV][Ciphertext + Auth Tag]
      const encryptedDelta = buf.subarray(1);
      if (encryptedDelta.length < 13) return;

      room.pendingDeltas.push(Buffer.from(encryptedDelta));
      if (room.pendingDeltas.length > MAX_PENDING_DELTAS) {
        room.pendingDeltas.shift();
      }

      broadcastBinary(senderWs, room, buf);
      return;
    }

    // Raw binary frame fallback (no 1-byte header): forward directly to peers
    room.pendingDeltas.push(Buffer.from(buf));
    if (room.pendingDeltas.length > MAX_PENDING_DELTAS) {
      room.pendingDeltas.shift();
    }
    broadcastBinary(senderWs, room, buf);
  }

  function broadcastBinary(senderWs, room, frameBuffer) {
    for (const peer of room.clients) {
      if (peer !== senderWs && peer.readyState === WebSocket.OPEN) {
        peer.send(frameBuffer, { binary: true });
      }
    }
  }

  async function destroyRoomSession(roomId, room) {
    room.snapshot = null;
    room.pendingDeltas = [];
    rooms.delete(roomId);

    try {
      await store.deleteRoom(roomId);
    } catch (err) {
      console.error(`Failed to delete room ${roomId}:`, err);
    }

    const peers = Array.from(room.clients);
    room.clients.clear();

    for (const peer of peers) {
      try {
        if (peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ type: "room_destroyed", roomId }));
        }
        peer.close(4005, "Room session ended");
      } catch {
        // Ignore close errors
      }
    }
  }

  return { server, wss, rooms, store };
}

/**
 * Stateless, zero-logging CORS pass-through for AI providers (such as opencode.ai)
 * that reject browser OPTIONS preflights or require custom User-Agent / session headers.
 */
function handleAiProxyRequest(req, res, fetchFn) {
  let rawBody = "";
  let bodyBytes = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    if (aborted) return;
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_PROXY_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(JSON.stringify({ error: { message: "Proxy payload too large" } }));
      req.destroy();
      return;
    }
    rawBody += chunk.toString("utf8");
  });

  req.on("end", async () => {
    if (aborted) return;
    try {
      const payload = JSON.parse(rawBody || "{}");
      const targetUrl = typeof payload.url === "string" ? payload.url : "";
      if (!targetUrl) {
        res.writeHead(400, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        });
        res.end(JSON.stringify({ error: { message: "Missing target url" } }));
        return;
      }

      const parsedUrl = new URL(targetUrl);
      if (parsedUrl.protocol !== "https:" || !ALLOWED_AI_HOSTS.has(parsedUrl.hostname)) {
        res.writeHead(400, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        });
        res.end(
          JSON.stringify({
            error: { message: `Disallowed AI provider host: ${parsedUrl.hostname}` }
          })
        );
        return;
      }

      const upstreamHeaders = {
        "Content-Type": "application/json",
        "User-Agent": "codemirror-agent/1.0"
      };

      if (payload.headers && typeof payload.headers === "object") {
        for (const [k, v] of Object.entries(payload.headers)) {
          if (typeof v === "string" && v.length > 0) {
            upstreamHeaders[k] = v;
          }
        }
      }

      const upstreamBody =
        typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body ?? {});

      const upstreamRes = await fetchFn(parsedUrl.toString(), {
        method: "POST",
        headers: upstreamHeaders,
        body: upstreamBody
      });

      const text = await upstreamRes.text();
      res.writeHead(upstreamRes.status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(text);
    } catch (err) {
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(
        JSON.stringify({
          error: { message: err instanceof Error ? err.message : "AI proxy request failed" }
        })
      );
    }
  });
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 8080;
  const { server, store } = createRelayServer();
  server.listen(PORT, () => {
    console.log(`CodeMirror relay running on port ${PORT} (store: ${store.mode})`);
  });
}

module.exports = {
  createRelayServer,
  createRoomStore,
  FRAME_TYPE_DELTA,
  FRAME_TYPE_SNAPSHOT,
  FRAME_TYPE_DESTROY,
  ALLOWED_AI_HOSTS,
  ROOM_TTL_MS
};
