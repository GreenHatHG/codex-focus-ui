#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { loadProjectConfig } = require("../packages/shared/src/config");

const repoRoot = path.resolve(__dirname, "..");
const config = loadProjectConfig(repoRoot);
const serviceDir = path.join(repoRoot, ".data", "service");
const pidFile = path.join(serviceDir, "runner.pid");
const logFile = path.join(serviceDir, "service.log");
const viewerPort = Number(process.env.CODEX_FOCUS_UI_PORT || config.viewerPort || 3939);
const viewerUrl = `http://127.0.0.1:${viewerPort}`;

function todayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isProcessRunning(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function readRunnerPid() {
  if (!fs.existsSync(pidFile)) return null;
  const value = String(fs.readFileSync(pidFile, "utf8") || "").trim();
  if (!value) return null;
  return Number(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureServiceRunning() {
  const existingPid = readRunnerPid();
  if (existingPid && isProcessRunning(existingPid)) {
    return existingPid;
  }

  fs.mkdirSync(serviceDir, { recursive: true });
  const child = spawn(process.execPath, ["scripts/service-runner.js"], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    const pid = readRunnerPid();
    if (pid && isProcessRunning(pid)) {
      return pid;
    }
  }

  throw new Error(`service failed to start. Check ${path.relative(repoRoot, logFile)}`);
}

function tryOpen(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "ignore",
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

function openViewer(url) {
  if (process.env.CFU_UI_NO_OPEN === "1") {
    return false;
  }

  const openers = [];
  const isTermux =
    Boolean(process.env.TERMUX_VERSION) ||
    String(process.env.PREFIX || "").includes("com.termux") ||
    fs.existsSync("/data/data/com.termux/files/usr/bin/termux-open-url");

  if (process.platform === "win32") {
    openers.push({ command: "cmd", args: ["/c", "start", "", url] });
  } else {
    if (isTermux) {
      openers.push({ command: "termux-open-url", args: [url] });
      openers.push({ command: "am", args: ["start", "-a", "android.intent.action.VIEW", "-d", url] });
    }
    if (process.platform === "darwin") {
      openers.push({ command: "open", args: [url] });
    } else {
      openers.push({ command: "xdg-open", args: [url] });
    }
  }

  for (const opener of openers) {
    if (tryOpen(opener.command, opener.args)) {
      return true;
    }
  }

  return false;
}

async function main() {
  await ensureServiceRunning();

  const targetUrl = `${viewerUrl}/?session=codex-auto-${todayString()}.jsonl`;
  const opened = openViewer(targetUrl);
  const action = opened ? "Opened" : "Ready";
  console.log(`${action}: ${targetUrl}`);
  console.log("Stop: npm run ui:stop");
}

main().catch((err) => {
  console.error(`[cfu-ui] ${err.message}`);
  process.exit(1);
});
