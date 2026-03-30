#!/usr/bin/env bash
set -euo pipefail

# Provisions an always-on AWS EC2 host, then deploys Flex Routing to it.
#
# Prereqs:
#   - AWS credentials already configured (aws sts get-caller-identity must work)
#   - Local SSH public key at ~/.ssh/id_ed25519.pub (default)
#   - Project .env present
#
# Optional env:
#   AWS_REGION                 default from aws config, else us-east-1
#   INSTANCE_NAME              default flex-routing-prod
#   INSTANCE_TYPE              default c6i.2xlarge
#   INSTANCE_TYPE_FALLBACK     default m6i.2xlarge
#   ROOT_DISK_GB               default 200
#   KEY_NAME                   default flex-routing-mac-key
#   SSH_PUBKEY_PATH            default ~/.ssh/id_ed25519.pub
#   ADMIN_CIDR                 default current public IP/32
#   TEAM_HTTPS_CIDR            default current public IP/32
#   SECURITY_GROUP_NAME        default flex-routing-sg
#   SUBNET_ID                  optional override subnet
#   BUILD_OSRM                 default 1
#   REMOTE_RETENTION_DAYS      default 90
#   VM_USER                    default ubuntu

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
AWS_BIN="${AWS_BIN:-}"
if [[ -z "$AWS_BIN" ]]; then
  if command -v aws >/dev/null 2>&1; then
    AWS_BIN="$(command -v aws)"
  elif [[ -x "$ROOT_DIR/.venv/bin/aws" ]]; then
    AWS_BIN="$ROOT_DIR/.venv/bin/aws"
  else
    echo "ERROR: AWS CLI not found. Install it or run: . .venv/bin/activate && pip install awscli"
    exit 1
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE"
  exit 1
fi

if [[ ! -f "${SSH_PUBKEY_PATH:-$HOME/.ssh/id_ed25519.pub}" ]]; then
  echo "ERROR: SSH public key not found at ${SSH_PUBKEY_PATH:-$HOME/.ssh/id_ed25519.pub}"
  exit 1
fi

awsq() {
  "$AWS_BIN" "$@"
}

set_env_key() {
  local key="$1"
  local value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
import pathlib, sys
env_path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = []
found = False
for raw in env_path.read_text(encoding="utf-8").splitlines():
    if raw.startswith(f"{key}="):
        lines.append(f"{key}={value}")
        found = True
    else:
        lines.append(raw)
if not found:
    lines.append(f"{key}={value}")
env_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
PY
}

random_password() {
  python3 - <<'PY'
import secrets, string
alphabet = string.ascii_letters + string.digits
print("fr-" + "".join(secrets.choice(alphabet) for _ in range(24)))
PY
}

AWS_REGION="${AWS_REGION:-$(awsq configure get region 2>/dev/null || true)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
INSTANCE_NAME="${INSTANCE_NAME:-flex-routing-prod}"
INSTANCE_TYPE="${INSTANCE_TYPE:-c6i.2xlarge}"
INSTANCE_TYPE_FALLBACK="${INSTANCE_TYPE_FALLBACK:-m6i.2xlarge}"
ROOT_DISK_GB="${ROOT_DISK_GB:-200}"
KEY_NAME="${KEY_NAME:-flex-routing-mac-key}"
SSH_PUBKEY_PATH="${SSH_PUBKEY_PATH:-$HOME/.ssh/id_ed25519.pub}"
SECURITY_GROUP_NAME="${SECURITY_GROUP_NAME:-flex-routing-sg}"
SUBNET_ID_OVERRIDE="${SUBNET_ID:-}"
BUILD_OSRM="${BUILD_OSRM:-1}"
REMOTE_RETENTION_DAYS="${REMOTE_RETENTION_DAYS:-90}"
VM_USER="${VM_USER:-ubuntu}"

echo "[0/8] Checking AWS credentials..."
awsq sts get-caller-identity --region "$AWS_REGION" >/dev/null

CURRENT_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '\r\n' || true)"
if [[ -z "$CURRENT_IP" ]]; then
  echo "ERROR: Could not detect current public IP for security group rules."
  exit 1
fi
ADMIN_CIDR="${ADMIN_CIDR:-${CURRENT_IP}/32}"
TEAM_HTTPS_CIDR="${TEAM_HTTPS_CIDR:-${CURRENT_IP}/32}"

echo "[1/8] Resolving Ubuntu 24.04 AMI..."
AMI_ID="$(awsq ssm get-parameter \
  --region "$AWS_REGION" \
  --name "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id" \
  --query 'Parameter.Value' --output text)"
if [[ -z "$AMI_ID" || "$AMI_ID" == "None" ]]; then
  echo "ERROR: Failed to resolve Ubuntu 24.04 AMI in $AWS_REGION"
  exit 1
fi

echo "[2/8] Resolving default VPC/subnet..."
VPC_ID="$(awsq ec2 describe-vpcs \
  --region "$AWS_REGION" \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
if [[ -z "$VPC_ID" || "$VPC_ID" == "None" ]]; then
  echo "ERROR: No default VPC found in $AWS_REGION."
  echo "Create one default VPC or set up a VPC/subnet manually and I will wire that next."
  exit 1
fi

if [[ -n "$SUBNET_ID_OVERRIDE" ]]; then
  SUBNET_CANDIDATES="$SUBNET_ID_OVERRIDE"
else
  SUBNET_CANDIDATES="$(awsq ec2 describe-subnets \
    --region "$AWS_REGION" \
    --filters Name=vpc-id,Values="$VPC_ID" Name=map-public-ip-on-launch,Values=true \
    --query 'Subnets[].SubnetId' --output text | tr '\t' '\n' | sed '/^$/d')"
  if [[ -z "$SUBNET_CANDIDATES" ]]; then
    SUBNET_CANDIDATES="$(awsq ec2 describe-subnets \
      --region "$AWS_REGION" \
      --filters Name=vpc-id,Values="$VPC_ID" \
      --query 'Subnets[].SubnetId' --output text | tr '\t' '\n' | sed '/^$/d')"
  fi
fi
if [[ -z "$SUBNET_CANDIDATES" ]]; then
  echo "ERROR: No subnet found in default VPC $VPC_ID."
  exit 1
fi

echo "[3/8] Ensuring key pair exists..."
if ! awsq ec2 describe-key-pairs --region "$AWS_REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  awsq ec2 import-key-pair \
    --region "$AWS_REGION" \
    --key-name "$KEY_NAME" \
    --public-key-material "fileb://${SSH_PUBKEY_PATH}" >/dev/null
fi

echo "[4/8] Ensuring security group rules..."
SG_ID="$(awsq ec2 describe-security-groups \
  --region "$AWS_REGION" \
  --filters Name=vpc-id,Values="$VPC_ID" Name=group-name,Values="$SECURITY_GROUP_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text)"
if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
  SG_ID="$(awsq ec2 create-security-group \
    --region "$AWS_REGION" \
    --group-name "$SECURITY_GROUP_NAME" \
    --description "Flex Routing internal access" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)"
fi

awsq ec2 authorize-security-group-ingress \
  --region "$AWS_REGION" \
  --group-id "$SG_ID" \
  --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":22,\"ToPort\":22,\"IpRanges\":[{\"CidrIp\":\"$ADMIN_CIDR\",\"Description\":\"flex-routing-admin-ssh\"}]}]" >/dev/null 2>&1 || true

awsq ec2 authorize-security-group-ingress \
  --region "$AWS_REGION" \
  --group-id "$SG_ID" \
  --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":443,\"ToPort\":443,\"IpRanges\":[{\"CidrIp\":\"$TEAM_HTTPS_CIDR\",\"Description\":\"flex-routing-https\"}]}]" >/dev/null 2>&1 || true

awsq ec2 authorize-security-group-ingress \
  --region "$AWS_REGION" \
  --group-id "$SG_ID" \
  --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":80,\"ToPort\":80,\"IpRanges\":[{\"CidrIp\":\"$TEAM_HTTPS_CIDR\",\"Description\":\"flex-routing-http\"}]}]" >/dev/null 2>&1 || true

USER_DATA_FILE="$(mktemp)"
trap 'rm -f "$USER_DATA_FILE"' EXIT
cat > "$USER_DATA_FILE" <<'UD'
#!/bin/bash
set -eux
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release rsync cron
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable docker
systemctl start docker
UD

launch_instance() {
  local itype="$1"
  local subnet_id="$2"
  awsq ec2 run-instances \
    --region "$AWS_REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$itype" \
    --key-name "$KEY_NAME" \
    --network-interfaces "AssociatePublicIpAddress=true,DeviceIndex=0,SubnetId=${subnet_id},Groups=${SG_ID}" \
    --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${ROOT_DISK_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --user-data "file://$USER_DATA_FILE" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}}]" \
    --query 'Instances[0].InstanceId' --output text
}

echo "[5/8] Launching EC2 instance..."
INSTANCE_ID=""
LAUNCH_LOG=""
for itype in "$INSTANCE_TYPE" "$INSTANCE_TYPE_FALLBACK"; do
  while IFS= read -r subnet_id; do
    [[ -z "$subnet_id" ]] && continue
    if INSTANCE_ID="$(launch_instance "$itype" "$subnet_id" 2> >(cat > /tmp/fr-launch.err))"; then
      echo "Launched $itype in subnet $subnet_id"
      break 2
    fi
    LAST_ERR="$(cat /tmp/fr-launch.err 2>/dev/null || true)"
    LAUNCH_LOG+="\n[$itype @ $subnet_id] $LAST_ERR"
  done <<< "$SUBNET_CANDIDATES"
done
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "ERROR: EC2 launch failed."
  echo -e "Tried combinations:${LAUNCH_LOG}"
  exit 1
fi

echo "[6/8] Waiting for instance to be running + healthy..."
awsq ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
awsq ec2 wait instance-status-ok --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"

PUBLIC_IP="$(awsq ec2 describe-instances \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
PUBLIC_DNS="$(awsq ec2 describe-instances \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicDnsName' --output text)"
HOST_FOR_TLS="$PUBLIC_DNS"
if [[ -z "$HOST_FOR_TLS" || "$HOST_FOR_TLS" == "None" ]]; then
  HOST_FOR_TLS="$PUBLIC_IP"
fi

if [[ -z "$PUBLIC_IP" || "$PUBLIC_IP" == "None" ]]; then
  echo "ERROR: Could not determine public IP for instance $INSTANCE_ID"
  exit 1
fi

echo "[7/8] Preparing app .env for this host..."
FR_PASSWORD_CURRENT="$(rg -N '^FR_SHARED_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
if [[ -z "$FR_PASSWORD_CURRENT" || "$FR_PASSWORD_CURRENT" == "change-me" ]]; then
  NEW_PASS="$(random_password)"
  set_env_key "FR_SHARED_PASSWORD" "$NEW_PASS"
  echo "Generated FR_SHARED_PASSWORD and wrote it to $ENV_FILE"
fi
set_env_key "INTERNAL_HOST" "$HOST_FOR_TLS"
set_env_key "FR_ALLOWED_ORIGINS" "https://${HOST_FOR_TLS}"

echo "Waiting for SSH to become reachable..."
for _ in $(seq 1 40); do
  if ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "${VM_USER}@${PUBLIC_IP}" "echo ssh-ready >/dev/null" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

echo "[8/8] Deploying app stack..."
VM_HOST="$PUBLIC_IP" \
VM_USER="$VM_USER" \
VM_SSH_PORT=22 \
BUILD_OSRM="$BUILD_OSRM" \
REMOTE_RETENTION_DAYS="$REMOTE_RETENTION_DAYS" \
"$ROOT_DIR/ops/deploy/deploy_vm.sh"

echo
echo "Provision + deploy complete."
echo "Instance ID: $INSTANCE_ID"
echo "Region:      $AWS_REGION"
echo "Public IP:   $PUBLIC_IP"
echo "Public DNS:  $PUBLIC_DNS"
echo "App URL:     https://${HOST_FOR_TLS}"
echo "Username:    $(rg -N '^FR_SHARED_USERNAME=' "$ENV_FILE" | cut -d= -f2- || echo team)"
echo "Password:    $(rg -N '^FR_SHARED_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
echo
echo "Important: TEAM_HTTPS_CIDR is currently set to $TEAM_HTTPS_CIDR."
echo "If your team uses VPN/internal CIDR, rerun with TEAM_HTTPS_CIDR=<your-cidr> for tighter access."
