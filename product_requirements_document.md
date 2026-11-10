# Product Requirements Document (PRD)

## Project: CodeMirror (GCP Edition)
**A Disposable, Zero-Knowledge Technical Interview & Code Pad**

---

### 1. Executive Summary & Objective
**CodeMirror** is a web-based, real-time collaborative text and code editor built specifically for running technical interviews, pair programming assessments, and live screening rounds. 

The tool eliminates friction:
- **Zero Registration:** No sign-up, login, credentials, or cookies.
- **Zero-Knowledge Security:** All keystrokes and document updates are encrypted in the browser with `AES-GCM-256` prior to transmission. Intermediate infrastructure (Google Cloud) never accesses unencrypted code or keys.
- **Scalable Concurrency:** Optimized to support 1-on-1 interviews up to panel reviews with 100 concurrent viewers at sub-50ms sync latency.
- **Auto-Disposability:** Sessions and associated snapshots permanently self-destruct 24 hours post-creation.

---

### 2. User Personas & Use Cases

#### 2.1 Personas
- **Interviewer (Lead / Host):** Generates an encrypted session link, pastes interview prompts, and assesses candidate code execution in real time.
- **Candidate (Primary Typist):** Joins via link, writes and refactors code live without needing to install plugins or create an account.
- **Observers / Panelists (Spectators, up to 100 peers):** Hiring managers, recruiters, or additional engineers observing keystrokes in real time with zero negative latency impact on the typist.

#### 2.2 Primary User Flow
1. The host visits the minimal homepage and clicks **"Start session"**.
2. The browser automatically generates a unique `roomId` and an encryption key, routes the host to `/room/<roomId>#<secretKey>`, and automatically copies the encrypted session URL to the host's clipboard.
3. The host shares the copied link with the candidate and panel (or clicks **"Copy Encrypted Link"** in the room header at any time).
4. Participants open the link. The client extracts the secret key from the URL hash, connects to the relay, pulls the latest encrypted document snapshot, and starts live syncing.
5. 24 hours after creation, the room and stored snapshots permanently purge from Google Cloud.

---

### 3. Scope & Boundaries

#### In-Scope (MVP)
- **One-Click Session Creation:** Generates a cryptographically strong room ID and local encryption key.
- **Client-Side E2EE:** Symmetric encryption (`AES-GCM-256`) leveraging the browser-native Web Crypto API. Encryption key lives strictly in `window.location.hash` (with a dedicated fallback prompt if a user opens a link missing the `#` key fragment).
- **Real-Time Keystroke Collaboration:** Multi-peer text editing powered by the CodeMirror 6 engine and Yjs CRDTs using incremental character-level delta binding.
- **Synchronized Syntax Highlighting Selector:** Manual 13-language selector (TypeScript, JavaScript, Kotlin, Python, Go, Java, Rust, SQL, JSON, HTML, CSS, Markdown, Plain Text) synchronized across all room participants inside the encrypted Yjs document (`Y.Map("meta")`).
- **High-Fanout Dumb Relay:** Untrusted WebSocket relay deployed to Cloud Run, distributing opaque binary updates to up to 100 concurrent clients.
- **Late-Joiner Reconstruction:** Joining peers receive the latest encrypted snapshot plus any uncommitted in-memory encrypted deltas since that snapshot to deterministically reconstruct the exact text buffer.
- **24-Hour Expiration:** Automatic document self-destruction powered natively by Cloud Firestore TTL policies, paired with real-time `expiresAt` room metadata synchronization.
- **Clean Desktop UI:** Monospace coding layout, line numbers, line wrapping, syntax language selector, connection status indicator, countdown timer, and 1-click link sharing.

#### Out-of-Scope (Explicitly Deferred)
- User accounts, team management, auth tokens, or login persistence.
- Remote mouse cursor tracking, text selection highlights, or user presence badges (intentionally excluded to ensure minimal network overhead).
- Cloud code execution engines, compilers, linters, or language servers.
- Offline browser AI language detection.
- Clipboard copy/paste interception or anti-cheat monitoring.
- Audio/video calling.

---

### 4. Functional Requirements

| ID | Requirement | Description |
| :--- | :--- | :--- |
| **FR-1** | **Session Generation & Auto-Copy** | On clicking "Start session", generate a UUIDv4 `roomId` and a 256-bit AES-GCM key, redirect to `/room/{roomId}#{base64Key}`, and automatically copy the full encrypted URL to the clipboard. |
| **FR-2** | **URL Key Isolation** | The secret key must reside exclusively within the URL fragment (`#`). It must never be sent to Firebase Hosting, Cloud Run, or Firestore via headers, queries, or body parameters. Opening a room URL without a valid `#` fragment displays a "Missing Decryption Key" screen. |
| **FR-3** | **Real-Time Synchronization** | Keystrokes and syntax language selection must synchronize across all active connections in sub-50ms using Yjs CRDT binary updates (`Y.Text` and `Y.Map`). |
| **FR-4** | **Client-Side Encryption** | Every outgoing binary delta (`0x01`) or full state snapshot (`0x02`) must be encrypted locally with AES-GCM-256 and a fresh 12-byte IV before transport. Inbound binary frames must be decrypted locally before being applied to the editor. |
| **FR-5** | **Periodic Snapshot Persistence** | Persist encrypted document state snapshots (`0x02`) to Cloud Firestore shortly after initial room edits (1.5s), every 30 seconds of active editing, and when the tab is hidden (`visibilitychange`) to support server restarts and late-joiners. |
| **FR-6** | **Late Joiner Catch-up** | When a client joins an active session, the relay server streams room expiration metadata (`room_meta`), the latest encrypted Firestore snapshot (`0x02`), and any uncommitted in-memory deltas (`0x01`) to restore the exact state. |
| **FR-7** | **24-Hour Expiration** | Rooms must store an `expiresAt` timestamp set to `createdAt + 24 hours`. Active connections to expired rooms are rejected (`4004`), and Firestore's native TTL worker deletes expired records automatically. |
| **FR-8** | **Session Toolbar** | The interface must include a persistent header with: branding, manual 13-language syntax selector (including Kotlin, TypeScript, Python, Go, Java, Rust, SQL, etc.), remaining session validity countdown timer, connection status badge (Connected / Reconnecting), and a "Copy Encrypted Link" button. |

---

### 5. Non-Functional Requirements

- **Latency:** Round-trip keystroke latency under 50ms across standard broadband connections.
- **Concurrency & UI Performance:** Support 100 concurrent WebSocket connections per room while maintaining a 60fps responsive typing experience in CodeMirror 6.
- **Bandwidth Optimization:** Eliminating cursor coordinate tracking limits network consumption strictly to active keystroke deltas ($< 5\text{ KB/s}$ per typist).
- **Security:** Zero plaintext storage or server-side parsing. Encryption uses Web Crypto API (`AES-GCM-256`) with a cryptographically random 12-byte initialization vector (IV) per frame.
- **Reliability & Hosting:** 100% Google Cloud Platform (Firebase Hosting for static frontend, Cloud Run for containerized WebSocket relay, Firestore for snapshot persistence and TTL).

---

### 6. User Interface & Layout Guidelines

- **Header / Utility Bar:**
  - Left: Logo / Branding ("CodeMirror") and a manual 13-language syntax highlighting dropdown (TypeScript, JavaScript, Kotlin, Python, Go, Java, Rust, SQL, JSON, HTML, CSS, Markdown, Plain Text).
  - Center: Countdown timer display (`Expires in: 23h 48m`).
  - Right: Live connection indicator (green dot for "Connected", amber for "Reconnecting") and a primary action button ("Copy Encrypted Link").
- **Main Viewport:**
  - Full-width, full-height desktop-first code editor.
  - Dark mode default (neutral slate/zinc theme).
  - High-contrast monospace font (`JetBrains Mono`, `Fira Code`, or native monospace stack).
  - Standard editor features: line numbering, active line highlight, automatic bracket closing, tab indentation (2 spaces).