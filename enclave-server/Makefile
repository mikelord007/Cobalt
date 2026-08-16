REGISTRY := local

.PHONY: default
default: out/nitro.eif

out:
	mkdir -p out

# Depend on `find src -type f`, not `git ls-files src` -- so untracked/uncommitted source edits
# still trigger a rebuild instead of silently reusing a stale image.
out/nitro.eif: $(shell find src -type f) Containerfile | out
	docker build --platform linux/amd64 --build-arg ENCLAVE_APP=$(ENCLAVE_APP) -t $(REGISTRY)/cobalt-enclave:$(ENCLAVE_APP) -f Containerfile .
	nitro-cli build-enclave --docker-uri $(REGISTRY)/cobalt-enclave:$(ENCLAVE_APP) --output-file out/nitro.eif | tee out/build.json
	python3 -c "import json; d=json.load(open('out/build.json')); m=d['Measurements']; open('out/nitro.pcrs','w').write(f\"PCR0 {m['PCR0']}\nPCR1 {m['PCR1']}\nPCR2 {m['PCR2']}\n\")"

.PHONY: run
run: out/nitro.eif
	sudo nitro-cli run-enclave --cpu-count 2 --memory 512M --eif-path out/nitro.eif

.PHONY: run-debug
run-debug: out/nitro.eif
	sudo nitro-cli run-enclave --cpu-count 2 --memory 512M --eif-path out/nitro.eif --debug-mode --attach-console
