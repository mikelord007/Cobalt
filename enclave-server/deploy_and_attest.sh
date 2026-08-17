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
if [ -z "$APP" ]; then
  echo "error: app name must not be empty" >&2
  exit 1
fi

SECRETS_PATH=""
INSTANCE_IP=""
SSH_USER="ec2-user"
SSH_KEY="${COBALT_SSH_KEY:-$HOME/kp-1.pem}"

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
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

for tool in aws ssh scp curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' was not found on PATH. This script needs aws-cli, ssh, scp, and curl to drive a real deploy." >&2
    if [ "$tool" = "aws" ]; then
      echo "install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html, then 'aws configure'." >&2
    fi
    exit 1
  fi
done

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
#
# Portable sha256: coreutils on Linux, `shasum -a 256` on macOS (which ships no sha256sum).
SHA256="$(command -v sha256sum || echo 'shasum -a 256')"
echo "==> computing source hash" >&2
# An ALLOWLIST of build inputs, not `find .` over all of enclave-server/. The old form also swept
# deployments/<app>/{manifest,attestation}.json and instances.json -- files THIS script and
# provisioner.sh write on every run -- so the "cache key" changed on every deploy and the S3
# head-object below could never hit. These five entries are exactly what the Containerfile
# consumes (see enclave-server/Containerfile); if a COPY source is ever added there, add it here
# too. Scoped to examples/$APP specifically, not all of examples/, so editing dice can't
# invalidate ping's cache.
#
# -print0/xargs -0 handles paths with spaces; LC_ALL=C sort is applied to the per-file digest
# lines (not the file list), which makes the result byte-identical across operators, locales and
# find implementations without depending on GNU-only `sort -z`. xargs may split into several
# sha256 invocations for a long file list -- sorting the combined output makes that irrelevant.
SOURCE_HASH=$(cd "$REPO_ROOT" && find \
    enclave-server/src/nautilus-server \
    "examples/$APP" \
    enclave-server/Containerfile \
    enclave-server/Makefile \
    .dockerignore \
    -path enclave-server/src/nautilus-server/target -prune -o -type f -print0 \
  | xargs -0 $SHA256 \
  | LC_ALL=C sort \
  | $SHA256 | awk '{print $1}')
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

  # 1. Ship. Tar ROOT is the repo root so the archive carries repo-root-relative paths
  # (./enclave-server/..., ./examples/...) -- the layout the Containerfile's four-`..` #[path]
  # depends on (see enclave-server/src/nautilus-server/src/lib.rs). Tar MEMBERS stay scoped to
  # just the two trees plus .dockerignore, so this stays small even though the root is wide.
  # COPYFILE_DISABLE=1 stops bsdtar (macOS) from embedding AppleDouble `._*` entries; harmless on
  # Linux/GNU tar.
  #
  # Extracted into a build/ subdir, wiped first: tar overwrites but never deletes, so without the
  # rm -rf a file removed in this revision (e.g. an app that used to live under
  # enclave-server/src/nautilus-server/src/apps/) would linger from a previous deploy and get
  # COPY'd into the image. The subdir is what makes that rm safe -- this app's runtime state
  # (secrets.json, enclave_id, socat.log, out/) lives one level up in ~/deployments/$APP/ and is
  # untouched.
  COPYFILE_DISABLE=1 tar -C "$REPO_ROOT" \
      --exclude=./enclave-server/src/nautilus-server/target \
      --exclude=./enclave-server/out \
      --exclude=./enclave-server/deployments \
      --exclude='*.eif' --exclude='*.pcrs' \
      -czf - ./.dockerignore ./enclave-server ./examples | \
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$INSTANCE_IP" \
      "rm -rf ~/deployments/$APP/build && mkdir -p ~/deployments/$APP/build && tar -xzf - -C ~/deployments/$APP/build"
  # Widened beyond *.sh: a CRLF Makefile/Containerfile recipe line fails with a much less
  # legible "/bin/sh: ^M: not found" than a shell script does.
  remote "find ~/deployments/$APP/build \( -name '*.sh' -o -name Makefile -o -name Containerfile \) -exec sed -i 's/\r\$//' {} +"

  # 2. Build, detached + polled. A background job on the remote returns SSH control almost
  # immediately -- the ssh command finishing is not evidence of anything, so never trust it as a
  # signal of build progress; always poll remote state directly instead.
  remote "cd ~/deployments/$APP/build/enclave-server && setsid nohup make ENCLAVE_APP=$APP > ~/deployments/$APP/build.log 2>&1 < /dev/null & disown -a"

  echo "==> build launched, polling (ceiling ~90 minutes)" >&2
  ELAPSED=0
  CEILING=5400
  while :; do
    if remote "test -f ~/deployments/$APP/build/enclave-server/out/nitro.pcrs"; then
      echo "==> build succeeded" >&2
      # Promote to the single canonical artifact location, ~/deployments/$APP/out/ -- the same
      # one the S3 cache-hit branch above writes to, so the scp-down below and the run-enclave
      # step later are identical on both paths.
      remote "mkdir -p ~/deployments/$APP/out && cp ~/deployments/$APP/build/enclave-server/out/nitro.eif ~/deployments/$APP/out/nitro.eif && cp ~/deployments/$APP/build/enclave-server/out/nitro.pcrs ~/deployments/$APP/out/nitro.pcrs"
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
# String([1,3]) in JS joins with "," -- exactly the format provisioner.sh's `record` subcommand
# expects for its cpu-ids-csv argument, so no extra parsing needed here.
CPU_IDS=$(printf '%s' "$RUN_JSON" | json_field CPUIDs)
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

# Persist this enclave's core claim in instances.json so a LATER deploy's capacity check (see
# provisioner.sh's `acquire`) doesn't think this instance still has room when it doesn't -- without
# this, a subsequent deploy gets silently routed here believing a core is free, then fails at the
# real `nitro-cli run-enclave` step once it hits the OS-level allocator's actual limit instead of
# either reusing real spare capacity or cleanly launching a fresh instance.
#
# Best-effort and non-fatal: an already-successful enclave deploy shouldn't fail just because this
# bookkeeping step couldn't complete -- e.g. --instance-ip pointed at a box provisioner.sh never
# registered as base capacity in the first place, which `record` requires (it looks the instance id
# up in instances.json and errors if it's not already there).
INSTANCE_ID_FOR_RECORD=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=ip-address,Values=$INSTANCE_IP" \
  --query "Reservations[0].Instances[0].InstanceId" --output text 2>/dev/null || true)
if [ -n "$INSTANCE_ID_FOR_RECORD" ] && [ "$INSTANCE_ID_FOR_RECORD" != "None" ]; then
  "$SCRIPT_DIR/provisioner.sh" record "$INSTANCE_ID_FOR_RECORD" "$APP" 1 "$ENCLAVE_ID" "$CPU_IDS" "$PARENT_PORT" \
    || echo "==> warning: could not record this enclave's core claim in instances.json (continuing -- the deploy itself succeeded)" >&2
else
  echo "==> warning: could not resolve an instance id for $INSTANCE_IP -- skipping instances.json bookkeeping" >&2
fi

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
