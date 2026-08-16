"use client";

import { useEffect, useRef } from "react";
import "./viewer.css";

/**
 * Enclave Registry Viewer. Ported from viewer/index.html, including all of its client-side
 * logic: a from-scratch Keccak-256, a minimal ABI encoder/decoder, raw JSON-RPC over fetch
 * (no library), a chunked/concurrent eth_getLogs scanner with retry/backoff, and the app
 * lookup + signer table rendering.
 *
 * This is a faithful, largely line-for-line port of the original imperative DOM-manipulation
 * script -- it's kept imperative on purpose (rather than rewritten as idiomatic React state)
 * to minimize the chance of subtly changing real functional behavior (live RPC calls, retry
 * logic, log scanning) during the port. The only structural changes from the original:
 *   - All `document.getElementById(id)` calls became `byId(id)`, scoped to this component's
 *     own DOM subtree via a ref, instead of the whole document.
 *   - Everything runs inside a `useEffect` (client-only, after mount) instead of a
 *     `DOMContentLoaded` listener, since this file is never executed during SSR/build.
 *   - Event listeners and in-flight scans are torn down in the effect's cleanup function so
 *     nothing leaks or double-fires if the component ever unmounts/remounts (e.g. React
 *     Strict Mode's mount->cleanup->mount in dev).
 * The RPC defaults (public Monad testnet RPC + the deployed EnclaveRegistry address) and the
 * known "ping" demo app id are unchanged from the original file.
 */
export default function ViewerDashboard() {
  const containerRef = useRef(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const byId = (id) => root.querySelector("#" + id);

    /* =====================================================================================
       0. CONSTANTS
       ===================================================================================== */
    const DEFAULT_RPC = "https://testnet-rpc.monad.xyz";
    // Hardcoded because it's public deployment info (deployments/monad-testnet.json).
    const DEFAULT_REGISTRY = "0xccF281dE61bfb970575827B5c962345F39bDa145";
    const EXPECTED_CHAIN_ID = 10143;

    // Apps whose appId is an explicit value from their cobalt.json config rather than
    // keccak256(name). "ping" is the live demo app referenced in examples/ping/cobalt.json.
    const KNOWN_APPS = {
      ping: "0x3160ada18c530e22627bf2c8c125e08ed5022b770f07efeb2c6ffaf6da861153",
    };

    const EVENT_SIG = "EnclaveRegistered(bytes32,address,bytes32,uint64)";
    const GETLOGS_CHUNK = 100; // inclusive block window per eth_getLogs call (RPC caps ~100)
    const SCAN_CONCURRENCY = 6; // concurrent in-flight eth_getLogs calls
    const DEFAULT_LOOKBACK = 50000; // blocks (~4h at Monad's ~0.3s/block pace)
    const MAX_RETRIES = 6;

    /* =====================================================================================
       1. KECCAK-256 (pure JS, no dependencies)
       Standard Keccak-f[1600] permutation, rate=136 bytes / capacity=64 bytes (256-bit
       security), multi-rate padding with the 0x01 / 0x80 domain-separated pad10*1 rule used
       by Ethereum's keccak256 (this is Keccak, NOT the later NIST SHA3 padding 0x06/0x80).
       ===================================================================================== */
    const KECCAK_MASK64 = (1n << 64n) - 1n;

    const KECCAK_RC = [
      0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
      0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
      0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
      0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
      0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
      0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
    ];

    // Rho rotation offsets r[x + 5y], the standard Keccak reference table.
    const KECCAK_ROT = [
      0n, 1n, 62n, 28n, 27n,
      36n, 44n, 6n, 55n, 20n,
      3n, 10n, 43n, 25n, 39n,
      41n, 45n, 15n, 21n, 8n,
      18n, 2n, 61n, 56n, 14n,
    ];

    function keccakRotl64(x, n) {
      if (n === 0n) return x;
      return ((x << n) | (x >> (64n - n))) & KECCAK_MASK64;
    }

    function keccakF1600(s) {
      const C = new BigUint64Array(5);
      const D = new BigUint64Array(5);
      const B = new BigUint64Array(25);
      for (let round = 0; round < 24; round++) {
        // theta
        for (let x = 0; x < 5; x++) {
          C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
        }
        for (let x = 0; x < 5; x++) {
          D[x] = C[(x + 4) % 5] ^ keccakRotl64(C[(x + 1) % 5], 1n);
        }
        for (let x = 0; x < 5; x++) {
          for (let y = 0; y < 5; y++) {
            s[x + 5 * y] ^= D[x];
          }
        }
        // rho + pi
        for (let x = 0; x < 5; x++) {
          for (let y = 0; y < 5; y++) {
            const newX = y;
            const newY = (2 * x + 3 * y) % 5;
            B[newX + 5 * newY] = keccakRotl64(s[x + 5 * y], KECCAK_ROT[x + 5 * y]);
          }
        }
        // chi
        for (let x = 0; x < 5; x++) {
          for (let y = 0; y < 5; y++) {
            s[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y]);
          }
        }
        // iota
        s[0] ^= KECCAK_RC[round];
      }
    }

    /** keccak256(bytes: Uint8Array) -> Uint8Array(32) */
    function keccak256(bytes) {
      const rate = 136; // bytes
      const state = new BigUint64Array(25);
      const inputLen = bytes.length;
      const numBlocks = Math.floor(inputLen / rate) + 1;
      const padded = new Uint8Array(numBlocks * rate);
      padded.set(bytes);
      padded[inputLen] ^= 0x01;
      padded[padded.length - 1] ^= 0x80;

      for (let offset = 0; offset < padded.length; offset += rate) {
        for (let i = 0; i < rate / 8; i++) {
          let word = 0n;
          for (let b = 7; b >= 0; b--) {
            word = (word << 8n) | BigInt(padded[offset + i * 8 + b]);
          }
          state[i] ^= word;
        }
        keccakF1600(state);
      }

      const out = new Uint8Array(32);
      for (let i = 0; i < 4; i++) {
        let word = state[i];
        for (let b = 0; b < 8; b++) {
          out[i * 8 + b] = Number(word & 0xffn);
          word >>= 8n;
        }
      }
      return out;
    }

    /* =====================================================================================
       2. HEX / BYTE UTILITIES
       ===================================================================================== */
    function strToBytes(s) { return new TextEncoder().encode(s); }
    function bytesToHex(bytes) {
      let out = "";
      for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
      return out;
    }
    function hexToBytes(hex) {
      hex = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
      if (hex.length % 2 !== 0) hex = "0" + hex;
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }
    function bytesToBigInt(bytes) {
      let v = 0n;
      for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
      return v;
    }

    /* =====================================================================================
       3. EIP-55 CHECKSUM (uses the keccak256 implementation above)
       ===================================================================================== */
    function toChecksumAddress(addr) {
      const clean = addr.replace(/^0x/i, "").toLowerCase();
      const hashHex = bytesToHex(keccak256(strToBytes(clean)));
      let out = "0x";
      for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (!/[a-f]/.test(c)) { out += c; continue; }
        out += parseInt(hashHex[i], 16) >= 8 ? c.toUpperCase() : c;
      }
      return out;
    }

    /* =====================================================================================
       4. HAND-ROLLED ABI ENCODER / DECODER
       Only supports exactly the shapes this page needs: selectors from signature strings,
       fixed-width word arguments (address / bytes32), and decoding the specific tuples
       returned by apps(), signers(), and isValidSigner().
       ===================================================================================== */
    function selectorHex(signature) {
      return "0x" + bytesToHex(keccak256(strToBytes(signature)).slice(0, 4));
    }
    function word32FromHex(hex) {
      return hex.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
    }
    function addressToWord(addr) {
      return word32FromHex(addr);
    }
    function buildCalldata(signature, words) {
      return selectorHex(signature) + words.join("");
    }

    function uintWord(bytes32) { return bytesToBigInt(bytes32); }
    function boolWord(bytes32) { return bytesToBigInt(bytes32) !== 0n; }
    function addressWordToHex(bytes32) { return "0x" + bytesToHex(bytes32.slice(12, 32)); }

    /** Decodes the App struct returned by apps(bytes32):
     *  (address owner, uint64 configVersion, uint32 signerTTL, bool paused, bool exists,
     *   bytes32 sourceCommit, string sourceURI)
     */
    function decodeAppsReturn(hex) {
      const data = hexToBytes(hex);
      if (data.length < 32 * 7) throw new Error("apps() return data too short");
      const w = (i) => data.slice(i * 32, i * 32 + 32);
      const owner = addressWordToHex(w(0));
      const configVersion = uintWord(w(1));
      const signerTTL = uintWord(w(2));
      const paused = boolWord(w(3));
      const exists = boolWord(w(4));
      const sourceCommit = "0x" + bytesToHex(w(5));
      const strOffset = Number(uintWord(w(6)));
      let sourceURI = "";
      if (data.length >= strOffset + 32) {
        const strLen = Number(uintWord(data.slice(strOffset, strOffset + 32)));
        const strBytes = data.slice(strOffset + 32, strOffset + 32 + strLen);
        sourceURI = new TextDecoder("utf-8", { fatal: false }).decode(strBytes);
      }
      return { owner, configVersion, signerTTL, paused, exists, sourceCommit, sourceURI };
    }

    /** Decodes the Signer struct returned by signers(address):
     *  (bytes32 appId, uint64 configVersion, uint64 expiresAt, bool revoked)
     */
    function decodeSignersReturn(hex) {
      const data = hexToBytes(hex);
      const w = (i) => data.slice(i * 32, i * 32 + 32);
      return {
        appId: "0x" + bytesToHex(w(0)),
        configVersion: uintWord(w(1)),
        expiresAt: uintWord(w(2)),
        revoked: boolWord(w(3)),
      };
    }

    function decodeBoolReturn(hex) {
      const data = hexToBytes(hex);
      return boolWord(data.slice(0, 32));
    }

    /** Decodes an EnclaveRegistered log entry. */
    function decodeEnclaveRegisteredLog(log) {
      const appId = log.topics[1];
      const signer = "0x" + log.topics[2].slice(-40);
      const data = hexToBytes(log.data);
      const pcrSetHash = "0x" + bytesToHex(data.slice(0, 32));
      const expiresAt = bytesToBigInt(data.slice(32, 64));
      return {
        appId,
        signer,
        pcrSetHash,
        expiresAt,
        blockNumber: parseInt(log.blockNumber, 16),
        txHash: log.transactionHash,
      };
    }

    /* =====================================================================================
       5. RAW JSON-RPC CLIENT (fetch, no library)
       ===================================================================================== */
    let rpcIdCounter = 1;
    async function rpcCall(rpcUrlValue, method, params) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: rpcIdCounter++, method, params });
      const res = await fetch(rpcUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from RPC`);
        err.httpStatus = res.status;
        throw err;
      }
      const json = await res.json();
      if (json.error) {
        const err = new Error(json.error.message || "RPC error");
        err.code = json.error.code;
        err.rpcMessage = json.error.message;
        throw err;
      }
      return json.result;
    }
    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    function isRateLimitError(err) {
      if (!err) return false;
      if (err.httpStatus === 429) return true;
      if (err.code === -32011 || err.code === -32614) return true;
      const msg = (err.rpcMessage || err.message || "").toLowerCase();
      return msg.includes("limited to") || msg.includes("rate limit") || msg.includes("too many");
    }

    /** Every RPC call in this page goes through this retrying wrapper -- the public testnet RPC
     *  rate-limits aggressively (HTTP 429 and JSON-RPC -32011/-32614), so a single-shot call would
     *  make the app lookup, per-row validity checks, and log scan all flaky under load. */
    async function rpcCallWithRetry(rpcUrlValue, method, params) {
      let attempt = 0;
      for (;;) {
        try {
          return await rpcCall(rpcUrlValue, method, params);
        } catch (err) {
          attempt++;
          if (!isRateLimitError(err) || attempt > MAX_RETRIES) throw err;
          const delay = Math.min(250 * 2 ** attempt, 5000) + Math.random() * 200;
          await sleep(delay);
        }
      }
    }
    async function ethCall(rpcUrlValue, to, data) {
      return rpcCallWithRetry(rpcUrlValue, "eth_call", [{ to, data }, "latest"]);
    }
    async function fetchLogsChunk(rpcUrlValue, params) {
      return rpcCallWithRetry(rpcUrlValue, "eth_getLogs", [params]);
    }

    /* =====================================================================================
       6. CHUNKED / CONCURRENT LOG SCANNER
       ===================================================================================== */
    function buildScanWindows(fromBlock, toBlock) {
      const windows = [];
      for (let end = toBlock; end >= fromBlock; end -= GETLOGS_CHUNK) {
        const start = Math.max(fromBlock, end - GETLOGS_CHUNK + 1);
        windows.push([start, end]);
      }
      return windows; // already newest-to-oldest
    }

    async function scanForSigners(rpcUrlValue, registryAddrValue, appId, fromBlock, toBlock, hooks) {
      const topic0 = "0x" + bytesToHex(keccak256(strToBytes(EVENT_SIG)));
      const topic1 = "0x" + word32FromHex(appId);
      const windows = buildScanWindows(fromBlock, toBlock);
      let cursor = 0;
      let completed = 0;
      const total = windows.length;

      async function worker() {
        while (cursor < windows.length) {
          if (hooks.isStopped()) return;
          const myIdx = cursor++;
          const [start, end] = windows[myIdx];
          try {
            const logs = await fetchLogsChunk(rpcUrlValue, {
              fromBlock: "0x" + start.toString(16),
              toBlock: "0x" + end.toString(16),
              address: registryAddrValue,
              topics: [topic0, topic1],
            });
            completed++;
            hooks.onChunk(logs, [start, end], completed, total, null);
          } catch (err) {
            completed++;
            hooks.onChunk([], [start, end], completed, total, err);
          }
        }
      }

      const workers = [];
      for (let i = 0; i < SCAN_CONCURRENCY; i++) workers.push(worker());
      await Promise.all(workers);
    }

    /* =====================================================================================
       7. HUMANIZERS
       ===================================================================================== */
    function humanizeDuration(totalSeconds) {
      const seconds = Number(totalSeconds);
      const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
      for (const [name, size] of units) {
        if (seconds >= size && seconds % size === 0) {
          const n = seconds / size;
          return `${n} ${name}${n === 1 ? "" : "s"}`;
        }
      }
      if (seconds >= 86400) return `~${(seconds / 86400).toFixed(1)} days`;
      if (seconds >= 3600) return `~${(seconds / 3600).toFixed(1)} hours`;
      if (seconds >= 60) return `~${(seconds / 60).toFixed(1)} minutes`;
      return `${seconds}s`;
    }

    function formatTimestamp(unixSeconds) {
      const ms = Number(unixSeconds) * 1000;
      const d = new Date(ms);
      const iso = d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
      const diffSec = Math.round((ms - Date.now()) / 1000);
      let rel;
      try {
        const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
        const abs = Math.abs(diffSec);
        if (abs < 60) rel = rtf.format(diffSec, "second");
        else if (abs < 3600) rel = rtf.format(Math.round(diffSec / 60), "minute");
        else if (abs < 86400) rel = rtf.format(Math.round(diffSec / 3600), "hour");
        else rel = rtf.format(Math.round(diffSec / 86400), "day");
      } catch (e) {
        rel = diffSec >= 0 ? `in ${diffSec}s` : `${-diffSec}s ago`;
      }
      return `${iso} (${rel})`;
    }

    function fmtInt(n) { return Number(n).toLocaleString("en-US"); }

    /* =====================================================================================
       8. DOM HELPERS
       ===================================================================================== */
    function el(tag, attrs, children) {
      const node = document.createElement(tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === "class") node.className = v;
          else if (k === "text") node.textContent = v;
          else node.setAttribute(k, v);
        }
      }
      if (children) for (const c of children) node.appendChild(c);
      return node;
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    function renderTerminal(bodyEl, lines) {
      clear(bodyEl);
      for (const line of lines) {
        const div = el("div", { class: "line" + (line.cls ? " " + line.cls : "") });
        div.textContent = line.text;
        bodyEl.appendChild(div);
      }
    }

    /** Safely render a possibly-external URI as a link, only for known-safe schemes. */
    function safeLinkOrText(container, uri) {
      clear(container);
      const trimmed = (uri || "").trim();
      if (!trimmed) {
        container.appendChild(el("span", { class: "muted", text: "(none set)" }));
        return;
      }
      const isSafe = /^https?:\/\//i.test(trimmed) || /^ipfs:\/\//i.test(trimmed);
      if (isSafe) {
        const a = el("a", { href: trimmed, target: "_blank", rel: "noopener noreferrer nofollow" });
        a.textContent = trimmed;
        container.appendChild(a);
      } else {
        container.appendChild(el("span", { class: "mono", text: trimmed }));
      }
    }

    /* =====================================================================================
       9. APP LOOKUP RESOLUTION
       ===================================================================================== */
    function isBytes32Hex(s) { return /^0x[0-9a-fA-F]{64}$/.test(s.trim()); }

    function resolveAppId(rawInput) {
      const trimmed = rawInput.trim();
      if (isBytes32Hex(trimmed)) {
        return { appId: "0x" + trimmed.slice(2).toLowerCase(), pathLabel: "literal bytes32", pathDetail: trimmed };
      }
      if (Object.prototype.hasOwnProperty.call(KNOWN_APPS, trimmed)) {
        return {
          appId: KNOWN_APPS[trimmed],
          pathLabel: `known app "${trimmed}"`,
          pathDetail: `explicit appId from ${trimmed}'s cobalt.json config -- not derived by hashing the name`,
        };
      }
      const hashHex = "0x" + bytesToHex(keccak256(strToBytes(trimmed)));
      return { appId: hashHex, pathLabel: `keccak256("${trimmed}")`, pathDetail: hashHex };
    }

    /* =====================================================================================
       10. STATE
       ===================================================================================== */
    const state = {
      currentBlock: null,
      chainOk: false,
      appId: null,
      appState: null,
      scanGeneration: 0,
      scanStopped: false,
      scanRunning: false,
      foundSigners: new Map(), // signer(lowercased) -> decoded log entry
    };

    function rpcUrl() { return byId("rpc-url").value.trim() || DEFAULT_RPC; }
    function registryAddr() { return byId("registry-address").value.trim() || DEFAULT_REGISTRY; }

    /* =====================================================================================
       11. CONNECTION CHECK
       ===================================================================================== */
    async function checkConnection() {
      const url = rpcUrl();
      const dot = byId("status-dot");
      const text = byId("status-text");
      const chainidEl = byId("status-chainid");
      const blockEl = byId("status-block");
      const latEl = byId("status-latency");
      const warnEl = byId("chain-warning");
      const termBody = byId("connection-terminal-body");

      dot.className = "status-dot pending";
      text.textContent = "checking...";
      clear(warnEl);

      const t0 = performance.now();
      try {
        const [chainIdHex, blockHex] = await Promise.all([
          rpcCallWithRetry(url, "eth_chainId", []),
          rpcCallWithRetry(url, "eth_blockNumber", []),
        ]);
        const t1 = performance.now();
        const chainId = parseInt(chainIdHex, 16);
        const block = parseInt(blockHex, 16);
        state.currentBlock = block;

        dot.className = "status-dot ok";
        text.textContent = "connected";
        chainidEl.textContent = `${chainId}`;
        blockEl.textContent = fmtInt(block);
        latEl.textContent = `${Math.round(t1 - t0)} ms`;

        state.chainOk = chainId === EXPECTED_CHAIN_ID;
        if (!state.chainOk) {
          warnEl.appendChild(el("div", {
            class: "warn-banner",
            text: `Warning: connected chain id is ${chainId}, expected Monad testnet (${EXPECTED_CHAIN_ID}). Data below may be from a different chain.`,
          }));
        }

        renderTerminal(termBody, [
          { text: `POST ${url}` },
          { text: `-> eth_chainId()` },
          { text: `<- ${chainIdHex}  (${chainId})`, cls: state.chainOk ? "ok" : "bad" },
          { text: `-> eth_blockNumber()` },
          { text: `<- ${blockHex}  (${fmtInt(block)})`, cls: "ok" },
          { text: `${state.chainOk ? "✓" : "✗"} chain id ${state.chainOk ? "matches" : "does NOT match"} expected ${EXPECTED_CHAIN_ID}`, cls: state.chainOk ? "ok" : "bad" },
        ]);

        const fromBlockInput = byId("from-block");
        if (!fromBlockInput.dataset.userEdited) {
          fromBlockInput.value = String(Math.max(0, block - DEFAULT_LOOKBACK));
        }
        byId("current-block-label").textContent = `current tip: ${fmtInt(block)}`;
      } catch (err) {
        dot.className = "status-dot bad";
        text.textContent = "connection failed";
        chainidEl.textContent = "—";
        blockEl.textContent = "—";
        latEl.textContent = "—";
        renderTerminal(termBody, [
          { text: `POST ${url}` },
          { text: `✗ ${err.message || err}`, cls: "bad" },
        ]);
        state.chainOk = false;
      }
    }

    /* =====================================================================================
       12. APP STATE PANEL
       ===================================================================================== */
    function renderAppStateLoading() {
      const body = byId("app-state-body");
      clear(body);
      body.appendChild(el("div", { class: "empty-note", text: "loading apps(appId)..." }));
    }

    function renderAppStateError(message) {
      const body = byId("app-state-body");
      clear(body);
      body.appendChild(el("div", { class: "warn-banner", text: message }));
    }

    function renderAppState(appId, app) {
      const body = byId("app-state-body");
      const title = byId("app-state-title");
      title.textContent = `apps(${appId.slice(0, 10)}…${appId.slice(-6)})`;
      clear(body);

      if (!app.exists) {
        const note = el("div", { class: "friendly-note" });
        note.appendChild(el("div", { class: "k", text: "APP NOT REGISTERED" }));
        const p = el("p");
        p.style.margin = "0.5rem 0 0 0";
        p.textContent = "createApp() hasn't been called for this appId yet -- this is not an error, just an empty record. Every field below defaults to zero/false until an owner registers the app on-chain.";
        note.appendChild(p);
        body.appendChild(note);
        return;
      }

      const grid = el("div", { class: "card-grid" });

      const ownerCard = el("div", { class: "card" });
      ownerCard.appendChild(el("div", { class: "k", text: "Owner" }));
      ownerCard.appendChild(el("div", { class: "v", text: toChecksumAddress(app.owner) }));
      grid.appendChild(ownerCard);

      const cvCard = el("div", { class: "card" });
      cvCard.appendChild(el("div", { class: "k", text: "Config version" }));
      cvCard.appendChild(el("div", { class: "v big", text: app.configVersion.toString() }));
      cvCard.appendChild(el("div", { class: "sub", text: "bumping this invalidates every prior signer + allowed image at once" }));
      grid.appendChild(cvCard);

      const ttlCard = el("div", { class: "card" });
      ttlCard.appendChild(el("div", { class: "k", text: "Signer TTL" }));
      ttlCard.appendChild(el("div", { class: "v", text: humanizeDuration(app.signerTTL) }));
      ttlCard.appendChild(el("div", { class: "sub mono", text: `${fmtInt(app.signerTTL)}s` }));
      grid.appendChild(ttlCard);

      const statusCard = el("div", { class: "card" });
      statusCard.appendChild(el("div", { class: "k", text: "Status" }));
      const pill = el("span", { class: "pill " + (app.paused ? "paused" : "active") });
      pill.appendChild(el("span", { class: "dot" }));
      pill.appendChild(document.createTextNode(app.paused ? "PAUSED" : "ACTIVE"));
      statusCard.appendChild(pill);
      grid.appendChild(statusCard);

      const commitCard = el("div", { class: "card" });
      commitCard.appendChild(el("div", { class: "k", text: "Source commit" }));
      const isZeroCommit = /^0x0+$/.test(app.sourceCommit);
      commitCard.appendChild(el("div", { class: "v " + (isZeroCommit ? "muted" : ""), text: isZeroCommit ? "(unset)" : app.sourceCommit }));
      grid.appendChild(commitCard);

      const uriCard = el("div", { class: "card card-wide" });
      uriCard.appendChild(el("div", { class: "k", text: "Source URI" }));
      const uriValueEl = el("div", { class: "v" });
      uriCard.appendChild(uriValueEl);
      grid.appendChild(uriCard);

      body.appendChild(grid);
      safeLinkOrText(uriValueEl, app.sourceURI);

      const termWrap = byId("appstate-terminal");
      const termBody = byId("appstate-terminal-body");
      termWrap.style.display = "";
      const calldata = buildCalldata("apps(bytes32)", [word32FromHex(appId)]);
      renderTerminal(termBody, [
        { text: `eth_call { to: ${registryAddr()},` },
        { text: `           data: ${calldata.slice(0, 26)}… }` },
        { text: `selector 0x38bb6def = keccak256("apps(bytes32)")[0:4]`, cls: "dim" },
        { text: `✓ owner            ${toChecksumAddress(app.owner)}`, cls: "ok" },
        { text: `✓ configVersion    ${app.configVersion}`, cls: "ok" },
        { text: `✓ signerTTL        ${app.signerTTL}s (${humanizeDuration(app.signerTTL)})`, cls: "ok" },
        { text: `✓ paused           ${app.paused}`, cls: app.paused ? "bad" : "ok" },
        { text: `✓ exists           ${app.exists}`, cls: "ok" },
      ]);
    }

    /* =====================================================================================
       13. SIGNERS TABLE
       ===================================================================================== */
    function resetSignersTable() {
      const tbody = byId("signers-tbody");
      clear(tbody);
      const tr = el("tr");
      const td = el("td", { colspan: "5", class: "dim mono", text: "scanning…" });
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    function rowIdFor(signer) { return "signer-row-" + signer.replace(/^0x/, "").toLowerCase(); }

    function upsertSignerRow(entry) {
      const tbody = byId("signers-tbody");
      // remove the placeholder row, if present
      const placeholder = tbody.querySelector("td[colspan]");
      if (placeholder) placeholder.closest("tr").remove();

      const id = rowIdFor(entry.signer);
      let tr = root.querySelector("#" + id);
      if (!tr) {
        tr = el("tr", { id });
        const checksummed = toChecksumAddress(entry.signer);

        const signerTd = el("td");
        signerTd.appendChild(el("div", { class: "mono", text: checksummed }));
        tr.appendChild(signerTd);

        const validTd = el("td", { class: "valid-cell" });
        validTd.appendChild(el("span", { class: "glyph-pending", text: "checking…" }));
        tr.appendChild(validTd);

        const blockTd = el("td", { text: fmtInt(entry.blockNumber) });
        tr.appendChild(blockTd);

        const expTd = el("td", { text: formatTimestamp(entry.expiresAt) });
        tr.appendChild(expTd);

        const pcrTd = el("td", { class: "mono", text: entry.pcrSetHash });
        tr.appendChild(pcrTd);

        // insertion sorted by block number descending (newest first)
        const rows = Array.from(tbody.querySelectorAll("tr[id^='signer-row-']"));
        let inserted = false;
        for (const r of rows) {
          if (Number(r.dataset.block) < entry.blockNumber) {
            tbody.insertBefore(tr, r);
            inserted = true;
            break;
          }
        }
        if (!inserted) tbody.appendChild(tr);
        tr.dataset.block = String(entry.blockNumber);
      }
      return tr;
    }

    function updateSignerValidity(signer, resolved) {
      const tr = root.querySelector("#" + rowIdFor(signer));
      if (!tr) return;
      const validTd = tr.querySelector(".valid-cell");
      clear(validTd);
      if (resolved.valid) {
        validTd.appendChild(el("span", { class: "glyph-ok", text: "✓ valid" }));
        tr.classList.add("valid-row");
      } else {
        validTd.appendChild(el("span", { class: "glyph-bad", text: "✗ invalid" }));
        if (resolved.reason) {
          validTd.appendChild(el("span", { class: "cell-sub", text: resolved.reason }));
        }
        tr.classList.remove("valid-row");
      }
    }

    async function resolveSignerStatus(url, registry, appId, signer, appState) {
      const validCalldata = buildCalldata("isValidSigner(bytes32,address)", [word32FromHex(appId), addressToWord(signer)]);
      let isValid = false;
      try {
        isValid = decodeBoolReturn(await ethCall(url, registry, validCalldata));
      } catch (err) {
        return { valid: false, reason: `error checking validity: ${err.message}` };
      }
      if (isValid) return { valid: true, reason: null };

      try {
        const signersCalldata = buildCalldata("signers(address)", [addressToWord(signer)]);
        const s = decodeSignersReturn(await ethCall(url, registry, signersCalldata));
        if (s.appId.toLowerCase() !== appId.toLowerCase()) {
          return { valid: false, reason: "not registered for this app" };
        }
        if (s.revoked) return { valid: false, reason: "revoked by app owner" };
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        if (nowSec > s.expiresAt) return { valid: false, reason: "TTL expired" };
        if (appState && appState.paused) return { valid: false, reason: "app is paused" };
        if (appState && s.configVersion !== appState.configVersion) {
          return { valid: false, reason: `invalidated by config bump (signer v${s.configVersion} != app v${appState.configVersion})` };
        }
        return { valid: false, reason: "unknown reason" };
      } catch (err) {
        return { valid: false, reason: `error checking signers(): ${err.message}` };
      }
    }

    async function runSignerScan() {
      if (!state.appId) return;
      const generation = ++state.scanGeneration;
      state.scanStopped = false;
      state.scanRunning = true;
      state.foundSigners = new Map();

      byId("btn-stop").disabled = false;
      byId("btn-rescan").disabled = true;
      resetSignersTable();

      const url = rpcUrl();
      const registry = registryAddr();
      const appId = state.appId;
      const appStateSnapshot = state.appState;

      const fromInput = byId("from-block").value.trim();
      const toInput = byId("to-block").value.trim();
      const toBlock = toInput ? parseInt(toInput, 10) : (state.currentBlock ?? 0);
      const fromBlock = fromInput ? parseInt(fromInput, 10) : Math.max(0, toBlock - DEFAULT_LOOKBACK);

      const progressEl = byId("scan-progress");
      const totalWindows = Math.ceil((toBlock - fromBlock + 1) / GETLOGS_CHUNK);
      let foundCount = 0;
      let errorCount = 0;

      function updateProgress(done) {
        progressEl.textContent = `scanned ${done}/${totalWindows} windows (blocks ${fmtInt(fromBlock)}–${fmtInt(toBlock)}) — ${foundCount} signer(s) found` + (errorCount ? `, ${errorCount} chunk error(s)` : "");
      }
      updateProgress(0);

      try {
        await scanForSigners(url, registry, appId, fromBlock, toBlock, {
          isStopped: () => state.scanStopped || generation !== state.scanGeneration,
          onChunk: (logs, range, done, total, err) => {
            if (generation !== state.scanGeneration) return;
            if (err) {
              errorCount++;
            } else {
              for (const log of logs) {
                const decoded = decodeEnclaveRegisteredLog(log);
                const key = decoded.signer.toLowerCase();
                if (state.foundSigners.has(key)) continue;
                state.foundSigners.set(key, decoded);
                foundCount++;
                upsertSignerRow(decoded);
                resolveSignerStatus(url, registry, appId, decoded.signer, appStateSnapshot)
                  .then((resolved) => {
                    if (generation !== state.scanGeneration) return;
                    updateSignerValidity(decoded.signer, resolved);
                  });
              }
            }
            updateProgress(done);
          },
        });
      } finally {
        if (generation === state.scanGeneration) {
          state.scanRunning = false;
          byId("btn-stop").disabled = true;
          byId("btn-rescan").disabled = false;
          const stoppedNote = state.scanStopped ? " (stopped)" : " (complete)";
          progressEl.textContent += stoppedNote;
          if (state.foundSigners.size === 0) {
            const tbody = byId("signers-tbody");
            clear(tbody);
            const tr = el("tr");
            tr.appendChild(el("td", { colspan: "5", class: "dim mono", text: "no EnclaveRegistered events found in this block range" }));
            tbody.appendChild(tr);
          }
        }
      }
    }

    function stopScan() {
      state.scanStopped = true;
      byId("btn-stop").disabled = true;
    }

    /** Invalidates any in-flight scan (e.g. because the user resolved a different app) so its
     *  stale onChunk/resolveSignerStatus callbacks stop touching the DOM, and resets the scan
     *  controls to an idle state. */
    function abandonRunningScan() {
      state.scanStopped = true;
      state.scanGeneration++;
      state.scanRunning = false;
      byId("btn-stop").disabled = true;
      byId("btn-rescan").disabled = false;
    }

    /* =====================================================================================
       14. APP LOOKUP FLOW
       ===================================================================================== */
    async function lookupApp() {
      abandonRunningScan();

      const rawInput = byId("app-input").value;
      const resolved = resolveAppId(rawInput);
      state.appId = resolved.appId;

      const pathEl = byId("resolution-path");
      pathEl.innerHTML = "";
      pathEl.appendChild(document.createTextNode("Resolved via "));
      pathEl.appendChild(el("span", { class: "mono chip-accent", text: resolved.pathLabel }));
      pathEl.appendChild(document.createTextNode("  →  "));
      const appIdSpan = el("span", { class: "mono", text: resolved.appId });
      pathEl.appendChild(appIdSpan);

      renderAppStateLoading();

      const url = rpcUrl();
      const registry = registryAddr();
      const calldata = buildCalldata("apps(bytes32)", [word32FromHex(resolved.appId)]);

      try {
        const result = await ethCall(url, registry, calldata);
        const app = decodeAppsReturn(result);
        state.appState = app;
        renderAppState(resolved.appId, app);

        if (app.exists) {
          await runSignerScan();
        } else {
          const tbody = byId("signers-tbody");
          clear(tbody);
          const tr = el("tr");
          tr.appendChild(el("td", { colspan: "5", class: "dim mono", text: "app does not exist -- nothing to scan" }));
          tbody.appendChild(tr);
          byId("scan-progress").textContent = "not scanning (app does not exist)";
        }
      } catch (err) {
        state.appState = null;
        renderAppStateError(`eth_call failed: ${err.message || err}`);
      }
    }

    /* =====================================================================================
       15. WIRING
       ===================================================================================== */
    const btnCheckConnection = byId("btn-check-connection");
    const btnLookup = byId("btn-lookup");
    const appInput = byId("app-input");
    const btnRescan = byId("btn-rescan");
    const btnStop = byId("btn-stop");
    const fromBlockInputEl = byId("from-block");

    const onCheckConnectionClick = () => { checkConnection(); };
    const onLookupClick = () => { lookupApp(); };
    const onAppInputKeydown = (e) => { if (e.key === "Enter") lookupApp(); };
    const onRescanClick = () => { runSignerScan(); };
    const onStopClick = () => { stopScan(); };
    const onFromBlockInput = (e) => { e.target.dataset.userEdited = "1"; };

    btnCheckConnection.addEventListener("click", onCheckConnectionClick);
    btnLookup.addEventListener("click", onLookupClick);
    appInput.addEventListener("keydown", onAppInputKeydown);
    btnRescan.addEventListener("click", onRescanClick);
    btnStop.addEventListener("click", onStopClick);
    fromBlockInputEl.addEventListener("input", onFromBlockInput);

    let cancelled = false;
    (async () => {
      byId("footer-registry").textContent = registryAddr();
      await checkConnection();
      if (cancelled) return;
      await lookupApp();
    })();

    return () => {
      cancelled = true;
      state.scanStopped = true;
      state.scanGeneration++;
      btnCheckConnection.removeEventListener("click", onCheckConnectionClick);
      btnLookup.removeEventListener("click", onLookupClick);
      appInput.removeEventListener("keydown", onAppInputKeydown);
      btnRescan.removeEventListener("click", onRescanClick);
      btnStop.removeEventListener("click", onStopClick);
      fromBlockInputEl.removeEventListener("input", onFromBlockInput);
    };
  }, []);

  return (
    <div className="page" ref={containerRef}>
      <header>
        <div className="eyebrow">COBALT &middot; MONAD TESTNET &middot; CHAIN 10143</div>
        <h1 className="headline">Enclave Registry<br />Dashboard</h1>
        <p className="subhead">
          A live, read-only window into the on-chain registry that binds AWS Nitro Enclave attestations
          to Ethereum signer addresses. Every value on this page is fetched directly from Monad testnet
          by this single-page app &mdash; raw JSON-RPC over <span className="mono">fetch</span>, a hand-written
          Keccak-256 and ABI codec, no indexer, no backend, no library.
        </p>
        <div className="badge-readonly"><span className="dot"></span>Read-only &mdash; no transactions, no private keys, ever</div>
      </header>

      {/* ================= CONNECTION ================= */}
      <section className="panel" id="connection-panel">
        <div className="eyebrow">01 &middot; Connection</div>
        <h2 className="section-title">Network</h2>

        <div className="grid-2">
          <label className="field">RPC URL
            <input type="text" id="rpc-url" defaultValue="https://testnet-rpc.monad.xyz" spellCheck="false" />
          </label>
          <label className="field">Enclave Registry address
            <input type="text" id="registry-address" defaultValue="0xccF281dE61bfb970575827B5c962345F39bDa145" spellCheck="false" />
          </label>
        </div>

        <div className="row" style={{ marginTop: "1rem" }}>
          <button id="btn-check-connection">Check connection</button>
        </div>

        <div className="status-row" id="connection-status">
          <div className="item"><span className="k">Status</span><span className="mono"><span className="status-dot pending" id="status-dot"></span><span id="status-text">not checked yet</span></span></div>
          <div className="item"><span className="k">Chain ID</span><span className="mono" id="status-chainid">&mdash;</span></div>
          <div className="item"><span className="k">Latest block</span><span className="mono" id="status-block">&mdash;</span></div>
          <div className="item"><span className="k">Round trip</span><span className="mono" id="status-latency">&mdash;</span></div>
        </div>
        <div id="chain-warning"></div>

        <div className="terminal" id="connection-terminal">
          <div className="terminal-chrome"><span className="tdot"></span><span className="tdot"></span><span className="tdot"></span></div>
          <div className="terminal-body" id="connection-terminal-body"><div className="line dim">{"// eth_chainId / eth_blockNumber not yet sent"}</div></div>
        </div>
      </section>

      {/* ================= LOOKUP ================= */}
      <section className="panel" id="lookup-panel">
        <div className="eyebrow">02 &middot; App Lookup</div>
        <h2 className="section-title">Resolve an app</h2>
        <p className="subhead">
          Enter a registered app&apos;s plain name or a raw <span className="mono">0x</span>-prefixed bytes32 <span className="mono">appId</span>.
          Names are hashed client-side with a from-scratch Keccak-256 implementation &mdash; except a small
          set of known demo apps (like <span className="mono">ping</span>) whose id was assigned explicitly at
          registration time rather than derived from their name; those resolve via that explicit id instead
          of a hash, and this page tells you which path it took.
        </p>

        <div className="row" style={{ marginTop: "1rem" }}>
          <label className="field" style={{ flex: 1, minWidth: "260px" }}>App name or bytes32 appId
            <input type="text" id="app-input" defaultValue="ping" spellCheck="false" />
          </label>
          <button id="btn-lookup">Resolve</button>
        </div>

        <div className="hint" id="resolution-path">&nbsp;</div>
      </section>

      {/* ================= APP STATE ================= */}
      <section className="panel" id="app-state-panel">
        <div className="eyebrow">03 &middot; App State</div>
        <h2 className="section-title" id="app-state-title">apps(appId)</h2>

        <div id="app-state-body">
          <div className="empty-note">Resolve an app above to load its on-chain state.</div>
        </div>

        <div className="terminal" id="appstate-terminal" style={{ display: "none" }}>
          <div className="terminal-chrome"><span className="tdot"></span><span className="tdot"></span><span className="tdot"></span></div>
          <div className="terminal-body" id="appstate-terminal-body"></div>
        </div>
      </section>

      {/* ================= SIGNERS ================= */}
      <section className="panel" id="signers-panel">
        <div className="eyebrow">04 &middot; Registered Signers</div>
        <h2 className="section-title">EnclaveRegistered log scan</h2>
        <p className="subhead">
          Discovered via <span className="mono">eth_getLogs</span> filtered on the app&apos;s <span className="mono">appId</span>
          topic. The public RPC caps each query to ~100 blocks, so the scan runs in small windows, several at
          once, newest block first, retrying automatically on rate limits.
        </p>

        <div className="scan-controls">
          <label className="field">Scan from block
            <input type="text" id="from-block" inputMode="numeric" spellCheck="false" />
          </label>
          <label className="field">Scan to block
            <input type="text" id="to-block" inputMode="numeric" spellCheck="false" placeholder="latest" />
          </label>
          <button id="btn-rescan">Rescan</button>
          <button id="btn-stop" className="secondary" disabled>Stop</button>
          <span className="hint" id="current-block-label"></span>
        </div>

        <div className="scan-progress" id="scan-progress">not scanning</div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Signer</th>
                <th>Currently valid</th>
                <th>Registered at block</th>
                <th>Expires</th>
                <th>PCR set hash</th>
              </tr>
            </thead>
            <tbody id="signers-tbody">
              <tr><td colSpan="5" className="dim mono">no scan run yet</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <footer>
        <span>Cobalt &middot; AWS Nitro Enclave attestations verified on Monad testnet</span>
        <span>&middot;</span>
        <span>Registry: <span className="mono" id="footer-registry">0xccF281dE61bfb970575827B5c962345F39bDa145</span></span>
        <span>&middot;</span>
        <span>Single-page app &middot; zero external requests other than your chosen RPC endpoint</span>
      </footer>
    </div>
  );
}
