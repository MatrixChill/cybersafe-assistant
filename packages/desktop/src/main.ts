import { installNavigationPolicy } from "./navigation-policy.js";
import { installInitialWindowReveal } from "./window-foreground.js";
import { readBuildIdentity } from "./build-identity.js";
import { registerProcessTerminationIpc } from "./process-termination-ipc.js";
import { createAiCredentialsStore, type AiCredentialsStore } from "./ai-credentials-store.js";
import { registerAiCredentialsIpc } from "./ai-credentials-ipc.js";
import { configureAiChild } from "./ai-api-channel.js";
import { windowsAppIdentity } from "./app-identity.js";
import { createAuthSessionStore } from "./auth-session-store.js";
import { registerAuthSessionIpc } from "./auth-session-ipc.js";
import { app, shell, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage, nativeTheme, screen, safeStorage } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ServiceClient } from "./service-client.js";
import { readOrCreatePipeCredential } from "./pipe-credential.js";
import { resolveExistingService } from "./service-readiness.js";
import { DEFAULT_API_PORT, startLocalApi, stopLocalApi, type ApiRuntime } from "./api-lifecycle.js";
import { buildTrayMenuTemplate, createTrayQuickScan, trayProtectionLevel, trayTooltip, resolveTrayIconAsset, type TrayMenuHandlers, type TrayProtectionInfo, type TrayProtectionLevel, type TrayScanInfo } from "./tray-menu.js";
import { trayTooltipWithIdentity } from "./tray-identity.js";
import { PendingProtection, SnapshotCommitter } from "./pending-protection.js";
import { protectionFailToast, requestProtectionToggle, type ProtectionActionResult } from "./protection-toggle-result.js";
import { ensurePdfExtension, validateReportPath } from "./report-save.js";
import { createExitConfirmation } from "./exit-confirmation.js";
import { createExitDelivery, type ExitDelivery } from "./exit-delivery.js";
import { appendDesktopLog } from "./desktop-log.js";
import { createStartupDiagnostic, classifyStartupError } from "./startup-diagnostics.js";
import { scanCompletionNotification } from "./scan-notification.js";
import { guardedServiceRequest, trustedIpcHandler, reportWindowPreferences } from "./ipc-guard.js";
import { createSecurityNotifications } from "./security-notifications.js";
import { createNativeNotificationDelivery } from "./notification-delivery.js";
import { applyTitleBarOverlay, normalizeTitleBarOverlayPayload, themeSourceForOverlayColor, titleBarOverlayWindowOptions } from "./titlebar-overlay.js";
import {
  VALID_BACKGROUND_MATERIALS,
  resolveWindowMaterial,
  type BackgroundMaterial,
} from "./window-material.js";
// Updater da aplicação — integração MÍNIMA (TP-UPDATE-INTEGRATE). Só faz o wiring
// do IPC; a máquina e os adaptadores vivem em src/updater/*. Hoje UNCONFIGURED
// (sem feed/chave/editor), adaptadores bloqueados, nada de rede/fs/instalador.
import {
  updaterCacheDir,
  failureResult,
  failureSnapshot,
  toAppUpdateSnapshot,
  toWireResult,
  validateAutomaticInput,
  validateInstallRequest,
} from "./updater/bridge.js";
import { createProductionUpdater } from "./updater/production.js";
import type { Updater } from "./updater/updater.js";
import type { UpdaterResult } from "./updater/index.js";
import { PIPE_NAME, CLAMAV_BINARY_ENV, stripDevIsolationEnv } from "@cybersafe/core";
import { resolveDevProfile, afirmarCaminhoIsolado } from "./dev-isolation.js";
import {
  comPoliticaLeituraWindows,
  suprimirAcoesTray,
  validarFronteiraWindowsReadOnly,
  validarRespostaSaida,
  type DecisaoSaida,
} from "./dev-windows-readonly-boundary.js";
import type { SecurityEvent, ScanState } from "@cybersafe/shared-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Perfil de isolamento. Calculado ao importar o módulo porque `client` e o
 * `probePipe` existem antes de `whenReady`, e porque o pipe do serviço instalado
 * tem de ser substituído ANTES de qualquer ligação. Empacotado, isto devolve os
 * valores de sempre (ver `dev-isolation.ts`).
 */
const perfil = resolveDevProfile({ isPackaged: app.isPackaged, env: process.env });
// ── Fronteira de leitura Windows (DEV, opt-in) ───────────────────────────────
// Decidida logo a seguir ao perfil efectivo e ANTES de `CYBERSAFE_API_BASE`, do
// `ServiceClient`, da janela, do IPC, da tray e do arranque no login: uma
// configuração inválida do modo não deixa nenhum desses efeitos para trás.
// Estritamente condicional: sem `CYBERSAFE_DEV_WINDOWS_READONLY=1` não há uma
// única verificação extra (o módulo devolve `{activo:false}` sem tocar no resto
// do ambiente) e o arranque normal é o de antes.
// Limite declarado e não evitável a partir daqui: as importações ES são içadas,
// portanto `electron`, `@cybersafe/core` e `dotenv`-like já correram os seus
// efeitos de topo antes desta linha; o que se garante é a ordem dentro deste
// módulo, não uma anterioridade absoluta sobre todos os módulos.
const fronteiraLeituraWindows = validarFronteiraWindowsReadOnly({
  env: process.env,
  isPackaged: app.isPackaged,
  perfil,
});
if (fronteiraLeituraWindows.activo) {
  // Sem caminhos, sem valores de ambiente, sem payloads: só o facto.
  console.log("[Electron] Fronteira de leitura Windows ativa: efeitos recusados antes do handler; janela propria e saida confirmadas continuam disponiveis.");
}
// O renderer lê `window.__CYBERSAFE_API_BASE__`; em dev a base chega daqui, não
// de um URL fixo no componente.
process.env.CYBERSAFE_API_BASE = perfil.apiBase;
let mainWindow: BrowserWindow | null = null;
// Updater da aplicação (ver updater/bridge.ts). `null` até whenReady inicializar;
// os handlers tratam `null` sem crash e sem `appUpdater!`.
let appUpdater: Updater | null = null;
let updateStateUnsub: (() => void) | null = null;
let tray: Tray | null = null;
let isQuitting = false;
/**
 * Credencial do pipe POR INSTALAÇÃO (ver `pipe-credential.ts`).
 *
 * Antes era `randomBytes(32)` ao importar o módulo — um valor novo por processo
 * Electron. Um serviço filho que sobrevivesse ao pai (crash, `app.exit(0)` no
 * prazo do `before-quit`, restauro de snapshot, reboot com arranque automático)
 * continuava a servir o pipe com a credencial antiga, que ninguém guardava: o
 * arranque seguinte nunca mais conseguia autenticar-se, e como a decisão de
 * "reutilizar" era tomada por um probe cru, nem se dava conta de que estava
 * bloqueado.
 * O estado é o que foi reportado na VM QA1 (janela aberta, nada confirmado, modo
 * limitado); o mecanismo foi reproduzido em HOST/LANE com motor e cliente reais.
 * Não há logs da VM para esta causa, por isso não se afirma que o episódio da VM
 * teve um serviço órfão — afirma-se que este desenho o tornava inevitável.
 *
 * Sem credencial não há como provar posse do pipe, por isso uma falha aqui é
 * falha real de arranque (razão legível no diálogo), nunca ligação silenciosa.
 */
let pipeCredentialError: string | null = null;
let pipeSessionToken: string | undefined;
if (app.isPackaged) {
  try {
    pipeSessionToken = readOrCreatePipeCredential(app.getPath("userData")).credential;
  } catch (error) {
    pipeCredentialError = String((error as Error)?.message ?? error);
    console.error("[Electron] Credencial do pipe indisponível:", error);
  }
}
const client = new ServiceClient(perfil.pipeName, pipeSessionToken);
const notificationHistory = new Map<string, number>();
const DEBOUNCE_TIME = 15000; // 15 segundos de silêncio para o mesmo arquivo

// ── Preferências locais (persistidas em userData/settings.json) ──
// `windowMaterial` é OPCIONAL e por omissão ausente: sem ela a janela usa o
// fundo sólido de sempre. Só um pedido explícito (ex.: um toggle futuro nas
// Definições) liga o backdrop nativo — e mesmo assim apenas quando o
// `window-material` confirmar que o sistema o suporta.
let preferences: { notificationsEnabled: boolean; windowMaterial?: BackgroundMaterial } = {
  notificationsEnabled: true,
};

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadPreferences() {
  try {
    if (fs.existsSync(settingsFilePath())) {
      const raw = fs.readFileSync(settingsFilePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.notificationsEnabled === "boolean") {
        preferences.notificationsEnabled = parsed.notificationsEnabled;
      }
      // Só se aceita um material da lista do Electron; qualquer outro valor fica
      // como ausente (fallback sólido), nunca vai para o `new BrowserWindow`.
      if (VALID_BACKGROUND_MATERIALS.includes(parsed.windowMaterial)) {
        preferences.windowMaterial = parsed.windowMaterial;
      }
    }
  } catch {
    // Ficheiro inválido não deve impedir o arranque.
  }
}

function savePreferences() {
  try {
    fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true });
    fs.writeFileSync(settingsFilePath(), JSON.stringify(preferences, null, 2), "utf8");
  } catch {
    // Falha de escrita não é fatal.
  }
}

// RECOVERY-SECURITY-20261014: a decisao de notificar vive em
// security-notifications.ts (testavel sem Electron); este ligacao e o unico
// caminho do EventBus real ate `Notification`.
const notificationDelivery = createNativeNotificationDelivery({
  isSupported: () => Notification.isSupported(),
  create: options => new Notification({ ...options, icon: resolveTrayIconPath() }),
  notificationsEnabled: () => preferences.notificationsEnabled,
  isQuitting: () => isQuitting,
  diagnostic: status => logExitEvent("notification-delivery", { status }),
});
const securityNotifications = createSecurityNotifications({
  notify: (title, body) => notificationDelivery.notify(title, body),
  notificationsEnabled: () => preferences.notificationsEnabled,
  isQuitting: () => isQuitting,
});

// Preferência de ícones: CS Shield (símbolo oficial compacto) > logo > padrão.
function assetsPath(...segments: string[]): string {
  return path.join(__dirname, "assets", ...segments);
}

// Icones do SO usam a familia `icon-*`: o mesmo tile, recortado ao bounding
// box de alpha e re-centrado com ~4% de margem (scripts/
// generate-branding-derivatives.py). Medido no mestre: o alpha occupa
// 90.6% linear do canvas (bbox 29/32 em icon-32), padding 3.1-6.2% por lado
// — a arte preenche o slot, o recorte nao e a causa do "pequeno" na bandeja.
// A causa e a DPI: a bandeja usa SM_CXSMICON = 16 px logicos x scaleFactor
// (20 px a 125%, 24 px a 150%), mas o bitmap era forcado a 16 px fisicos —
// a 150% ficava com 16/24 do slot. A taskbar nao sofre disto porque consome
// o icon.ico multi-frame e o Windows escolhe o frame certo para o DPI.
// O .ico actual e gerado a partir do mesmo mestre, por isso a taskbar
// continua a PARTILHAR a arte; so a entrega da tray muda.
function trayIconSizePx(): number {
  let sf = 1;
  try {
    sf = screen.getPrimaryDisplay().scaleFactor || 1;
  } catch {
    // screen ainda nao inicializado: 16 px e o nominal a 100%.
  }
  // 32 e o frame maximo entregue (icon-32); acima disso o Windows escala o
  // hIcon ate ao slot, que e melhor do que upsample embacado por resize.
  return Math.min(32, Math.max(16, Math.round(16 * sf)));
}

function resolveTrayIconPath(): string {
  const candidates = [
    assetsPath("cybersafe", "icon-32.png"),
    assetsPath("cybersafe", "icon-24.png"),
    assetsPath("cybersafe", "icon-16.png"),
    assetsPath("icon.png"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

// Ícone da janela/taskbar: o .ico multi-tamanho gerado a partir do mesmo tile
// recortado (Windows escolhe 16/24/32/48 conforme a barra e o DPI); os PNG são
// o caminho em Linux.
function resolveWindowIconPath(): string {
  const candidates = [
    assetsPath("icon.ico"),
    assetsPath("cybersafe", "icon-256.png"),
    assetsPath("cybersafe", "icon-48.png"),
    assetsPath("icon.png"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

// Em dev, refresca os derivados da marca (assets/branding/generated) para
// dist/assets, para que mexer no mestre se veja sem re-correr o build.
// Antes isto copiava toda a árvore otimizada (escudos antigos + matrix) e
// qualquer PNG solto na raiz de branding — era assim que o logo de 1,5 MB sem
// alpha chegava ao bundle. Os retratos matrix não têm consumo aqui.
function syncBrandingAssets() {
  if (app.isPackaged) return;
  try {
    const repoRoot = path.resolve(app.getAppPath(), "..", "..");
    const generatedDir = path.join(repoRoot, "assets", "branding", "generated");
    if (!fs.existsSync(generatedDir)) return;
    const outDir = assetsPath("cybersafe");
    fs.mkdirSync(outDir, { recursive: true });

    let copied = 0;
    // So o que o shell consome: a familia icon-* (janela/bandeja), o tile do
    // splash e o .ico. Copiar generated/ inteiro traria o symbol-flat e a
    // familia tile-* da UI para dentro do bundle do desktop.
    const wanted = /^icon-\d+\.png$|^tile-128\.png$|^cybersafe-icon\.ico$/;
    for (const file of fs.readdirSync(generatedDir)) {
      if (!wanted.test(file)) continue;
      const src = path.join(generatedDir, file);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(outDir, file));
      copied += 1;
    }
    // Os nomes que o empacotamento e os resolvedores acima já conhecem.
    const readIf = (name: string) => fs.readFileSync(path.join(generatedDir, name));
    fs.writeFileSync(assetsPath("icon.ico"), readIf("cybersafe-icon.ico"));
    fs.writeFileSync(assetsPath("icon.png"), readIf("icon-256.png"));
    console.log("[Electron] Branding sincronizado:", copied, "derivative(s).");
  } catch (error) {
    console.error("[Electron] Falha ao sincronizar branding:", error);
  }
}

// Detecta se foi lançado via auto-start (boot do Windows) para iniciar escondido na tray
const launchHidden = process.argv.includes("--hidden");
let pendingForegroundRequest = false;
let initialWindowPresentation: ReturnType<typeof installInitialWindowReveal> | null = null;

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return;
  // Fundo nativo da janela (DWM backdrop) decidido a partir da plataforma, da
  // build do Windows e da preferência. Fora do Windows 11, ou sem pedido
  // explícito, devolve apenas o fundo sólido — nunca `transparent`.
  const windowMaterial = resolveWindowMaterial({
    platform: process.platform,
    osRelease: os.release(),
    requested: preferences.windowMaterial ?? null,
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    // "janela pequena": um piso mínimo evita que a faixa de título, os botões
    // nativos (Window Controls Overlay) e o shell colapsem quando a janela é
    // arrastada para dimensões onde o layout já não é utilizável.
    minWidth: 820,
    minHeight: 600,
    // Fundo sólido base (contrato `boot-flow`): é a reserva quando não há
    // material do SO, e o `backgroundColor` que o Electron usa por baixo dele.
    backgroundColor: "#090b12",
    icon: resolveWindowIconPath(),
    show: false,
    // Apenas quando suportado e pedido: material do sistema atrás da janela.
    ...(windowMaterial.options.backgroundMaterial
      ? { backgroundMaterial: windowMaterial.options.backgroundMaterial }
      : {}),
    // Barra de janela premium no Windows: o frame nativo desaparece e os botões
    // do sistema passam a viver em Window Controls Overlay, com a cor do tema
    // ativo enviada pelo renderer (`app:set-titlebar-overlay`). Fora do Windows
    // a função devolve `{}` e a janela mantém exactamente o frame de antes.
    ...titleBarOverlayWindowOptions(process.platform),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // A política de PRODUÇÃO viaja no <meta> do index.html: o renderer empacotado
  // é carregado por loadFile(file://), onde onHeadersReceived NÃO é aplicado a
  // esse documento. Não se registam dois veículos divergentes; a navegação e o
  // IPC continuam com as guardas próprias.
  installNavigationPolicy(mainWindow.webContents, () => app.isPackaged
    ? pathToFileURL(path.join(__dirname, "index.html")).href
    : "http://localhost:5173/");

  // Observável para a verificação manual: diz o que vamos PEDIR ao SO, não o que
  // se vê (superfícies opacas do renderer podem ocultar o backdrop). Sem dados
  // pessoais.
  console.log(
    `[Electron] Fundo da janela: pedido=${windowMaterial.applied ?? "solido"} ` +
      `(motivo=${windowMaterial.reason}, build=${windowMaterial.build ?? "?"}, ` +
      `backdrop_suportado=${windowMaterial.backdropSupported})`,
  );

  initialWindowPresentation?.dispose();
  initialWindowPresentation = installInitialWindowReveal(mainWindow, {
    hidden: launchHidden && !pendingForegroundRequest,
    isQuitting: () => isQuitting,
  });
  pendingForegroundRequest = false;
  mainWindow.once("ready-to-show", () => {
    if (!app.isPackaged) mainWindow?.webContents.openDevTools();
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "index.html"));
  } else {
    const tryLoad = () => {
      mainWindow?.loadURL("http://localhost:5173").catch(() => {
        setTimeout(tryLoad, 1000);
      });
    };
    tryLoad();
  }

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Um renderer morto deixava uma página em branco que nunca mais se pintava:
  // a janela ficava "branca" de forma permanente, sem forma de a recuperar.
  // Aqui a janela é recarregada e o incidente fica registado (exit.log).
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logExitEvent("renderer-gone", {
      reason: details?.reason ?? "unknown",
      exitCode: details?.exitCode ?? null,
    });
    console.error("[Electron] Renderer terminou inesperadamente:", details?.reason);
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.reload();
    } catch (error) {
      console.error("[Electron] Falha ao recarregar a janela após a queda do renderer:", error);
    }
  });
  mainWindow.webContents.on("unresponsive", () => {
    logExitEvent("renderer-unresponsive");
    console.warn("[Electron] Renderer sem resposta.");
  });
}

import { spawn, type ChildProcess } from "node:child_process";

let isServiceRunning = false;
let serviceProcess: ChildProcess | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;

// API local empacotada (P0 — instalador). É AUXILIAR: se falhar, a proteção, a
// tray e a janela continuam a funcionar (nada aqui pode bloquear o arranque).
let apiRuntime: ApiRuntime | null = null;
let apiChild: ChildProcess | null = null;
let apiStartInFlight = false;
let aiStore: AiCredentialsStore | undefined;
function currentAiStore() {
  return aiStore ??= createAiCredentialsStore(app.getPath("userData"), safeStorage);
}

/** Tenta abrir o named pipe do serviço. true = um serviço vivo está a servir. */
function probePipe(timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    const socket = net.createConnection(perfil.pipeName);
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

/** Aguarda o pipe ficar acessível (readiness real) com timeout e pausas. */
async function waitForPipe(deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await probePipe(900)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return probePipe(900);
}

/**
 * DIST-CLAMAV13OUT — pin do motor ClamAV EMPACOTADO.
 *
 * O `vendor/clamav` (binários oficiais verificados) é publicado em
 * `resources/clamav` pela integração de empacotamento — que é um passo
 * SEPARADO e ainda não feito. Aqui só se DIZ ao serviço onde está o motor, e
 * só quando ele EXISTE mesmo: apontar para um caminho ausente seria um pin
 * fantasma. Sem o ficheiro, a chave não é definida e a resolução do core cai
 * no PATH — em DEV e em máquinas com ClamAV instalado nada muda.
 */
function serviceEnv(pipeToken: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    CYBERSAFE_PIPE_TOKEN: pipeToken,
  };
  const bundledClamscan = path.join(process.resourcesPath, "clamav", "clamscan.exe");
  if (fs.existsSync(bundledClamscan)) env[CLAMAV_BINARY_ENV] = bundledClamscan;
  // Base offline read-only, separada do perfil. O serviço verifica pins e
  // licença em cada probe; freshclam nunca recebe este directório.
  const bundledClamavSeed = path.join(process.resourcesPath, "clamav-seed");
  if (fs.existsSync(path.join(bundledClamavSeed, "SEED-MANIFEST.json"))) {
    env.CYBERSAFE_CLAMAV_SEED_DIR = bundledClamavSeed;
  }
  // DIST-ISOLATION: num build EMPACOTADO o serviço filho NÃO pode herdar o
  // otim-in de isolamento via `...process.env` — há de o apagar explicitamente.
  // Em dev (não empacotado) as variáveis ficam preservadas. `app.isPackaged` é
  // o gate autoritativo; o detector heurístico do core é só defesa em profundidade.
  if (app.isPackaged) stripDevIsolationEnv(env);
  return env;
}

/**
 * Estado do arranque do serviço. Um booleano não chegava: `true` significava
 * "há qualquer coisa à escuta", e o `false` perdia o motivo — foi assim que a
 * arranque reportado na VM QA1 abriu a janela sem serviço e sem nenhuma afirmação
 * honesta (mecanismo lido no fonte; medido em host/lane).
 */
type ServiceStartOutcome =
  | { status: "connected" }
  | { status: "failed"; reason: string };

async function startServiceProcess(): Promise<ServiceStartOutcome> {
  if (!app.isPackaged) {
    console.log("[Electron] Modo dev: serviço assumido via concurrently");
    return { status: "connected" };
  }
  if (pipeCredentialError) {
    return { status: "failed", reason: `credencial do pipe indisponível — ${pipeCredentialError}` };
  }

  // Reutilizar um serviço de um boot anterior SÓ é válido se ele aceitar a
  // credencial desta instalação. O probe cru prova que existe um listener, não
  // que o listener é nosso; decidir por ele era o lockout.
  const reuse = await resolveExistingService({
    probePipe: () => probePipe(1500),
    connect: () => client.connect(),
    teardown: () => client.disconnect(),
    log: (message) => console.log(message),
  });
  if (reuse.status === "reused") {
    console.log("[Electron] Serviço existente autenticado.");
    return { status: "connected" };
  }
  if (reuse.status === "foreign-service") {
    // Não se lança um segundo serviço: o pipe está ocupado e ele morreria em
    // `EADDRINUSE`, deixando um motor a servir zero pedidos. Falha honesta.
    return { status: "failed", reason: reuse.reason ?? "pipe ocupado por um serviço que não é desta instalação" };
  }

  const serviceEntry = path.join(app.getAppPath(), "node_modules", "@cybersafe", "service", "dist", "index.js");

  console.log("[Electron] Iniciando serviço embutido:", serviceEntry);
  serviceProcess = spawn(process.execPath, [serviceEntry], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    // Build packaged = produção: o serviço embutido tem de correr com
    // NODE_ENV=production (desliga o canário dev-only e alinha com o
    // windows-service.ts, que também o define).
    env: serviceEnv(pipeSessionToken),
  });

  // Consume output continuously: an unread pipe can block service writes and
  // therefore delay unrelated RPCs. Do not accumulate child logs in Electron.
  // The service retains its own diagnostic files.
  serviceProcess.stdout?.resume();
  serviceProcess.stderr?.resume();

  let exitedEarly = false;
  serviceProcess.on("exit", (code) => {
    exitedEarly = true;
    console.log(`[Electron] Processo do Serviço encerrou com código: ${code}`);
    serviceProcess = null;
  });

  serviceProcess.on("error", (err) => {
    exitedEarly = true;
    console.error("[Electron] Falha ao iniciar processo do serviço:", err);
  });

  // Readiness assíncrono do próprio serviço (além do probe do pipe).
  serviceProcess.on("message", (msg: any) => {
    if (msg?.type === "service-ready") {
      console.log("[Electron] Serviço sinalizou service-ready via IPC.");
    }
  });

  const ready = await waitForPipe(25_000);
  if (!ready) {
    console.error("[Electron] Serviço não ficou pronto a tempo (pipe inacessível).");
    if (serviceProcess && !exitedEarly) {
      try { serviceProcess.kill(); } catch {}
    }
    return { status: "failed", reason: "o serviço embutido não ficou à escuta em 25 s (pipe inacessível)" };
  }

  // Prontidão REAL é handshake autenticado, não listener. Um filho que apanhou
  // `EADDRINUSE` e saiu limpo (0) deixa no pipe um serviço de um boot anterior;
  // é essa posse que aqui se prova, e nunca se dá por adquirida em silêncio.
  const authenticated = await resolveExistingService({
    probePipe: async () => true,
    connect: () => client.connect(),
    teardown: () => client.disconnect(),
    log: (message) => console.log(message),
  });
  if (authenticated.status !== "reused") {
    return { status: "failed", reason: authenticated.reason ?? "o serviço não completou o handshake" };
  }
  return { status: "connected" };
}

/**
 * Arranca a API local empacotada, sem bloquear o boot.
 *
 * Em DEV a API é arrancada pelo `npm run dev:api` — aqui não se duplica. No
 * artefacto, é um processo filho do Electron com segredo próprio da instalação
 * guardado em `userData` (nunca dentro do pacote). A falha é declarada e NÃO
 * impede o serviço de proteção nem a janela de arrancar.
 */
function startPackagedApi(): void {
  if (!app.isPackaged) {
    console.log("[Electron] Modo dev: API assumida via npm run dev:api");
    return;
  }
  if (isQuitting || apiRuntime || apiStartInFlight || apiChild) return;
  apiStartInFlight = true;

  void startLocalApi({
    appPath: app.getAppPath(),
    userDataDir: app.getPath("userData"),
    electronPath: process.execPath,
    port: DEFAULT_API_PORT,
    // O renderer empacotado carrega em file:// e envia Origin: null. Só é aceite
    // porque é a instalação local desta máquina (o bind continua a ser
    // 127.0.0.1) e o opt-in é explícito — nunca implícito.
    allowNullOrigin: true,
    diagnostic: logStartup,
    onChildSpawned: (child) => {
      apiChild = child;
      child.once("exit", () => {
        if (apiChild === child) apiChild = null;
        if (apiRuntime?.child === child) apiRuntime = null;
      });
      if (isQuitting) stopLocalApi(child);
    },
    log: (message, error) => (error ? console.error(message, error) : console.log(message)),
  }).then((result) => {
    logStartup("api-result", { status: result.status, port: DEFAULT_API_PORT, ...(result.status === "failed" ? { classification: classifyStartupError(result.error ?? result.reason) } : {}) });
    if (result.status === "started") {
      if (isQuitting) stopLocalApi(result.runtime.child);
      else {
        apiRuntime = result.runtime;
        void configureAiChild(result.runtime.child, currentAiStore()).then((applied) => {
          if (!applied) stopLocalApi(result.runtime.child);
        }).catch(() => stopLocalApi(result.runtime.child));
      }
      return;
    }
    // Sem "API pronta" quando não está: o estado é declarado tal como é.
    console.error(`[Electron] API local não arrancou (${result.status}): ${result.reason}`);
    if (result.status === "failed" && result.error) {
      console.error("[Electron] Detalhe da falha da API:", result.error);
    }
  }).catch((error) => {
    logStartup("api-unavailable", { status: "failed", port: DEFAULT_API_PORT, classification: classifyStartupError(error) });
    console.error("[Electron] Falha inesperada no arranque da API:", error);
  }).finally(() => { apiStartInFlight = false; });
}

/**
 * Repinta o ícone da tray a partir do estado REAL. Extracted de
 * `updateServiceStatus` para que uma acção de menu (ativar/pausar proteção)
 * atualize o ícone sem ter de esperar pelo poll de 5 s.
 */
async function updateTrayIcon() {
  if (!tray) return;
  try {
    const level = trayProtectionLevel({ ...trayProtectionInfo(), serviceRunning: isServiceRunning });
    applyTrayImage(level);
  } catch (e) {
    console.error("Erro ao atualizar icone", e);
  }
}

/**
 * Pinta o ícone da bandeja para o estado real. A escolha do ficheiro vive em
 * `resolveTrayIconAsset` (tray-menu.ts) para ser testável sem Electron.
 */
function applyTrayImage(level: TrayProtectionLevel) {
  if (!tray) return;
  const slotPx = trayIconSizePx();
  const { path: iconPathToUse, dedicated } = resolveTrayIconAsset(
    level,
    slotPx,
    (p) => fs.existsSync(p),
    assetsPath,
  );

  const image = nativeImage.createFromPath(iconPathToUse);
  if (!image.isEmpty()) {
    tray.setImage(dedicated ? image : image.resize({ width: slotPx, height: slotPx }));
  }

  // Sinal redundante em texto ao lado do ícone. NÃO é o mecanismo principal —
  // os três estados já têm ícones distintos de facto. Fica porque o Windows
  // mostra este título em modo reduzido e torna o estado legível sem
  // ampliar o ícone.
  tray.setTitle(
    level === "unprotected" ? "✕" : level === "attention" ? "!" : "",
  );
}

async function updateServiceStatus() {
  // Shutdown: a tray deixa de fazer leituras periódicas ao serviço.
  if (isQuitting) return;
  const status = client.isConnected ? 'RUNNING' : 'STOPPED';
  isServiceRunning = status === 'RUNNING';

  // Atualiza o menu da tray com o estado real (proteção + contadores).
  await refreshTrayProtectionInfo();
  updateTrayMenu();
  await updateTrayIcon();
}

/**
 * Liga/desliga a proteção e devolve o estado CONFIRMADO pelo motor.
 *
 * Historial da guarda, em três camadas:
 *  1. um `.catch` que fabricava `protectionEnabled: !enabled` fazia a UI
 *     acreditar que a operação tinha corrido bem quando o serviço nem respondeu;
 *  2. `result.protectionEnabled ?? true` afirmava ATIVO a partir de uma resposta
 *     incompleta (HIGH-2 da auditoria, 15/10);
 *  3. o cast `as {...}` escondia do compilador o facto de o contrato partilhado
 *     dizer outra coisa (HIGH-1), pelo que nenhuma das duas camas anteriores era
 *     verificável.
 * Agora: o pedido é tipado pelo `ServiceResponseMap` real e TODO o caminho —
 * aguardar, validar, sanitizar a rejeição — vive em `protection-toggle-result.ts`,
 * que os testes exercitam com um `request` injetado. O `main.ts` não tem segunda
 * versão da guarda; `protectionEnabled: null` é NÃO CONFIRMADO e o toast diz-no.
 */
async function setProtectionEnabled(enabled: boolean): Promise<ProtectionActionResult> {
  return requestProtectionToggle((cmd) => client.request(cmd, undefined), enabled, (err) =>
    console.error("[Tray] Falha ao mudar o estado da proteção:", err),
  );
}

/** Pausa a proteção por N minutos. O motor trata da reativação automática. */
async function pauseProtection(minutes: number): Promise<boolean> {
  try {
    const result = (await client.request("monitor.pause", { durationMs: minutes * 60_000 })) as {
      ok?: boolean;
      protectionEnabled?: boolean;
    } | undefined;
    if (!result || result.ok !== true) return false;
    // P1-C (RE-REVIEW CODEX): aqui NÃO há refresh nem repaint. O ciclo de
    // vida do pending é só do RPC/deadline do voo: pintar depois do refresh
    // validado acontece em `pendingProtection.settle`, com identidade e
    // geração. Refrescar fora do guarda deixava o snapshot velho a competir
    // com o voo vigente.
    return true;
  } catch (err) {
    console.error("[Tray] Falha ao pausar a proteção:", err);
    return false;
  }
}

/**
 * Estado da proteção em cache para a tray (poll de 5 s, settle do voo,
 * eventos). P1-B (RE-REVIEW CODEX): escrever aqui deixou de ser livre — TODA
 * a escrita passa pelo `SnapshotCommitter`, que só aceita uma leitura se
 * nenhuma leitura mais nova nem nenhum evento abriu geração depois dela.
 * Um snapshot velho a sobrescrever um evento recente era o limite apontado.
 */
const DEFAULT_TRAY_SNAPSHOT: TrayProtectionInfo = {
  serviceRunning: false,
  status: null,
  score: null,
  threats: null,
  quarantine: null,
};
const traySnapshot = new SnapshotCommitter<TrayProtectionInfo>();
/** Leitura do snapshot vigente (null = nunca pintado; default honesto). */
const trayProtectionInfo = (): TrayProtectionInfo => traySnapshot.value ?? DEFAULT_TRAY_SNAPSHOT;

// ── Estado de análise na tray (R7-L3) ──
/** Último estado de análise PUBLICADO pelo motor. null = nenhum confirmado. */
let trayScanInfo: TrayScanInfo | null = null;
/** O motor publica um evento por ficheiro: o menu reconstrói no máximo ~1x/segundo. */
let lastTrayScanPaint = 0;
let trayScanPaintTimer: ReturnType<typeof setTimeout> | null = null;
const TRAY_SCAN_REPAINT_MS = 1000;

/**
 * Pinta o estado de análise na tray. Throttle idêntico em ideia ao
 * `SnapshotCommitter` da proteção: reconstruir o menu a cada evento
 * de scan era desperdício puro, e o utilizador não lê mais depressa
 * por isso.
 */
function paintTrayScan(scan: TrayScanInfo | null) {
  trayScanInfo = scan;
  const now = Date.now();
  const remaining = TRAY_SCAN_REPAINT_MS - (now - lastTrayScanPaint);
  if (remaining <= 0) {
    lastTrayScanPaint = now;
    updateTrayMenu();
    return;
  }
  if (trayScanPaintTimer) return;
  trayScanPaintTimer = setTimeout(() => {
    trayScanPaintTimer = null;
    lastTrayScanPaint = Date.now();
    updateTrayMenu();
  }, remaining);
}

/**
 * Acção de proteção pedida pela tray e ainda NÃO confirmada pelo motor.
 *
 * LATÊNCIA MEDIDA: entre o clique em "Ativar proteção" e a resposta do motor
 * passavam segundos sem a tray mudar — o item continuava a dizer "Ativar
 * proteção" e o clique parecia não fazer nada.
 *
 * O estado, o deadline e a IDENTIDADE POR VOO vivem em
 * `pending-protection.ts` (módulo puro, testável sem Electron). O REVIEW CODEX
 * classificou como P1 o clear sem identidade: o refresh tardio de A apagava o
 * pending de B. Hoje cada voo captura um token e, depois de cada await, só o
 * dono do token vigente pinta/notifica; o deadline cobre RPCs que nunca
 * resolvem e `isQuitting` corta resoluções no encerramento.
 */
const pendingProtection = new PendingProtection({
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  refreshState: async () => {
    await refreshTrayProtectionInfo();
  },
  repaint: () => {
    updateTrayMenu();
    void updateTrayIcon();
  },
  notify: (n) => notifyUser(n.title, n.body),
  isQuitting: () => isQuitting,
  onDeadlineExpired: (action) =>
    console.warn(
      `[Tray] Pedido '${action}' sem resposta do serviço — pending limpo após o prazo; o estado real foi relido, nada foi afirmado.`,
    ),
  onStaleResolution: (action, token) =>
    console.warn(
      `[Tray] Resolução atrasada do pedido '${action}' (token ${token}) ignorada — o pending vigente pertence a outro voo.`,
    ),
});

async function refreshTrayProtectionInfo() {
  // Shutdown: nunca iniciar uma nova leitura ao serviço.
  if (isQuitting) return;
  // P1-B: a leitura abre GERACAO. Se outra leitura ou um evento do motor
  // escrever depois do nosso await, o commit e descartado — um snapshot
  // velho nunca sobrescreve um mais recente.
  const myGeneration = traySnapshot.begin();
  try {
    const state = await Promise.race([
      client.request("protection.getState", undefined) as Promise<any>,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
    ]);
    if (isQuitting) return;
    const riskScore = state?.stats?.riskScore;
    traySnapshot.commit(myGeneration, {
      serviceRunning: isServiceRunning,
      // O estado interno fica aqui (e nos logs) — tray-menu.ts traduz antes de
      // chegar à UI, por isso o enum nunca é mostrado ao utilizador.
      status: typeof state?.status === "string" ? state.status : null,
      score: typeof riskScore === "number" ? Math.max(0, 100 - riskScore) : null,
      threats: typeof state?.stats?.totalEvents === "number" ? state.stats.totalEvents : null,
      quarantine: typeof state?.stats?.quarantinedCount === "number" ? state.stats.quarantinedCount : null,
      // Facto real on/off. `undefined` quando o motor antigo não responde: aí a
      // tray não pode afirmar "Protegido".
      protectionEnabled:
        typeof state?.protectionEnabled === "boolean" ? state.protectionEnabled : null,
      pausedUntil: typeof state?.protectionPausedUntil === "string" ? state.protectionPausedUntil : null,
    });
  } catch {
    if (isQuitting) return;
    traySnapshot.commit(myGeneration, {
      serviceRunning: isServiceRunning,
      status: null,
      score: null,
      threats: null,
      quarantine: null,
      // Falha na leitura é DESCONHECIDO, nunca "desligada". Distinguir os dois
      // evita dizer "Não protegido" quando o motor está só em silêncio.
      protectionEnabled: null,
      pausedUntil: null,
    });
  }
}

/** Encerramento completo: serviço → watcher/motores → Electron. Sem órfãos. */
async function quitCyberSafe() {
  // isQuitting = estado de shutdown da app: a partir daqui nem o renderer
  // (via guarda dos handlers) nem a tray iniciam leituras novas ao serviço.
  logExitEvent("quit-start", {
    service: Boolean(serviceProcess && serviceProcess.pid),
    api: Boolean(apiRuntime),
  });
  isQuitting = true;
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  pendingProtection.abandon();
  tray?.setToolTip("Encerrando CyberSafe...");

  console.log("[Electron] Electron shutdown requested");
  console.log("[Electron] Enviando comando de shutdown ao serviço...");
  await client.requestShutdown().catch((err) =>
    console.error("[Electron] Shutdown request falhou:", err));
  console.log("[Electron] Ligação ao serviço fechada; a terminar o Electron.");
  logExitEvent("quit-app-quit");

  // O pedido shutdown já termina watcher/motores/updater no serviço (exit(0))
  // e o before-quit garante o kill do serviceProcess remanescente.
  app.quit();
}

function updateTrayMenu() {
  if (!tray) return;

  const info: TrayProtectionInfo = {
    ...trayProtectionInfo(),
    serviceRunning: isServiceRunning,
    pendingAction: pendingProtection.current,
    scan: trayScanInfo,
  };
  const level = trayProtectionLevel(info);

  // O tooltip deixou de mentir. Antes dizia "protecao em tempo real a
  // funcionar" sempre que o servico estava de pe — e o servico estar de pe
  // nao diz nada sobre os motores. Agora segue o mesmo estado do icone.
  tray.setToolTip(
    trayTooltipWithIdentity(trayTooltip(level, info.pausedUntil), {
      isPackaged: app.isPackaged,
      devIsolated: devIsolamentoVerificado,
      pid: process.pid,
    }),
  );

  // Copy + tradução de estados vivem em tray-menu.ts (testável, sem enums crus).
  const template = buildTrayMenuTemplate(info, {
    open: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    },
    // Confirmação integrada (modal CyberSafe) — nunca o diálogo nativo branco.
    exit: () => {
      void exitConfirmation.request();
    },
    ...(() => {
      // As acções da tray NÃO passam por IPC: são chamadas directas do handler
      // nativo. `tray-menu.ts` esconde o item cujo handler não existe, por isso
      // suprimir o handler suprime o efeito. Com o modo desligado o objecto é
      // exatamente o de antes.
      const acoes = trayActionHandlers();
      return fronteiraLeituraWindows.activo ? suprimirAcoesTray(acoes) : acoes;
    })(),
  });

  tray.setContextMenu(Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]));
}

/**
 * Acções da tray. Cada handler existe porque o backend lhe dá suporte; o menu
 * esconde o que não tiver handler. `stopProtection`/`startProtection` esperam
 * pela confirmação do motor antes de mexer no ícone — o menu não declara
 * sucesso por conta própria.
 */
const runTrayQuickScan = createTrayQuickScan(
  (topic, payload) => client.request(topic, payload),
  (state) => sendToRenderer("scanner", { state }),
  (error) => sendToRenderer("scanner", { error }),
);

function trayActionHandlers(): Pick<
  TrayMenuHandlers,
  | "quickScan" | "showProtection" | "openQuarantine" | "openSettings"
  | "startProtection" | "stopProtection" | "pauseProtection"
> {
  return {
    quickScan: () => {
      showWindow();
      sendToRenderer("scanner");
      void runTrayQuickScan();
    },
    showProtection: () => {
      showWindow();
      // O painel de proteção vive no Dashboard (ProtectionDetails).
      sendToRenderer("dashboard");
    },
    openQuarantine: () => {
      showWindow();
      // Existe página "Quarentena": a tray abre a rota real. Mandar para o
      // Monitor de Rede era o comportamento errado que o utilizador viu.
      sendToRenderer("quarantine");
    },
    openSettings: () => {
      showWindow();
      sendToRenderer("settings");
    },
    startProtection: () => {
      // Um segundo clique enquanto o primeiro está em voo seria um pedido
      // concorrente ao motor. A tray já mostra o pedido em curso.
      if (pendingProtection.busy) return;
      const mine = pendingProtection.begin("starting");
      void setProtectionEnabled(true).then((res) =>
        pendingProtection.settle(
          mine,
          res.ok,
          {
            title: "Proteção em tempo real ativada",
            body: res.degraded?.length
              ? `Ficheiros e processos monitorizados. Limitação declarada: ${res.degraded[0].reason}`
              : "A monitorização do CyberSafe foi ativada. Consulte os motores e as limitações no painel de proteção.",
          },
          protectionFailToast("ativar", res),
        ),
      );
    },
    stopProtection: () => {
      if (pendingProtection.busy) return;
      const mine = pendingProtection.begin("stopping");
      void setProtectionEnabled(false).then((res) =>
        pendingProtection.settle(
          mine,
          res.ok,
          {
            title: "Proteção em tempo real desativada",
            body: res.reason ?? "O CyberSafe deixou de monitorizar novos ficheiros. As outras proteções do Windows são independentes.",
          },
          protectionFailToast("desativar", res),
        ),
      );
    },
    pauseProtection: (minutes: number) => {
      if (pendingProtection.busy) return;
      const mine = pendingProtection.begin("pausing");
      void pauseProtection(minutes).then((ok) =>
        pendingProtection.settle(
          mine,
          ok,
          {
            title: `Proteção em pausa (${minutes} min)`,
            body: "A monitorização do CyberSafe está em pausa e tem reativação agendada.",
          },
          {
            title: "Não foi possível pausar a proteção",
            body: "O serviço não confirmou a pausa.",
          },
        ),
      );
    },
  };
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

/**
 * Pede ao renderer que mude de página. `page` tem de ser uma `Page` real — o
 * renderer valida e ignora o que não conhece, para que o menu nunca finja ter
 * levado o utilizador a algum lado.
 */
function sendToRenderer(page: string, scanSession?: { state?: import("@cybersafe/shared-types").ScanState; error?: string }) {
  if (isQuitting) return;
  const target = mainWindow;
  if (!target || target.isDestroyed()) return;
  // O renderer pode ainda não ter terminado de carregar: nesse caso a navegação
  // seria perdida. Por isso só se envia quando a página já está pronta.
  const deliver = () => {
    if (isQuitting || target.isDestroyed()) return;
    target.webContents.send("app:navigate", page);
    if (scanSession) target.webContents.send("app:scan-session", scanSession);
  };
  if (target.webContents.isLoading()) {
    target.webContents.once("did-finish-load", () => {
      deliver();
    });
    return;
  }
  deliver();
}

function notifyUser(title: string, body: string) {
  notificationDelivery.notify(title, body);
}

/**
 * Notificação de fim de análise (R7-L3). Só com o motor a confirmar
 * o estado terminal, atrás da preferência (gate em `notifyUser`) e
 * do debounce já existente — nada de toasts duplicados. Copy PT-PT
 * com os contadores reais do próprio estado; sem eles, não se
 * afirma número nenhum.
 */
function notifyScanEnd(state: ScanState) {
  const key = `scan-end:${state.id}`;
  const now = Date.now();
  if (now - (notificationHistory.get(key) ?? 0) <= DEBOUNCE_TIME) return;
  notificationHistory.set(key, now);
  const message = scanCompletionNotification(state);
  if (message) notifyUser("CyberSafe Assistant", message);
}

// ── Confirmação de saída (modal CyberSafe no renderer) ──
// O diálogo nativo branco do Windows deixou de ser a UX: o tray pede o modal
// ao renderer e só depois corre o shutdown JÁ existente (quitCyberSafe).
let exitConfirmResolve: ((confirmed: boolean) => void) | null = null;
let exitModalDelivery: ExitDelivery | null = null;
const EXIT_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Log persistente do ciclo de saída.
 *
 * O stdout do pacote não é observável quando a app é aberta pelo atalho — foi
 * por isso que a falha intermitente da tray (10/10/2026) não deixou evidência
 * nenhuma. Estes eventos (e os do renderer) ficam em userData/logs/exit.log.
 */
/** Technical startup diagnostics only. Read-only test mode stays free of log writes. */
function logStartup(event: string, details: Record<string, unknown> = {}): void {
  if (!app.isPackaged || fronteiraLeituraWindows.activo) return;
  createStartupDiagnostic(startupLogPath)(event, details);
}

function exitLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "exit.log");
}
function logExitEvent(event: string, details: Record<string, unknown> = {}): void {
  appendDesktopLog(exitLogPath(), event, details);
}

/**
 * Recria a janela se tiver sido destruída, mas NÃO a mostra: quem pede o modal
 * de saída só a revela depois de o renderer confirmar que o modal está
 * apresentado. Mostrar uma janela escondida ANTES do primeiro frame é o que o
 * Windows apresenta como janela branca; revelar depois evita isso.
 */
function prepareMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    createWindow();
  }
  const win = mainWindow;
  if (!win || win.isDestroyed()) return null;
  return win;
}

/** Traz a janela para a frente (restaura se minimizada, mostra se escondida). */
function revealMainWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** Explicit launch intent can arrive before whenReady/createWindow. */
function requestMainWindowForeground(): void {
  if (isQuitting) return;
  pendingForegroundRequest = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    pendingForegroundRequest = false;
    if (initialWindowPresentation) initialWindowPresentation.requestForeground();
    else revealMainWindow(mainWindow);
  } else if (app.isReady()) {
    createWindow();
  }
}

/** O renderer consegue desenhar o modal? (janela viva e não crashada) */
function canAskRenderer(win: BrowserWindow | null): win is BrowserWindow {
  if (!win || win.isDestroyed()) return false;
  const contents = win.webContents;
  if (contents.isDestroyed()) return false;
  try {
    return !contents.isCrashed();
  } catch {
    return true;
  }
}

/** Pergunta ao utilizador no renderer (modal CyberSafe). true = confirmar. */
async function askExitConfirmation(): Promise<boolean> {
  const win = prepareMainWindow();
  if (!canAskRenderer(win)) {
    logExitEvent("modal-unavailable");
    console.warn("[Electron] Renderer indisponível para o modal de saída — confirmação de último recurso.");
    return nativeExitFallback();
  }

  // A resposta do renderer é capturada ANTES do envio: um clique imediato no
  // modal nunca pode chegar sem ninguém à espera dele.
  const answer = new Promise<boolean>((resolve) => {
    exitConfirmResolve = resolve;
  });

  const delivery = createExitDelivery({
    send: () => {
      try {
        if (win.webContents.isLoading()) {
          // Janela recriada: o reenvio da entrega cobre o carregamento em curso.
          win.webContents.once("did-finish-load", () => {
            if (!win.isDestroyed()) win.webContents.send("app:exit-confirm", true);
          });
        } else {
          win.webContents.send("app:exit-confirm", true);
        }
      } catch (error) {
        console.error("[Electron] Falha ao abrir o modal de saída:", error);
      }
    },
    isRendererAvailable: () => canAskRenderer(mainWindow),
    onEvent: (event, details) => logExitEvent(event, details),
  });
  exitModalDelivery = delivery;

  // O renderer ACKAR (modal apresentado) ou o utilizador responder — o que vier
  // primeiro — decide. Sem ack em ~3,8 s cai na confirmação nativa: nunca há um
  // clique "engolido" à espera dos 30 s do timeout global.
  const outcome = await Promise.race([delivery.request(), answer.then(() => "answered" as const)]);
  exitModalDelivery = null;

  if (outcome === "unavailable" || outcome === "gave-up") {
    exitConfirmResolve = null;
    logExitEvent("native-fallback", { outcome });
    console.warn(`[Electron] Modal de saída sem confirmação (${outcome}) — confirmação nativa.`);
    return nativeExitFallback();
  }

  // Modal apresentado: agora sim a janela pode aparecer — já pintada.
  revealMainWindow(win);
  logExitEvent("modal-shown", { outcome });
  return answer;
}

/**
 * Último recurso, usado APENAS quando não há renderer utilizável: sem isto o
 * utilizador ficaria sem forma de encerrar a aplicação pela tray.
 */
async function nativeExitFallback(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancelar", "Sair"],
    defaultId: 0,
    cancelId: 0,
    title: "Sair do CyberSafe",
    message: "Sair do CyberSafe?",
    detail: "A proteção em tempo real será encerrada neste computador.",
  });
  return response === 1;
}

/**
 * Uma pergunta em curso não se duplica e cancelar nunca encerra. O shutdown
 * (quitCyberSafe) é chamado no máximo uma vez.
 */
const exitConfirmation = createExitConfirmation({
  ask: askExitConfirmation,
  onConfirmed: () => {
    logExitEvent("exit-confirmed");
    return quitCyberSafe();
  },
  timeoutMs: EXIT_CONFIRM_TIMEOUT_MS,
  onTimeout: () => {
    const win = mainWindow;
    exitConfirmResolve = null;
    logExitEvent("confirm-timeout");
    console.warn("[Electron] Sem resposta ao pedido de confirmação de saída — encerramento cancelado.");
    try {
      if (win && !win.isDestroyed()) win.webContents.send("app:exit-confirm", false);
    } catch {
      // A janela desapareceu entretanto: nada a fazer.
    }
  },
  onError: (error) => {
    logExitEvent("confirm-error", { message: String(error) });
    console.error("[Electron] Confirmação de saída falhou:", error);
  },
});

function createTray() {
  const size = trayIconSizePx();
  // Ícone inicial pelo ESTADO DA PROTECÇÃO, não pelo serviço de pé. Antes usava
  // isServiceRunning, que pintava o ícone de "protegido" com a proteção
  // desligada. `trayProtectionInfo` ainda vale o default (serviço em baixo) na
  // criação — é substituído pelo poll logo a seguir; o importante é que já nasce
  // no ícone de "não protegido" e não no de "protegido".
  const initialLevel = trayProtectionLevel({ ...trayProtectionInfo(), serviceRunning: isServiceRunning });
  const { path: iconPath, dedicated } = resolveTrayIconAsset(
    initialLevel,
    size,
    (p) => fs.existsSync(p),
    assetsPath,
  );
  const primary = nativeImage.createFromPath(iconPath);
  const fallback = nativeImage.createFromPath(resolveTrayIconPath());
  const trayImage = !primary.isEmpty()
    ? (dedicated ? primary : primary.resize({ width: size, height: size }))
    : (fallback.isEmpty() ? nativeImage.createEmpty() : fallback.resize({ width: size, height: size }));
  tray = new Tray(trayImage);

  updateTrayMenu();

  // Poll service status every 5 seconds
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(updateServiceStatus, 5000);
  updateServiceStatus();
}

function wireRealtimeEvents() {
  client.onConnectionState((connected) => {
    if (isQuitting) return;
    isServiceRunning = connected;
    if (!connected) {
      traySnapshot.paint({ ...DEFAULT_TRAY_SNAPSHOT, protectionEnabled: null, pausedUntil: null });
      // Sem pipe, nenhum estado de análise está confirmado: a linha
      // desaparece até o motor voltar a publicar.
      trayScanInfo = null;
      updateTrayMenu();
      void updateTrayIcon();
    }
    mainWindow?.webContents.send("service:connection-state", { connected });
    // Motor essencial indisponivel/restabelecido: o modulo decide e deduplica
    // (RECOVERY-SECURITY-20261014) — o arranque ligado nao notifica.
    securityNotifications.handleConnectionState(connected);
    if (connected) void updateServiceStatus();
  });
  client.onEvent((event: SecurityEvent) => {
    // Shutdown: nada de eventos para o renderer (que já está a encerrar).
    if (isQuitting) return;
    // Per-event logging stays off by default: a scan emits an event every few
    // files, and logging each one in the main process is pure overhead.
    if (process.env.CYBERSAFE_DEBUG_SCAN === "1" && event.type === "scan.progress") {
      const data = (event.data ?? {}) as { id?: string; status?: string; progress?: number; filesScanned?: number; phase?: string };
      console.log(`[ScanIPC] forward scanId=${data.id ?? "n/a"} status=${data.status} phase=${data.phase} progress=${data.progress} files=${data.filesScanned} at=${new Date().toISOString()}`);
    }
    mainWindow?.webContents.send("service:event", event);
    // Estado CONFIRMADO da proteção por EVENTO (baixa frequência), não por poll:
    // a tray deixa de esperar até 5 s para pintar a mudança que o motor já
    // confirmou. P1-A (RE-REVIEW CODEX): o evento pinta o ESTADO GLOBAL e NÃO
    // liberta pedidos pendentes — um `protection.changed` atrasado de A já
    // apagou o pending de B. O ciclo de vida do pending é só do seu RPC ou do
    // seu deadline, revalidados por token na máquina.
    if (event.type === "protection.changed") {
      const d = (event.data ?? {}) as {
        protectionEnabled?: boolean;
        protectionPausedUntil?: string | null;
      };
      if (typeof d.protectionEnabled === "boolean") {
        // `paint` abre geração: leituras em curso perdem o direito de commit;
        // o estado do motor é o mais recente e é ele que se mostra.
        traySnapshot.paint({
          ...trayProtectionInfo(),
          protectionEnabled: d.protectionEnabled,
          pausedUntil: d.protectionPausedUntil ?? null,
        });
        updateTrayMenu();
        void updateTrayIcon();
      }
    }
    // Estado de análise para a tray (R7-L3): só o que o motor publicou.
    // Progresso só com número real (0 é o arranque, 100 só existe no
    // terminal — nenhum dos dois é progresso); cancelada não vira
    // "concluída" (a linha simplesmente desaparece).
    if (event.type === "scan.progress") {
      const scanState = event.data as Partial<ScanState> | undefined;
      if (
        scanState &&
        typeof scanState.id === "string" &&
        typeof scanState.status === "string"
      ) {
        if (scanState.status === "running" || scanState.status === "queued") {
          paintTrayScan({
            status: "running",
            phase: typeof scanState.phase === "string" ? scanState.phase : undefined,
            progress:
              typeof scanState.progress === "number" && Number.isFinite(scanState.progress)
                ? scanState.progress
                : null,
          });
        } else if (scanState.status === "completed") {
          paintTrayScan({
            status: "completed",
            threatsFound:
              typeof scanState.threatsFound === "number" ? scanState.threatsFound : undefined,
          });
          notifyScanEnd(scanState as ScanState);
        } else if (scanState.status === "failed") {
          paintTrayScan({ status: "failed" });
          notifyScanEnd(scanState as ScanState);
        } else if (scanState.status === "cancelled") {
          paintTrayScan(null);
        }
      }
    }
    // Only show desktop notifications for truly dangerous events —
    // RECOVERY-SECURITY-20261014: o gate (preferencia, severidade, dedup,
    // tipos elegiveis, mudancas reais de protecao) e todo do modulo.
    securityNotifications.handleEvent(event);
  });
}

let ipcRegistered = false;

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;

/**
 * O parâmetro tem identidade como default de propósito: `registerIpc` é o único
 * ponto onde a política de leitura se aplica, e os testes de segurança
 * (`r6-l13-ipc-security`, `r8-usb-ipc`) extraem exatamente esta função e correm-na
 * num `vm` com um sandbox próprio. Sem o default, qualquer nome novo do módulo
 * rebentaria lá (`ReferenceError`) e a baseline deixaria de provar o que pode.
 */
function registerIpc(
  envolverLeituraWindows: (canal: string, handler: IpcHandler) => IpcHandler = (_canal, handler) => handler,
  decidirRespostaSaida: (confirmado: unknown) => DecisaoSaida = (confirmado) => ({
    consumir: true,
    valor: Boolean(confirmado),
    causa: "comportamento_normal",
  }),
  registerSession: (handle: (channel: string, handler: IpcHandler) => void) => void = () => {},
) {
  // Idempotente: um segundo registo lançaria "Attempted to register a second
  // handler for '<channel>'" e deixaria o IPC do scanner morto.
  if (ipcRegistered) return;
  ipcRegistered = true;
  // Emissor/frame/URL primeiro (nunca enfraquecido), política de leitura depois,
  // handler por último: com o modo ligado um canal de efeito é recusado ANTES de
  // tocar em Electron, fs, spawn, rede ou registo. Com o modo desligado a
  // composição é a de antes — uma chamada extra sem efeito observável, que nem
  // lê o payload nem reescreve a resposta dos canais permitidos.
  const handle = (channel: string, handler: IpcHandler) =>
    ipcMain.handle(channel, trustedIpcHandler(
      () => mainWindow?.webContents ?? null,
      () => app.isPackaged ? pathToFileURL(path.join(__dirname, "index.html")).href : "http://localhost:5173/",
      envolverLeituraWindows(channel, handler),
    ));
  registerSession(handle);
  registerAiCredentialsIpc(handle, currentAiStore, async (store) => {
    const child = apiRuntime?.child ?? null;
    const applied = await configureAiChild(child, store);
    if (!applied && child) stopLocalApi(child);
    return applied;
  });
  handle("service:get-connection-state", () => ({ connected: client.isConnected }));
  // Cores da barra de janela (Window Controls Overlay): o renderer envia os
  // valores já resolvidos do tema ativo e o módulo puro valida-os — um payload
  // inválido devolve `{ ok: false }` em vez de rebentar dentro do IPC.
  handle("app:set-titlebar-overlay", (_event, payload) => {
    const result = applyTitleBarOverlay(mainWindow, payload);
    const color = normalizeTitleBarOverlayPayload(payload)?.color;
    if (result.ok && color) nativeTheme.themeSource = themeSourceForOverlayColor(color);
    return result;
  });

  // ── Updater da aplicação (mínimo; UNCONFIGURED hoje) ──────────────────────
  // `handle` já envolve trustedIpcHandler (documento principal, rejeita subframe/
  // remote). Validação EM RUNTIME dos payloads (o tipo TS não valida nada) e guard
  // de `appUpdater === null` sem `!` (nunca crashar o IPC por init em falta).
  const updateVersion = () => app.getVersion();
  const withUpdater = async (run: (u: Updater) => Promise<UpdaterResult>) =>
    appUpdater ? toWireResult(await run(appUpdater)) : failureResult("unconfigured", updateVersion(), "updater não inicializado");
  handle("app:update-get-snapshot", async () =>
    appUpdater ? toAppUpdateSnapshot(appUpdater.snapshotCopy()) : failureSnapshot("unconfigured", updateVersion(), "updater não inicializado"));
  handle("app:update-check", () => withUpdater((u) => u.check()));
  handle("app:update-download", () => withUpdater((u) => u.download()));
  handle("app:update-reveal", () => withUpdater((u) => u.revealVerifiedDownload((file) => shell.showItemInFolder(file))));
  handle("app:update-cancel", () => withUpdater((u) => u.cancel()));
  handle("app:update-defer", () => withUpdater((u) => u.defer()));
  handle("app:update-install", async (_event, req: unknown) => {
    const v = validateInstallRequest(req);
    if (!v.ok) return failureResult("installation", updateVersion(), "pedido de instalação inválido");
    return withUpdater((u) => u.install(v.value));
  });
  handle("app:update-set-automatic", async (_event, enabled: unknown) => {
    const v = validateAutomaticInput(enabled);
    if (!v.ok) return failureResult("internal", updateVersion(), "flag automática inválida");
    return withUpdater((u) => u.setAutomaticCheck(v.value));
  });

  /**
   * Canal do renderer contra o serviço, com a guarda de shutdown:
   * - durante o shutdown não inicia leituras novas (o renderer já parou os
   *   pollers; isto é a segunda linha de defesa);
   * - pedidos que estavam em voo quando o pipe foi desligado resolvem em null,
   *   em vez do ruído "Error occurred in handler ... Service client disconnected";
   * - em runtime normal os erros reais continuam a propagar para o renderer.
   */
  const serviceRequest = (
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
  ) =>
    handle(channel, (event, ...args) =>
      guardedServiceRequest(() => isQuitting, () => Promise.resolve(handler(event, ...args))),
    );

  serviceRequest("service:get-protection-state", () => client.request("protection.getState", undefined));
  // Escrita de proteção a partir do Painel. Reutiliza as MESMAS rotinas da tray
  // (monitor.start/stop e monitor.pause) — nenhum comando novo no serviço,
  // nenhuma lógica duplicada. Depois da operação, refresca o snapshot e repinta
  // a tray para que tray e renderer vejam o mesmo facto confirmado pelo motor.
  serviceRequest("service:set-protection", async (_event, enabled: boolean) => {
    const result = await setProtectionEnabled(enabled);
    await refreshTrayProtectionInfo();
    updateTrayMenu();
    void updateTrayIcon();
    return result;
  });
  serviceRequest("service:pause-protection", async (_event, minutes: number) => {
    const ok = await pauseProtection(Number(minutes) || 15);
    await refreshTrayProtectionInfo();
    updateTrayMenu();
    void updateTrayIcon();
    return ok;
  });
  serviceRequest("service:get-events", (_event, payload) => client.request("events.list", payload));
  serviceRequest("service:get-scan-history", (_event, payload) => client.request("scan.history", payload));
  serviceRequest("service:get-threats", () => client.request("threats.list", undefined));
  serviceRequest("service:get-processes", () => client.request("processes.list", undefined));
  serviceRequest("service:get-connections", () => client.request("connections.list", undefined));
  serviceRequest("service:get-quarantine", () => client.request("quarantine.list", undefined));
  serviceRequest("service:clear-events", () => client.request("events.clear", undefined));
  serviceRequest("service:scan-artifact", (_event, filePath: string) => client.request("scan.artifact", { path: filePath }));
  serviceRequest("service:scan-full-system", () => client.request("scan.fullSystem", undefined));
  // serviceRequest includes trusted main-frame, readonly and shutdown guards.
  registerProcessTerminationIpc(serviceRequest, {
    prepare: selection => client.request("process.termination.prepare",selection),
    confirm: ticket => client.request("process.termination.confirm",{ticket}),
    cancel: ticket => client.request("process.termination.cancel",{ticket}),
    critical: () => isQuitting || ["installing","verifying"].includes(appUpdater?.snapshotCopy().phase ?? ""),
  });
  serviceRequest("service:kill-process-tree", (_event, pid: number) => client.request("process.killTree", { pid }));
  serviceRequest("service:analyze-process", (_event, pid: number) => client.request("process.analyze", { pid }));
  serviceRequest("service:get-hardware", () => client.request("hardware.snapshot", undefined));
  serviceRequest("service:get-windows-health", () => client.request("windows.healthSnapshot", undefined));
  serviceRequest("service:get-pcstate", () => client.request("pcstate.get", undefined));
  serviceRequest("service:restore-quarantine", (_event, id: string, trustAfterRestore = false) =>
    client.request("quarantine.restore", { id, trustAfterRestore }));
  serviceRequest("service:delete-quarantine", (_event, id: string) => client.request("quarantine.delete", { id }));
  serviceRequest("service:allow-hash", (_event, sha256: string) => client.request("trust.allowHash", { sha256 }));
  serviceRequest("service:allow-publisher", (_event, publisher: string) =>
    client.request("trust.allowPublisher", { publisher }));
  serviceRequest("service:run-restricted-analysis", (_event, filePath: string) =>
    client.request("analysis.restricted", { path: filePath }));
  serviceRequest("service:update-definitions", () => client.request("definitions.update", undefined));
  // Leitura do estado por fonte (ClamAV / YARA / HashDB). Pass-through fino: a
  // contagem, a idade e o backoff vivem no servico — o renderer nao os inferir.
  serviceRequest("service:get-definitions-status", () => client.request("definitions.status", undefined));
  // Contrato R7: snapshot a pedido, nunca disparado por scan.progress.
  // O serviço valida as regras antes de gravar; a política interna não é editável.
  serviceRequest("service:get-exclusions", () => client.request("exclusions.get", undefined));
  serviceRequest("service:update-exclusions", (_event, config: { rules: import("@cybersafe/shared-types").ExclusionRule[] }) =>
    client.request("exclusions.update", config));
  // ── Opt-in de retoma ao arrancar ──────────────────────────────────────────
  // Pass-through fino e validado: a decisão de gravar e a confirmação em disco
  // vivem no serviço. O renderer não escreve ficheiros nem infere estado — e um
  // `enabled` que não é booleano nem chega a sair do main.
  serviceRequest("service:get-protection-intent", () => client.request("protectionIntent.get", undefined));
  serviceRequest("service:set-protection-intent", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      return { ok: false, guardado: false, motivo: "enabled_nao_booleano" };
    }
    return client.request("protectionIntent.setOptIn", { enabled });
  });
  // DIAGNÓSTICO (sem mudança de comportamento): cada tentativa de iniciar scan
  // fica com uma linha `[ScanStartTrace]` que liga origem -> aceite/rejeitado ->
  // scanId. `origin` vem do caller (scanner-page / optimize-page / tray) e é
  // APENAS registado — não é enviado ao serviço nem altera o pedido.
  let scanStartSeq = 0;
  serviceRequest("service:start-scan", async (_event, type: string, targetPath?: string, origin?: string) => {
    const requestId = `scan-${Date.now().toString(36)}-${++scanStartSeq}`;
    const from = origin ?? "unknown";
    console.log(
      `[ScanStartTrace] requestId=${requestId} origin=${from} type=${type} targetPath=${targetPath ?? ""} at=${new Date().toISOString()}`,
    );
    console.log(`[ScanIPC] request received type=${type} targetPath=${targetPath ?? ""} at=${new Date().toISOString()}`);
    try {
      const result = await client.request("scan.start", { type, targetPath } as any);
      const accepted = Boolean(result && (result as any).success === true && (result as any).id);
      const reason = accepted ? "" : ((result as any)?.error ?? "rejected");
      console.log(
        `[ScanStartTrace] requestId=${requestId} origin=${from} accepted=${accepted} scanId=${(result as any)?.id ?? ""} reason=${reason} at=${new Date().toISOString()}`,
      );
      console.log(`[ScanIPC] forwarded to service -> accepted=${accepted} scanId=${(result as any)?.id ?? ""} at=${new Date().toISOString()}`);
      return result;
    } catch (err: any) {
      console.log(
        `[ScanStartTrace] requestId=${requestId} origin=${from} accepted=false reason=${err.message} at=${new Date().toISOString()}`,
      );
      console.error(`[ScanIPC] forwarded to service -> ERROR ${err.message} at=${new Date().toISOString()}`);
      throw err;
    }
  });
  // Snapshot de ressincronização: a UI pergunta pelo scan ativo ao montar
  // (voltar à página do Scanner não pode perder o progresso em curso).
  serviceRequest("service:get-active-scan", () => client.request("scan.getActive", undefined));
  // ── Proteção USB (R8) ──
  // Leitura coalescida do estado (a UI consulta quando o painel monta) e o
  // opt-in. O renderer NUNCA envia caminhos nem alvos: só `{ enabled: boolean }`.
  // O auto-scan USB é decidido pelo serviço, a partir do dispositivo que ele
  // próprio confirmou — a raiz nunca vem da UI.
  serviceRequest("service:get-usb-protection", () => client.request("usb.getState", undefined));
  serviceRequest("service:configure-usb-protection", (_event, payload: unknown) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("Pedido USB inválido: { enabled: boolean } é obrigatório.");
    }
    const campos = Object.keys(payload as Record<string, unknown>);
    const enabled = (payload as Record<string, unknown>).enabled;
    if (campos.length !== 1 || campos[0] !== "enabled" || typeof enabled !== "boolean") {
      throw new Error("Pedido USB inválido: só { enabled: boolean } é aceite (nenhum caminho é aceite).");
    }
    return client.request("usb.configure", { enabled });
  });
  // A fronteira Electron recusa payloads inválidos sem efeitos. O serviço
  // valida novamente consentimento/identidade e resolve as raízes localmente.
  serviceRequest("service:usb-scan", (_event, payload: unknown) => {
    const bruto = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown> : {};
    if (typeof bruto.deviceId !== "string" || !bruto.deviceId.trim() ||
        typeof bruto.requestId !== "string" || !bruto.requestId.trim() || bruto.consent !== true) {
      return Promise.resolve({ ok: false, error: "Pedido de análise USB inválido ou sem consentimento." });
    }
    return client.request("usb.scan", {
      deviceId: bruto.deviceId, requestId: bruto.requestId, consent: true,
    });
  });
  serviceRequest("service:usb-cancel", (_event, payload: unknown) => {
    const bruto = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown> : {};
    if (typeof bruto.deviceId !== "string" || !bruto.deviceId.trim() ||
        typeof bruto.scanId !== "string" || !bruto.scanId.trim()) {
      return Promise.resolve({ ok: false, error: "Pedido de cancelamento USB inválido." });
    }
    return client.request("usb.cancel", { deviceId: bruto.deviceId, scanId: bruto.scanId });
  });
  serviceRequest("service:get-last-scan", (_event, id?: string) => client.request("scan.getLast", { id }));
  serviceRequest("service:cancel-scan", (_event, id: string) =>
    client.request("scan.cancel", { id } as any));
  serviceRequest("service:threat-action", (_event, id: string, action: "quarantine" | "restore" | "delete", expectedSha256?: string) =>
    client.request("threat.action", { id, action, sha256: expectedSha256 }));

  handle("dialog:open-file", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "All Files", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle("dialog:open-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Confirmação de saída (modal CyberSafe no renderer) ──
  // O renderer confirma que o modal está APRESENTADO: para os reenvios da
  // entrega e é o sinal para revelar a janela já pintada (sem janela branca).
  handle("app:exit-confirm-ack", () => {
    exitModalDelivery?.ack();
    logExitEvent("ipc:modal-ack");
    return { received: true };
  });
  handle("app:exit-confirm-response", (_event, confirmado: unknown) => {
    // Normal: `Boolean(confirmado)`, exatamente como sempre. Com o modo de leitura
    // ligado, só um booleano real consome o resolver pendurado — uma string ou
    // lixo não pode aprovar a saída nem fechar a janela por trás do utilizador.
    const decisao = decidirRespostaSaida(confirmado);
    if (!decisao.consumir) return { received: false };
    const resolve = exitConfirmResolve;
    exitConfirmResolve = null;
    if (resolve) resolve(decisao.valor);
    return { received: true };
  });

  // ── Auto-Start IPC ──
  handle("app:get-auto-start", () => {
    if (process.platform !== "win32") return { enabled: false, startMinimized: false };
    const settings = app.getLoginItemSettings();
    return {
      enabled: settings.executableWillLaunchAtLogin,
      startMinimized: settings.launchItems.some(item => item.enabled && item.args.includes("--hidden")),
    };
  });

  handle("app:set-auto-start", (_event, config: { enabled: boolean; startMinimized: boolean }) => {
    if (process.platform !== "win32") return { success: false };
    app.setLoginItemSettings({
      openAtLogin: config.enabled,
      path: process.execPath,
      args: config.enabled && config.startMinimized ? ["--hidden"] : [],
    });
    return { success: true };
  });

  // ── Notifications IPC ──
  handle("app:get-notifications-enabled", () => ({ enabled: preferences.notificationsEnabled }));

  handle("app:set-notifications-enabled", (_event, enabled: boolean) => {
    preferences.notificationsEnabled = Boolean(enabled);
    savePreferences();
    return { enabled: preferences.notificationsEnabled };
  });

  // ── Report Window IPC ──
  handle("app:open-report-window", async (_event, html: string) => {
    const reportWin = new BrowserWindow({
      width: 860,
      height: 640,
      title: "CyberSafe — Relatório de Segurança",
      icon: resolveWindowIconPath(),
      webPreferences: reportWindowPreferences(),
      show: false,
    });
    reportWin.once("ready-to-show", () => reportWin.show());
    // data URI com encoding seguro (data:text/html;charset=utf-8)
    await reportWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    return { success: true };
  });

  // ── PDF Export IPC ──
  // Caminho pedido (R7-L3): guarda o relatório a PDF de verdade —
  // diálogo de escolha, renderização A4 do mesmo HTML e escrita
  // no ficheiro. A janela de impressão manual (acima) não se altera.
  handle("app:export-pdf", async (_event, html: string, suggestedName: string) => {
    if (typeof html !== "string" || html.trim() === "") {
      return { success: false, error: "Relatório vazio." };
    }
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const dialogOptions = {
      title: "Guardar relatório como PDF",
      defaultPath: ensurePdfExtension(
        typeof suggestedName === "string" && suggestedName.trim() !== ""
          ? suggestedName
          : "Relatorio-CyberSafe.pdf",
      ),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const chosen = parent
      ? await dialog.showSaveDialog(parent, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);
    if (chosen.canceled || !chosen.filePath) {
      // O utilizador cancelou: não é um erro.
      return { success: false, canceled: true };
    }
    const filePath = ensurePdfExtension(chosen.filePath);
    const validation = validateReportPath(filePath);
    if (!validation.ok) {
      return { success: false, error: validation.error };
    }
    let reportWin: BrowserWindow | null = null;
    try {
      reportWin = new BrowserWindow({
        width: 860,
        height: 640,
        title: "CyberSafe — Relatório de Segurança",
        icon: resolveWindowIconPath(),
        webPreferences: reportWindowPreferences(),
        show: false,
      });
      // O mesmo HTML A4 que a janela de relatório apresenta.
      await reportWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      const pdf = await reportWin.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
      });
      await fs.promises.writeFile(filePath, pdf);
      reportWin.destroy();
      return { success: true, path: filePath };
    } catch {
      reportWin?.destroy();
      // Segurança: mensagens de erro do fs podem conter o caminho
      // escolhido — não vão para o log nem para o renderer.
      console.error("[CyberSafe] Falha ao exportar o relatório PDF.");
      return { success: false, error: "Não foi possível guardar o PDF." };
    }
  });
}

// ── Auto-Start Registration (Production Only, Windows Only) ──────────────────
function configureAutoStart() {
  if (process.platform !== "win32") return;
  // Em dev NUNCA se toca no registo de arranque: `setLoginItemSettings` é feito
  // sob o nome da app, e o nome do artefacto é "CyberSafe" — um dev a correr
  // podia apagar a entrada de arranque da instalação do utilizador.
  if (!perfil.autoStart) return;
  // Defesa em profundidade para o modo de leitura: em DEV `perfil.autoStart` já é
  // `false` (`dev-isolation.ts`), logo esta linha nunca é alcançada no caminho
  // normal — mas se o perfil algum dia mudar, o modo não escreve no registo de
  // arranque do Windows.
  if (fronteiraLeituraWindows.activo) return;

  app.setLoginItemSettings({
    openAtLogin: false, // FASE 1.1: Auto-start desativado por padrão
    path: process.execPath,
    args: app.isPackaged ? ["--hidden"] : [path.resolve(process.argv[1]), "--hidden"],
  });
}

// O lock de instância única é chaveado pelo `userData`: sem isto, o dev partilha
// a identidade e o lock com o CyberSafe instalado. Aplicado ANTES do lock.
let devIsolamentoVerificado = false;
if (!app.isPackaged) {
  const dirDadosDev = perfil.userDataDir;
  const dirSessaoDev = perfil.sessionDir;
  if (!dirDadosDev) throw new Error("perfil dev sem userData isolado");
  if (!dirSessaoDev) throw new Error("perfil dev sem sessionData isolado");
  app.setName(perfil.appName);
  fs.mkdirSync(dirDadosDev, { recursive: true });
  fs.mkdirSync(dirSessaoDev, { recursive: true });
  // Os DOIS caminhos de estado do Chromium são desviados, e os DOIS são confirmados
  // por leitura antes do lock, de `settings.json`, dos logs e de qualquer BrowserWindow.
  // Só `userData` não bastava: `sessionData` (cookies, session storage, caches de
  // sessão) ficava no default do Electron, fora da raiz de teste, sem qualquer asserção.
  app.setPath("userData", dirDadosDev);
  app.setPath("sessionData", dirSessaoDev);
  const efectivaUserData = afirmarCaminhoIsolado("userData", app.getPath("userData"), dirDadosDev, perfil.raizDev);
  const efectivaSessao = afirmarCaminhoIsolado("sessionData", app.getPath("sessionData"), dirSessaoDev, perfil.raizDev);
  devIsolamentoVerificado = Boolean(
    process.env.CYBERSAFE_DEV_ISOLATION === "1" && efectivaUserData && efectivaSessao && perfil.raizDev,
  );
  console.log(`[Electron] isolamento verificado ANTES da janela: userData=${efectivaUserData} sessionData=${efectivaSessao} raiz=${String(perfil.raizDev)}`);
}

const startupLogPath = path.join(app.getPath("userData"), "logs", "startup.log");
const gotTheLock = app.requestSingleInstanceLock();
logStartup("electron-start", { pid: process.pid, packaged: app.isPackaged, version: app.getVersion(), port: perfil.apiPort });

// DEV direct runner owns this inherited IPC channel. Production has no listener.
if (!app.isPackaged && devIsolamentoVerificado && process.env.CYBERSAFE_DEV_OWNED_CHILD === "1" && process.connected) {
  let closing: Promise<void> | undefined;
  const closeOwnedDesktop = () => { closing ??= quitCyberSafe().catch((error) => console.error("[Electron] Parent shutdown failed:", error)); };
  process.on("message", (value: unknown) => {
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "cybersafe:dev:shutdown") closeOwnedDesktop();
  });
  process.on("disconnect", closeOwnedDesktop);
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    // Silent Windows autostart must not steal focus from an existing session.
    if (Array.isArray(commandLine) && commandLine.includes("--hidden")) return;
    requestMainWindowForeground();
  });

  app.whenReady().then(async () => {
    logStartup("electron-ready", { pid: process.pid, port: perfil.apiPort });
    loadPreferences();
    // Updater: hoje UNCONFIGURED (sem feed/chave/editor). `runtimeSupported` só
    // em Windows empacotado; dev/portable ⇒ `unsupported` honesto. Nenhum adapter
    // real é exercitado neste estado.
    // Identidade REAL do artefacto: o carimbo escrito pelo staging do renderer.
    // Sem carimbo, build/commit ficam ausentes e a UI diz «desconhecida» — nunca
    // se inventa um valor a partir da versão ou do nome do ficheiro.
    const installedIdentity = readBuildIdentity(app.getAppPath(), app.getVersion());
    appUpdater = createProductionUpdater({
      cacheDir: updaterCacheDir(app.getPath("userData")),
      runtimeSupported: app.isPackaged && process.platform === "win32",
      installedVersion: app.getVersion(),
      installedBuild: installedIdentity.build,
      installedCommit: installedIdentity.commit,
    });
    updateStateUnsub = appUpdater.onState((s) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:update-state", toAppUpdateSnapshot(s));
    });
    // Identidade da aplicação no Windows (taskbar/notificações/ateliers).
    app.setName(perfil.appName);
    if (process.platform === "win32") {
      // Idade de notificações/taskbar própria: partilhar a do artefacto faria o
      // dev aparecer como a instalação do utilizador.
      let metadata: unknown;
      try { metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")); }
      catch { /* Old packages retain their existing identity. */ }
      app.setAppUserModelId(windowsAppIdentity(metadata, app.isPackaged));
    }
    // O menu File/Edit/View/Window/Help é o menu POR OMISSÃO do Electron: nunca
    // existiu menu próprio neste produto (o único Menu usado é o contexto da
    // tray). No artefacto era o menu de desenvolvimento exposto ao utilizador,
    // por isso é retirado só quando empacotado; em DEV tudo fica como estava.
    if (app.isPackaged) {
      Menu.setApplicationMenu(null);
    }

    syncBrandingAssets();
    createWindow();
    // A política de leitura e o corte da resposta de saída entram por argumento
    // (ver `registerIpc`): com o modo desligado são a identidade e o `Boolean`
    // de sempre, exatamente o registo de antes.
    registerIpc(
      (canal, handler) => comPoliticaLeituraWindows(canal, () => fronteiraLeituraWindows.activo, handler),
      (confirmado) => validarRespostaSaida(confirmado, fronteiraLeituraWindows.activo),
      (handle) => registerAuthSessionIpc(handle, () => createAuthSessionStore(app.getPath("userData"), safeStorage)),
    );
    configureAutoStart();
    wireRealtimeEvents();
    createTray();

    logStartup("service-attempt", { status: "pending" });
    const serviceStart = await startServiceProcess();
    logStartup("service-result", { status: serviceStart.status, ...(serviceStart.status === "failed" ? { classification: classifyStartupError(serviceStart.reason) } : {}) });

    if (serviceStart.status !== "connected") {
      logStartup("api-skipped", { status: "skipped", port: DEFAULT_API_PORT, classification: classifyStartupError(serviceStart.reason) });
      logStartup("api-unavailable", { status: "unavailable", port: DEFAULT_API_PORT });
      console.error(`Failed to start/reuse the background service: ${serviceStart.reason}`);
      dialog.showErrorBox(
        "CyberSafe — Serviço indisponível",
        "O serviço de proteção em segundo plano não está utilizável.\n\n" +
          `Motivo: ${serviceStart.reason}\n\n` +
          "Verifique os logs em %USERPROFILE%\\.cybersafe-service\\error.log."
      );
      // Também é um shutdown: o renderer não pode continuar a pedir dados.
      isQuitting = true;
      app.quit();
      return;
    }

    // API local empacotada: arranca em paralelo com a ligação ao serviço e
    // nunca substitui a proteção (o serviço e o pipe já estão garantidos acima).
    startPackagedApi();

    try {
      await client.connect();
    } catch (error) {
      console.error("Failed to connect to service:", error);
      if (!perfil.protectionService) {
        // Modo DEV isolado (opção ii): o serviço de proteção não é ligado, por
        // isso a ausência dele não é uma falha do produto nem motivo para
        // encerrar — encerrar deixava a MATRIX injulgável pela interface. Nada
        // aqui inicia serviço, watcher, scanner ou proteção, e nada afirma
        // proteção ativa: o renderer já recebe `service:connection-state
        // { connected: false }` e o tray trata "sem pipe" como "nada
        // confirmado". Empacotado cai no ramo seguinte, inalterado.
        console.warn("[Electron] Serviço de proteção indisponível em dev — a janela continua aberta; nenhum estado de monitorização é afirmado.");
        return;
      }
      dialog.showErrorBox(
        "Service Connection Failed",
        `Failed to start or connect to the CyberSafe background service. Underlying error:\n${error}`
      );
      isQuitting = true;
      app.quit();
    }
  }).catch((error) => {
    // Rede de segurança do arranque. Antes não havia `.catch`: a rejeição do
    // `startServiceProcess()` morria no microtask do `whenReady()` depois de
    // `createWindow()` já ter aberto a janela — nenhum diálogo, nenhum
    // encerramento, nenhuma leitura confirmada. É o modo limitado reportado na VM QA1.
    // Fica registado porque um arranque que falha tem de o dizer, não calar.
    logStartup("boot-failure", { status: "failed", classification: classifyStartupError(error) });
    console.error("[Electron] Falha não tratada no arranque:", error);
    logExitEvent("boot-failure", { classification: classifyStartupError(error) });
  });
}

// Fecha apenas os filhos CyberSafe deste processo (nunca processos alheios).
let quitCleanupStarted = false;
app.on("before-quit", (event) => {
  isQuitting = true;
  logExitEvent("before-quit", {
    service: Boolean(serviceProcess && serviceProcess.pid),
    api: Boolean(apiRuntime),
  });
  // updater: liberta o listener de estado (sem referência solta após sair).
  if (updateStateUnsub) { try { updateStateUnsub(); } catch { /* já removido */ } updateStateUnsub = null; }
  appUpdater = null;
  if (!app.isPackaged) {
    // Em `npm run dev`, o `concurrently -k` mata os restantes watchers
    // (tsx/vite) com SIGTERM quando o Electron sai; os scripts npm que se
    // seguem terminam com code 1. Isso é comportamento esperado do dev
    // runner, não uma falha do produto — distinguimos no log.
    console.log("[Electron] EXPECTED DEV SHUTDOWN — encerramento limpo (não é falha).");
  }
  // API local primeiro: sem isto ficaria um processo órfão a segurar a porta
  // 4000 no arranque seguinte.
  const ownedApi = apiRuntime?.child ?? apiChild;
  if (ownedApi) stopLocalApi(ownedApi);
  apiRuntime = null;
  if (!serviceProcess || !serviceProcess.pid) return;
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  event.preventDefault();

  const deadline = Date.now() + 3000;
  const timer = setInterval(() => {
    if (Date.now() >= deadline || !serviceProcess || serviceProcess.exitCode !== null) {
      clearInterval(timer);
      logExitEvent("before-quit-exit", {
        serviceExitCode: serviceProcess ? serviceProcess.exitCode : null,
      });
      app.exit(0);
    }
  }, 150);
  // Clear the status polling interval
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  setTimeout(() => {
    try {
      if (serviceProcess && serviceProcess.exitCode === null) serviceProcess.kill();
    } catch {}
  }, 2000);
});
