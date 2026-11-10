# AGENTS.md — Engineering & AI Agent Guidelines

This document defines the architecture, tech-stack conventions, and non-negotiable security invariants for **CodeMirror (GCP Edition)**. Both AI coding agents and human contributors must follow these rules when modifying or extending the repository.

---

## 1. Tech Stack & Languages Used

| Layer | Technology / Language | Details & Location |
| :--- | :--- | :--- |
| **Frontend Language & Bundler** | **TypeScript 5.6+** (`ES2022`, `strict: true`) + **Vite 6** | Located in `client/`. Uses native ES modules and Rollup `manualChunks` (`yjs`, `codemirror`, `languages`). |
| **Styling** | **Tailwind CSS v4** (`@tailwindcss/vite`) + Custom CSS | Located in `client/src/style.css` and `client/index.html`. Dark-first (`zinc-950`) desktop layout. |
| **Editor Engine** | **CodeMirror 6** (`@codemirror/view`, `@codemirror/state`, `@codemirror/language`, `@codemirror/theme-one-dark`) | Located in `client/src/editor.ts`. Includes first-party language modes (`@codemirror/lang-*`) plus `@codemirror/legacy-modes` (`StreamLanguage.define(kotlin)`) for Kotlin. |
| **CRDT Synchronization** | **Yjs** (`yjs`) | `Y.Text("codemirror")` holds the document buffer; `Y.Map("meta")` holds synchronized room metadata such as the selected syntax language. |
| **Cryptography** | **Browser Web Crypto API** (`crypto.subtle`) | Located in `client/src/crypto.ts`. Symmetric `AES-GCM-256` with a 12-byte random IV per frame. |
| **Backend Relay** | **Node.js 20+ LTS** (CommonJS JavaScript) + **`ws`** | Located in `server/server.js`, containerized via `server/Dockerfile` (`node:20-alpine`). |
| **Persistence & TTL** | **Google Cloud Firestore** (`@google-cloud/firestore`) | Stores `/rooms/{roomId}` with `createdAt`, `expiresAt` (+24h Native TTL), and `snapshot` (`Blob`). Automatic in-memory fallback (`createRoomStore`) when running locally without GCP credentials. |
| **Testing** | **Vitest** (`client/src/__tests__/sync-crypto.test.ts`) | Automated unit and multi-peer E2E WebSocket relay integration tests. |

---

## 2. Non-Negotiable Zero-Knowledge Security Invariants

1. **URL Fragment Key Isolation (`FR-2`)**:
   - The `AES-GCM-256` key (base64-encoded JWK) **must only ever reside in `window.location.hash`**.
   - **NEVER** include the key in HTTP headers, URL query parameters (`?key=...`), WebSocket handshakes, Firestore documents, analytics, or console logs.
2. **Fresh Random 12-Byte IV Per Frame (`FR-4`)**:
   - Every call to `encryptDelta()` must generate a new 12-byte IV via `crypto.getRandomValues(new Uint8Array(12))`. Reusing an IV with the same AES-GCM key is a critical cryptographic vulnerability.
3. **Opaque Binary Relay (`server/server.js`)**:
   - The backend relay must treat encrypted payloads as opaque binary buffers (`Buffer` / `Uint8Array`).
   - Never attempt to decrypt, inspect, or parse Yjs updates on the server.
4. **No Presence / Cursor Broadcasts**:
   - Do not add `y-protocols/awareness`, remote cursor coordinates, or user presence broadcasts. They are intentionally excluded by the PRD to preserve privacy and keep bandwidth under 5 KB/s per typist.

---

## 3. Wire Protocol Contract (`client/src/provider.ts` ↔ `server/server.js`)

All binary WebSocket frames use `binaryType = "arraybuffer"` with a 1-byte frame type header followed by the AES-GCM frame:

```text
+-------------------+------------------------+-----------------------------------+
| Frame Type (1 B)  |       IV (12 B)        |   AES-GCM Ciphertext + Tag (Var)  |
| 0x01 = Delta      | crypto.getRandomValues | Encrypted Yjs update + 16B tag    |
| 0x02 = Snapshot   |                        |                                   |
+-------------------+------------------------+-----------------------------------+
```

- **`0x01` (`FRAME_TYPE_DELTA`)**: Incremental encrypted Yjs update (`doc.on("update")`). The relay broadcasts this immediately to all other peers in `roomId` and appends it to the room's in-memory `pendingDeltas` array (capped at `MAX_PENDING_DELTAS = 500`).
- **`0x02` (`FRAME_TYPE_SNAPSHOT`)**: Full encrypted Yjs document state (`Y.encodeStateAsUpdate(doc)`), sent 1.5s after initial edits, every 30s of active editing, and on `visibilitychange` (`hidden`). The relay persists the payload to Firestore `/rooms/{roomId}.snapshot` and clears `pendingDeltas`.
- **JSON Control Frame (`room_meta`)**: On connection, the server sends `{ type: "room_meta", roomId, createdAt, expiresAt }` as a UTF-8 text frame so all peers render an identical 24-hour countdown timer, followed by the latest `0x02` snapshot and any uncommitted `0x01` `pendingDeltas`.

---

## 4. CodeMirror 6 ↔ Yjs Binding Rules (`client/src/editor.ts`)

- **Never overwrite the full `Y.Text` on local edits** (do not do `ytext.delete(0, len); ytext.insert(0, fullText)`). Doing so destroys concurrent peer edits and resets cursor positions.
- **Always use incremental delta translation with origin guards**:
  - Local CodeMirror edits (`EditorView.updateListener`) must iterate `update.changes.iterChanges` inside `doc.transact(() => ..., "cm-local")` and apply minimal `ytext.delete(fromB, toA - fromA)` and `ytext.insert(fromB, inserted.toString())` operations.
  - Remote Yjs updates (`ytext.observe`) must ignore transactions where `transaction.origin === "cm-local"` and dispatch CodeMirror changes annotated with `remoteYjsAnnotation.of(true)`.
- **Adding a New Syntax Highlighting Language**:
  1. Add the language ID to `SupportedLanguage` and `LANGUAGE_OPTIONS` in `client/src/editor.ts`.
  2. Return its CodeMirror `Extension` in `getLanguageExtension()` (either a `@codemirror/lang-*` package or `StreamLanguage.define(...)` from `@codemirror/legacy-modes`).
  3. Add any new package to `manualChunks.languages` in `client/vite.config.ts`.

---

## 5. Development, Testing & Verification Commands

Before completing any code change, always run both the automated test suite and the production TypeScript/Vite build from the repository root:

```bash
# 1. Run unit + multi-peer E2E encrypted WebSocket sync tests (Vitest)
npm test

# 2. Verify strict TypeScript typecheck and production Vite bundle
npm run build
```

For local interactive development (requires no GCP credentials thanks to `USE_IN_MEMORY_STORE=true`):
```bash
# Terminal 1: Start WebSocket relay on port 8080
USE_IN_MEMORY_STORE=true npm run dev:server

# Terminal 2: Start Vite dev server on http://localhost:5173 (proxies /ws -> :8080)
npm run dev:client
```
