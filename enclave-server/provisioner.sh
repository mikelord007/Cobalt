#!/bin/bash
# Minimal capacity-aware provisioner (D3). Reads/writes enclave-server/instances.json. Runs
# locally on the operator's dev machine -- it never touches the EC2 instances themselves, it just
# tracks which physical cores their enclaves have already claimed so a deploy knows where there's
# room. Does NOT auto-launch new instances when none has room -- it just errors out clearly; a
# fleet-growing provisioner is out of scope for this pass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTANCES_JSON="$SCRIPT_DIR/instances.json"

usage() {
  echo "usage: $0 acquire <app> [--cores N]" >&2
  echo "       $0 record <instance-id> <app> <cores> <enclave-id> <cpu-ids-csv> <parent-port>" >&2
  exit 1
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
    python3 - "$INSTANCES_JSON" "$APP" "$CORES" <<'PY'
import json, sys

path, app, cores = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(path) as f:
    data = json.load(f)

for inst in data["instances"]:
    used = inst["cores_reserved_for_parent"] + sum(e["cores"] for e in inst["enclaves"])
    free = inst["physical_cores"] - used
    if free >= cores:
        print(inst["public_ip"])
        sys.exit(0)

sys.exit(f"error: no instance in {path} has {cores} free physical core(s) for app '{app}' "
          f"(auto-launching a new instance is not implemented -- add capacity manually)")
PY
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
