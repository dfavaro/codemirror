# CodeMirror

Disposable, end-to-end encrypted (`AES-GCM-256`) collaborative code pad.

**[Try Now](https://codemirror-9c8e3.web.app)**

## Stack

- **Client (`client/`)**: TypeScript, Vite, CodeMirror 6, Yjs CRDT, Web Crypto API (`AES-GCM-256` key in URL `#hash`), Tailwind CSS.
- **Relay (`server/`)**: Node.js (`ws`) binary WebSocket relay on Google Cloud Run + encrypted 24h TTL snapshots in Cloud Firestore.
- **Hosting**: Firebase Hosting.

## Local Development

Runs offline using an in-memory store fallback (no GCP account required):

```bash
npm run install:all
npm test

# Terminal 1: WebSocket relay (:8080)
USE_IN_MEMORY_STORE=true npm run dev:server

# Terminal 2: Vite client (http://localhost:5173)
npm run dev:client
```

## Deployment (GCP & Firebase)

### Prerequisites
1. Create a Firebase / GCP project on the Blaze plan.
2. Create a Cloud Firestore database in **Native mode**.

### Manual Deploy
```bash
gcloud auth login
firebase login
PROJECT_ID="your-gcp-project-id" REGION="europe-west1" npm run deploy:gcp
```

### GitHub Actions (Auto-Deploy on Push to `main`)
`.github/workflows/deploy.yml` runs tests and executes `scripts/deploy-gcp.sh` on every push to `main`. Configure in **Settings → Secrets and variables → Actions**:

- **Secrets**:
  - `GCP_SA_KEY`: GCP Service Account JSON key with roles:
    - `roles/run.admin` (Cloud Run Admin)
    - `roles/iam.serviceAccountUser` (Service Account User)
    - `roles/cloudbuild.builds.editor` (Cloud Build Editor)
    - `roles/artifactregistry.writer` (Artifact Registry Writer)
    - `roles/datastore.indexAdmin` (Datastore Index Admin — for Firestore TTL)
    - `roles/serviceusage.serviceUsageAdmin` (Service Usage Admin)
    - `roles/firebasehosting.admin` (Firebase Hosting Admin)
- **Variables** (optional, defaults to `codemirror-9c8e3` / `europe-west1`):
  - `GCP_PROJECT_ID`: Your GCP/Firebase project ID
  - `GCP_REGION`: Cloud Run region (e.g. `europe-west1`)

## License

[Apache-2.0](./LICENSE) — requires preserving copyright and [`NOTICE`](./NOTICE) attribution in redistributions and derivative works.

