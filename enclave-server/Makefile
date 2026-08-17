REGISTRY := local

# Every target here needs the app name; fail at parse time with a readable message rather than
# letting an empty --features reach cargo (or an empty `find ../examples/` match nothing silently).
ifndef ENCLAVE_APP
$(error ENCLAVE_APP is required, e.g. `make ENCLAVE_APP=dice`)
endif

.PHONY: default
default: out/nitro.eif

out:
	mkdir -p out

# Depend on `find`, not `git ls-files` -- so untracked/uncommitted source edits still trigger a
# rebuild instead of silently reusing a stale image. TWO trees now, because an app's Rust source
# lives in the repo's top-level examples/<app>/ (the one and only copy), not under src/ here.
#
# `-path ... -prune` rather than `-not -path ...`: POSIX-portable, and it stops find from walking
# the cargo target/ dir a local `cargo test` leaves behind -- that dir dwarfs the real source tree
# and gets rewritten on every local test run, which used to make this target look stale always.
NAUTILUS_SRC := $(shell find src/nautilus-server -path src/nautilus-server/target -prune -o -type f -print)
APP_SRC      := $(shell find ../examples/$(ENCLAVE_APP) -type f)

# Context is the REPO ROOT (`..`), so examples/ is reachable; -f is resolved against make's own
# CWD, and Docker is fine with a Dockerfile outside its context. .dockerignore is picked up from
# the CONTEXT root, hence ../.dockerignore -- which is also a prereq, since pruning it wrong can
# starve the build.
out/nitro.eif: $(NAUTILUS_SRC) $(APP_SRC) Containerfile ../.dockerignore | out
	docker build --platform linux/amd64 --build-arg ENCLAVE_APP=$(ENCLAVE_APP) -t $(REGISTRY)/cobalt-enclave:$(ENCLAVE_APP) -f Containerfile ..
	nitro-cli build-enclave --docker-uri $(REGISTRY)/cobalt-enclave:$(ENCLAVE_APP) --output-file out/nitro.eif | tee out/build.json
	python3 -c "import json; d=json.load(open('out/build.json')); m=d['Measurements']; open('out/nitro.pcrs','w').write(f\"PCR0 {m['PCR0']}\nPCR1 {m['PCR1']}\nPCR2 {m['PCR2']}\n\")"

.PHONY: run
run: out/nitro.eif
	sudo nitro-cli run-enclave --cpu-count 2 --memory 512M --eif-path out/nitro.eif

.PHONY: run-debug
run-debug: out/nitro.eif
	sudo nitro-cli run-enclave --cpu-count 2 --memory 512M --eif-path out/nitro.eif --debug-mode --attach-console
