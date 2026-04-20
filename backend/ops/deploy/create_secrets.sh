#!/usr/bin/env bash
# Create Secret Manager secrets for FIREBASE_SERVICE_ACCOUNT and Google Maps key,
# reading values from ../../.env.local. Safe with multi-line JSON and quoted values.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/Users/jalenbrown/Projects/AIRouting/.env.local}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found." >&2
  exit 1
fi

# Python does the safe parse (handles quotes, JSON, spaces).
read_env_var() {
  local key="$1"
  python3 - <<PY
import os, re, sys
text = open("${ENV_FILE}").read()
for line in text.splitlines():
    if line.startswith("${key}="):
        val = line[len("${key}=") :]
        # Strip matching outer quotes if any.
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        sys.stdout.write(val)
        break
PY
}

create_or_update_secret() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    echo "SKIP: ${name} value empty."
    return
  fi
  if gcloud secrets describe "${name}" >/dev/null 2>&1; then
    echo "==> ${name} exists — adding new version"
    printf '%s' "${value}" | gcloud secrets versions add "${name}" --data-file=-
  else
    echo "==> Creating ${name}"
    printf '%s' "${value}" | gcloud secrets create "${name}" \
      --data-file=- \
      --replication-policy=automatic
  fi
}

FIREBASE_SA_VALUE="$(read_env_var FIREBASE_SERVICE_ACCOUNT)"
MAPS_KEY_VALUE="$(read_env_var NEXT_PUBLIC_GOOGLE_MAPS_API_KEY)"

create_or_update_secret firebase-sa "${FIREBASE_SA_VALUE}"
create_or_update_secret google-maps-key "${MAPS_KEY_VALUE}"

echo ""
echo "Done. Now run grant_secret_access.sh, then configure_env.sh."
