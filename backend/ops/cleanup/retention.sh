#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${1:-/data}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"
RUNS_DIR="${DATA_ROOT}/runs"
REGISTRY_FILE="${DATA_ROOT}/run_registry.json"

if [[ ! -d "${RUNS_DIR}" ]]; then
  echo "Runs dir not found: ${RUNS_DIR}"
  exit 0
fi

echo "Pruning run directories older than ${RETENTION_DAYS} day(s) from ${RUNS_DIR} ..."
find "${RUNS_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +"${RETENTION_DAYS}" -print -exec rm -rf {} +

if [[ -f "${REGISTRY_FILE}" ]]; then
  echo "Pruning registry entries in ${REGISTRY_FILE} ..."
  REGISTRY_FILE="${REGISTRY_FILE}" RUNS_DIR="${RUNS_DIR}" RETENTION_DAYS="${RETENTION_DAYS}" python3 - <<'PY'
import json
import os
from pathlib import Path
from datetime import datetime, timedelta

registry = Path(os.environ["REGISTRY_FILE"])
runs_dir = Path(os.environ["RUNS_DIR"])
retention_days = int(os.environ["RETENTION_DAYS"])
cutoff = datetime.utcnow() - timedelta(days=retention_days)

try:
    data = json.loads(registry.read_text(encoding='utf-8'))
except Exception:
    print('Registry unreadable; skipping')
    raise SystemExit(0)

runs = data.get('runs', []) if isinstance(data, dict) else []
out = []
for item in runs:
    run_id = str(item.get('runId', '')).strip()
    if not run_id:
        continue
    run_path = runs_dir / run_id
    if not run_path.exists():
        continue
    updated = str(item.get('updatedAt') or item.get('createdAt') or '')
    keep = True
    if updated.endswith('Z'):
        updated = updated[:-1]
    try:
        dt = datetime.fromisoformat(updated) if updated else None
    except Exception:
        dt = None
    if dt is not None and dt < cutoff:
        keep = False
    if keep:
        out.append(item)

data['runs'] = out
registry.write_text(json.dumps(data), encoding='utf-8')
print(f'Kept {len(out)} run registry entries')
PY
fi

echo "Retention cleanup complete."
