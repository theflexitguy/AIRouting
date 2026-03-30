#!/usr/bin/env bash
set -euo pipefail

# One-command internal rollout for Flex Routing.
#
# Required env:
#   VM_HOST               e.g. 10.0.0.25 or routing-vm.internal
# Optional env:
#   VM_USER               default: ubuntu
#   VM_SSH_PORT           default: 22
#   VM_APP_DIR            default: /opt/flex-routing
#   BUILD_OSRM            default: 1 (set 0 to skip region build)
#   REMOTE_RETENTION_DAYS default: 90
#
# Local prerequisites:
#   ssh, rsync
#   .env configured in repo root (FR_SHARED_PASSWORD must not be "change-me")

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VM_HOST="${VM_HOST:-}"
VM_USER="${VM_USER:-ubuntu}"
VM_SSH_PORT="${VM_SSH_PORT:-22}"
VM_APP_DIR="${VM_APP_DIR:-/home/${VM_USER}/flex-routing}"
BUILD_OSRM="${BUILD_OSRM:-1}"
REMOTE_RETENTION_DAYS="${REMOTE_RETENTION_DAYS:-90}"

if [[ -z "$VM_HOST" ]]; then
  echo "ERROR: VM_HOST is required."
  echo "Example: VM_HOST=10.0.0.25 VM_USER=ubuntu $0"
  exit 1
fi

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "ERROR: $ROOT_DIR/.env not found. Copy .env.example to .env and fill values first."
  exit 1
fi

if grep -Eq '^FR_SHARED_PASSWORD=change-me$' "$ROOT_DIR/.env"; then
  echo "ERROR: FR_SHARED_PASSWORD is still set to change-me in .env"
  exit 1
fi

for cmd in ssh rsync; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $cmd"
    exit 1
  fi
done

SSH_TARGET="${VM_USER}@${VM_HOST}"
SSH_CMD=(
  ssh
  -p "$VM_SSH_PORT"
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=10
  "$SSH_TARGET"
)

echo "[1/4] Checking SSH connectivity..."
"${SSH_CMD[@]}" "echo connected >/dev/null"

echo "[2/4] Preparing remote directory..."
"${SSH_CMD[@]}" "mkdir -p '$VM_APP_DIR'"

echo "[3/4] Syncing project files..."
rsync -az --delete \
  --exclude '.git/' \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude 'data/' \
  --exclude 'routing_plan.csv' \
  --exclude 'routing_plan.edited.csv' \
  --exclude 'route_preview.html' \
  --exclude 'route_preview.edited.html' \
  --exclude 'uploaded.csv' \
  -e "ssh -p $VM_SSH_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10" \
  "$ROOT_DIR/" "$SSH_TARGET:$VM_APP_DIR/"

echo "[4/4] Starting services on VM..."
"${SSH_CMD[@]}" "bash -lc '
  set -euo pipefail
  cd \"$VM_APP_DIR\"
  SUDO=\"\"
  if command -v sudo >/dev/null 2>&1; then
    SUDO=\"sudo\"
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo \"ERROR: docker is not installed on VM\"
    exit 1
  fi
  DOCKER_USE_SUDO=0
  if ! docker info >/dev/null 2>&1; then
    if [[ -n \"\$SUDO\" ]] && \$SUDO docker info >/dev/null 2>&1; then
      DOCKER_USE_SUDO=1
    else
      echo \"ERROR: docker is installed but not usable by \$USER (and sudo fallback failed)\"
      exit 1
    fi
  fi
  if [[ \"\$DOCKER_USE_SUDO\" == \"1\" ]]; then
    if ! \$SUDO docker compose version >/dev/null 2>&1; then
      echo \"ERROR: docker compose plugin is not installed on VM\"
      exit 1
    fi
  else
    if ! docker compose version >/dev/null 2>&1; then
      echo \"ERROR: docker compose plugin is not installed on VM\"
      exit 1
    fi
  fi

  if ! command -v osmium >/dev/null 2>&1; then
    if [[ -n \"\$SUDO\" ]]; then
      \$SUDO apt-get update -y
      \$SUDO apt-get install -y osmium-tool
    else
      apt-get update -y
      apt-get install -y osmium-tool
    fi
  fi

  MEM_MB=\$(awk \"/MemTotal/ {print int(\\\$2/1024)}\" /proc/meminfo)
  if [[ \"\$MEM_MB\" -lt \"12000\" ]]; then
    if ! swapon --show | grep -q .; then
      echo \"Low RAM detected (\${MEM_MB}MB). Creating swap file for OSRM preprocessing...\"
      if [[ -n \"\$SUDO\" ]]; then
        \$SUDO fallocate -l 16G /swapfile || \$SUDO dd if=/dev/zero of=/swapfile bs=1M count=16384 status=progress
        \$SUDO chmod 600 /swapfile
        \$SUDO mkswap /swapfile >/dev/null
        \$SUDO swapon /swapfile
        if ! \$SUDO grep -q \"^/swapfile \" /etc/fstab; then
          echo \"/swapfile none swap sw 0 0\" | \$SUDO tee -a /etc/fstab >/dev/null
        fi
      else
        fallocate -l 16G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=16384 status=progress
        chmod 600 /swapfile
        mkswap /swapfile >/dev/null
        swapon /swapfile
      fi
    fi
  fi

  mkdir -p data/osrm data/cache/osrm_matrix data/runs
  chmod +x ops/osrm/build-region.sh ops/cleanup/retention.sh || true

  if [[ \"$BUILD_OSRM\" == \"1\" ]]; then
    DOCKER_USE_SUDO=\"\$DOCKER_USE_SUDO\" ./ops/osrm/build-region.sh ./data/osrm region
  fi

  if [[ \"\$DOCKER_USE_SUDO\" == \"1\" ]]; then
    \$SUDO docker compose up -d --build
  else
    docker compose up -d --build
  fi

  set +e
  READY=0
  HOST_HDR=\$(awk -F= \"/^INTERNAL_HOST=/{print \\\$2}\" .env | tail -n1)
  if [[ -z \"\$HOST_HDR\" ]]; then
    HOST_HDR=localhost
  fi
  for _ in \$(seq 1 60); do
    if curl -fsS -H \"Host: \$HOST_HDR\" http://127.0.0.1/healthz >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 2
  done
  set -e
  if [[ \"\$READY\" != \"1\" ]]; then
    echo \"WARNING: app did not pass local health check yet. Check: docker compose logs app --tail=200\"
  fi

  CRON_LINE=\"30 2 * * * RETENTION_DAYS=$REMOTE_RETENTION_DAYS $VM_APP_DIR/ops/cleanup/retention.sh /data >/tmp/flex-routing-retention.log 2>&1\"
  (crontab -l 2>/dev/null | grep -v \"ops/cleanup/retention.sh\" || true; echo \"\$CRON_LINE\") | crontab -

  echo \"Deployment complete.\"
  echo \"Health: http://127.0.0.1:8000/healthz\"
  echo \"Ready:  http://127.0.0.1:8000/readyz\"
'"

echo "Done. Next:"
echo "  1) Ensure internal DNS points to VM and TLS is reachable at your INTERNAL_HOST."
echo "  2) Open https://<INTERNAL_HOST> and sign in with FR_SHARED_USERNAME / FR_SHARED_PASSWORD."
