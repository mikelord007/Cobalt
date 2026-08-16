#!/usr/bin/env node
"use strict";

// Offline smoke test for registrar.js: exercises the pieces that don't need network access
// (calldata encoding via the vendored keccak256, PCR hashing, revert-reason decoding, and the
// calldata-slot file writer's clear-before-write behavior). Run with:
//   node tools/registrar.smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { encodeCall, keccak256 } = require("../src/vendor/nitro-validator/tools/hinted_attestation_calls");
const registrar = require("./registrar");

function testKnownSelector() {
  // transfer(address,uint256) is a well-known selector: 0xa9059cbb. If the vendored pure-JS
  // Keccak implementation is wired correctly, this must match exactly.
  const selector = keccak256(Buffer.from("transfer(address,uint256)", "ascii")).subarray(0, 4).toString("hex");
  assert.strictEqual(selector, "a9059cbb", "transfer(address,uint256) selector mismatch");
  console.log("ok: known selector matches (transfer(address,uint256) = 0xa9059cbb)");
}

function testEncodeCallRegisterEnclave() {
  const appId = "11".repeat(32);
  const data = encodeCall("registerEnclave(bytes32,bytes,bytes,bytes)", [
    { type: "bytes32", value: appId },
    { type: "bytes", value: Buffer.from("aa", "hex") },
    { type: "bytes", value: Buffer.from("bb", "hex") },
    { type: "bytes", value: Buffer.from("cc", "hex") },
  ]);
  assert.ok(data.startsWith("0x"), "calldata must be 0x-prefixed");
  const selector = keccak256(Buffer.from("registerEnclave(bytes32,bytes,bytes,bytes)", "ascii"))
    .subarray(0, 4)
    .toString("hex");
  assert.strictEqual(data.slice(2, 10), selector, "registerEnclave selector mismatch");
  console.log("ok: registerEnclave calldata carries the correct selector");
}

function testComputePcrSetHash() {
  const pcr0 = Buffer.alloc(48, 0x01);
  const pcr1 = Buffer.alloc(48, 0x02);
  const pcr2 = Buffer.alloc(48, 0x03);
  const hash = registrar.computePcrSetHash(pcr0, pcr1, pcr2);
  const expected = `0x${keccak256(Buffer.concat([pcr0, pcr1, pcr2])).toString("hex")}`;
  assert.strictEqual(hash, expected, "pcrSetHash must equal keccak256(pcr0 || pcr1 || pcr2)");

  assert.throws(() => registrar.computePcrSetHash(Buffer.alloc(47), pcr1, pcr2), /must be exactly 48 bytes/);
  console.log("ok: computePcrSetHash matches keccak256(pcr0||pcr1||pcr2) and rejects wrong lengths");
}

function testValidateHelpers() {
  assert.strictEqual(registrar.validateAddress(`0x${"Ab".repeat(20)}`, "from"), `0x${"ab".repeat(20)}`);
  assert.throws(() => registrar.validateAddress("not-an-address", "from"), /must be a 0x-prefixed 20-byte address/);

  assert.strictEqual(registrar.validateBytes32(`0x${"ab".repeat(32)}`, "app-id"), `0x${"ab".repeat(32)}`);
  assert.throws(() => registrar.validateBytes32("0xdead", "app-id"), /must be a 0x-prefixed 32-byte hex value/);

  const buf = registrar.decodeFixedHexBuffer(`0x${"aa".repeat(48)}`, 48, "pcr0");
  assert.strictEqual(buf.length, 48);
  assert.throws(() => registrar.decodeFixedHexBuffer("0xaa", 48, "pcr0"), /must be exactly 48 bytes/);
  console.log("ok: address / bytes32 / fixed-hex validators accept good input and reject bad input");
}

function testDecodeRevertReason() {
  const selector = keccak256(Buffer.from("ImageNotAllowed(bytes32,bytes32)", "ascii")).subarray(0, 4).toString("hex");
  const appId = "11".repeat(32);
  const pcrSetHash = "22".repeat(32);
  const data = `0x${selector}${appId}${pcrSetHash}`;

  const decoded = registrar.decodeRevertReason(data);
  assert.strictEqual(decoded.name, "ImageNotAllowed(bytes32,bytes32)");
  assert.deepStrictEqual(decoded.args, [`0x${appId}`, `0x${pcrSetHash}`]);

  assert.strictEqual(registrar.decodeRevertReason("0x"), null);
  assert.strictEqual(registrar.decodeRevertReason(`0xdeadbeef`), null);
  console.log("ok: decodeRevertReason decodes a known custom error and ignores unknown ones");
}

function testSlotWriterClearsStaleGasLimit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cobalt-registrar-smoke-"));
  try {
    registrar.writeSlot(dir, 1, "0x1111111111111111111111111111111111111111", "0xaabb", "first run", 12345n);
    assert.ok(fs.existsSync(path.join(dir, "tx1_gaslimit.txt")), "gas limit file should exist after first write");

    registrar.clearSlots(dir);
    registrar.writeSlot(dir, 1, "0x2222222222222222222222222222222222222222", "0xccdd", "second run", undefined);

    // The known trap: a leftover *_gaslimit.txt from a previous run must never silently apply to
    // an unrelated new call that didn't ask for one.
    assert.ok(!fs.existsSync(path.join(dir, "tx1_gaslimit.txt")), "stale gas limit file must be cleared");
    assert.strictEqual(fs.readFileSync(path.join(dir, "tx1_label.txt"), "utf8"), "second run");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("ok: clearSlots removes a stale gas-limit file before a new plan is written");
}

testKnownSelector();
testEncodeCallRegisterEnclave();
testComputePcrSetHash();
testValidateHelpers();
testDecodeRevertReason();
testSlotWriterClearsStaleGasLimit();

console.log("\nall registrar smoke checks passed");
