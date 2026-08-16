#!/usr/bin/env node
"use strict";

// Turns a raw Nitro attestation (or a set of PCR values) into on-disk calldata slots consumable
// by script/SubmitCalldataDir.s.sol. Pure Node, no dependencies beyond what ships with the
// runtime -- all attestation/cert parsing and inverse-hint generation is delegated unmodified to
// the vendored tools under src/vendor/nitro-validator/tools/.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { encodeCall, keccak256, prepareHintedAttestationCalls } = require(
  "../src/vendor/nitro-validator/tools/hinted_attestation_calls",
);
const { decodeBytes, repairMissingPublicKeyBytes } = require(
  "../src/vendor/nitro-validator/tools/nitro_attestation_input",
);

const DEFAULT_RPC_URL = "https://testnet-rpc.monad.xyz";
const MAX_SLOTS = 8;
const FALLBACK_GAS_LIMIT = 15_000_000n;
const GAS_ESTIMATE_RETRY_ATTEMPTS = 5;
const GAS_ESTIMATE_RETRY_DELAY_MS = 500;
const GAS_BUFFER_NUMERATOR = 110n;
const GAS_BUFFER_DENOMINATOR = 100n;

const KNOWN_ERRORS = [
  { signature: "AttestationTooOld(uint64)", types: ["uint64"] },
  { signature: "AppDoesNotExist(bytes32)", types: ["bytes32"] },
  { signature: "AppIsPaused(bytes32)", types: ["bytes32"] },
  { signature: "ImageNotAllowed(bytes32,bytes32)", types: ["bytes32", "bytes32"] },
  { signature: "ZeroPcrs(bytes32)", types: ["bytes32"] },
  { signature: "AttestationMissingPublicKey()", types: [] },
  { signature: "SignerAlreadyRegistered(address)", types: ["address"] },
  { signature: "AppAlreadyExists(bytes32)", types: ["bytes32"] },
];

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  main();
}

function main() {
  const [, , command, ...rest] = process.argv;

  Promise.resolve()
    .then(async () => {
      const options = parseFlags(rest);

      if (command === "plan-register") {
        const manifest = await planRegister({
          attestation: requireOption(options, "attestation"),
          appId: requireOption(options, "app-id"),
          certManager: requireOption(options, "cert-manager"),
          validator: requireOption(options, "validator"),
          registry: requireOption(options, "registry"),
          rpcUrl: options["rpc-url"] || DEFAULT_RPC_URL,
          from: requireOption(options, "from"),
          outDir: requireOption(options, "out"),
          repair: options.repair === "true",
        });
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      } else if (command === "plan-allow-image") {
        const manifest = await planAllowImage({
          appId: requireOption(options, "app-id"),
          pcr0: requireOption(options, "pcr0"),
          pcr1: requireOption(options, "pcr1"),
          pcr2: requireOption(options, "pcr2"),
          registry: requireOption(options, "registry"),
          rpcUrl: options["rpc-url"] || DEFAULT_RPC_URL,
          from: requireOption(options, "from"),
          outDir: requireOption(options, "out"),
        });
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      } else {
        usage();
        process.exitCode = 2;
      }
    })
    .catch((err) => {
      process.stderr.write(`${(err && err.stack) || err}\n`);
      process.exitCode = 1;
    });
}

function usage() {
  process.stderr.write(`Usage:
  node tools/registrar.js plan-register --attestation <hex|base64|@file> --app-id <0x-bytes32> \\
      --cert-manager <addr> --validator <addr> --registry <addr> --from <addr> --out <dir> \\
      [--rpc-url <url>] [--repair true]

  node tools/registrar.js plan-allow-image --app-id <0x-bytes32> \\
      --pcr0 <48-byte hex> --pcr1 <48-byte hex> --pcr2 <48-byte hex> \\
      --registry <addr> --from <addr> --out <dir> [--rpc-url <url>]

Writes tx{N}_to.txt / tx{N}_calldata.txt / tx{N}_label.txt / tx{N}_gaslimit.txt slots into --out,
consumable by script/SubmitCalldataDir.s.sol, plus a manifest.json describing the plan.
`);
}

// ---------------------------------------------------------------------------
// plan-register
// ---------------------------------------------------------------------------

async function planRegister({ attestation, appId, certManager, validator, registry, rpcUrl, from, outDir, repair }) {
  validateAddress(certManager, "cert-manager");
  validateAddress(validator, "validator");
  validateAddress(registry, "registry");
  validateAddress(from, "from");
  const appIdHex = validateBytes32(appId, "app-id");

  let attestationBytes = decodeBytes(attestation);
  if (repair) {
    attestationBytes = repairMissingPublicKeyBytes(attestationBytes);
  }

  const plan = prepareHintedAttestationCalls(attestationBytes, { certManager, validator });

  // plan.cold is [...cert-cache txs, final validate-attestation tx]. The cert-cache txs are the
  // only ones eligible to be skipped when already cached; the attestation itself is re-validated
  // (cheaply, from cache) as part of registerEnclave below, so we never submit it standalone.
  const certCacheTxs = plan.cold.slice(0, -1);
  if (certCacheTxs.length + 1 > MAX_SLOTS) {
    throw new Error(
      `attestation cert bundle needs ${certCacheTxs.length + 1} transactions, ` +
        `which exceeds the ${MAX_SLOTS}-slot limit of SubmitCalldataDir.s.sol`,
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  clearSlots(outDir);

  const manifest = {
    schema: "cobalt.registrar.plan-register.v1",
    appId: appIdHex,
    certManager,
    validator,
    registry,
    rpcUrl,
    from,
    slots: [],
  };

  let slot = 1;
  for (const tx of certCacheTxs) {
    const cached = await isCertCached(rpcUrl, certManager, tx.certHash);
    if (cached) {
      manifest.slots.push({ slot: null, label: tx.label, to: tx.to, certHash: tx.certHash, skipped: true, reason: "already cached on-chain" });
      continue;
    }

    const gasLimit = await estimateGasLimit({ rpcUrl, from, to: tx.to, data: tx.calldata });
    writeSlot(outDir, slot, tx.to, tx.calldata, tx.label, gasLimit);
    manifest.slots.push({
      slot,
      label: tx.label,
      to: tx.to,
      certHash: tx.certHash,
      skipped: false,
      gasLimit: gasLimit.toString(),
    });
    slot += 1;
  }

  // The final registerEnclave call. This is NEVER skipped -- a revert here (e.g.
  // SignerAlreadyRegistered) is meaningful and must surface, not be swallowed like a cached cert.
  const warmTx = plan.warm[0];
  const registerCalldata = encodeCall("registerEnclave(bytes32,bytes,bytes,bytes)", [
    { type: "bytes32", value: appIdHex },
    { type: "bytes", value: hexToBuffer(warmTx.args.attestationTbs) },
    { type: "bytes", value: hexToBuffer(warmTx.args.signature) },
    { type: "bytes", value: hexToBuffer(warmTx.args.attestationHints) },
  ]);

  const registerGasLimit = await estimateGasLimit({ rpcUrl, from, to: registry, data: registerCalldata });
  writeSlot(outDir, slot, registry, registerCalldata, "register enclave", registerGasLimit);
  manifest.slots.push({
    slot,
    label: "register enclave",
    to: registry,
    skipped: false,
    gasLimit: registerGasLimit.toString(),
  });

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---------------------------------------------------------------------------
// plan-allow-image
// ---------------------------------------------------------------------------

async function planAllowImage({ appId, pcr0, pcr1, pcr2, registry, rpcUrl, from, outDir }) {
  validateAddress(registry, "registry");
  validateAddress(from, "from");
  const appIdHex = validateBytes32(appId, "app-id");

  const pcr0Buf = decodeFixedHexBuffer(pcr0, 48, "pcr0");
  const pcr1Buf = decodeFixedHexBuffer(pcr1, 48, "pcr1");
  const pcr2Buf = decodeFixedHexBuffer(pcr2, 48, "pcr2");
  const pcrSetHash = computePcrSetHash(pcr0Buf, pcr1Buf, pcr2Buf);

  fs.mkdirSync(outDir, { recursive: true });
  clearSlots(outDir);

  const calldata = encodeCall("setAllowedImage(bytes32,bytes32)", [
    { type: "bytes32", value: appIdHex },
    { type: "bytes32", value: pcrSetHash },
  ]);

  const gasLimit = await estimateGasLimit({ rpcUrl, from, to: registry, data: calldata });
  writeSlot(outDir, 1, registry, calldata, "set allowed image", gasLimit);

  const manifest = {
    schema: "cobalt.registrar.plan-allow-image.v1",
    appId: appIdHex,
    registry,
    rpcUrl,
    from,
    pcrSetHash,
    slots: [{ slot: 1, label: "set allowed image", to: registry, skipped: false, gasLimit: gasLimit.toString() }],
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---------------------------------------------------------------------------
// PCR / image identity
// ---------------------------------------------------------------------------

function computePcrSetHash(pcr0, pcr1, pcr2) {
  for (const [name, buf] of [["pcr0", pcr0], ["pcr1", pcr1], ["pcr2", pcr2]]) {
    if (buf.length !== 48) throw new Error(`${name} must be exactly 48 bytes, got ${buf.length}`);
  }
  return `0x${keccak256(Buffer.concat([pcr0, pcr1, pcr2])).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Cert-cache lookup: is this cert hash already loaded into the deployed CertManager?
// ---------------------------------------------------------------------------

async function isCertCached(rpcUrl, certManager, certHashHex) {
  const selector = keccak256(Buffer.from("loadVerified(bytes32)", "ascii")).subarray(0, 4).toString("hex");
  const paddedHash = hexToBuffer(certHashHex);
  const data = `0x${selector}${paddedHash.toString("hex").padStart(64, "0")}`;

  const result = await rpcCall(rpcUrl, "eth_call", [{ to: certManager, data }, "latest"]);
  const words = splitWords(result);
  // Return layout for a single dynamic struct: word0 = outer offset, word1..word5 = the 5
  // VerifiedCert fields (ca, notAfter, maxPathLen, subjectHash, pubKey-offset), word6 =
  // pubKey.length. A cert with an empty pubKey has never been verified/cached.
  if (words.length < 7) return false;
  return BigInt(`0x${words[6]}`) > 0n;
}

// ---------------------------------------------------------------------------
// Gas estimation: live RPC estimate -> fresh-process retries -> fixed generous fallback.
// ---------------------------------------------------------------------------

async function estimateGasLimit({ rpcUrl, from, to, data }) {
  const txParams = { from, to, data };

  // Layer 1: a live estimate, in-process.
  try {
    const estimate = await rpcCall(rpcUrl, "eth_estimateGas", [txParams]);
    return applyGasBuffer(BigInt(estimate));
  } catch {
    // fall through to retries
  }

  // Layer 2: retry in a series of FRESH node child processes, not just in-process retries.
  // HTTP keep-alive can pin a process to one stale RPC backend behind a load balancer, so a
  // brand-new process (and therefore a brand-new connection) is what actually gets a fresh
  // routing decision.
  for (let attempt = 0; attempt < GAS_ESTIMATE_RETRY_ATTEMPTS; attempt++) {
    try {
      const estimate = estimateGasInFreshProcess(rpcUrl, txParams);
      return applyGasBuffer(estimate);
    } catch {
      if (attempt < GAS_ESTIMATE_RETRY_ATTEMPTS - 1) {
        await sleep(GAS_ESTIMATE_RETRY_DELAY_MS);
      }
    }
  }

  // Layer 3: a fixed, generous fallback. Monad testnet gas is free, and the real broadcast will
  // revert honestly if this estimate turns out to be wrong -- better to proceed than to block.
  return FALLBACK_GAS_LIMIT;
}

function estimateGasInFreshProcess(rpcUrl, txParams) {
  const script = `
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      const { rpcUrl, txParams } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [txParams] }),
      })
        .then((res) => res.json())
        .then((body) => {
          if (body.error) {
            process.stderr.write(JSON.stringify(body.error));
            process.exit(1);
          }
          process.stdout.write(String(body.result));
        })
        .catch((err) => {
          process.stderr.write(String((err && err.stack) || err));
          process.exit(1);
        });
    });
  `;
  const result = execFileSync("node", ["-e", script], {
    input: JSON.stringify({ rpcUrl, txParams }),
    encoding: "utf8",
  });
  return BigInt(result.trim());
}

function applyGasBuffer(estimate) {
  return (estimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// JSON-RPC + revert-reason decoding
// ---------------------------------------------------------------------------

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) {
    const decoded = decodeRevertReason(extractRevertData(body.error));
    const suffix = decoded ? ` (${decoded.name}${decoded.args.length ? `: ${decoded.args.join(", ")}` : ""})` : "";
    const err = new Error(`${body.error.message || "RPC error"}${suffix}`);
    err.rpcError = body.error;
    err.decoded = decoded;
    throw err;
  }
  return body.result;
}

function extractRevertData(rpcError) {
  if (!rpcError) return null;
  if (typeof rpcError.data === "string") return rpcError.data;
  if (rpcError.data && typeof rpcError.data.data === "string") return rpcError.data.data;
  return null;
}

function decodeRevertReason(dataHex) {
  if (!dataHex || dataHex === "0x") return null;
  const raw = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (raw.length < 8) return null;

  const selector = raw.slice(0, 8);
  const entry = KNOWN_ERRORS.find(
    (candidate) => keccak256(Buffer.from(candidate.signature, "ascii")).subarray(0, 4).toString("hex") === selector,
  );
  if (!entry) return null;

  const words = splitWords(`0x${raw.slice(8)}`);
  const args = entry.types.map((type, i) => decodeErrorArg(type, words[i]));
  return { name: entry.signature, args };
}

function decodeErrorArg(type, word) {
  if (word === undefined) return null;
  if (type === "address") return `0x${word.slice(24)}`;
  if (type.startsWith("uint")) return BigInt(`0x${word}`).toString();
  return `0x${word}`;
}

function splitWords(hexValue) {
  const raw = (hexValue || "").startsWith("0x") ? hexValue.slice(2) : hexValue || "";
  const words = [];
  for (let i = 0; i + 64 <= raw.length; i += 64) {
    words.push(raw.slice(i, i + 64));
  }
  return words;
}

// ---------------------------------------------------------------------------
// Calldata slot files
// ---------------------------------------------------------------------------

function slotPaths(dir, index) {
  return {
    to: path.join(dir, `tx${index}_to.txt`),
    calldata: path.join(dir, `tx${index}_calldata.txt`),
    label: path.join(dir, `tx${index}_label.txt`),
    gaslimit: path.join(dir, `tx${index}_gaslimit.txt`),
  };
}

// Deletes ALL FOUR file types for every slot before a new plan writes into the directory.
// A leftover *_gaslimit.txt from a previous run must never silently apply to an unrelated call.
function clearSlots(dir) {
  for (let i = 1; i <= MAX_SLOTS; i++) {
    for (const filePath of Object.values(slotPaths(dir, i))) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
}

function writeSlot(dir, slot, to, calldata, label, gasLimit) {
  const paths = slotPaths(dir, slot);
  fs.writeFileSync(paths.to, to);
  fs.writeFileSync(paths.calldata, calldata);
  fs.writeFileSync(paths.label, label);
  if (gasLimit !== undefined && gasLimit !== null) {
    fs.writeFileSync(paths.gaslimit, gasLimit.toString());
  }
}

// ---------------------------------------------------------------------------
// Small parsing / validation helpers
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !key.startsWith("--") || value === undefined) {
      throw new Error(`malformed argument near "${key || ""}"`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function requireOption(options, name) {
  if (options[name] === undefined) throw new Error(`missing --${name}`);
  return options[name];
}

function validateAddress(address, label) {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`--${label} must be a 0x-prefixed 20-byte address, got: ${address}`);
  }
  return `0x${address.slice(2).toLowerCase()}`;
}

function validateBytes32(value, label) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`--${label} must be a 0x-prefixed 32-byte hex value, got: ${value}`);
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

function decodeFixedHexBuffer(value, length, label) {
  if (!value) throw new Error(`missing --${label}`);
  const raw = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (raw.length !== length * 2 || !/^[0-9a-f]+$/i.test(raw)) {
    throw new Error(`--${label} must be exactly ${length} bytes of hex, got ${raw.length / 2} bytes`);
  }
  return Buffer.from(raw, "hex");
}

function hexToBuffer(hexValue) {
  const raw = hexValue.startsWith("0x") || hexValue.startsWith("0X") ? hexValue.slice(2) : hexValue;
  return Buffer.from(raw, "hex");
}

module.exports = {
  planRegister,
  planAllowImage,
  isCertCached,
  computePcrSetHash,
  estimateGasLimit,
  decodeRevertReason,
  writeSlot,
  clearSlots,
  validateAddress,
  validateBytes32,
  decodeFixedHexBuffer,
};
