#!/bin/bash
# Builds (or reuses a cached build of) an enclave app, ships/boots it on a target EC2 instance,
# delivers secrets over vsock, and waits for the enclave to report healthy. Runs on the operator's
# side (this dev machine) driving everything over SSH/SCP -- nothing extra needs to be installed
# on the target instance beyond what its cloud-init already set up.
#
# usage: deploy_and_attest.sh <app-name> --secrets <path> [--instance-ip <ip>] [--ssh-key <path>] [--ssh-user <user>]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <app-name> [--secrets <path>] [--instance-ip <ip>] [--ssh-key <path>] [--ssh-user <user>]" >&2
  exit 1
fi

APP="$1"
shift

SECRETS_PATH=""
INSTANCE_IP=""
SSH_USER="ec2-user"
SSH_KEY="$HOME/kp-1.pem"

while [ $# -gt 0 ]; do
  case "$1" in
    --secrets) SECRETS_PATH="$2"; shift 2 ;;
    --instance-ip) INSTANCE_IP="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --ssh-user) SSH_USER="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# No explicit --instance-ip override -- ask the capacity-aware provisioner which instance to target
# (it auto-launches fresh capacity if nothing existing has room for this app).
if [ -z "$INSTANCE_IP" ]; then
  echo "==> no --instance-ip given -- asking provisioner.sh for capacity for app '$APP'" >&2
  INSTANCE_IP=$("$SCRIPT_DIR/provisioner.sh" acquire "$APP")
  echo "==> provisioner assigned instance $INSTANCE_IP" >&2
fi

remote() {
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$INSTANCE_IP" "$@"
}

# Extracts a single field from JSON on stdin. Node, not python3 -- node is already required to run
# the CLI that invokes this script at all, so it costs nothing extra; python3 would be one more
# thing a fresh machine might not have.
json_field() {
  node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8'))['$1']))"
}

AWS_ACCOUNT_ID="279056796721"
REGION="us-east-1"
BUCKET="cobalt-enclave-artifacts-${AWS_ACCOUNT_ID}-${REGION}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# The EIF-rebuild-per-instance problem is the single biggest time cost if not designed around:
# build once, key the artifact by a hash of the source, store it centrally in S3, and have every
# future launch (on this instance or a later one, once D3's provisioner grows a fleet) download
# and boot instead of recompiling. Hash every tracked source file's own content (not the tarball
# we ship, which would vary with mtimes/compression) so the skip-check is a fast, deterministic
# S3 head-object before any SSH or build work happens.
echo "==> computing source hash" >&2
SOURCE_HASH=$(cd "$SCRIPT_DIR" && find . \( -path ./out -o -path ./src/nautilus-server/target \) -prune -o -type f -print | sort | xargs sha256sum | sha256sum | awk '{print $1}')
echo "==> source hash: $SOURCE_HASH" >&2

S3_PREFIX="s3://$BUCKET/$APP/$SOURCE_HASH"

if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  echo "==> creating artifact bucket $BUCKET" >&2
  aws s3 mb "s3://$BUCKET" --region "$REGION" >&2
fi

CACHE_HIT=0
if aws s3api head-object --bucket "$BUCKET" --key "$APP/$SOURCE_HASH/nitro.pcrs" >/dev/null 2>&1; then
  CACHE_HIT=1
fi

if [ "$CACHE_HIT" = "1" ]; then
  echo "==> cached build found for $APP @ $SOURCE_HASH -- skipping build, downloading artifact" >&2
  aws s3 cp "$S3_PREFIX/nitro.eif" "$WORK_DIR/nitro.eif" --only-show-errors
  aws s3 cp "$S3_PREFIX/nitro.pcrs" "$WORK_DIR/nitro.pcrs" --only-show-errors
  remote "mkdir -p ~/deployments/$APP/out"
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$WORK_DIR/nitro.eif" "$SSH_USER@$INSTANCE_IP:~/deployments/$APP/out/nitro.eif"
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$WORK_DIR/nitro.pcrs" "$SSH_USER@$INSTANCE_IP:~/deployments/$APP/out/nitro.pcrs"
else
  echo "==> no cached artifact -- shipping source and building on $INSTANCE_IP" >&2

  # 1. Ship.
  tar -C "$SCRIPT_DIR" --exclude=src/nautilus-server/target --exclude=out -czf - . | \
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$INSTANCE_IP" "mkdir -p ~/deployments/$APP && tar -xzf - -C ~/deployments/$APP"
  remote "find ~/deployments/$APP -name '*.sh' -exec sed -i 's/\r\$//' {} +"

  # 2. Build, detached + polled. A background job on the remote returns SSH control almost
  # immediately -- the ssh command finishing is not evidence of anything, so never trust it as a
  # signal of build progress; always poll remote state directly instead.
  remote "cd ~/deployments/$APP && setsid nohup make ENCLAVE_APP=$APP > build.log 2>&1 < /dev/null & disown -a"

  echo "==> build launched, polling (ceiling ~90 minutes)" >&2
  ELAPSED=0
  CEILING=5400
  while :; do
    if remote "test -f ~/deployments/$APP/out/nitro.pcrs"; then
      echo "==> build succeeded" >&2
      break
    fi
    # `make`'s recipe runs `docker build` and then `nitro-cli build-enclave` in sequence -- once
    # the docker build step finishes, its process disappears even though make is still legitimately
    # working on EIF packaging. Match on `make` itself (which spans the whole recipe) as well as
    # the two known sub-steps, so the poll loop doesn't declare a false failure in that gap.
    if remote "pgrep -f 'make ENCLAVE_APP=$APP' || pgrep -f 'docker build.*ENCLAVE_APP=$APP' || pgrep -f 'nitro-cli build-enclave'" >/dev/null 2>&1; then
      echo "==> still building ($ELAPSED s elapsed)" >&2
    else
      echo "==> build process is gone but out/nitro.pcrs was never produced -- last 60 lines of build.log:" >&2
      remote "tail -60 ~/deployments/$APP/build.log" >&2
      exit 1
    fi
    sleep 30
    ELAPSED=$((ELAPSED+30))
    if [ "$ELAPSED" -ge "$CEILING" ]; then
      echo "==> build did not finish within the poll ceiling" >&2
      exit 1
    fi
  done

  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$INSTANCE_IP:~/deployments/$APP/out/nitro.eif" "$WORK_DIR/nitro.eif"
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$INSTANCE_IP:~/deployments/$APP/out/nitro.pcrs" "$WORK_DIR/nitro.pcrs"
fi

# 3. Refuse an all-zero PCR0 -- indicates a debug-mode build. Checked unconditionally (whether
# the artifact was just built or pulled from cache) before anything launches or gets cached.
PCR0=$(awk '/^PCR0/{print $2}' "$WORK_DIR/nitro.pcrs")
PCR1=$(awk '/^PCR1/{print $2}' "$WORK_DIR/nitro.pcrs")
PCR2=$(awk '/^PCR2/{print $2}' "$WORK_DIR/nitro.pcrs")
NONZERO=$(printf '%s' "$PCR0" | tr -d '0')
if [ -z "$NONZERO" ]; then
  echo "==> refusing to launch: PCR0 is all zeros ($PCR0) -- this indicates a debug-mode build" >&2
  exit 1
fi
echo "==> PCR0=$PCR0" >&2
echo "==> PCR1=$PCR1" >&2
echo "==> PCR2=$PCR2" >&2

if [ "$CACHE_HIT" = "0" ]; then
  echo "==> uploading build artifact to $S3_PREFIX" >&2
  aws s3 cp "$WORK_DIR/nitro.eif" "$S3_PREFIX/nitro.eif" --only-show-errors
  aws s3 cp "$WORK_DIR/nitro.pcrs" "$S3_PREFIX/nitro.pcrs" --only-show-errors
fi

# 4. Launch. Kill only this app's previously tracked enclave (never terminate-enclave --all,
# which would kill other apps' enclaves sharing the instance).
PREV_ID=$(remote "cat ~/deployments/$APP/enclave_id 2>/dev/null || true")
if [ -n "$PREV_ID" ]; then
  echo "==> terminating this app's previous enclave $PREV_ID" >&2
  remote "sudo nitro-cli terminate-enclave --enclave-id '$PREV_ID' || true"
fi

echo "==> launching enclave (production mode, no --debug-mode)" >&2
RUN_JSON=$(remote "sudo nitro-cli run-enclave --cpu-count 2 --memory 512M --eif-path ~/deployments/$APP/out/nitro.eif")
echo "$RUN_JSON" >&2
ENCLAVE_ID=$(printf '%s' "$RUN_JSON" | json_field EnclaveID)
CID=$(printf '%s' "$RUN_JSON" | json_field EnclaveCID)
remote "echo '$ENCLAVE_ID' > ~/deployments/$APP/enclave_id"
echo "==> enclave id $ENCLAVE_ID, cid $CID" >&2

# 5. Port forward. PARENT_PORT=3000 for the first app deployed on this instance; a small
# flock-guarded ports.json on the remote hands out 3001, 3002, ... to later apps.
cat > "$WORK_DIR/portalloc.py" <<'PY'
import json, os, sys

app = sys.argv[1]
path = os.path.expanduser('~/deployments/ports.json')
try:
    with open(path) as f:
        ports = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    ports = {}

if app in ports:
    print(ports[app])
else:
    used = set(ports.values())
    port = 3000
    while port in used:
        port += 1
    ports[app] = port
    with open(path, 'w') as f:
        json.dump(ports, f)
    print(port)
PY
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$WORK_DIR/portalloc.py" "$SSH_USER@$INSTANCE_IP:~/deployments/portalloc.py"
PARENT_PORT=$(remote "mkdir -p ~/deployments && flock ~/deployments/ports.lock python3 ~/deployments/portalloc.py $APP")
echo "==> parent port: $PARENT_PORT" >&2

# Kill by port ownership (fuser), never by a text pattern (pkill -f) that could match a later
# line of this same remote invocation and kill the calling shell itself.
remote "sudo fuser -k ${PARENT_PORT}/tcp || true"
remote "setsid nohup socat TCP4-LISTEN:${PARENT_PORT},reuseaddr,fork VSOCK-CONNECT:${CID}:3000 > ~/deployments/$APP/socat.log 2>&1 < /dev/null & disown -a"

# 6. Secrets. Deliver over vsock:7777 -- run.sh's socat blocks waiting for exactly one payload
# before it starts the app binary, so even a no-secrets deploy must send an empty object to
# unblock it. `socat file:$SOURCE VSOCK-CONNECT:...` (not a pipe into socat with a stray
# `< /dev/null` -- the redirect silently wins over the pipe and sends nothing).
if [ -n "$SECRETS_PATH" ]; then
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SECRETS_PATH" "$SSH_USER@$INSTANCE_IP:~/deployments/$APP/secrets.json"
else
  remote "printf '{}' > ~/deployments/$APP/secrets.json"
fi

echo "==> delivering secrets over vsock:7777 to cid $CID" >&2
remote "
  i=0
  while [ \$i -lt 15 ]; do
    if socat file:\$HOME/deployments/$APP/secrets.json VSOCK-CONNECT:$CID:7777; then
      exit 0
    fi
    i=\$((i+1))
    sleep 2
  done
  echo 'failed to deliver secrets over vsock:7777 after 15 attempts' >&2
  exit 1
"

# 7. Poll /health from THIS machine, through the forwarded port.
echo "==> polling http://$INSTANCE_IP:$PARENT_PORT/health" >&2
HEALTH_JSON=""
i=0
while [ "$i" -lt 20 ]; do
  HEALTH_JSON=$(curl -s -m 3 "http://$INSTANCE_IP:$PARENT_PORT/health" || true)
  if printf '%s' "$HEALTH_JSON" | grep -q '"eth_address"'; then
    break
  fi
  i=$((i+1))
  sleep 1
done
if ! printf '%s' "$HEALTH_JSON" | grep -q '"eth_address"'; then
  echo "==> /health did not become ready within 20s" >&2
  exit 1
fi
ETH_ADDRESS=$(printf '%s' "$HEALTH_JSON" | json_field eth_address)
echo "==> enclave eth address: $ETH_ADDRESS" >&2

ATTESTATION_JSON=$(curl -s -m 10 "http://$INSTANCE_IP:$PARENT_PORT/attestation")
ATTESTATION_HEX=$(printf '%s' "$ATTESTATION_JSON" | json_field attestation)

# 8. Write outputs atomically, then echo the manifest as the LAST line of stdout -- this is the
# contract a CLI built on a different track parses to pick up the deploy result.
DEPLOY_OUT_DIR="$SCRIPT_DIR/deployments/$APP"
mkdir -p "$DEPLOY_OUT_DIR"
node - "$DEPLOY_OUT_DIR" "$APP" "$PCR0" "$PCR1" "$PCR2" "$ETH_ADDRESS" "$PARENT_PORT" "$CID" "$INSTANCE_IP" "$ATTESTATION_HEX" <<'JS'
const fs = require("fs");
const path = require("path");
const [deployDir, app, pcr0, pcr1, pcr2, ethAddress, parentPort, enclaveCid, instance, attestationHex] = process.argv.slice(2);

const manifest = {
  app,
  pcrs: { pcr0, pcr1, pcr2 },
  attestation_path: `enclave-server/deployments/${app}/attestation.json`,
  eth_address: ethAddress,
  parent_port: parseInt(parentPort, 10),
  enclave_cid: parseInt(enclaveCid, 10),
  instance,
};
const attestation = { attestation: attestationHex };

for (const [name, obj] of [["manifest.json", manifest], ["attestation.json", attestation]]) {
  const finalPath = path.join(deployDir, name);
  const tmpPath = finalPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
  fs.renameSync(tmpPath, finalPath);
}

console.log(JSON.stringify(manifest));
JS
