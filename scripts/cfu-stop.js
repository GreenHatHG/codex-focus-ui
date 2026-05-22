#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const serviceDir = path.join(repoRoot, ".data", "service");
const pidFile = path.join(serviceDir, "runner.pid");
const statusFile = path.join(serviceDir, "status.json");
const dryRun = process.env.CFU_STOP_DRY_RUN === "1";

function nowIso() {
  return new Date().toISOString();
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

function readStatus() {
  if (!fs.existsSync(statusFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(statusFile, "utf8"));
  } catch {
    return {};
  }
}

function writeStoppedStatus() {
  fs.mkdirSync(serviceDir, { recursive: true });
  const current = readStatus();
  const payload = {
    ...current,
    runnerPid: null,
    viewerPid: null,
    state: "stopped",
    updatedAt: nowIso()
  };

  if (!payload.startedAt) {
    payload.startedAt = payload.updatedAt;
  }

  fs.writeFileSync(statusFile, JSON.stringify(payload, null, 2), "utf8");
}

function readProcessCommandLine(pid) {
  const procPath = `/proc/${pid}/cmdline`;
  if (!fs.existsSync(procPath)) return null;

  try {
    return fs.readFileSync(procPath, "utf8").replace(/\u0000/g, " ").trim();
  } catch {
    return null;
  }
}

function looksLikeServiceRunner(pid) {
  const cmdline = readProcessCommandLine(pid);
  if (!cmdline) return true;
  return cmdline.includes("scripts/service-runner.js");
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const runnerPid = readRunnerPid();

  if (!runnerPid) {
    writeStoppedStatus();
    console.log("Service is not running.");
    return;
  }

  if (!isProcessRunning(runnerPid)) {
    safeUnlink(pidFile);
    writeStoppedStatus();
    console.log(`Service already stopped. Cleaned stale pid file (${runnerPid}).`);
    return;
  }

  if (!looksLikeServiceRunner(runnerPid)) {
    console.error(`Refusing to stop pid ${runnerPid}: runner.pid does not match codex-focus-ui service.`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`Dry run: would stop service (PID: ${runnerPid}).`);
    return;
  }

  try {
    process.kill(runnerPid, "SIGTERM");
  } catch (err) {
    console.error(`Failed to stop service pid ${runnerPid}: ${err.message}`);
    process.exit(1);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    if (!isProcessRunning(runnerPid)) {
      safeUnlink(pidFile);
      writeStoppedStatus();
      console.log(`Service stopped (PID: ${runnerPid}).`);
      return;
    }
  }

  console.error(`Service did not stop in time (PID: ${runnerPid}).`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[cfu-stop] ${err.message}`);
  process.exit(1);
});
