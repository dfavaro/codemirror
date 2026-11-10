# CodeMirror (GCP Edition)

**A Disposable, Zero-Knowledge Technical Interview & Code Pad**

[![Try Now](https://img.shields.io/badge/%F0%9F%9A%80_Try_Now-Live_Demo-10b981?style=for-the-badge)](https://codemirror-9c8e3.web.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-zinc?style=for-the-badge)](#license)
[![Encryption: AES-GCM-256](https://img.shields.io/badge/E2EE-AES--GCM--256-059669?style=for-the-badge)](#2-how-the-zero-knowledge-flow-works)

👉 **[Try Now — Open Live App (`https://codemirror-9c8e3.web.app`)](https://codemirror-9c8e3.web.app)**

---

## Overview

**CodeMirror (GCP Edition)** is an open-source, self-deployable, real-time collaborative code pad designed for technical interviews, pair programming assessments, and live screening rounds.

- **Zero Registration:** No accounts, logins, cookies, or tracking.
- **Zero-Knowledge End-to-End Encryption (`AES-GCM-256`):** Every keystroke and document snapshot is encrypted in the browser before transmission. The decryption key lives strictly in `window.location.hash` (`#...`) and never touches Google Cloud or Firebase.
- **Sub-50ms CRDT Sync & High Fanout:** Powered by **CodeMirror 6** and **Yjs**, supporting up to 100 concurrent participants per room without remote-cursor network bloat.
- **13 Built-In Languages (Synced Encrypted):** TypeScript, JavaScript, **Kotlin**, Python, Go, Java, Rust, SQL, JSON, HTML, CSS, Markdown, and Plain Text.
- **24-Hour Auto-Destruct:** Encrypted snapshots expire and permanently purge 24 hours after room creation via Cloud Firestore's native TTL engine.

---

## 1. What Lives Where (Architecture Map)

The project uses 3 serverless services inside a single Google Cloud / Firebase project:

| Service | Where to find it in Console | What it does | Local Code |
| :--- | :--- | :--- | :--- |
| **1. Firebase Hosting** | Firebase Console → Hosting | Serves the static frontend SPA (`index.html`, JS/CSS bundles) over a global CDN with automatic SSL. | `client/` & `firebase.json` |
| **2. Google Cloud Run** (`codemirror-relay`) | GCP Console → Cloud Run | Runs the containerized Node.js WebSocket server (`ws`). Relays encrypted binary frames (`0x01` deltas) between peers in memory and writes encrypted snapshots (`0x02`) to Firestore. Scales to `0` when nobody is connected. | `server/server.js` & `server/Dockerfile` |
| **3. Cloud Firestore** (Native mode + TTL) | Firebase Console → Firestore | Stores `/rooms/{roomId}` documents containing `createdAt`, `expiresAt` (`+24h`), and `snapshot` (encrypted binary blob). Firestore's native **TTL policy** on `expiresAt` automatically deletes expired rooms. | Accessed by `server/server.js` |

---

## 2. How the Zero-Knowledge Flow Works

1. **Key Generation (`client/src/crypto.ts`)**:
   - Clicking **"New Session"** generates a random UUIDv4 `roomId` and a 256-bit `AES-GCM` key in the browser via `window.crypto.subtle`.
   - The key is placed in the URL fragment: `/room/<roomId>#<base64JwkKey>`.
   - Per RFC 3986, browsers never send `#hash` fragments over HTTP or WebSocket requests, so neither Firebase Hosting nor Cloud Run ever sees the key.
2. **Real-Time Sync (`client/src/provider.ts` & `client/src/editor.ts`)**:
   - Keystrokes update a local Yjs CRDT (`Y.Text("codemirror")`), and language changes update `Y.Map("meta")`.
   - Every update is encrypted locally with a fresh 12-byte random IV (`AES-GCM-256`) and sent as a binary WebSocket frame (`0x01` prefix) to Cloud Run.
   - Cloud Run broadcasts the opaque bytes to all other connected peers in that `roomId` and buffers recent deltas in memory since the last snapshot.
3. **Snapshots & 24-Hour Auto-Destruct (`server/server.js`)**:
   - 1.5s after initial edits, every **30 seconds** of active typing, and when the tab is hidden, the client sends an encrypted full Yjs state snapshot (`0x02` prefix).
   - Cloud Run saves this encrypted blob to Firestore `/rooms/{roomId}` with `expiresAt = createdAt + 24h`.
   - Late joiners receive the latest snapshot + any uncommitted deltas since that snapshot. After 24 hours, Firestore's TTL worker permanently purges the document.

---

## 3. Local Development & Testing (Zero Cloud Config Required)

The relay server includes an automatic in-memory store fallback (`USE_IN_MEMORY_STORE=true`), so you can run and test the entire stack offline without a Google Cloud account:

```bash
# 1. Install all dependencies (both server/ and client/)
npm run install:all

# 2. Run automated unit & multi-peer E2E encrypted sync tests
npm test

# 3. Start the local WebSocket relay on :8080 (Terminal 1)
USE_IN_MEMORY_STORE=true npm run dev:server

# 4. Start the Vite frontend on http://localhost:5173 (Terminal 2)
npm run dev:client
```

---

## 4. Self-Hosting Guide (Deploy Your Own Instance on GCP & Firebase)

You can deploy your own private or public instance of **CodeMirror (GCP Edition)** to any Google Cloud / Firebase project in ~5 minutes.

### Prerequisites
- [Node.js 20+](https://nodejs.org/)
- [Google Cloud SDK (`gcloud`)](https://cloud.google.com/sdk/docs/install)
- [Firebase CLI (`firebase-tools`)](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`)

### Step 1: Create a Firebase / GCP Project & Firestore Database
1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a new project (e.g. `my-codemirror-pad`).
2. Upgrade the project to the **Blaze (pay-as-you-go)** plan (required by Cloud Run; idle cost is **$0** because `--min-instances=0`).
3. In **Build → Firestore Database**, click **Create database**, select **Standard edition (Native mode)**, and choose your preferred region (e.g. `europe-west1` or `us-central1`).

### Step 2: Authenticate Your CLI
```bash
gcloud auth login
firebase login
```

### Step 3: One-Command Automated Deployment
Run the included deployment script with your `PROJECT_ID` and Cloud Run `REGION`:

```bash
PROJECT_ID="your-gcp-project-id" REGION="europe-west1" npm run deploy:gcp
```

What `scripts/deploy-gcp.sh` does automatically:
1. Sets the active `gcloud` project to `PROJECT_ID`.
2. Enables required Google Cloud APIs (`run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`, `firestore.googleapis.com`).
3. Configures the **Firestore Native TTL policy** on collection group `rooms`, field `expiresAt`.
4. Builds and deploys the `codemirror-relay` container to **Google Cloud Run** (`--session-affinity`, `--timeout=3600`, `--min-instances=0`, `--max-instances=5`).
5. Compiles the production Vite bundle (`client/dist`) wired to your Cloud Run `wss://` relay endpoint.
6. Deploys the static bundle to **Firebase Hosting** (`https://<your-gcp-project-id>.web.app`).

---

## 5. Day-to-Day Maintenance & Operations

### Deploying Updates
- **Full Deploy (Backend + Frontend):**
  ```bash
  PROJECT_ID="your-gcp-project-id" REGION="europe-west1" npm run deploy:gcp
  ```
- **Frontend-Only Change (UI / Editor changes in `client/`):**
  ```bash
  export PROJECT_ID="your-gcp-project-id"
  export REGION="europe-west1"
  VITE_WS_RELAY_URL="$(gcloud run services describe codemirror-relay --region=$REGION --project=$PROJECT_ID --format='value(status.url)' | sed 's|^https://|wss://|')/ws" npm run build
  firebase deploy --only hosting --project "$PROJECT_ID"
  ```

### Viewing Logs & Debugging
- **Cloud Run Relay Logs:**
  ```bash
  gcloud run services logs read codemirror-relay --region=europe-west1 --project=your-gcp-project-id --limit=50
  ```
- **Check Relay Health Endpoint:**
  ```bash
  curl "$(gcloud run services describe codemirror-relay --region=europe-west1 --project=your-gcp-project-id --format='value(status.url)')/healthz"
  ```

### Cost & Scaling Controls
- **Cloud Run (`codemirror-relay`)** runs with `--min-instances=0` and `--max-instances=5` (`1 CPU`, `512Mi RAM`). When no interview session is active, it scales to **0 instances** ($0 idle compute cost).
- **Firestore** stores 1 document per active room (`rooms/{roomId}`), updated at most every 30 seconds during active typing, and automatically deleted after 24 hours via TTL—staying well within the free tier.
- **Billing Alerts:** In [GCP Console → Billing → Budgets & alerts](https://console.cloud.google.com/billing), set a small monthly budget alert (e.g. €5) for peace of mind.

---

## 6. Contributing & AI Agents

See **[`AGENTS.md`](./AGENTS.md)** for architectural rules, TypeScript/Node.js conventions, and zero-knowledge cryptographic invariants before submitting changes.

## License

MIT

