# Technical Requirements Document (TRD)

## Project: CodeMirror (GCP Edition)
**Architecture, Cryptographic Protocols, and Deployment Specifications**

---

### 1. System Topology & Architecture

The architecture separates the frontend, real-time binary transport, and persistent storage using a zero-knowledge trust model:

```
+-------------------------------------------------------------------------------+
| BROWSER CLIENT (1 to 100 participants)                                         |
|                                                                               |
|  [ CodeMirror 6 Editor ]                                                      |
|           ^                                                                   |
|           v (Local text changes)                                              |
|      [ Yjs (Y.Doc) ]                                                          |
|           ^                                                                   |
|           v (Raw Uint8Array CRDT deltas)                                      |
|  [ Web Crypto API: AES-GCM-256 ]                                              |
|  - Key origin: window.location.hash                                           |
|  - Generates 12-byte IV per packet                                            |
+-----------^-----------------------------------------^-------------------------+
            | 1. Static Assets (HTTPS)                | 2. Encrypted Frames (WSS)
            v                                         v
+------------------------+      +-----------------------------------------------+
| FIREBASE HOSTING (CDN) |      | GOOGLE CLOUD RUN (Containerized Relay)        |
|                        |      |                                               |
| - Serves Vite bundle   |      | - Service: codemirror-relay                   |
| - Handles SPA rewrites |      | - Node.js + 'ws' library                      |
| - Global edge caching  |      | - In-memory Map<roomId, Set<WebSocket>>       |
| - Free automatic SSL   |      | - Session Affinity enabled                    |
+------------------------+      | - Request timeout: 3600s                      |
                                +---------------------^-------------------------+
                                                      | 3. Snapshot (Every 30s)
                                                      v
                                +-----------------------------------------------+
                                | CLOUD FIRESTORE (Native TTL Storage)          |
                                |                                               |
                                | - Collection: /rooms/{roomId}                 |
                                | - Field: snapshot (Encrypted Uint8Array Blob) |
                                | - Field: expiresAt (Timestamp: now + 24h)     |
                                | - Background TTL engine purges expired docs   |
                                +-----------------------------------------------+
```

---

### 2. Technology Stack

- **Client Framework & Bundler:** Vite 6 + TypeScript 5 (`ES2022`, strict mode) + Tailwind CSS v4.
- **Editor Engine:** CodeMirror 6 (`codemirror`, `@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/theme-one-dark`, `@codemirror/lang-*`, and `@codemirror/legacy-modes` for Kotlin).
- **CRDT Engine:** Yjs (`yjs` — `Y.Text("codemirror")` for code buffer, `Y.Map("meta")` for synchronized language selection).
- **Cryptography Engine:** Native Browser Web Crypto API (`window.crypto.subtle`, `AES-GCM-256`).
- **WebSocket Relay:** Node.js 20+ LTS with `ws` (Lightweight WebSocket library).
- **Backend Infrastructure:** Google Cloud Run (Serverless container runtime).
- **Storage & TTL:** Google Cloud Firestore (Native mode with built-in Time-to-Live engine, plus automatic in-memory fallback for zero-config local development and testing).
- **Static Hosting:** Firebase Hosting (Global CDN with SPA rewrites).
- **Automated Testing:** Vitest (`vitest`) for cryptographic unit tests and multi-peer WebSocket E2E tests.

---

### 3. Cryptographic Specification (Zero-Knowledge E2EE)

#### 3.1 Key Generation & URL Hash Lifecycle
1. Session initialization runs entirely in the creator's browser:
   ```typescript
   export async function createSession(): Promise<{ roomId: string; hashKey: string }> {
     const roomId = crypto.randomUUID();
     const key = await window.crypto.subtle.generateKey(
       { name: "AES-GCM", length: 256 },
       true,
       ["encrypt", "decrypt"]
     );
     const exported = await window.crypto.subtle.exportKey("jwk", key);
     const hashKey = btoa(JSON.stringify(exported));
     return { roomId, hashKey };
   }
   ```
2. The URL is structured as `https://<domain>/room/<roomId>#<hashKey>`.
3. Per RFC 3986, the fragment identifier (`#...`) is evaluated exclusively by client user agents and is never included in HTTP request lines sent to Firebase Hosting or Cloud Run.

#### 3.2 Binary Frame Format
Every keystroke or language switch generates a Yjs CRDT delta (`0x01`), and periodic full-document states generate a snapshot (`0x02`). Each payload is encrypted with a fresh 12-byte random IV before sending:

```
+-----------------------------------------------------------------------------+
|                           ENCRYPTED BINARY WIRE FRAME                       |
+-------------------+-------------------------+-------------------------------+
|  Frame Type (1B)  |  Initialization Vector  |     Ciphertext + Auth Tag     |
|  0x01 = Delta     |       (12 Bytes)        |          (Variable)           |
|  0x02 = Snapshot  |                         |                               |
+-------------------+-------------------------+-------------------------------+
```

- **Frame Header:** `0x01` (`FRAME_TYPE_DELTA`) for incremental Yjs updates; `0x02` (`FRAME_TYPE_SNAPSHOT`) for full `Y.encodeStateAsUpdate(doc)` snapshots persisted to Firestore.
- **Algorithm:** `AES-GCM-256`
- **IV / Nonce:** 12 random bytes generated per frame (`crypto.getRandomValues(new Uint8Array(12))`).
- **Authentication Tag:** 128-bit (16-byte) authentication tag appended to the ciphertext automatically by the Web Crypto API.

```typescript
export async function encryptDelta(delta: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    delta
  );
  const frame = new Uint8Array(12 + ciphertext.byteLength);
  frame.set(iv, 0);
  frame.set(new Uint8Array(ciphertext), 12);
  return frame;
}

export async function decryptDelta(frame: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = frame.slice(0, 12);
  const data = frame.slice(12);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  return new Uint8Array(decrypted);
}
```

---

### 4. Communication & Synchronization Protocol

The WebSocket relay acts as an untrusted, dumb binary reflector (`binaryType = "arraybuffer"`).

#### 4.1 Connection & Catch-Up Workflow
1. Client establishes a WebSocket connection to `wss://<cloud-run-domain>/ws?room=<roomId>`.
2. Cloud Run loads `/rooms/<roomId>` from Firestore (or in-memory room state if active) and rejects expired sessions (`4004`) or rooms exceeding 100 peers (`4003`).
3. Cloud Run sends a UTF-8 JSON control frame (`{ type: "room_meta", roomId, createdAt, expiresAt }`) so all connected participants render an identical 24-hour expiration countdown.
4. If an encrypted snapshot exists, Cloud Run sends it as a binary `0x02` frame, followed by any uncommitted in-memory `0x01` delta frames (`pendingDeltas`) accumulated since that snapshot.
5. The client unwraps each binary frame, decrypts the payload via `decryptDelta()`, and applies it to the local `Y.Doc` inside a `"remote"` transaction: `Y.applyUpdate(doc, decryptedBytes, "remote")`.

#### 4.2 Live Sync & Snapshots
1. When a user types or changes the syntax language, CodeMirror updates Yjs (`Y.Text("codemirror")` or `Y.Map("meta")`), triggering a local `doc.on("update")` event.
2. The client encrypts the delta with `encryptDelta()`, prepends `0x01` (`FRAME_TYPE_DELTA`), and sends the resulting `Uint8Array` over the WebSocket.
3. Cloud Run appends the encrypted delta to the room's `pendingDeltas` buffer and broadcasts the raw binary frame to all other sockets registered to that `roomId`.
4. Observers receive the frame, decrypt it via `decryptDelta()`, and apply it to their local Yjs document, updating CodeMirror and the language selector instantly.
5. **Debounced Persistence:** 1.5 seconds after initial room edits, every 30 seconds of active editing, and on `visibilitychange` (`hidden`), the client sends an encrypted full document state (`Y.encodeStateAsUpdate(doc)`) prefixed with `0x02` (`FRAME_TYPE_SNAPSHOT`), which Cloud Run persists to Firestore `/rooms/{roomId}` and uses to clear `pendingDeltas`.

---

### 5. Backend Server Implementation (Google Cloud Run)

#### 5.1 Relay Server Logic (`server/server.js`)
```javascript
const { WebSocketServer } = require("ws");
const http = require("http");
const { Firestore } = require("@google-cloud/firestore");

const firestore = new Firestore();
const server = http.createServer();
const wss = new WebSocketServer({ server });

const rooms = new Map(); // Map<string, Set<WebSocket>>

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomId = url.searchParams.get("room");

  if (!roomId) {
    ws.close(4000, "Missing room ID");
    return;
  }

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  const room = rooms.get(roomId);
  room.add(ws);

  // Send historical encrypted snapshot to the joining peer
  try {
    const docRef = firestore.collection("rooms").doc(roomId);
    const doc = await docRef.get();
    if (doc.exists && doc.data().snapshot) {
      ws.send(doc.data().snapshot.toBuffer());
    }
  } catch (err) {
    console.error("Failed to fetch room snapshot:", err);
  }

  ws.on("message", async (data, isBinary) => {
    if (!isBinary) return;

    // Broadcast opaque binary frame to all other connected peers
    for (const peer of room) {
      if (peer !== ws && peer.readyState === ws.OPEN) {
        peer.send(data);
      }
    }
  });

  ws.on("close", () => {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`CodeMirror relay running on port ${PORT}`);
});
```

#### 5.2 Containerfile (`server/Dockerfile`)
```dockerfile
FROM node:20-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

---

### 6. Cloud Firestore Schema & Native TTL Setup

#### 6.1 Schema Specification
- **Collection:** `rooms`
- **Document ID:** `{roomId}` (UUID string)
- **Fields:**
  - `createdAt`: `Timestamp` (System time at creation)
  - `expiresAt`: `Timestamp` (`createdAt` + 24 hours)
  - `snapshot`: `Blob` (Binary encrypted Yjs document state)

#### 6.2 Enabling Firestore Native TTL
Run the following Google Cloud SDK command to configure background deletion:
```bash
gcloud firestore fields ttls update expiresAt \
    --collection-group=rooms \
    --enable-ttl
```
*Firestore's built-in TTL sweeper deletes expired documents automatically without requiring Cloud Functions or cron services.*

---

### 7. Frontend SPA & Firebase Hosting Setup

#### 7.1 Single-Page App Rewrite (`firebase.json`)
```json
{
  "hosting": {
    "public": "client/dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  }
}
```

#### 7.2 CodeMirror 6 & Yjs Editor Integration (`client/src/editor.ts`)
Uses incremental CRDT delta binding (`ChangeSet.iterChanges` <-> `ytext.observe`) with transaction origin guards (`"cm-local"` and `remoteYjsAnnotation`) so concurrent edits never overwrite each other or reset cursor positions, plus a `Compartment` for 13-language syntax highlighting (including Kotlin via `StreamLanguage.define(kotlin)`) synced via `Y.Map("meta")`:

```typescript
// Local CodeMirror change -> Incremental Y.Text operations
EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  if (update.transactions.some((tr) => tr.annotation(remoteYjsAnnotation))) return;

  doc.transact(() => {
    update.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
      if (toA > fromA) ytext.delete(fromB, toA - fromA);
      if (inserted.length > 0) ytext.insert(fromB, inserted.toString());
    });
  }, "cm-local");
});

// Remote Y.Text delta -> Incremental CodeMirror transaction
ytext.observe((event, transaction) => {
  if (transaction.origin === "cm-local") return;
  const changes: { from: number; to: number; insert: string }[] = [];
  let pos = 0;
  for (const op of event.delta) {
    if (typeof op.retain === "number") pos += op.retain;
    else if (typeof op.delete === "number") {
      changes.push({ from: pos, to: pos + op.delete, insert: "" });
      pos += op.delete;
    } else if (typeof op.insert === "string") {
      changes.push({ from: pos, to: pos, insert: op.insert });
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, annotations: remoteYjsAnnotation.of(true) });
  }
});
```

---

### 8. Cloud Run Deployment Command

Deploy the WebSocket container using these production flags:

```bash
gcloud run deploy codemirror-relay \
    --source=./server \
    --platform=managed \
    --region=us-central1 \
    --allow-unauthenticated \
    --timeout=3600 \
    --session-affinity \
    --min-instances=0 \
    --max-instances=5 \
    --cpu=1 \
    --memory=512Mi
```

- `--timeout=3600`: Sets the WebSocket connection limit to 1 hour before reconnect.
- `--session-affinity`: Routes reconnecting clients to the same active container.
- `--min-instances=0`: Scales to zero during idle periods to eliminate unnecessary billing.

---

### 9. Step-by-Step AI Agent Prompting Sequence

To execute this build via an AI coding assistant, use the following prompts in order:

#### Prompt 1: Backend Relay & Docker Configuration
> "Generate the complete backend codebase for `server/server.js`, `server/package.json`, and `server/Dockerfile` for the application named CodeMirror based on the TRD. Implement an untrusted, zero-knowledge WebSocket relay using Node.js and the `ws` package. Connect it to `@google-cloud/firestore` to read and write encrypted document snapshots for late-joining peers. Do not attempt to parse or decrypt incoming binary payloads; forward raw ArrayBuffers directly to all peers sharing the same room parameter."

#### Prompt 2: Client Crypto & Custom Yjs WebSocket Provider
> "Using TypeScript and the native Web Crypto API, create `client/src/crypto.ts` and `client/src/provider.ts` according to the TRD specifications for the CodeMirror application. Implement AES-GCM-256 key generation, export/import via JWK in `window.location.hash`, and packet wrapping using a 12-byte IV prepended to the ciphertext. Implement a custom transport class that subscribes to `Y.Doc` update events, encrypts them, transmits them over a native WebSocket, and applies incoming decrypted frames to the local document."

#### Prompt 3: CodeMirror 6 Editor & Application UI
> "Build the frontend client for the CodeMirror application using Vite, CodeMirror 6, and Tailwind CSS. Implement `client/src/editor.ts`, `client/src/ui.ts`, and `client/src/main.ts`. Connect CodeMirror 6 to the Yjs document. Build a desktop utility header branding the app as 'CodeMirror', containing a connection status indicator (Connected / Reconnecting), an expiration countdown timer calculated from the 24-hour mark, and a 'Copy Encrypted Link' button. Configure `firebase.json` with SPA rewrites."