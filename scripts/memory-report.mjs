// memory-report.mjs — Medição de memória CyberSafe (dev only)
// Executar: node scripts/memory-report.mjs
// Mostra memória de processos CyberSafe vs Dev Tooling.

import { execSync } from "node:child_process";
import { platform } from "node:os";

function getProcesses() {
  if (platform() !== "win32") {
    console.log("Este script suporta apenas Windows.");
    return [];
  }

  const raw = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe' OR Name='electron.exe' OR Name='opencode.exe'\\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"`,
    { encoding: "utf8", windowsHide: true }
  );
  return JSON.parse(raw || "[]").map((p) => ({
    pid: p.ProcessId,
    name: p.Name,
    cmd: p.CommandLine || "",
  }));
}

function getWorkingSet(pid) {
  try {
    const raw = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64 / 1MB"`,
      { encoding: "utf8", windowsHide: true }
    );
    const mb = parseFloat(raw.trim());
    return Number.isFinite(mb) ? mb : 0;
  } catch {
    return 0;
  }
}

const CYBERSAFE_PATTERNS = [
  /cybersafe-assistant.*index\.ts/i,
  /cybersafe-assistant.*src\/index/i,
  /ELECTRON_RUN_AS_NODE/i,
  /packages\/desktop/i,
  /packages\/app/i,
  /cybersafe-assistant.*dist\/main/i,
];

function isCyberSafe(cmd) {
  if (!cmd) return false;
  // Matches: service, desktop, API, app dev
  const patterns = [
    /cybersafe-assistant.*packages\/service.*index/i,
    /cybersafe-assistant.*packages\/desktop.*src\/index/i,
    /cybersafe-assistant.*packages\/api.*src\/index/i,
    /cybersafe-assistant.*dist\/main/i,
    /cybersafe-assistant.*dist\/preload/i,
    /cybersafe-assistant.*node_modules\/tsx.*src\/index/i,
    /ELECTRON_RUN_AS_NODE.*cybersafe/i,
  ];
  return patterns.some((p) => p.test(cmd));
}

function isDevTooling(cmd) {
  if (!cmd) return true;
  if (/vite.*build|concurrently|wait-on|tsx.*watch/i.test(cmd)) return true;
  if (isCyberSafe(cmd)) return false;
  if (/omniroute|matrix-code|codex|opencode/i.test(cmd)) return false;
  return false;
}

const procs = getProcesses();
const rows = [];

for (const p of procs) {
  const mb = getWorkingSet(p.pid);
  const category = isCyberSafe(p.cmd)
    ? "CYBERSAFE"
    : isDevTooling(p.cmd)
    ? "DEV_TOOLING"
    : "OTHER";
  rows.push({ ...p, mb, category });
}

// Group by category
const grouped = { CYBERSAFE: [], DEV_TOOLING: [], OTHER: [] };
for (const r of rows) grouped[r.category].push(r);

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║          CyberSafe — Memory Report                      ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log();

function printGroup(name, items) {
  const total = items.reduce((s, i) => s + i.mb, 0);
  const label = name === "CYBERSAFE" ? "🛡️  PRODUCT RUNTIME" : name === "DEV_TOOLING" ? "🔧 DEV TOOLING" : "📦 OTHER";
  console.log(`${label} (${items.length} processes)`);
  console.log("─".repeat(56));
  if (items.length === 0) {
    console.log("  (none)");
  } else {
    for (const item of items.sort((a, b) => b.mb - a.mb)) {
      const label = item.cmd.slice(0, 44).padEnd(44);
      console.log(`  PID ${String(item.pid).padStart(6)} │ ${String(item.mb.toFixed(1)).padStart(8)} MB │ ${label}`);
    }
  }
  console.log(`  TOTAL: ${total.toFixed(1)} MB`);
  console.log();
  return total;
}

const cybersafeTotal = printGroup("CYBERSAFE", grouped.CYBERSAFE);
const devTotal = printGroup("DEV_TOOLING", grouped.DEV_TOOLING);
printGroup("OTHER", grouped.OTHER);

console.log("─".repeat(56));
console.log(`CyberSafe product RAM: ${cybersafeTotal.toFixed(1)} MB`);
console.log(`Dev tooling RAM:      ${devTotal.toFixed(1)} MB`);
console.log(`System node.exe total: ${(cybersafeTotal + devTotal + grouped.OTHER.reduce((s, i) => s + i.mb, 0)).toFixed(1)} MB`);
console.log();

// Quick heap info for Node processes that are ours
const heapProc = rows.find(
  (r) => r.category === "CYBERSAFE" && /dist\/main/i.test(r.cmd)
);
if (heapProc) {
  console.log(`Main process PID ${heapProc.pid}:`);
  console.log(`  Working Set: ${heapProc.mb.toFixed(1)} MB`);
}
