#!/usr/bin/env node
/**
 * GATE DE IDENTIDADE DE PACKAGING (CyberSafe Assistant).
 *
 * Verifica que a build final apresenta a identidade CyberSafe ao Windows, e
 * que o que NÃO é verificável neste ambiente é reportado como UNKNOWN — nunca
 * como PASS inventado. Um gate que passa o que não mediu é pior do que não ter
 * gate: dá confiança a quem não a merecia.
 *
 * O que este gate mede (fichheiros + metadata Windows real):
 *   - nome do executável principal
 *   - FileDescription / ProductName / CompanyName / OriginalFilename / versoes
 *   - assinatura digital (publisher), se houver certificado
 *   - presença do ícone de origem
 *   - identidade do serviço embutido (esta dentro do app.asar) e COMO é lançado
 *   - processos filhos observados, se a app estiver a correr
 *   - reconhecimento explícito de clamscan.exe como motor EXTERNO esperado
 *
 * O que este gate NÃO pode decidir, e diz UNKNOWN:
 *   - publisher sem certificado configurado (não há o que medir)
 *   - ícone EMBUTIDO no .exe (exige parsing do PE / inspecção visual)
 *   - processos filhos com a app parada (não há processo a observar)
 *
 * Uso:
 *   node scripts/check-packaged-identity.mjs [dir-build] [--json]
 *                                            [--require-signature]
 *   (sem argumento: packages/desktop/release/win-unpacked)
 *
 * Sai com 1 se houver qualquer FAIL. UNKNOWN nao falha o gate; aparece no
 * relatorio e no PACKAGING_IDENTITY_BLOCKERS para a decisao ser humana.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as url from "node:url";

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/** Quatro estados, porque "nao medivel" nao e "passou". */
const PASS = "PASS";
const FAIL = "FAIL";
const UNKNOWN = "UNKNOWN";
const INFO = "INFO";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const AS_JSON = flags.has("--json");
const REQUIRE_SIGNATURE = flags.has("--require-signature");

const BUILD_DIR = path.resolve(
  positional[0] ?? path.join(REPO_ROOT, "packages", "desktop", "release", "win-unpacked"),
);
const DESKTOP_PKG = path.join(REPO_ROOT, "packages", "desktop", "package.json");

/**
 * `clamscan.exe` e motor EXTERNO do ClamAV. Aparece no Gestor de Tarefas
 * durante a analise e isso NAO e um bug de branding: o CyberSafe orquestra o
 * ClamAV, nao o reescreve. Renomear, esconder ou falsificar esta identidade
 * esta PROIBIDO. Este gate regista-o como esperado, nunca como falha.
 */
const EXTERNAL_ENGINES = [
  { name: "clamscan.exe", role: "motor ClamAV externo, orquestado pelo CyberSafe" },
  { name: "freshclam.exe", role: "actualizador de assinaturas ClamAV, externo" },
];

const checks = [];
const blockers = [];

function add(id, status, title, detail, extra = {}) {
  checks.push({ id, status, title, detail, ...extra });
  return status;
}

function block(reason) {
  if (!blockers.includes(reason)) blockers.push(reason);
}

/* ── electron-builder config: a fonte das expectativas ───────────────────── */

function loadBuilderConfig() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(DESKTOP_PKG, "utf8"));
  } catch (e) {
    add("config", FAIL, "electron-builder config", `nao foi possivel ler ${DESKTOP_PKG}: ${e.message}`);
    return null;
  }
  const build = pkg.build;
  if (!build) {
    add("config", FAIL, "electron-builder config", "packages/desktop/package.json nao tem chave `build`");
    return null;
  }
  if (typeof build !== "object" || build === null || Array.isArray(build)) {
    add("config", FAIL, "electron-builder config", "a chave `build` nao e um objeto de configuracao");
    return null;
  }
  add("config", PASS, "electron-builder config", `lido de ${path.relative(REPO_ROOT, DESKTOP_PKG)}`, {
    appId: build.appId,
    productName: build.productName,
    executableName: build.executableName ?? null,
  });
  return { pkg, build };
}

const loaded = loadBuilderConfig();
const build = loaded?.build ?? null;
const pkg = loaded?.pkg ?? null;

/**
 * O que electron-builder faz do config, segundo a documentacao:
 *  - `executableName` omitido  -> o executavel chama-se `productName`.exe
 *  - `CompanyName`             <- `author` (string) ou author.name
 *  - `FileDescription`         <- `description`
 *  - `OriginalFilename`        <- `executableName` (so quando configurado)
 * As expectativas derivam do CONFIG, nao de literais inventados aqui: se o
 * productName mudar, o gate segue a mudanca.
 */
const productName = build?.productName ?? "CyberSafe Assistant";
const authorRaw = pkg?.author;
const authorName = typeof authorRaw === "string" ? authorRaw : authorRaw?.name ?? null;
const description = pkg?.description ?? null;
const expectedExeName = build?.executableName ? `${build.executableName}.exe` : `${productName}.exe`;
const version = pkg?.version ?? null;

/* ── metadata Windows (a medicao real) ───────────────────────────────────── */

/** Le a metadata de versao de um .exe. UNKNOWN se nao for possivel. */
function readVersionInfo(exePath) {
  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$v=(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo`,
      "$o=[ordered]@{",
      " FileDescription=$v.FileDescription; ProductName=$v.ProductName; CompanyName=$v.CompanyName;",
      " FileVersion=$v.FileVersion; ProductVersion=$v.ProductVersion;",
      " InternalName=$v.InternalName; OriginalFilename=$v.OriginalFilename;",
      " LegalCopyright=$v.LegalCopyright }",
      "($o | ConvertTo-Json -Compress)",
    ].join("\n");
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { ok: true, value: JSON.parse(out) };
  } catch (e) {
    return { ok: false, reason: e.message.split("\n")[0] };
  }
}

/** Assinatura digital. `NotSigned` e um facto, nao um erro de leitura. */
function readSignature(exePath) {
  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$s=Get-AuthenticodeSignature -LiteralPath '${exePath.replace(/'/g, "''")}'`,
      "([ordered]@{ Status=$s.Status.ToString(); Subject=$(if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null}) } | ConvertTo-Json -Compress)",
    ].join("\n");
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { ok: true, value: JSON.parse(out) };
  } catch (e) {
    return { ok: false, reason: e.message.split("\n")[0] };
  }
}

/** Processos cujo executavel vive dentro da build. Vazio != ausencia de filho. */
function observeChildren(buildDir) {
  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$root='${buildDir.replace(/'/g, "''")}'`,
      "$rows=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[System.StringComparison]::OrdinalIgnoreCase) }",
      "$rows | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress",
    ].join("\n");
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 45_000,
    });
    if (!out.trim()) return { ok: true, rows: [] };
    const parsed = JSON.parse(out);
    return { ok: true, rows: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (e) {
    return { ok: false, reason: e.message.split("\n")[0] };
  }
}

/** O binario do clamscan existe nesta maquina? NAO e um requisito do produto. */
function clamscanPresente() {
  try {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$c=Get-Command clamscan.exe -ErrorAction SilentlyContinue",
      "($(if($c){$c.Source}else{$null}))",
    ].join("\n");
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/* ── app.asar: onde vive o serviço embutido ──────────────────────────────── */

/** Le o header do asar e devolve os caminhos (o gate precisa do nome, nao do conteudo). */
function listAsarPaths(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonLen = head.readUInt32LE(12);
    const buf = Buffer.alloc(jsonLen);
    fs.readSync(fd, buf, 0, jsonLen, 16);
    const header = JSON.parse(buf.toString("utf8"));
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (entry.files) walk(entry, p);
        else out.push({ path: p, unpacked: Boolean(entry.unpacked) });
      }
    };
    walk(header, "");
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/* ── verificacoes ─────────────────────────────────────────────────────────── */

const exePath = path.join(BUILD_DIR, expectedExeName);

if (!fs.existsSync(BUILD_DIR)) {
  add(
    "build-dir", FAIL, "directorio de build",
    `${path.relative(REPO_ROOT, BUILD_DIR)} nao existe. Gerar com \`npm run dist:dir -w @cybersafe/desktop\`.`,
  );
} else {
  add("build-dir", PASS, "directorio de build", path.relative(REPO_ROOT, BUILD_DIR));
}

const exeExists = fs.existsSync(exePath);
if (!exeExists) {
  add("exe-presente", FAIL, "executavel principal", `nao encontrei ${path.basename(exePath)} em ${BUILD_DIR}`);
  // Sem o .exe nao ha mais metadata a ler. Os checks abaixo ficam UNKNOWN
  // explicito em vez de disappear.
  for (const [id, title] of [
    ["exe-nome", "nome do executavel"],
    ["metadata", "metadata Windows"],
    ["publisher", "publisher / assinatura"],
    ["icone", "icone"],
    ["servico", "identidade do servico"],
    ["filhos", "processos filhos observados"],
  ]) {
    add(id, UNKNOWN, title, `nao verificavel: o executavel principal nao existe (${path.basename(exePath)})`);
  }
} else {
  add("exe-presente", PASS, "executavel principal", path.basename(exePath));

  // Nome: o ficheiro tem de se chamar como o config diz. Uma build pode ter o
  // metadata certo e o nome wrong (ou vice-versa) — sao factos separados.
  const actualExeName = fs
    .readdirSync(BUILD_DIR)
    .find((f) => f.toLowerCase().endsWith(".exe"));
  add(
    "exe-nome", actualExeName === expectedExeName ? PASS : FAIL,
    "nome do executavel",
    actualExeName === expectedExeName
      ? `${actualExeName} (esperado pelo config)`
      : `encontrado "${actualExeName}", esperado "${expectedExeName}"`,
    { esperado: expectedExeName, encontrado: actualExeName ?? null },
  );

  const vi = readVersionInfo(exePath);
  if (!vi.ok) {
    add("metadata", UNKNOWN, "metadata Windows", `nao foi possivel ler: ${vi.reason}`);
  } else {
    const m = vi.value;
    const cmp = (field, esperado) => {
      if (esperado === null || esperado === undefined) {
        return { status: UNKNOWN, detail: `"${field}" esta vazio e o config nao define valor para comparar` };
      }
      const got = (m[field] ?? "").trim();
      const gotOk = got.toLowerCase() === String(esperado).trim().toLowerCase();
      return {
        status: gotOk ? PASS : FAIL,
        detail: gotOk ? got : `obtido "${got}", esperado "${esperado}"`,
      };
    };

    for (const [field, esperado, titulo] of [
      ["ProductName", productName, "ProductName"],
      ["FileDescription", description, "FileDescription"],
      ["CompanyName", authorName, "CompanyName"],
    ]) {
      const r = cmp(field, esperado);
      add(`metadata-${field.toLowerCase()}`, r.status, `metadata ${titulo}`, r.detail, {
        campo: field, esperado: esperado ?? null, obtido: (m[field] ?? "").trim(),
      });
    }

    // OriginalFilename so e preenchido quando `executableName` esta no config.
    // Sem ele, o campo vazio e o comportamento documentado — nao uma falha.
    const ofn = (m.OriginalFilename ?? "").trim();
    add(
      "metadata-originalfilename",
      build?.executableName ? (ofn === `${build.executableName}.exe` ? PASS : FAIL) : INFO,
      "metadata OriginalFilename",
      build?.executableName
        ? (ofn || "(vazio)")
        : `(vazio) — electron-builder so escreve OriginalFilename quando \`executableName\` esta definido, e nao esta.`,
      { campo: "OriginalFilename", obtido: ofn || null },
    );

    // Versoes: tem de bater certo com o package.json, senao o "acerca de"
    // programa instalado diz uma coisa e o About diz outra.
    const versoesOk =
      (m.FileVersion ?? "").startsWith(version ?? "\u0000") &&
      (m.ProductVersion ?? "").startsWith(version ?? "\u0000");
    add(
      "metadata-versao", versoesOk ? PASS : FAIL, "versoes",
      `FileVersion=${m.FileVersion} ProductVersion=${m.ProductVersion}, package.json version=${version}`,
      { esperado: version, fileVersion: m.FileVersion, productVersion: m.ProductVersion },
    );

    for (const [field, valor] of [["InternalName", m.InternalName], ["LegalCopyright", m.LegalCopyright]]) {
      add(`metadata-${field.toLowerCase()}`, INFO, `metadata ${field}`, valor || "(vazio)");
    }

    // Publisher: so e verificavel com certificado. Sem certificado, UNKNOWN.
    const sig = readSignature(exePath);
    if (!sig.ok) {
      add("publisher", UNKNOWN, "publisher / assinatura", `nao foi possivel ler: ${sig.reason}`);
    } else if (sig.value.Status === "NotSigned") {
      block(
        "exe principal sem assinatura digital: nao ha publisher verificavel no Gestor de Tarefas nem no Explorador de Ficheiros",
      );
      add(
        "publisher", REQUIRE_SIGNATURE ? FAIL : UNKNOWN, "publisher / assinatura",
        REQUIRE_SIGNATURE
          ? "NotSigned e --require-signature foi pedido"
          : "NotSigned — nao ha certificado de assinatura configurado no electron-builder, logo nao ha publisher a medir",
        { assinatura: "NotSigned" },
      );
    } else {
      const assinado = sig.value.Status === "Valid";
      add(
        "publisher", assinado ? PASS : FAIL, "publisher / assinatura",
        `${sig.value.Status} — ${sig.value.Subject ?? "(sem subject)"}`,
        { assinatura: sig.value.Status, subject: sig.value.Subject ?? null },
      );
    }

    // Icone de origem: presenca e tamanho. O icone EMBUTIDO no .exe nao e
    // verificavel sem parsing de PE, e dizemo-lo em vez de o adivinhar.
    const iconSrc = build?.win?.icon;
    if (!iconSrc) {
      add("icone", UNKNOWN, "icone", "o config nao define `win.icon`");
    } else {
      const iconAbs = path.resolve(REPO_ROOT, "packages", "desktop", iconSrc);
      if (!fs.existsSync(iconAbs)) {
        add("icone", FAIL, "icone de origem", `${iconSrc} nao existe`, { caminho: iconSrc });
      } else {
        const size = fs.statSync(iconAbs).size;
        add(
          "icone", size > 0 ? PASS : FAIL, "icone de origem",
          `${iconSrc} (${size} bytes)`,
          { caminho: iconSrc, bytes: size },
        );
      }
    }
    add(
      "icone-embutido", UNKNOWN, "icone embutido no .exe",
      "verificar o icone gravado no .exe exige parsing do recurso PE ou inspeccao visual; este gate nao o mede e nao o presume",
    );

    // Identidade do servico embutido: tem de estar NO asar, no path que o
    // main.ts resolve, e de ser lançado com ELECTRON_RUN_AS_NODE (o que faz o
    // filho ter a MESMA identidade do exe, em vez de node.exe).
    const asar = path.join(BUILD_DIR, "resources", "app.asar");
    if (!fs.existsSync(asar)) {
      add("servico", FAIL, "identidade do servico", `resources/app.asar nao existe em ${BUILD_DIR}`);
    } else {
      const entries = listAsarPaths(asar);
      const entryPoint = "node_modules/@cybersafe/service/dist/index.js";
      const found = entries.find((e) => e.path === entryPoint);
      if (!found) {
        add(
          "servico", FAIL, "identidade do servico",
          `o app.asar nao contem ${entryPoint} — que e o path que o main resolve para o servico embutido`,
          { esperado: entryPoint },
        );
      } else {
        const viaNodeGenerico = entries.some((e) => /(^|\/)node\.exe$/i.test(e.path));
        add(
          "servico-entrypoint", PASS, "servico embutido dentro do app.asar",
          found.unpacked
            ? `${entryPoint} (unpacked)`
            : `${entryPoint} — o filho herda a identidade de "${expectedExeName}" via ELECTRON_RUN_AS_NODE`,
          { path: found.path, unpacked: found.unpacked },
        );
        add(
          "servico-sem-node-generico", viaNodeGenerico ? FAIL : PASS,
          "o servico nao e um node.exe separado",
          viaNodeGenerico
            ? "o asar contem um node.exe: o servico apareceria no Gestor de Tarefas com o nome generico"
            : "o asar nao embute node.exe: o servico corre com o proprio executavel do produto",
        );

        // O modo de launch e uma promessa da identidade: confirmar no codigo.
        const mainSrc = fs.readFileSync(
          path.join(REPO_ROOT, "packages", "desktop", "src", "main.ts"),
          "utf8",
        );
        const usaElf = /ELECTRON_RUN_AS_NODE/.test(mainSrc);
        const usaExecPath = /spawn\(\s*process\.execPath/.test(mainSrc);
        add(
          "servico-modo-launch",
          usaElf && usaExecPath ? PASS : FAIL,
          "modo de lancamento do servico",
          usaElf && usaExecPath
            ? "main.ts lanca o servico com process.execPath + ELECTRON_RUN_AS_NODE: o filho tem a identidade do produto"
            : "main.ts nao lanca o servico com process.execPath + ELECTRON_RUN_AS_NODE: o filho pode aparecer como node.exe",
        );
      }
    }

    // Processos filhos: so se mede com a app a correr.
    const obs = observeChildren(BUILD_DIR);
    if (!obs.ok) {
      add("filhos", UNKNOWN, "processos filhos observados", `nao foi possivel enumerar: ${obs.reason}`);
    } else if (obs.rows.length === 0) {
      block("build nao executada durante o gate: os processos filhos nao foram observados em runtime");
      add(
        "filhos", UNKNOWN, "processos filhos observados",
        "nenhum processo a correr a partir desta build. O gate nao pode afirmar quais os filhos observaveis sem a app em execucao.",
      );
    } else {
      const nomes = obs.rows.map((r) => r.Name);
      add(
        "filhos", PASS, "processos filhos observados",
        `${obs.rows.length} processo(s): ${nomes.join(", ")}`,
        { processos: obs.rows },
      );
      const genericos = obs.rows.filter((r) => /^(node|electron)\.exe$/i.test(r.Name));
      add(
        "filhos-sem-genericos", genericos.length === 0 ? PASS : FAIL,
        "nenhum filho aparece como node.exe/electron.exe",
        genericos.length === 0
          ? "todos os processos observados pertencem ao produto"
          : `${genericos.length} processo(s) com nome generico: ${genericos.map((r) => r.Name).join(", ")}`,
      );
    }
  }
}

/* ── motores externos: registados, nunca falhados ─────────────────────────── */

const clam = clamscanPresente();
for (const engine of EXTERNAL_ENGINES) {
  add(
    `externo-${engine.name}`,
    INFO,
    `motor externo esperado: ${engine.name}`,
    clam && engine.name === "clamscan.exe"
      ? `presente nesta maquina em ${clam}. Aparece no Gestor de Tarefas durante a analise — comportamento esperado, nao e falha de branding.`
      : engine.name === "clamscan.exe"
        ? "nao encontrado nesta maquina (ClamAV pode nao estar instalado). Ausencia nao e falha: o motor e externo."
        : "motor externo do ClamAV. Nao e renomeado, escondido nem reescrito — e proibido.",
    { papel: engine.role, branded: false },
  );
}
add(
  "externos-regra", INFO, "regra de terceiros",
  "clamscan.exe/freshclam.exe sao motores ClmAV externos orquestados pelo CyberSafe. O gate NAO os trata como falha de identidade e nao existe nenhuma acao para os disfarcar.",
);

/* ── relatorio ────────────────────────────────────────────────────────────── */

const counts = checks.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
const hasFail = counts[FAIL] > 0;

if (AS_JSON) {
  console.log(JSON.stringify({
    buildDir: BUILD_DIR,
    exe: exeExists ? exePath : null,
    esperado: { exe: expectedExeName, productName, companyName: authorName, appId: build?.appId ?? null },
    checks,
    contagens: counts,
    blockers,
    motoresExternos: EXTERNAL_ENGINES.map((e) => e.name),
  }, null, 2));
} else {
  const mark = { PASS: "[PASS]    ", FAIL: "[FAIL]    ", UNKNOWN: "[UNKNOWN] ", INFO: "[INFO]    " };
  console.log(`\nGATE DE IDENTIDADE DE PACKAGING — ${path.relative(REPO_ROOT, BUILD_DIR)}\n`);
  for (const c of checks) {
    console.log(`${mark[c.status]}${c.id.padEnd(26)} ${c.title}`);
    console.log(`          ${c.detail}`);
  }
  console.log(`\nMOTORES EXTERNOS ESPERADOS (nao sao falha): ${EXTERNAL_ENGINES.map((e) => e.name).join(", ")}`);
  if (blockers.length > 0) {
    console.log(`\nBLOQUEIOS DE IDENTIDADE (${blockers.length}):`);
    for (const b of blockers) console.log(`  - ${b}`);
  } else {
    console.log(`\nBLOQUEIOS DE IDENTIDADE: nenhum`);
  }
  console.log(
    `\nRESUMO: ${counts.PASS ?? 0} PASS, ${counts.FAIL ?? 0} FAIL, ${counts.UNKNOWN ?? 0} UNKNOWN, ${counts.INFO ?? 0} INFO`,
  );
  console.log(
    hasFail
      ? "\nRESULTADO: FAIL — ha verificacoes que falharam acima.\n"
      : counts.UNKNOWN
        ? "\nRESULTADO: SEM FAIL, COM UNKNOWN — o que esta UNKNOWN nao foi medido e nao se presume. PASS para revisao manual.\n"
        : "\nRESULTADO: PASS\n",
  );
}

process.exit(hasFail ? 1 : 0);