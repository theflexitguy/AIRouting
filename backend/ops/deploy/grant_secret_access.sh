#!/usr/bin/env bash
# Grant the Cloud Run runtime service account access to the two secrets.
set -euo pipefail

PROJECT_NUMBER=$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')
SA="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
ROLE="roles/secretmanager.secretAccessor"

for SECRET in firebase-sa google-maps-key; do
  echo "==> Granting ${ROLE} on ${SECRET} to ${SA}"
  gcloud secrets add-iam-policy-binding "${SECRET}" --member="${SA}" --role="${ROLE}"
done

echo "Done."
