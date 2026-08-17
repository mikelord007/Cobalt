#!/usr/bin/env node
// The Cobalt CLI: takes an app directory through attest -> createApp -> setAllowedImage ->
// registerEnclave -> verify against an already-deployed, already-multi-tenant registry. This is
// the platform's actual deliverable -- everything else exists to make this one command possible.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Two distinct roots, deliberately not conflated:
//  - PACKAGE_ROOT: wherever npm actually installed this package (global prefix, a local
//    node_modules/, or this repo itself in dev). This is where the CLI's OWN code lives
//    (tools/, scripts/) and where install-foundry.js's postinstall bundles Foundry -- fixed,
//    always writable by whoever ran the install.
//  - projectRoot (see resolveProjectRoot() below): the user's own Cobalt checkout -- where
//    foundry.toml, lib/, script/, enclave-server/, examples/ and deployments/ live, and where
//    every deploy writes its mutable state (.work-calldata/, enclave-server/deployments/, forge's
//    out/cache/broadcast). Resolved fresh per command from the app directory, NOT assumed to be
//    PACKAGE_ROOT -- a global install's directory is frequently root-owned/read-only, and the
//    README's documented flow already requires a `git clone` to run `cobalt deploy` at all, so
//    that clone is where deploy state should actually land.
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const registrar = require(path.join(PACKAGE_ROOT, "tools", "registrar.js"));

const DEFAULT_RPC_URL = "https://testnet-rpc.monad.xyz";
const DEFAULT_SIGNER_TTL = "2592000"; // 30 days

// `npm install -g cobalt-tee`'s postinstall (scripts/install-foundry.js) downloads Foundry
// straight from GitHub when it isn't already on PATH, and drops forge/cast/anvil/chisel into
// <package-root>/.bin-foundry/ -- it deliberately does NOT touch the user's PATH (fragile/invasive
// from a postinstall, and often needs a fresh shell anyway). So every place below that shells out
// to "cast"/"forge" resolves through here instead: bundled copy first, PATH second. This makes the
// two ways Foundry can end up available (auto-installed vs. already installed some other way)
// transparent to the rest of this file. Bundled under PACKAGE_ROOT, not projectRoot: it's
// install-time state tied to this one npm install, reused across whatever project directories you
// later point `cobalt` at.
const BUNDLED_FOUNDRY_DIR = path.join(PACKAGE_ROOT, ".bin-foundry");

function foundryBinName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function resolveFoundryBin(name) {
  const bundled = path.join(BUNDLED_FOUNDRY_DIR, foundryBinName(name));
  if (fs.existsSync(bundled)) return bundled;
  return name; // fall back to PATH
}

const CAST_BIN = resolveFoundryBin("cast");
const FORGE_BIN = resolveFoundryBin("forge");

// Walks up from an app directory looking for the nearest ancestor that looks like a real Cobalt
// checkout (has both foundry.toml and enclave-server/), and uses that as the project root for
// everything deploy-related: forge's cwd, .work-calldata/, enclave-server/deployments/,
// deployments/monad-testnet.json. Falls back to PACKAGE_ROOT only if THAT happens to look like a
// checkout too (true for a `git clone` used in place, false for a typical global npm install,
// which no longer ships those files at all -- see package.json's "files"). Otherwise this is a
// clear, fixable user error, not something to paper over by guessing.
function hasProjectMarkers(dir) {
  return fs.existsSync(path.join(dir, "foundry.toml")) && fs.existsSync(path.join(dir, "enclave-server"));
}

function resolveProjectRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (hasProjectMarkers(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  if (hasProjectMarkers(PACKAGE_ROOT)) return PACKAGE_ROOT;
  throw new Error(
    `could not find a Cobalt checkout (a directory containing both foundry.toml and enclave-server/) ` +
      `above ${startDir}. "cobalt deploy"/"cobalt status" need to run against an app directory that's ` +
      `inside a full checkout -- see the README's Install section ("git clone ... && cd Cobalt").`,
  );
}

// Resolves a real POSIX shell to run enclave-server/deploy_and_attest.sh (and the --attest-cmd
// escape hatch) through -- explicitly, as an argv[0], never via Node's `shell: true`. On win32,
// `shell: true` always spawns cmd.exe regardless of which shell you typed this command into
// (including Git Bash -- Node still shells out through cmd.exe, which can't find `bash` on the
// PATH it gets, or even parse a POSIX-style PATH if it happens to inherit one). So this resolves
// an actual bash.exe up front and calls it directly, with no shell layer in between.
function resolveBash() {
  if (process.env.COBALT_BASH) return process.env.COBALT_BASH;
  if (process.platform !== "win32") return "/bin/bash";

  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const found = execFileSync("where.exe", ["bash"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch {
    // where.exe found nothing (or isn't itself on PATH) -- fall through to the error below.
  }
  throw new Error(
    "no bash found. The attest step runs a real bash script (enclave-server/deploy_and_attest.sh) and " +
      "needs a real POSIX shell -- Windows has none built in. Install Git for Windows " +
      "(https://git-scm.com/downloads/win), which bundles one, or run this whole command from inside WSL " +
      "(https://learn.microsoft.com/windows/wsl/install) instead, where cobalt runs as a normal Linux CLI " +
      "with no special-casing needed. Set $COBALT_BASH to point at a specific bash.exe directly.",
  );
}

function main() {
  const [, , command, ...rest] = process.argv;
  if (command === "deploy") return deployCommand(rest);
  if (command === "status") return statusCommand(rest);
  usage();
  process.exit(command ? 1 : 0);
}

function usage() {
  console.log(`usage:
  node tools/cobalt.js deploy <app-dir> [options]
  node tools/cobalt.js status <app-dir> [options]

deploy options:
  --app-name <name>            defaults to <app-dir>'s basename, or cobalt.json's "name"
  --secrets <path>              path to a JSON secrets file (relative to app-dir), passed to the attest command
  --attest-cmd "<cmd>"          overrides the default attest command (see below)
  --manifest-path <path>        read the deploy manifest from here instead of the attest command's stdout
  --attestation <hex|@file>     skip the attest step; provide the attestation directly
  --pcr0 / --pcr1 / --pcr2 <hex>   required alongside --attestation (48 bytes each)
  --eth-address <addr>          required alongside --attestation
  --app-id <bytes32>            defaults to keccak256(app-name)
  --signer-ttl <seconds>        defaults to 2592000 (30 days)
  --source-commit <bytes32>     defaults to the zero hash
  --source-uri <string>         defaults to ""
  --registry / --cert-manager / --validator <addr>   default from deployments/monad-testnet.json
  --rpc-url <url>                default from deployments/monad-testnet.json, else ${DEFAULT_RPC_URL}
  --dry-run true                 stop after planning, don't broadcast anything

Default attest command:
  bash enclave-server/deploy_and_attest.sh <app-name> --secrets <resolved-secrets-path>

Requires PRIVATE_KEY in the environment for every write step -- and even for --dry-run, since
live eth_estimateGas needs a real sender to price Monad gas accurately.
`);
}

// ---------------------------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------------------------

async function deployCommand(args) {
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("error: <app-dir> is required");
    usage();
    process.exit(2);
  }
  const appDir = path.resolve(args[0]);
  const options = parseFlags(args.slice(1));

  if (!fs.existsSync(appDir)) {
    console.error(`error: app directory does not exist: ${appDir}`);
    process.exit(1);
  }
  const projectRoot = resolveProjectRoot(appDir);

  checkFoundryOnPath();
  const privateKey = requireEnv("PRIVATE_KEY");
  const from = castWalletAddress(privateKey);

  const config = loadAppConfig(appDir);
  const chainDefaults = loadChainDefaults(projectRoot);

  const appName = options["app-name"] || config.name || path.basename(appDir);
  const appId = normalizeBytes32(options["app-id"] || config.appId || keccak256Hex(appName));
  const signerTTL = options["signer-ttl"] || config.signerTTL || DEFAULT_SIGNER_TTL;
  const sourceCommit = normalizeBytes32(options["source-commit"] || config.sourceCommit || "0x00");
  const sourceURI = options["source-uri"] || config.sourceURI || "";

  const rpcUrl = options["rpc-url"] || chainDefaults.rpcUrl || DEFAULT_RPC_URL;
  const registry = registrar.validateAddress(options["registry"] || config.registry || chainDefaults.registry, "registry");
  const certManager = registrar.validateAddress(options["cert-manager"] || config.certManager || chainDefaults.certManager, "cert-manager");
  const validator = registrar.validateAddress(options["validator"] || config.validator || chainDefaults.validator, "validator");
  const dryRun = options["dry-run"] === "true";

  console.log(`==> deploying "${appName}" (appId ${appId})`);

  // 1. attest
  const manifest = await resolveManifest(appDir, options, appName, projectRoot);
  console.log(`==> attestation ready: eth_address ${manifest.eth_address}`);
  console.log(`    pcr0 ${manifest.pcrs.pcr0}`);
  console.log(`    pcr1 ${manifest.pcrs.pcr1}`);
  console.log(`    pcr2 ${manifest.pcrs.pcr2}`);

  // 2. createApp
  const exists = appExists(registry, appId, rpcUrl);
  if (!exists) {
    console.log("==> app does not exist on-chain yet, calling createApp");
    if (!dryRun) {
      castSend(registry, "createApp(bytes32,uint32,bytes32,string)", [appId, signerTTL, sourceCommit, sourceURI], rpcUrl, privateKey);
    }
  } else {
    console.log("==> app already exists, skipping createApp");
  }

  // 3. setAllowedImage
  // Guard: isImageAllowed compares allowedImageVersion[appId][hash] against apps[appId].configVersion
  // -- for an app that doesn't exist yet, BOTH default to zero, so the raw view spuriously returns
  // true. Only trust it once we know the app really exists (or we just created it above).
  const pcrSetHash = registrar.computePcrSetHash(
    registrar.decodeFixedHexBuffer(manifest.pcrs.pcr0, 48, "pcr0"),
    registrar.decodeFixedHexBuffer(manifest.pcrs.pcr1, 48, "pcr1"),
    registrar.decodeFixedHexBuffer(manifest.pcrs.pcr2, 48, "pcr2"),
  );
  const alreadyAllowed = exists || !dryRun ? isImageAllowed(registry, appId, pcrSetHash, rpcUrl) : false;
  if (!alreadyAllowed) {
    console.log(`==> image not yet allowed (pcrSetHash ${pcrSetHash}), calling setAllowedImage`);
    if (!dryRun) {
      const outDir = path.join(projectRoot, ".work-calldata", `allow-image-${sanitize(appName)}`);
      const plan = await registrar.planAllowImage({
        appId, pcr0: manifest.pcrs.pcr0, pcr1: manifest.pcrs.pcr1, pcr2: manifest.pcrs.pcr2,
        registry, rpcUrl, from, outDir,
      });
      broadcastCalldataDir(outDir, { rpcUrl, privateKey, from, projectRoot });
      void plan;
    }
  } else {
    console.log("==> image already allowed, skipping setAllowedImage");
  }

  // 4. registerEnclave -- never skipped. If the signer is already registered, that's a
  // meaningful revert (SignerAlreadyRegistered), not something to silently swallow.
  console.log("==> registering the enclave's attestation");
  if (!dryRun) {
    const outDir = path.join(projectRoot, ".work-calldata", `register-${sanitize(appName)}`);
    await registrar.planRegister({
      attestation: manifest.attestation, appId, certManager, validator, registry, rpcUrl, from, outDir,
    });
    broadcastCalldataDir(outDir, { rpcUrl, privateKey, from, projectRoot });
  }

  // 5. verify
  if (!dryRun) {
    const valid = isValidSigner(registry, appId, manifest.eth_address, rpcUrl);
    if (!valid) {
      console.error(`error: isValidSigner(${appId}, ${manifest.eth_address}) is false after registration.`);
      console.error("check the EnclaveRegistered event's actual signer -- it may not match the manifest's eth_address.");
      process.exit(1);
    }
    console.log(`==> verified: ${manifest.eth_address} is a valid signer for ${appId}`);
    console.log("==> deploy complete");
    console.log(JSON.stringify({ appId, appName, registry, ethAddress: manifest.eth_address, pcrSetHash }, null, 2));
  } else {
    console.log("==> dry run complete, nothing broadcast");
  }
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

function statusCommand(args) {
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("error: <app-dir> is required");
    usage();
    process.exit(2);
  }
  const appDir = path.resolve(args[0]);
  const options = parseFlags(args.slice(1));
  const projectRoot = resolveProjectRoot(appDir);

  checkFoundryOnPath();
  const config = loadAppConfig(appDir);
  const chainDefaults = loadChainDefaults(projectRoot);

  const appName = options["app-name"] || config.name || path.basename(appDir);
  const appId = normalizeBytes32(options["app-id"] || config.appId || keccak256Hex(appName));
  const rpcUrl = options["rpc-url"] || chainDefaults.rpcUrl || DEFAULT_RPC_URL;
  const registry = registrar.validateAddress(options["registry"] || config.registry || chainDefaults.registry, "registry");

  const out = castCall(registry, "apps(bytes32)(address,uint64,uint32,bool,bool,bytes32,string)", [appId], rpcUrl);
  const [owner, configVersion, signerTTL, paused, exists] = out;

  console.log(`app        ${appName} (${appId})`);
  console.log(`registry   ${registry}`);
  if (exists !== "true") {
    console.log("exists     false -- createApp has not been called for this app yet");
    return;
  }
  console.log(`owner      ${owner}`);
  console.log(`configVer  ${configVersion}`);
  console.log(`signerTTL  ${signerTTL}s`);
  console.log(`paused     ${paused}`);

  const deployManifestPath = path.join(projectRoot, "enclave-server", "deployments", appName, "manifest.json");
  if (fs.existsSync(deployManifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(deployManifestPath, "utf8"));
    const valid = isValidSigner(registry, appId, manifest.eth_address, rpcUrl);
    console.log(`signer     ${manifest.eth_address} -- currently valid: ${valid}`);
  }
}

// ---------------------------------------------------------------------------------------------
// manifest resolution (the attest step)
// ---------------------------------------------------------------------------------------------

async function resolveManifest(appDir, options, appName, projectRoot) {
  if (options["attestation"]) {
    const eth = options["eth-address"];
    if (!eth) throw new Error("--eth-address is required alongside --attestation");
    return normalizeManifest({
      attestation: options["attestation"],
      pcrs: { pcr0: requireOpt(options, "pcr0"), pcr1: requireOpt(options, "pcr1"), pcr2: requireOpt(options, "pcr2") },
      eth_address: eth,
    }, projectRoot);
  }

  let manifest;
  if (options["manifest-path"]) {
    manifest = JSON.parse(fs.readFileSync(path.resolve(options["manifest-path"]), "utf8"));
  } else {
    const bash = resolveBash();
    let stdout;
    if (options["attest-cmd"]) {
      // Escape hatch for a fully custom attest command -- still a shell string by nature (it's
      // meant to be arbitrary), so it still needs a real shell to interpret it. Explicit
      // `bash -c`, never Node's shell:true (which on Windows always means cmd.exe, and cmd.exe
      // can neither run bash syntax nor reliably find `bash` itself -- see resolveBash()).
      console.log(`==> running attest command: ${options["attest-cmd"]}`);
      stdout = execFileSync(bash, ["-c", options["attest-cmd"]], {
        cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
      });
    } else {
      const secrets = options["secrets"];
      if (!secrets) throw new Error("--secrets is required for the default attest command");
      const secretsPath = path.isAbsolute(secrets) ? secrets : path.join(appDir, secrets);
      if (!fs.existsSync(secretsPath)) throw new Error(`secrets file does not exist: ${secretsPath}`);
      const scriptPath = path.join(projectRoot, "enclave-server", "deploy_and_attest.sh");
      // Argv array, not a shell string: no quoting layer needed here at all, and it behaves
      // identically whether `bash` turns out to be Git Bash, WSL's bash, or a native one.
      console.log(`==> running attest command: ${bash} ${scriptPath} ${appName} --secrets ${secretsPath}`);
      stdout = execFileSync(bash, [scriptPath, appName, "--secrets", secretsPath], {
        cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
      });
    }
    manifest = parseManifestFromStdout(stdout);
    if (!manifest) {
      const fallbackPath = path.join(projectRoot, "enclave-server", "deployments", appName, "manifest.json");
      if (fs.existsSync(fallbackPath)) manifest = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
    }
    if (!manifest) throw new Error("could not resolve a deploy manifest from the attest command's output");
  }
  return normalizeManifest(manifest, projectRoot);
}

function parseManifestFromStdout(stdout) {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && (parsed.pcrs || parsed.attestation || parsed.attestation_path)) return parsed;
    } catch {
      // not JSON, keep scanning upward
    }
  }
  return null;
}

function normalizeManifest(manifest, projectRoot) {
  if (!manifest.pcrs || !manifest.pcrs.pcr0 || !manifest.pcrs.pcr1 || !manifest.pcrs.pcr2) {
    throw new Error("manifest is missing pcr0/pcr1/pcr2");
  }
  let attestation = manifest.attestation;
  if (!attestation && manifest.attestation_path) {
    const attestationPath = path.isAbsolute(manifest.attestation_path)
      ? manifest.attestation_path
      : path.join(projectRoot, manifest.attestation_path);
    attestation = JSON.parse(fs.readFileSync(attestationPath, "utf8")).attestation;
  }
  if (!attestation) throw new Error("manifest has neither attestation nor attestation_path");
  if (!manifest.eth_address) throw new Error("manifest is missing eth_address");
  return {
    attestation: attestation.startsWith("0x") ? attestation : `0x${attestation}`,
    pcrs: manifest.pcrs,
    eth_address: manifest.eth_address,
  };
}

// ---------------------------------------------------------------------------------------------
// chain reads/writes
// ---------------------------------------------------------------------------------------------

function appExists(registry, appId, rpcUrl) {
  const out = castCall(registry, "apps(bytes32)(address,uint64,uint32,bool,bool,bytes32,string)", [appId], rpcUrl);
  return out[4] === "true";
}

function isImageAllowed(registry, appId, pcrSetHash, rpcUrl) {
  const out = castCall(registry, "isImageAllowed(bytes32,bytes32)(bool)", [appId, pcrSetHash], rpcUrl);
  return out[0] === "true";
}

function isValidSigner(registry, appId, signer, rpcUrl) {
  const out = castCall(registry, "isValidSigner(bytes32,address)(bool)", [appId, signer], rpcUrl);
  return out[0] === "true";
}

function castCall(to, sig, args, rpcUrl) {
  const out = execFileSync(CAST_BIN, ["call", to, sig, ...args, "--rpc-url", rpcUrl], { encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function castSend(to, sig, args, rpcUrl, privateKey) {
  execFileSync(CAST_BIN, ["send", to, sig, ...args.map(String), "--rpc-url", rpcUrl, "--private-key", privateKey], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function castWalletAddress(privateKey) {
  return execFileSync(CAST_BIN, ["wallet", "address", "--private-key", privateKey], { encoding: "utf8" }).trim();
}

// Monad charges the submitted gas LIMIT, not gas used -- so the real cost of a broadcast is
// bounded by the sum of the calldata dir's own per-slot limits, not by what actually gets
// consumed. Check this against the sender's live balance BEFORE invoking forge: a silent
// multi-minute stall (observed once, likely a transient RPC hiccup layered on top of this same
// condition) is a much worse failure mode than an immediate, clear error here.
function preflightBalanceCheck(dir, { rpcUrl, from }) {
  let totalGas = 0n;
  for (let slot = 1; slot <= 8; slot++) {
    const gasLimitPath = path.join(dir, `tx${slot}_gaslimit.txt`);
    if (fs.existsSync(gasLimitPath)) totalGas += BigInt(fs.readFileSync(gasLimitPath, "utf8").trim());
  }
  if (totalGas === 0n) return;
  const gasPriceHex = execFileSync(CAST_BIN, ["gas-price", "--rpc-url", rpcUrl], { encoding: "utf8" }).trim();
  const gasPrice = BigInt(gasPriceHex);
  const balanceWei = BigInt(execFileSync(CAST_BIN, ["balance", from, "--rpc-url", rpcUrl], { encoding: "utf8" }).trim());
  const requiredWei = totalGas * gasPrice;
  if (balanceWei < requiredWei) {
    const toMon = (wei) => (Number(wei) / 1e18).toFixed(4);
    const toGwei = (wei) => (Number(wei) / 1e9).toFixed(2);
    throw new Error(
      `insufficient balance for this broadcast: need up to ~${toMon(requiredWei)} MON ` +
        `(${totalGas} total gas limit at ${toGwei(gasPrice)} gwei), have ${toMon(balanceWei)} MON. ` +
        `Fund ${from} on Monad testnet before retrying.`,
    );
  }
}

function broadcastCalldataDir(dir, { rpcUrl, privateKey, from, projectRoot, gasMultiplier = "110" }) {
  preflightBalanceCheck(dir, { rpcUrl, from });
  const out = execFileSync(
    FORGE_BIN,
    ["script", "script/SubmitCalldataDir.s.sol:SubmitCalldataDir", "--rpc-url", rpcUrl, "--broadcast", "-g", String(gasMultiplier)],
    {
      cwd: projectRoot,
      // Forward slashes even on Windows: script/SubmitCalldataDir.s.sol concatenates this with
      // "/txN_calldata.txt" directly, and foundry.toml's fs_permissions matching is
      // separator-sensitive -- a raw Windows path here (backslashes) has been observed to trip it.
      env: { ...process.env, CALLDATA_DIR: toPosixPath(dir), PRIVATE_KEY: privateKey },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10 * 60 * 1000, // never hang silently, regardless of root cause -- fail loudly after 10 minutes
    },
  );
  console.log(out);
}

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function loadAppConfig(appDir) {
  const configPath = path.join(appDir, "cobalt.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function loadChainDefaults(projectRoot) {
  const deployPath = path.join(projectRoot, "deployments", "monad-testnet.json");
  if (!fs.existsSync(deployPath)) return {};
  const d = JSON.parse(fs.readFileSync(deployPath, "utf8"));
  return { rpcUrl: d.rpcUrl, registry: d.enclaveRegistry, certManager: d.certManager, validator: d.nitroValidator };
}

function parseFlags(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = "true";
    } else {
      options[key] = next;
      i++;
    }
  }
  return options;
}

function requireOpt(options, name) {
  if (!options[name]) throw new Error(`--${name} is required`);
  return options[name];
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in the environment`);
  return value;
}

// Every write/read path shells out to Foundry's `cast` (and `forge` for broadcasting) -- without
// it, execFileSync fails with a raw, confusing "ENOENT" deep inside some unrelated step. Check
// once, upfront, and fail with an actionable message instead. Checks the bundled copy at
// .bin-foundry/ (see resolveFoundryBin() above) first, then PATH, same as every call site above.
function checkFoundryOnPath() {
  for (const [tool, bin] of [["cast", CAST_BIN], ["forge", FORGE_BIN]]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(
          `'${tool}' was not found (checked ${bin === tool ? "PATH" : bin} and PATH). The Cobalt CLI requires ` +
            `Foundry (cast + forge) to be installed -- if you installed via "npm install -g cobalt-tee" this ` +
            `should have happened automatically; check the npm install output above for a Foundry auto-install ` +
            `warning. Otherwise see https://getfoundry.sh to install it manually. If you already installed it, ` +
            `this is likely a PATH issue: foundryup sometimes only wires "%USERPROFILE%\\.foundry\\bin" into ` +
            `Unix-style shell profiles, not PowerShell/cmd. Add it to your PATH yourself and open a brand new ` +
            `terminal -- note that simply running cobalt from inside Git Bash does not reliably fix this on its ` +
            `own, since Git Bash can hand Node a POSIX-style PATH that this same lookup can't parse either; ` +
            `WSL (where cobalt runs as a normal Linux CLI) is the more reliable fallback if a PATH edit doesn't work.`,
        );
      }
      // Any other failure (e.g. a non-zero exit from --version) means the binary exists and is
      // runnable, which is all this check cares about -- let the real command surface any deeper
      // problem itself rather than swallowing it here.
    }
  }
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function normalizeBytes32(value) {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  return `0x${hex.padStart(64, "0")}`;
}

function keccak256Hex(value) {
  return execFileSync(CAST_BIN, ["keccak", value], { encoding: "utf8" }).trim();
}

if (require.main === module) {
  Promise.resolve(main()).catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
