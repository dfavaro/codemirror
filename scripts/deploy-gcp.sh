#!/usr/bin/env bash
set -euo pipefail

# CodeMirror (GCP Edition) — Guided Deployment Helper Script
# Usage:
#   PROJECT_ID="your-gcp-project-id" REGION="us-central1" bash scripts/deploy-gcp.sh

PROJECT_ID="${PROJECT_ID:-codemirror-9c8e3}"
REGION="${REGION:-europe-west1}"
SERVICE_NAME="${SERVICE_NAME:-codemirror-relay}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: PROJECT_ID is required."
  echo "Usage: PROJECT_ID=your-gcp-project-id REGION=us-central1 bash scripts/deploy-gcp.sh"
  exit 1
fi

echo "==> 1. Setting active GCP project to: ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"

echo "==> 2. Enabling required Google Cloud APIs (Cloud Run, Cloud Build, Artifact Registry, Firestore)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com

echo "==> 3. Checking Firestore Native TTL policy on collection 'rooms' field 'expiresAt'"
TTL_STATE="$(gcloud firestore fields describe expiresAt --collection-group=rooms --format='value(ttlConfig.state)' 2>/dev/null || true)"
if [[ "$TTL_STATE" == "ACTIVE" || "$TTL_STATE" == "CREATING" ]]; then
  echo "Firestore TTL on rooms.expiresAt is already ${TTL_STATE}."
else
  gcloud firestore fields ttls update expiresAt \
    --collection-group=rooms \
    --enable-ttl \
    --async || echo "Note: TTL policy update is initializing in the background."
fi

echo "==> 4. Deploying WebSocket relay (${SERVICE_NAME}) to Cloud Run (${REGION})"
gcloud run deploy "${SERVICE_NAME}" \
  --source=./server \
  --platform=managed \
  --region="${REGION}" \
  --allow-unauthenticated \
  --timeout=3600 \
  --session-affinity \
  --min-instances=0 \
  --max-instances=5 \
  --cpu=1 \
  --memory=512Mi \
  --quiet

RELAY_HTTP_URL="$(gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" --format='value(status.url)')"
RELAY_WSS_URL="wss://${RELAY_HTTP_URL#https://}/ws"
echo "==> Cloud Run Relay URL: ${RELAY_WSS_URL}"

echo "==> 5. Building frontend client with VITE_WS_RELAY_URL=${RELAY_WSS_URL}"
printf "VITE_WS_RELAY_URL=%s\n" "${RELAY_WSS_URL}" > client/.env.production
VITE_WS_RELAY_URL="${RELAY_WSS_URL}" npm run build --prefix client

echo "==> 6. Deploying static SPA bundle to Firebase Hosting"
firebase deploy --only hosting --project "${PROJECT_ID}" --non-interactive

echo "==> Deployment complete!"
