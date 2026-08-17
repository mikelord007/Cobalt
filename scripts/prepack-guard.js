#!/usr/bin/env node
// prepack: hard-fail `npm publish`/`npm pack` if this checkout's git submodules aren't populated.
//
// package.json's "files" allowlist doesn't currently include lib/, src/, or foundry.toml at all --
// tools/cobalt.js resolves a "project root" from the app directory the CLI is pointed at (see
// resolveProjectRoot() there) and runs every `forge` invocation against THAT checkout, not against
// wherever this package itself got installed. So a missing lib/forge-std/ wouldn't break the
// published tarball today. This check exists anyway, as cheap insurance against that changing: if
// a future edit reintroduces Foundry project files into "files", or a maintainer runs `npm
// publish` from a shallow, non-recursive clone for some other reason, fail loudly here rather than
// ship (or half-ship) something broken silently. Never exits non-zero for reasons unrelated to
// this specific check -- that's what would actually block a publish.
"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const MARKER = path.join(REPO_ROOT, "lib", "forge-std", "src", "Script.sol");

if (!fs.existsSync(MARKER)) {
  console.error(
    `[cobalt-tee] prepack: expected to find ${path.relative(REPO_ROOT, MARKER)} but it's missing. ` +
      `This checkout's git submodules (lib/forge-std, lib/openzeppelin-contracts -- see .gitmodules) ` +
      `aren't populated. Run "git submodule update --init --recursive" and try again.`,
  );
  process.exit(1);
}

console.log("[cobalt-tee] prepack: submodule check OK.");
