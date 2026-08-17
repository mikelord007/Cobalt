#!/bin/bash
# Capacity-aware provisioner (D3). Reads/writes enclave-server/instances.json. Runs locally on the
# operator's dev machine. It tracks which physical cores each EC2 instance's enclaves have already
# claimed so a deploy knows where there's room -- and when nothing has room, it auto-launches a new
# c6a.xlarge instance (matching the fleet's existing launch configuration exactly), waits for it to
# be genuinely ready (booted + cloud-init finished installing the Nitro CLI and Docker), registers
# it in instances.json, and hands back its IP just like the existing-instance path does.
set -euo pipefail

# Under Git Bash on Windows (MSYS2), any argv element that starts with "/" gets silently rewritten
# into a Windows path before native (non-MSYS) executables like `aws` ever see it -- so
# "/aws/service/..." below becomes "C:/Program Files/Git/aws/service/..." and every AWS-owned
# public SSM parameter lookup fails with a confusing ParameterNotFound. Excluding just the "/aws/"
# prefix (not a blanket MSYS_NO_PATHCONV=1) leaves MSYS's conversion of this script's OTHER path
# arguments (SSH_KEY, USER_DATA_FILE) working correctly. A no-op everywhere else (real Linux/macOS
# bash, or any non-MSYS shell) -- this env var simply isn't read there.
export MSYS2_ARG_CONV_EXCL="${MSYS2_ARG_CONV_EXCL:-}/aws/"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTANCES_JSON="$SCRIPT_DIR/instances.json"

for tool in aws ssh; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' was not found on PATH. The provisioner needs aws-cli and ssh to manage EC2 capacity." >&2
    if [ "$tool" = "aws" ]; then
      echo "install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html, then 'aws configure'." >&2
    fi
    exit 1
  fi
done

# Launch configuration -- must match the fleet's existing instance(s) exactly so a freshly launched
# one is a genuine equivalent, not a divergent one-off.
REGION="us-east-1"
INSTANCE_TYPE="c6a.xlarge"      # 2 physical cores: 1 reserved for host OS, 1 free for an enclave.
KEY_NAME="cobalt-kp-1"
SG_NAME="cobalt-enclave-sg"
SSH_KEY="${COBALT_SSH_KEY:-$HOME/kp-1.pem}"
SSH_KEY_JSON="~/kp-1.pem"       # how the key path is recorded in instances.json (matches the existing entry).
SSH_USER="ec2-user"
# The real file is real operator secret material and gitignored at .secrets/user-data.sh, so it
# is never in the npm tarball or a fresh clone -- see enclave-server/user-data.sh.example for the
# template this deliberately-absent-by-default file must be created from.
USER_DATA_FILE="${COBALT_USER_DATA:-$SCRIPT_DIR/../.secrets/user-data.sh}"

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
  current_count=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).instances.length)" -- "$INSTANCES_JSON")
  if [ "$current_count" -ge "$MAX_INSTANCES" ]; then
    echo "error: already at $current_count/$MAX_INSTANCES c6a.xlarge instances (the account's 16 vCPU quota allows no more) -- cannot auto-launch another for app '$app'" >&2
    exit 1
  fi

  if [ ! -f "$USER_DATA_FILE" ]; then
    echo "error: user-data file not found at $USER_DATA_FILE" >&2
    echo "copy enclave-server/user-data.sh.example to .secrets/user-data.sh (or point COBALT_USER_DATA at your own copy) and fill in the real values first." >&2
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

  # aws-cli is a native (non-MSYS) executable, so a "file://" paramfile URI built from an
  # MSYS/Git-Bash POSIX path (e.g. /c/Users/...) does NOT get auto-translated the way a bare
  # leading-slash argument does (that's the opposite of the MSYS2_ARG_CONV_EXCL problem worked
  # around above) -- aws-cli's paramfile loader just strips "file://" and hands the rest straight
  # to Python's open(), which can't resolve a POSIX-style path on Windows. Route through cygpath
  # (always present under Git Bash/MSYS) to get a real Windows path first; a no-op everywhere
  # else, where $USER_DATA_FILE is already a path aws-cli can open directly.
  local user_data_uri="file://$USER_DATA_FILE"
  if command -v cygpath >/dev/null 2>&1; then
    user_data_uri="file://$(cygpath -w "$USER_DATA_FILE")"
  fi

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
    --user-data "$user_data_uri" \
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
  node - "$INSTANCES_JSON" "$instance_id" "$REGION" "$INSTANCE_TYPE" "$public_ip" "$SSH_KEY_JSON" "$SSH_USER" <<'JS'
const fs = require("fs");
const [path, instanceId, region, instanceType, publicIp, sshKey, sshUser] = process.argv.slice(2);

const data = JSON.parse(fs.readFileSync(path, "utf8"));
data.instances.push({
  instance_id: instanceId,
  region,
  instance_type: instanceType,
  public_ip: publicIp,
  ssh_key: sshKey,
  ssh_user: sshUser,
  physical_cores: 2,
  cores_reserved_for_parent: 1,
  enclaves: [],
});

const tmpPath = path + ".tmp";
fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
fs.renameSync(tmpPath, path);
JS

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
    FOUND_IP=$(node - "$INSTANCES_JSON" "$CORES" <<'JS'
const fs = require("fs");
const [path, coresArg] = process.argv.slice(2);
const cores = parseInt(coresArg, 10);

const data = JSON.parse(fs.readFileSync(path, "utf8"));
for (const inst of data.instances) {
  const used = inst.cores_reserved_for_parent + inst.enclaves.reduce((sum, e) => sum + e.cores, 0);
  const free = inst.physical_cores - used;
  if (free >= cores) {
    console.log(inst.public_ip);
    process.exit(0);
  }
}
process.exit(1);
JS
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
    node - "$INSTANCES_JSON" "$INSTANCE_ID" "$APP" "$CORES" "$ENCLAVE_ID" "$CPU_IDS" "$PARENT_PORT" <<'JS'
const fs = require("fs");
const [path, instanceId, app, coresArg, enclaveId, cpuIds, parentPortArg] = process.argv.slice(2);
const cores = parseInt(coresArg, 10);
const parentPort = parseInt(parentPortArg, 10);
const cpuIdsList = cpuIds.split(",").filter((x) => x !== "").map((x) => parseInt(x, 10));

const data = JSON.parse(fs.readFileSync(path, "utf8"));
const inst = data.instances.find((i) => i.instance_id === instanceId);
if (!inst) {
  console.error(`error: no instance with id '${instanceId}' in ${path}`);
  process.exit(1);
}
inst.enclaves = inst.enclaves.filter((e) => e.app !== app);
inst.enclaves.push({ app, cores, enclave_id: enclaveId, cpu_ids: cpuIdsList, parent_port: parentPort });

const tmpPath = path + ".tmp";
fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
fs.renameSync(tmpPath, path);
JS
    echo "recorded enclave for app '$APP' on instance '$INSTANCE_ID'" >&2
    ;;
  *)
    usage
    ;;
esac
