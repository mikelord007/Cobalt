#!/usr/bin/env node
// postinstall: auto-install Foundry (forge/cast/anvil/chisel) so `npm install -g cobalt-tee`
// produces a working `cobalt` command with no separate manual "go install Foundry" step.
//
// Behavior, in order:
//   1. If forge+cast are already runnable (on PATH, or already bundled from a previous install),
//      do nothing. We never clobber an existing install.
//   2. Otherwise, detect platform/arch, download the matching official Foundry release asset
//      straight from GitHub (foundry-rs/foundry releases), verify its sha256 checksum, extract it,
//      and drop the binaries into <package-root>/.bin-foundry/. tools/cobalt.js (and any other
//      caller) looks there first before falling back to PATH -- see resolveFoundryBin() there.
//   3. If ANYTHING here fails (offline, unsupported platform, GitHub rate-limited, no tar/
//      PowerShell available, etc.) we print a warning and exit 0 regardless. A postinstall script
//      that exits non-zero fails the *entire* `npm install`, which would be strictly worse than
//      just not having auto-installed Foundry -- tools/cobalt.js's own checkFoundryOnPath() already
//      gives a clear, actionable error at actual CLI-use time if it's genuinely still missing.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUNDLE_DIR = path.join(REPO_ROOT, ".bin-foundry");
const GITHUB_API_LATEST = "https://api.github.com/repos/foundry-rs/foundry/releases/latest";
const USER_AGENT = "cobalt-tee-postinstall (+https://github.com/mikelord007/Cobalt)";
const FOUNDRY_BINARIES = ["forge", "cast", "anvil", "chisel"];
const MANUAL_INSTALL_HINT = "see https://getfoundry.sh for a manual install (curl -L https://foundry.paradigm.xyz | bash, then foundryup).";

function log(msg) {
  console.log(`[cobalt-tee] ${msg}`);
}

function warn(msg) {
  console.warn(`[cobalt-tee] warning: ${msg}`);
}

function binName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function isRunnable(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch (err) {
    return err.code !== "ENOENT";
  }
}

function foundryAlreadyAvailable() {
  // On PATH already (system-wide install, foundryup, package manager, CI image, ...)?
  if (isRunnable("cast") && isRunnable("forge")) return true;
  // Bundled from a previous run of this same script (e.g. `npm install -g` re-run/upgrade)?
  const bundledCast = path.join(BUNDLE_DIR, binName("cast"));
  const bundledForge = path.join(BUNDLE_DIR, binName("forge"));
  if (fs.existsSync(bundledCast) && fs.existsSync(bundledForge) && isRunnable(bundledCast) && isRunnable(bundledForge)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// platform/arch -> Foundry release asset mapping
//
// Verified against the real `foundry-rs/foundry` v1.7.1 release assets (GitHub API, checked live):
//   foundry_v1.7.1_darwin_amd64.tar.gz   foundry_v1.7.1_darwin_arm64.tar.gz
//   foundry_v1.7.1_linux_amd64.tar.gz    foundry_v1.7.1_linux_arm64.tar.gz
//   foundry_v1.7.1_alpine_amd64.tar.gz   foundry_v1.7.1_alpine_arm64.tar.gz
//   foundry_v1.7.1_win32_amd64.zip
// (there's no win32_arm64 asset -- not relevant here.) Each archive is FLAT: forge/cast/anvil/
// chisel (or *.exe) sit directly at the archive root, no nested directory.
// ---------------------------------------------------------------------------------------------

// True on musl libc (Alpine and similar) -- glibcVersionRuntime is present in process.report only
// when the running Node binary is itself linked against glibc. Without this check, Alpine gets
// the glibc `linux` asset by default, which fails the runnability probe in installFoundry() below
// and silently deletes the whole bundle with just a warning (see main()'s catch block).
function isMusl() {
  try {
    return process.report.getReport().header.glibcVersionRuntime === undefined;
  } catch {
    return false; // process.report unavailable (very old Node) -- assume glibc, the common case
  }
}

function detectTarget() {
  const platformMap = { linux: isMusl() ? "alpine" : "linux", darwin: "darwin", win32: "win32" };
  const archMap = { x64: "amd64", arm64: "arm64" };
  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) return null;
  if (platform === "win32" && arch === "arm64") return null; // Foundry publishes no win32 arm64 asset
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return { platform, arch, ext };
}

// ---------------------------------------------------------------------------------------------
// networking: plain Node `https`, manual redirect-follow (GitHub's download URLs 302 to
// objects.githubusercontent.com). No new npm dependency for this.
// ---------------------------------------------------------------------------------------------

function httpGetFollowing(url, headers, redirectsLeft, onResponse) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const { statusCode } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects fetching ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        httpGetFollowing(next, headers, redirectsLeft - 1, onResponse).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} -> HTTP ${statusCode}`));
        return;
      }
      Promise.resolve(onResponse(res)).then(resolve, reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error(`request timed out: ${url}`)));
  });
}

function fetchJSON(url) {
  return httpGetFollowing(url, { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" }, 5, (res) => {
    return new Promise((resolve, reject) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`failed to parse JSON from ${url}: ${err.message}`));
        }
      });
      res.on("error", reject);
    });
  });
}

function fetchText(url) {
  return httpGetFollowing(url, { "User-Agent": USER_AGENT, Accept: "text/plain, */*" }, 5, (res) => {
    return new Promise((resolve, reject) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
  });
}

function downloadToFile(url, destPath) {
  return httpGetFollowing(url, { "User-Agent": USER_AGENT, Accept: "application/octet-stream, */*" }, 5, (res) => {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close((err) => (err ? reject(err) : resolve())));
      fileStream.on("error", reject);
      res.on("error", reject);
    });
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------------------------

function extractTarGz(archivePath, destDir) {
  // GNU tar and bsdtar both handle -xzf identically for a real .tar.gz -- safe everywhere
  // Linux/macOS actually ship tar (which is the entire premise of not needing an npm dependency
  // here).
  execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "pipe" });
}

function extractZip(archivePath, destDir) {
  // Deliberately NOT using a plain `tar` on PATH here even though modern Windows ships one that
  // can (in theory) read zip via libarchive: verified live on a real Windows 11 box that when Git
  // for Windows is installed (extremely common on dev machines), its GNU tar.exe shadows the
  // Windows one on PATH, and GNU tar cannot read zip archives at all ("This does not look like a
  // tar archive"). PowerShell's Expand-Archive is bundled with every Windows 10/11 install
  // (PowerShell 5.1+) and was verified live here to extract this exact archive correctly, so it's
  // tried first -- but it isn't universal (some trimmed Server Core / CI images lack Windows
  // PowerShell on PATH while having pwsh, or neither). Fall back to `pwsh` (PowerShell 7+, also
  // Expand-Archive), then to the real Windows-native tar.exe by its ABSOLUTE path under
  // %SystemRoot%\System32 -- bypassing PATH entirely sidesteps the Git-Bash-shadowing problem
  // above, since this is specifically Microsoft's own libarchive-based tar, not GNU tar.
  const psCommand = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
  const attempts = [
    () => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], { stdio: "pipe" }),
    () => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", psCommand], { stdio: "pipe" }),
    () => execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", archivePath, "-C", destDir], { stdio: "pipe" }),
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      attempt();
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`could not extract ${archivePath}: tried powershell.exe, pwsh and System32\\tar.exe, all failed (last error: ${lastErr && lastErr.message})`);
}

// ---------------------------------------------------------------------------------------------
// main install flow
// ---------------------------------------------------------------------------------------------

async function installFoundry(target) {
  log(`Foundry not found -- auto-installing for ${target.platform}/${target.arch}...`);

  log("looking up the latest foundry-rs/foundry release...");
  const release = await fetchJSON(GITHUB_API_LATEST);
  const tag = release.tag_name;
  if (!tag || !Array.isArray(release.assets)) {
    throw new Error("unexpected GitHub releases/latest response shape (missing tag_name/assets)");
  }

  const extPattern = target.ext.replace(".", "\\.");
  const assetRe = new RegExp(`^foundry_.+_${target.platform}_${target.arch}\\.${extPattern}$`);
  const asset = release.assets.find((a) => assetRe.test(a.name));
  if (!asset) {
    throw new Error(`no release asset matching ${assetRe} found in ${tag} (release asset naming may have changed)`);
  }
  log(`found ${asset.name} (${tag})`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cobalt-tee-foundry-"));
  const archivePath = path.join(tmpDir, asset.name);

  try {
    log(`downloading ${asset.name}...`);
    await downloadToFile(asset.browser_download_url, archivePath);

    const checksumAsset = release.assets.find((a) => a.name === `${asset.name.replace(/\.(tar\.gz|zip)$/, "")}.sha256`);
    if (checksumAsset) {
      log("verifying sha256 checksum...");
      const checksumText = await fetchText(checksumAsset.browser_download_url);
      const expected = (checksumText.trim().split(/\s+/)[0] || "").toLowerCase();
      const actual = (await sha256File(archivePath)).toLowerCase();
      if (!expected || expected !== actual) {
        throw new Error(`sha256 mismatch for ${asset.name}: expected ${expected || "<unparseable>"}, got ${actual}`);
      }
      log("checksum OK.");
    } else {
      warn(`no .sha256 asset found for ${asset.name}; skipping checksum verification.`);
    }

    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    fs.mkdirSync(BUNDLE_DIR, { recursive: true });

    log("extracting...");
    if (target.ext === "zip") {
      extractZip(archivePath, BUNDLE_DIR);
    } else {
      extractTarGz(archivePath, BUNDLE_DIR);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  for (const name of FOUNDRY_BINARIES) {
    const binPath = path.join(BUNDLE_DIR, binName(name));
    if (!fs.existsSync(binPath)) {
      throw new Error(`expected ${binName(name)} in extracted archive but it's missing (found: ${fs.readdirSync(BUNDLE_DIR).join(", ")})`);
    }
    if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
  }

  // Confirm the bundled binaries actually run (catches libc mismatches, corrupted archives, etc.)
  // before declaring success.
  const forgeVersion = execFileSync(path.join(BUNDLE_DIR, binName("forge")), ["--version"], { encoding: "utf8" }).trim();
  const castVersion = execFileSync(path.join(BUNDLE_DIR, binName("cast")), ["--version"], { encoding: "utf8" }).trim();
  log(`installed to ${BUNDLE_DIR}`);
  log(forgeVersion.split("\n")[0]);
  log(castVersion.split("\n")[0]);
}

async function main() {
  if (foundryAlreadyAvailable()) {
    log("Foundry (forge/cast) already available -- nothing to do.");
    return;
  }

  const target = detectTarget();
  if (!target) {
    warn(`no Foundry release is published for this platform/arch (${process.platform}/${process.arch}).`);
    warn(MANUAL_INSTALL_HINT);
    return;
  }

  try {
    await installFoundry(target);
  } catch (err) {
    warn(`automatic Foundry install failed (${err && err.message ? err.message : err}).`);
    warn("`cobalt` will still install, but Foundry (forge/cast) must be installed manually before use --");
    warn(MANUAL_INSTALL_HINT);
    // best-effort cleanup so a half-extracted BUNDLE_DIR can't masquerade as a working install
    try {
      fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// Belt-and-suspenders: whatever happens above, never let this script fail `npm install`.
process.on("uncaughtException", (err) => {
  warn(`unexpected error (${err && err.message ? err.message : err}); continuing without auto-installed Foundry.`);
  warn(MANUAL_INSTALL_HINT);
  process.exit(0);
});

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      warn(`unexpected error (${err && err.message ? err.message : err}); continuing without auto-installed Foundry.`);
      warn(MANUAL_INSTALL_HINT);
      process.exit(0);
    },
  );
}

module.exports = { detectTarget, foundryAlreadyAvailable, BUNDLE_DIR };
