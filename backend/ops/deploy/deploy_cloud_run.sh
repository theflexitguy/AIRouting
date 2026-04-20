#!/usr/bin/env bash
# Deploy RouteIQ Python backend to Google Cloud Run.
#
# Prerequisites (one-time):
#   1. brew install --cask google-cloud-sdk
#   2. gcloud auth login
#   3. gcloud config set project <YOUR_PROJECT_ID>
#   4. gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
#        artifactregistry.googleapis.com
#
# Usage:
#   cd backend && bash ops/deploy/deploy_cloud_run.sh
#
# Outputs the public Cloud Run URL at the end — paste it into Vercel as
# BACKEND_URL (Production + Preview + Development).

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-routeiq-backend}"
REGION="${REGION:-us-central1}"
MEMORY="${MEMORY:-2Gi}"
CPU="${CPU:-2}"
TIMEOUT="${TIMEOUT:-300}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-5}"
CONCURRENCY="${CONCURRENCY:-40}"

PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "ERROR: no GCP project set. Run: gcloud config set project <id>" >&2
  exit 1
fi

IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:$(date +%Y%m%d-%H%M%S)"

echo "==> Building image ${IMAGE} via Cloud Build (no local Docker needed)"
gcloud builds submit --tag "${IMAGE}" --timeout=1200s

echo "==> Deploying ${SERVICE_NAME} to Cloud Run (${REGION})"
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --allow-unauthenticated \
  --memory="${MEMORY}" \
  --cpu="${CPU}" \
  --timeout="${TIMEOUT}" \
  --min-instances="${MIN_INSTANCES}" \
  --max-instances="${MAX_INSTANCES}" \
  --concurrency="${CONCURRENCY}" \
  --port=8080

URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" --format='value(status.url)')"

echo ""
echo "==> Deployed: ${URL}"
echo ""
echo "Next steps:"
echo "  1. Set secrets/env vars (once):"
echo "     gcloud run services update ${SERVICE_NAME} --region=${REGION} \\"
echo "       --set-env-vars GOOGLE_MAPS_API_KEY=<key>,FIREBASE_SERVICE_ACCOUNT='<minified-json>',ROUTEIQ_ALLOWED_ORIGINS=https://<your-vercel-domain>,FR_AUTH_ENABLED=false"
echo ""
echo "     Prefer Secret Manager for FIREBASE_SERVICE_ACCOUNT and GOOGLE_MAPS_API_KEY:"
echo "       printf '%s' '<minified-json>' | gcloud secrets create firebase-sa --data-file=-"
echo "       gcloud run services update ${SERVICE_NAME} --region=${REGION} \\"
echo "         --update-secrets FIREBASE_SERVICE_ACCOUNT=firebase-sa:latest"
echo ""
echo "  2. Add BACKEND_URL=${URL} to Vercel (Production + Preview + Development)."
echo ""
echo "  3. Redeploy Vercel so Next.js picks up BACKEND_URL."
