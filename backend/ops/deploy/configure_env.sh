#!/usr/bin/env bash
# Attach Secret Manager secrets and env vars to the Cloud Run service.
# Run once after initial deploy, and again whenever secrets rotate.

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-routeiq-backend}"
REGION="${REGION:-us-central1}"
VERCEL_ORIGIN="${VERCEL_ORIGIN:-https://ai-routing-phi.vercel.app}"

gcloud run services update "${SERVICE_NAME}" \
  --region="${REGION}" \
  --update-secrets=FIREBASE_SERVICE_ACCOUNT=firebase-sa:latest,GOOGLE_MAPS_API_KEY=google-maps-key:latest \
  --set-env-vars=ROUTEIQ_ALLOWED_ORIGINS="${VERCEL_ORIGIN}",FR_AUTH_ENABLED=false

echo ""
echo "==> Done. Service now has FIREBASE_SERVICE_ACCOUNT + GOOGLE_MAPS_API_KEY from Secret Manager,"
echo "    plus ROUTEIQ_ALLOWED_ORIGINS=${VERCEL_ORIGIN} and FR_AUTH_ENABLED=false."
