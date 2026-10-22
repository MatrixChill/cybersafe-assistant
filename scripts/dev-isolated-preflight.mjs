#!/usr/bin/env node
/**
 * dev-isolated-preflight.mjs — TP-REAL-BOOT isolamento (READ-ONLY).
 *
 * Decide se um arranque REAL do Electron pode correr com perfil/dados de TESTE
 * ISOLADOS sem tocar na instalação pessoal nem ativar proteção/monitor/scan.
 * NÃO arranca Electron nem serviço; só lê env/sistema, usa os VALIDADORES reais
 * do core (sem duplicar regras) e sonda o pipe. Sai 0 se o arranque isolado é
 * GO, 2 se está BLOCKED (com o motivo por camada).
 *
 * Camadas: API (porta+DB isoláveis), Electron userData (--user-data-dir),
 * Serviço (BASE_DIR + PIPE via otim-in EXPLÍCITO), Proteção (auto-on?),
 * Motor/ClamAV (presença).
 *
 * Otim-in (todos obrigatórios em conjunto; default inalterado sem a flag):
 *   CYBERSAFE_DEV_ISOLATION=1
 *   CYBERSAFE_DEV_SERVICE_DIR=<dir absoluto dedicado, NUNCA ~/.cybersafe-service>
 *   CYBERSAFE_DEV_PIPE_NAME=\\.\pipe\<nome local estrito>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PIPE = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
const PERSONAL_DIR = path.join(os.homedir(), ".cybersafe-service");
const probe = { env: process.env, home: os.homedir(), argv: [], execPath: process.execPath };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let blocked = 0;
const L = (tag, m) => console.log(`${tag.padEnd(7)} ${m}`);
const ok = (m) => L("OK", m), warn = (m) => L("WARN", m), blk = (m) => { blocked++; L("BLOCK", m); };

function probePipe(p, ms = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ path: p });
    const done = (r) => { try { s.destroy(); } catch {} resolve(r); };
    s.setTimeout(ms); s.once("connect", () => done(true)); s.once("timeout", () => done(false)); s.once("error", () => done(false));
  });
}
function probeTcp(host, port, ms = 500) {
  return new Promise((resolve) => { const s = net.connect({ host, port }); const d = (r) => { try { s.destroy(); } catch {} resolve(r); }; s.setTimeout(ms); s.once("connect", () => d(true)); s.once("timeout", () => d(false)); s.once("error", () => d(false)); });
}

console.log("== TP-REAL-BOOT isolamento (READ-ONLY; nada é arrancado) ==");

// ── Carga dos VALIDADORES reais do core (sem duplicar regras) ──
let iso;
try {
  const modPath = path.join(REPO, "packages", "core", "dist", "dev-isolation.js");
  iso = await import(pathToFileURL(modPath).href);
} catch (e) {
  iso = null;
  blk(`Core: dist/dev-isolation.js não carregado (${e.message}) — corre \`npm run build -w @cybersafe/core\` antes do preflight; sem validadores reais não há GO.`);
}

// API/profile are required prerequisites, not optional warnings.
function dedicatedExistingDirectory(dir) {
  if (!iso || !dir || !path.isAbsolute(dir) || dir.startsWith("\\\\")) return false;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false;
    let cur = path.resolve(dir);
    for (;;) {
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const real = fs.realpathSync(dir);
    return !iso.pathIsSameOrUnder(real, PERSONAL_DIR)
      && !iso.pathIsSameOrUnder(PERSONAL_DIR, real)
      && path.resolve(real).toLowerCase() !== path.resolve(os.homedir()).toLowerCase();
  } catch { return false; }
}
const apiDb = process.env.CYBERSAFE_DB_PATH;
if (!apiDb || !path.isAbsolute(apiDb) || !dedicatedExistingDirectory(path.dirname(apiDb))) {
  blk("API: exige CYBERSAFE_DB_PATH absoluto num diretorio dedicado existente, sem links e fora dos dados pessoais.");
} else {
  try {
    const st = fs.lstatSync(apiDb);
    if (!st.isFile() || st.isSymbolicLink()) blk("API: DB existente deve ser ficheiro regular sem link.");
    else ok("API: caminho de DB de teste validado (conteudo nao lido).");
  } catch (e) {
    if (e.code === "ENOENT") ok("API: caminho novo de DB de teste validado; nada criado.");
    else blk("API: nao foi possivel validar caminho da DB.");
  }
}
const apiPort = Number(process.env.CYBERSAFE_API_PORT || 4000);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) blk("API: porta invalida.");
else if (await probeTcp("127.0.0.1", apiPort)) blk("API: porta ocupada; identidade da instancia nao comprovada.");
else ok("API: porta alvo livre nesta verificacao.");
const userData = process.env.CYBERSAFE_DEV_USER_DATA_DIR;
if (!dedicatedExistingDirectory(userData)) blk("Electron: exige CYBERSAFE_DEV_USER_DATA_DIR dedicado existente e sem links; o runner tem de o passar por --user-data-dir.");
else ok("Electron: perfil de teste validado; ainda NAO confirma argumento efetivo do processo.");

// ── Camada SERVIÇO: BASE_DIR e PIPE via otim-in EXPLÍCITO ──
if (iso) {
  const requested = iso.devIsolationRequested(process.env);
  const packaged = iso.looksLikePackagedRuntime(probe);
  if (!requested) {
    blk(`Serviço: otim-in NÃO ligado (falta CYBERSAFE_DEV_ISOLATION=1). Sem ele o serviço usa ${PERSONAL_DIR} e o pipe partilhado ${DEFAULT_PIPE} — NÃO isola.`);
  } else if (packaged) {
    blk("Serviço: heurística deteta runtime EMPACOTADO → o core devolve o default. NAO é prova estanque; o gate autoritativo é app.isPackaged no main (serviceEnv). Este preflight é só p/ arranque DEV.");
  } else {
    let svcDir, pipeName;
    try {
      svcDir = iso.resolveServiceBaseDir(probe);
      pipeName = iso.resolvePipeName(probe);
    } catch (e) {
      blk(`Serviço: otim-in ligado mas INVÁLIDO/PARCIAL → boot falharia FECHADO: ${e.message}`);
    }
    if (svcDir && pipeName) {
      // Gate de GO (ensaio): a raiz dedicada tem de EXISTIR (criada pelo
      // runner), ser um diretório LOCAL sem qualquer reparse point na cadeia
      // até à raiz, e o seu realpath não pode coincidir nem conter o pessoal.
      // path.resolve/form-checks do core NÃO provam isto — o sistema de
      // ficheiros prova aqui.
      let exists = false, real = null, reparseHit = null;
      try {
        const st = fs.lstatSync(svcDir);
        exists = st.isDirectory();
        if (st.isSymbolicLink()) reparseHit = svcDir;
        real = fs.realpathSync(svcDir);
        let cur = path.dirname(path.resolve(svcDir));
        for (;;) {
          let s;
          try { s = fs.lstatSync(cur); } catch { break; }
          if (s.isSymbolicLink()) { reparseHit = cur; break; }
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      } catch { exists = false; }
      const personalLow = PERSONAL_DIR.toLowerCase();
      const realLow = real ? real.toLowerCase() : null;
      if (!exists) {
        blk(`Serviço: BASE_DIR isolado ${svcDir} AINDA NÃO EXISTE — para o ensaio crie antes a raiz local dedicada (runner) e volte: GO exige diretório existente, sem reparse, não-pessoal.`);
      } else if (reparseHit) {
        blk(`Serviço: isolamento toca um LINK/junction (${reparseHit}) que pode redirecionar p/ dados pessoais — recusa sem GO.`);
      } else if (realLow && (realLow === personalLow || iso.pathIsSameOrUnder(real, PERSONAL_DIR))) {
        blk(`Serviço: realpath ${real} coincide/está sob o pessoal — reparse disfarçado ou config errada; recusa sem GO.`);
      } else if (realLow && iso.pathIsSameOrUnder(PERSONAL_DIR, real)) {
        blk(`Serviço: o pessoal ${PERSONAL_DIR} ficaria DENTRO do isolamento ${real} — o serviço poderia escrever no pessoal; recusa.`);
      } else {
        ok(`Serviço: BASE_DIR ISOLADO => ${svcDir} (realpath ${real}; existente, local, sem reparse, não-pessoal)`);
      }
      const pipeInUse = await probePipe(pipeName);
      ok(`Serviço: PIPE ISOLADO => ${pipeName} (desktop e serviço partilham o MESMO nome via core). Estado agora: ${pipeInUse ? "EM USO (outro serviço isolado já está lá)" : "livre"}.`);
      if (pipeInUse) blk("Pipe isolado ocupado; identidade da instancia nao comprovada. Nao arrancar.");
    }
  }
}

// ── Proteção auto-on? (estático: NÃO) ──
ok("Proteção: NÃO é ativada no boot — main só liga o pipe/serviço; monitor.start só via toggle do utilizador (service:set-protection). Arranque não dispara scan/monitor por si.");

// ── Motor/ClamAV (presença, não executa) ──
const engine = path.join(REPO, "packages", "native-engine", "build", "Release", "scan-engine.exe");
L("motor", `scan-engine.exe ${fs.existsSync(engine) ? "presente" : "AUSENTE"} (não executado aqui)`);
L("clamav", `CLAMAV_BINARY_ENV=${process.env.CYBERSAFE_CLAMAV_BINARY ?? "(unset)"} (motor só usado se proteção ligada)`);

console.log("");
if (blocked > 0) {
  console.log(`ISOLAMENTO: BLOCKED (${blocked}). Electron real NÃO deve ser arrancado até o otim-in estar válido.`);
  console.log("Ativar isolamento (dev dedicado; default do produto fica inalterado sem isto):");
  console.log("  CYBERSAFE_DEV_ISOLATION=1");
  console.log("  CYBERSAFE_DEV_SERVICE_DIR=<dir absoluto dedicado, NUNCA ~/.cybersafe-service>");
  console.log("  CYBERSAFE_DEV_PIPE_NAME=\\\\.\\pipe\\<nome local estrito>");
  console.log("  CYBERSAFE_DB_PATH=<db de teste>          # API, já isolável");
  process.exit(2);
}
console.log("ISOLAMENTO: GO PRELIMINAR — caminhos e portas verificados agora. O runner ainda tem de passar --user-data-dir e revalidar antes do arranque; nao comprova runtime.");
console.log("Comando de arranque DEV isolado (standalone; desktop e serviço partilham PIPE_NAME via core + mesma env):");
console.log(`  Defina os caminhos isolados; arranque Electron explicitamente com --user-data-dir igual a CYBERSAFE_DEV_USER_DATA_DIR. Nao use npm run dev sem configurar esse argumento.`);
console.log("NOTA (honest, NÃO estanque): o boot EMPACOTADO já fecha o FILHO — main.serviceEnv apaga as 3 vars quando app.isPackaged. Mas o import do core no PRÓPRIO main (PIPE_NAME) corre antes de qualquer check; aí só há a heurística isElectron/!defaultApp, que NÃO é prova. Um ENV órfão no main instalado é postura de dev não suportada. Ver relatório p/ proposta de gate confiável se necessário.");
process.exit(0);
