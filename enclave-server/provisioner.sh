#!/bin/bash
# Capacity-aware provisioner (D3). Reads/writes enclave-server/instances.json. Runs locally on the
# operator's dev machine. It tracks which physical cores each EC2 instance's enclaves have already
# claimed so a deploy knows where there's room -- and when nothing has room, it auto-launches a new
# c6a.xlarge instance (matching the fleet's existing launch configuration exactly), waits for it to
# be genuinely ready (booted + cloud-init finished installing the Nitro CLI and Docker), registers
# it in instances.json, and hands back its IP just like the existing-instance path does.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTANCES_JSON="$SCRIPT_DIR/instances.json"

# Launch configuration -- must match the fleet's existing instance(s) exactly so a freshly launched
# one is a genuine equivalent, not a divergent one-off.
REGION="us-east-1"
INSTANCE_TYPE="c6a.xlarge"      # 2 physical cores: 1 reserved for host OS, 1 free for an enclave.
KEY_NAME="cobalt-kp-1"
SG_NAME="cobalt-enclave-sg"
SSH_KEY="$HOME/kp-1.pem"
SSH_KEY_JSON="~/kp-1.pem"       # how the key path is recorded in instances.json (matches the existing entry).
SSH_USER="ec2-user"
USER_DATA_FILE="$SCRIPT_DIR/../.secrets/user-data.sh"

# Account's On-Demand Standard vCPU quota is 16; a c6a.xlarge is 4 vCPU, so at most 4 can run at
# once. Enforce that here rather than letting AWS reject the launch with an opaque quota error.
MAX_INSTANCES=4

usage() {
  echo "usage: $0 acquire <app> [--cores N]" >&2
  echo "       $0 record <instance-id> <app> <cores> <enclave-id> <cpu-ids-csv> <parent-port>" >&2
  exit 1
}

# Launches a brand-new c6a.xlarge, waits for it to be running and genuinely ready (SSH + cloud-init
# done), registers it in instances.json, and prints its public IP on stdout. Everything else goes
# to stderr, matching the existing acquire contract of "one thing on stdout: the usable IP".
launch_new_instance() {
  local app="$1"

  local current_count
  current_count=$(python3 -c "import json; print(len(json.load(open('$INSTANCES_JSON'))['instances']))")
  if [ "$current_count" -ge "$MAX_INSTANCES" ]; then
    echo "error: already at $current_count/$MAX_INSTANCES c6a.xlarge instances (the account's 16 vCPU quota allows no more) -- cannot auto-launch another for app '$app'" >&2
    exit 1
  fi

  if [ ! -f "$USER_DATA_FILE" ]; then
    echo "error: user-data file not found at $USER_DATA_FILE" >&2
    exit 1
  fi

  echo "==> no existing instance has room for app '$app' -- auto-launching a new $INSTANCE_TYPE ($current_count/$MAX_INSTANCES instances so far)" >&2

  echo "==> looking up latest AL2023 AMI" >&2
  local ami_id
  ami_id=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --region "$REGION" --query Parameter.Value --output text)
  echo "==> ami: $ami_id" >&2

  echo "==> looking up security group '$SG_NAME'" >&2
  local sg_id
  sg_id=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" --region "$REGION" --query "SecurityGroups[0].GroupId" --output text)
  if [ -z "$sg_id" ] || [ "$sg_id" = "None" ]; then
    echo "error: could not find security group '$SG_NAME' in $REGION" >&2
    exit 1
  fi
  echo "==> security group: $sg_id" >&2

  local tag_name="cobalt-enclave-$((current_count + 1))"
  echo "==> launching instance ($tag_name)" >&2
  local instance_id
  instance_id=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$ami_id" \
    --instance-type "$INSTANCE_TYPE" \
    --count 1 \
    --key-name "$KEY_NAME" \
    --security-group-ids "$sg_id" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":200}}]' \
    --enclave-options 'Enabled=true' \
    --user-data "file://$USER_DATA_FILE" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$tag_name}]" \
    --query "Instances[0].InstanceId" --output text)
  echo "==> instance id: $instance_id -- waiting for 'running' state" >&2

  aws ec2 wait instance-running --region "$REGION" --instance-ids "$instance_id"

  local public_ip
  public_ip=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$instance_id" \
    --query "Reservations[0].Instances[0].PublicIpAddress" --output text)
  echo "==> public ip: $public_ip -- waiting for cloud-init (nitro-cli + docker) to be ready" >&2

  local ready=0
  local elapsed=0
  local ceiling=420  # 7 minutes
  while [ "$elapsed" -lt "$ceiling" ]; do
    if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes \
         "$SSH_USER@$public_ip" "test -f /usr/bin/nitro-cli && systemctl is-active --quiet docker" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 10
    elapsed=$((elapsed + 10))
    echo "==> still waiting for $public_ip to be ready (${elapsed}s elapsed)" >&2
  done

  if [ "$ready" != "1" ]; then
    echo "error: instance $instance_id ($public_ip) did not become ready (SSH + nitro-cli + docker) within ${ceiling}s" >&2
    exit 1
  fi

  echo "==> instance $instance_id ready -- recording it in $INSTANCES_JSON" >&2
  python3 - "$INSTANCES_JSON" "$instance_id" "$REGION" "$INSTANCE_TYPE" "$public_ip" "$SSH_KEY_JSON" "$SSH_USER" <<'PY'
import json, os, sys

path, instance_id, region, instance_type, public_ip, ssh_key, ssh_user = sys.argv[1:8]
with open(path) as f:
    data = json.load(f)

data["instances"].append({
    "instance_id": instance_id,
    "region": region,
    "instance_type": instance_type,
    "public_ip": public_ip,
    "ssh_key": ssh_key,
    "ssh_user": ssh_user,
    "physical_cores": 2,
    "cores_reserved_for_parent": 1,
    "enclaves": [],
})

tmp_path = path + ".tmp"
with open(tmp_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp_path, path)
PY

  echo "$public_ip"
}

[ $# -ge 1 ] || usage
CMD="$1"
shift

case "$CMD" in
  acquire)
    [ $# -ge 1 ] || usage
    APP="$1"
    shift
    CORES=1
    while [ $# -gt 0 ]; do
      case "$1" in
        --cores) CORES="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
      esac
    done

    set +e
    FOUND_IP=$(python3 - "$INSTANCES_JSON" "$CORES" <<'PY'
import json, sys

path, cores = sys.argv[1], int(sys.argv[2])
with open(path) as f:
    data = json.load(f)

for inst in data["instances"]:
    used = inst["cores_reserved_for_parent"] + sum(e["cores"] for e in inst["enclaves"])
    free = inst["physical_cores"] - used
    if free >= cores:
        print(inst["public_ip"])
        sys.exit(0)

sys.exit(1)
PY
)
    FOUND_STATUS=$?
    set -e

    if [ "$FOUND_STATUS" -eq 0 ] && [ -n "$FOUND_IP" ]; then
      echo "$FOUND_IP"
    else
      launch_new_instance "$APP"
    fi
    ;;
  record)
    [ $# -eq 6 ] || usage
    INSTANCE_ID="$1"; APP="$2"; CORES="$3"; ENCLAVE_ID="$4"; CPU_IDS="$5"; PARENT_PORT="$6"
    python3 - "$INSTANCES_JSON" "$INSTANCE_ID" "$APP" "$CORES" "$ENCLAVE_ID" "$CPU_IDS" "$PARENT_PORT" <<'PY'
import json, os, sys

path, instance_id, app, cores, enclave_id, cpu_ids, parent_port = sys.argv[1:8]
cores = int(cores)
parent_port = int(parent_port)
cpu_ids_list = [int(x) for x in cpu_ids.split(",") if x != ""]

with open(path) as f:
    data = json.load(f)

for inst in data["instances"]:
    if inst["instance_id"] != instance_id:
        continue
    inst["enclaves"] = [e for e in inst["enclaves"] if e["app"] != app]
    inst["enclaves"].append({
        "app": app,
        "cores": cores,
        "enclave_id": enclave_id,
        "cpu_ids": cpu_ids_list,
        "parent_port": parent_port,
    })
    break
else:
    sys.exit(f"error: no instance with id '{instance_id}' in {path}")

tmp_path = path + ".tmp"
with open(tmp_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp_path, path)
PY
    echo "recorded enclave for app '$APP' on instance '$INSTANCE_ID'" >&2
    ;;
  *)
    usage
    ;;
esac
