#!/usr/bin/env bash
set -euo pipefail

# Convenience wrapper for one-day sandbox pilot.
# Usage:
#   ./scripts/run_fieldroutes_pilot.sh <run-id> [dry-run|apply] [YYYY-MM-DD]

RUN_ID="${1:-}"
MODE="${2:-dry-run}"
PILOT_DATE="${3:-2026-04-01}"

if [[ -z "${RUN_ID}" ]]; then
  echo "Usage: ./scripts/run_fieldroutes_pilot.sh <run-id> [dry-run|apply] [YYYY-MM-DD]" >&2
  exit 2
fi

if [[ "${MODE}" != "dry-run" && "${MODE}" != "apply" ]]; then
  echo "Mode must be 'dry-run' or 'apply'." >&2
  exit 2
fi

if docker compose ps app >/dev/null 2>&1; then
  CMD=(docker compose exec -T app python scripts/push_fieldroutes.py --run-id "${RUN_ID}" --edited --date "${PILOT_DATE}")
else
  CMD=(python3 scripts/push_fieldroutes.py --run-id "${RUN_ID}" --edited --date "${PILOT_DATE}")
fi
if [[ "${MODE}" == "apply" ]]; then
  CMD+=(--apply)
else
  CMD+=(--dry-run)
fi

echo "Running: ${CMD[*]}"
"${CMD[@]}"
