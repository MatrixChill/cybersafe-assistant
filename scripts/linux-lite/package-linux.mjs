#!/usr/bin/env node
/**
 * Empacotamento Linux Lite: `.deb` + `.AppImage` com o electron-builder já
 * presente no projeto (25.1.8), usando a configuração separada
 * `packages/desktop/electron-builder.linux-lite.yml`.
 *
 * Porque existe um script próprio e nenhum flag no Windows:
 *  - O `scripts/package-windows.mjs` estampa uma árvore nova, exige
 *    `scan-engine.exe` no PREFLIGHT e corre `@electron/rebuild` que muda
 *    `node_modules` no lugar. Nada disso deve ser tocado por um build Linux
 *    (§14: não alterar o packaging NSIS Windows).
 *  - Um `.deb` gerado noutro sistema operativo não é um artefacto validado.
 *    Este script recusa-se a correr fora de Linux para que o resultado
 *    transporte a sua própria origem.
 *
 * Não publica nada: `--publish never` vai no comando e não há upload,
 * assinatura nem release neste caminho.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProductVersion, verifyBuiltRenderer } from "../app-version.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESKTOP = path.join(RAIZ, "packages", "desktop");
const CONFIG = path.join(DESKTOP, "electron-builder.linux-lite.yml");
const SAIDA = path.join(DESKTOP, "release-linux");

/** Executa sem shell: argumentos vão como lista, nunca interpolados. */
function executar(bin, args, opcoes = {}) {
  const r = spawnSync(bin, args, {
    cwd: opcoes.cwd || RAIZ,
    encoding: "utf8",
    maxBuffer: opcoes.maxBuffer ?? 128 * 1024 * 1024,
  });
  return {
    ok: r.status === 0 && !r.error,
    saida: `${r.stdout || ""}${r.stderr || ""}${r.error ? r.error.message : ""}`,
    codigo: r.status,
  };
}

function lerCabeca(ficheiro, bytes = 4) {
  const fd = openSync(ficheiro, "r");
  const buf = Buffer.alloc(bytes);
  try {
    readSync(fd, buf, 0, bytes, 0);
  } finally {
    closeSync(fd);
  }
  return buf;
}

const sha256De = (ficheiro) => createHash("sha256").update(readFileSync(ficheiro)).digest("hex");

const DEPENDENCIA_NATIVE = "better-sqlite3";

/**
 * Trocar o addon pelo binário do ABI do Electron.
 *
 * Medido: o `better-sqlite3` deixado pelo `npm install` em Linux tem
 * `NODE_MODULE_VERSION 127` (o Node 22 da máquina), mas o processo da API é um
 * filho do Electron (`ELECTRON_RUN_AS_NODE`) que exige 130 (Electron 33.4.11), e
 * o `require` rebenta com `ERR_DLOPEN_FAILED`. Foi exatamente assim que o
 * `.deb` de 0.1.11 ficou com uma janela de login sem backend: a API foi
 * encontrada no pacote mas morreu ao abrir a base de utilizadores.
 *
 * O vendor publica o prebuild do Electron — `better-sqlite3-v<versão>-electron-
 * v130-linux-x64.tar.gz`, medido `http 200` na release oficial — e é buscado
 * pela ferramenta que o próprio pacote usa para se instalar. Por isso não há
 * compilação, não há `g++` (medido: ausente neste ambiente), nem número de ABI
 * inventado neste script.
 */
function prepararNativoParaElectron() {
  const pastaNative = path.join(RAIZ, "node_modules", DEPENDENCIA_NATIVE);
  if (!existsSync(path.join(pastaNative, "package.json"))) return { ok: false, porque: `falta node_modules/${DEPENDENCIA_NATIVE}` };
  const prebuildCli = path.join(RAIZ, "node_modules", "prebuild-install", "bin.js");
  if (!existsSync(prebuildCli)) return { ok: false, porque: "falta node_modules/prebuild-install (o instalador do próprio addon)" };
  const electron = JSON.parse(readFileSync(path.join(RAIZ, "node_modules/electron/package.json"), "utf8")).version;
  const troca = executar("node", [prebuildCli, "--runtime=electron", `--target=${electron}`, "--arch=x64", "--platform=linux"], { cwd: pastaNative });
  if (!troca.ok) return { ok: false, porque: `prebuild-install --runtime=electron falhou: ${troca.saida.slice(-500)}` };
  return { ok: true, porque: `addon trocado para electron ${electron}` };
}

/**
 * Gate de ABI: não se lê um número de um ficheiro nem se confia no log do
 * utilitário — carrega-se o módulo NO runtime que o vai usar e abre-se uma base
 * real. O pipeline Windows tem gate da mesma espécie (secção «Rebuild nativo do
 * pipeline» em `scripts/package-windows.mjs`, com o comentário de que «viajaria
 * ABI errada em silêncio» sem ele); repeti-lo aqui é o que impede um `.deb`
 * «construído com sucesso» e inutilizável.
 */
function gateAbiElectron() {
  const bin = path.join(RAIZ, "node_modules/electron/dist/electron");
  if (!existsSync(bin)) return { ok: false, porque: `falta ${path.relative(RAIZ, bin)}` };
  const teste = "const D=require(process.argv[1]);const db=new D(':memory:');db.exec('CREATE TABLE t(x)');db.prepare('INSERT INTO t VALUES (?)').run(1);console.log('ABI_OK',process.versions.modules,process.versions.electron,db.prepare('SELECT x FROM t').get().x)";
  const r = executar("env", [`ELECTRON_RUN_AS_NODE=1`, bin, "-e", teste, path.join(RAIZ, "node_modules", DEPENDENCIA_NATIVE)], { cwd: RAIZ });
  const linha = (r.saida.match(/ABI_OK[^\n]*/) || ["sem_saida"])[0];
  if (!r.ok || !linha.startsWith("ABI_OK")) return { ok: false, porque: `${DEPENDENCIA_NATIVE} não carregou no Electron-as-node (${linha})` };
  return { ok: true, porque: linha };
}

/**
 * O `dist` do desktop TEM de conter o renderer, não só o shell.
 *
 * Porque isto é uma verificação e não um `existsSync`: o `index.html` do
 * desktop é `<body></body>` por origem (medido em `packages/desktop/dist`), e o
 * React real só aparece lá depois de `scripts/stage-renderer.mjs` copiar
 * `packages/app/dist` por cima. Sem staging, o `electron-builder` empacota uma
 * casca e a janela abre-se vazia — foi exatamente o que a sonda CDP mediu no
 * pacote de `49eb4f3`: `{"root":-1,"body":0,"texto":"","scripts":[]}` com zero
 * exceções. Um ficheiro que existe não é prova de conteúdo.
 *
 * Exigimos as duas coisas que a janela precisa de facto: o contentor onde o
 * React monta (`#root`) e o `src` do script; e a identidade embutida no bundle
 * conferida por `verifyBuiltRenderer` — a mesma verificação que o pipeline
 * Windows já usa, por isso não inventamos aqui um critério paralelo.
 */
export function estadoRenderer(distDir, { root = RAIZ } = {}) {
  let html;
  try {
    html = readFileSync(path.join(distDir, "index.html"), "utf8");
  } catch (error) {
    return { comRenderer: false, porque: `sem index.html legível (${error.code ?? error.message})` };
  }
  if (!/<div[^>]+\bid="root"/.test(html)) return { comRenderer: false, porque: "index.html não tem o contentor #root do React" };
  if (!/<script[^>]+\bsrc=/.test(html)) return { comRenderer: false, porque: "index.html não referencia nenhum script" };
  let version;
  try {
    version = readProductVersion({ root }).version;
  } catch (error) {
    return { comRenderer: false, porque: `versão canónica ilegível (${error.message})` };
  }
  const ver = verifyBuiltRenderer({ distDir, version, allowCommitUnknown: true });
  if (!ver.ok) return { comRenderer: false, porque: `renderer verificado como ${version}: ${ver.problems.join("; ")}` };
  const id = ver.identities[0];
  return { comRenderer: true, porque: `#root + <script src>, renderer ${id.version} build ${id.buildId} (${id.files.length} .js)` };
}

/**
 * O PREFLIGHT diz o que falta ANTES de perder minutos num build. Cada linha é
 * uma verificação com a sua razão nomeada — `indefinido` não é um passe.
 */
export function preflight(alvos = ["deb", "AppImage"]) {
  const falhas = [];
  const verificar = (nome, ok, porque) => {
    if (!ok) falhas.push(`${nome}: ${porque}`);
  };

  verificar(
    "plataforma",
    process.platform === "linux",
    `electron-builder empacota para a plataforma da máquina; a correr em ${process.platform} o resultado seria um artefacto construído fora de Linux, que §14 não permite chamar validado`
  );
  verificar("config-linux", existsSync(CONFIG), `falta ${path.relative(RAIZ, CONFIG)}`);

  const cliBuilder = path.join(RAIZ, "node_modules", "electron-builder", "cli.js");
  verificar("electron-builder", existsSync(cliBuilder), "não está instalado em node_modules/electron-builder");

  // O `dist` do Electron é o da plataforma da máquina. Se veio de Windows, o
  // pacote sairia com binários Windows — exatamente o que §14 proíbe.
  const binElectron = path.join(RAIZ, "node_modules", "electron", "dist", "electron");
  const eMag = existsSync(binElectron) ? lerCabeca(binElectron) : null;
  verificar(
    "electron-linux",
    !!eMag && eMag.subarray(0, 4).toString("hex") === "7f454c46",
    existsSync(binElectron)
      ? `node_modules/electron/dist/electron não é ELF (magic ${eMag.toString("hex")})`
      : "falta node_modules/electron/dist/electron; o `npm install` tem de correr em Linux"
  );

  // Vite 8 liga com rolldown; o binding por plataforma só existe se a
  // instalação foi feita nesse SO.
  verificar(
    "rolldown-linux",
    existsSync(path.join(RAIZ, "node_modules", "@rolldown", "binding-linux-x64-gnu")),
    "falta node_modules/@rolldown/binding-linux-x64-gnu (instalação de node_modules feita fora de Linux)"
  );
  // `app-builder` é o binário Go que empacota o asar e escreve o `.deb`. O
  // pacote traz linux/mac/win, mas uma `node_modules` parcial (copiada de
  // outro SO) pode não o ter — e o erro do electron-builder é um ENOENT no
  // meio do build, não uma mensagem sobre dependências.
  verificar(
    "app-builder-bin",
    existsSync(path.join(RAIZ, "node_modules", "app-builder-bin", "linux", "x64", "app-builder")),
    "falta node_modules/app-builder-bin/linux/x64/app-builder; correr `npm install --no-save app-builder-bin@<versão do lockfile>` em Linux"
  );

  for (const [p, ficheiro] of [
    ["packages/desktop", "dist/main.js"],
    ["packages/desktop", "dist/preload.cjs"],
  ]) {
    verificar(
      `build-${path.basename(ficheiro)}`,
      existsSync(path.join(RAIZ, p, ficheiro)),
      `falta ${p}/${ficheiro}; correr primeiro ` + "npm run build:all"
    );
  }

  // O `index.html` do desktop é uma casca vazia POR ORIGEM (`<body></body>`): o
  // React real é copiado por cima por `scripts/stage-renderer.mjs`, que
  // `construir()` corre. Um `--check` não compila nada, por isso aqui a
  // ausência ainda não pode ser um obstáculo — é nota. A asserção dura está em
  // `construir()`, logo a seguir ao staging e antes de qualquer escrita.
  const estagio = estadoRenderer(path.join(DESKTOP, "dist"));
  if (!estagio.comRenderer) {
    console.log(`nota: dist/ ainda sem renderer (${estagio.porque}); construir() corre stage-renderer.mjs e volta a verificar antes de escrever`);
  } else {
    console.log(`nota: dist/ já tem renderer — ${estagio.porque}`);
  }

  // Só as ferramentas que o BUILD chama. `unsquashfs` não está aqui de
  // propósito: quem desembrulha o AppImage na verificação é o runtime do
  // próprio pacote, e se ele falhar a linha sai `DESCONHECIDO` com a razão.
  for (const ferramenta of alvos.flatMap((alvo) => alvo === "deb" ? ["dpkg-deb"] : alvo === "AppImage" ? ["mksquashfs"] : [])) {
    verificar(ferramenta, which(ferramenta), "não está no PATH (necessário para escrever o .deb e o squashfs do AppImage)");
  }

  return falhas;
}

function which(bin) {
  return executar("sh", ["-c", `command -v ${bin}`]).saida.trim() !== "";
}

/**
 * Copia o fecho de workspaces do desktop para `packages/desktop/node_modules`
 * como diretórios reais (não links).
 *
 * Porque: o electron-builder resolve o `realpath` de cada ficheiro que copia e
 * exige que ele esteja dentro do `appDir` (`app-builder-lib/out/util/filter.js:28`,
 * «must be under»). Os `@cybersafe/*` são links de workspace para `packages/*`,
 * por isso um único ficheiro deles — `packages/core/definitions/yara/default.yar`
 * — rebentou o build depois de o `linux-unpacked` já estar escrito. Um pacote
 * copiado como diretório real tem o caminho dentro do `appDir`, e os módulos do
 * npm hoisted na raiz passam no mesmo teste porque têm `node_modules/` no meio.
 *
 * Só escreve dentro de `packages/desktop/node_modules`, que é artefacto de
 * build; nada em `packages/*` é tocado.
 */
function materializarWorkspaces() {
  const pastaWorkspace = (nome) => path.join(RAIZ, "packages", nome.split("/").pop());
  const leDependencias = (nome) => {
    try {
      return Object.keys(JSON.parse(readFileSync(path.join(pastaWorkspace(nome), "package.json"), "utf8")).dependencies || {});
    } catch {
      return [];
    }
  };
  const desktop = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf8"));

  // Fecho: só interessem workspaces locais; um nome publicado não tem pasta.
  const fecho = new Set();
  const fila = Object.keys(desktop.dependencies || {}).filter((n) => existsSync(path.join(pastaWorkspace(n), "package.json")));
  for (let i = 0; i < fila.length; i++) {
    const nome = fila[i];
    if (fecho.has(nome)) continue;
    fecho.add(nome);
    fila.push(...leDependencias(nome).filter((d) => !fecho.has(d) && existsSync(path.join(pastaWorkspace(d), "package.json"))));
  }

  const raizAlvo = path.join(DESKTOP, "node_modules");
  mkdirSync(raizAlvo, { recursive: true });
  for (const nome of fecho) {
    const destino = path.join(raizAlvo, ...nome.split("/"));
    if (!destino.startsWith(raizAlvo + path.sep)) throw new Error(`destino fora da área de build: ${destino}`);
    rmSync(destino, { recursive: true, force: true });
    cpSync(pastaWorkspace(nome), destino, {
      recursive: true,
      dereference: true,
      // `dist` fica (é o código que corre); fontes, testes e bancadas não.
      filter: (de) => !/(^|[\\/])(node_modules|test|bench|src|\.git)([\\/]|$)/.test(path.relative(pastaWorkspace(nome), de)),
    });
  }
  console.log(`MATERIALIZADAS ${JSON.stringify([...fecho].sort())}`);
}

/**
 * Workspaces que têm de ser COMPILADOS antes de empacotar.
 *
 * É a mesma lista que o pipeline Windows usa (`BUILD_WORKSPACES` em
 * `scripts/package-windows.mjs`), repetida de propósito: no Windows o motivo
 * declarado era «o único workspace que o pipeline nunca reconstruía podia sair
 * com um `dist` de uma alteração antiga». Em Linux era ainda pior — o `dist` do
 * `api` simplesmente não existia, e o `startLocalApi` do pacote respondeu
 * «API não encontrada no artefacto», ou seja, o `.deb` abria uma janela de login
 * que não conseguia autenticar. Compilar por lista em vez de confiar no que a
 * máquina tem é o que impede esse estado.
 */
const COMPILA = ["@cybersafe/shared-types", "@cybersafe/native-windows", "@cybersafe/core", "@cybersafe/service", "api"];

/** A entrada que o `api-lifecycle` procura dentro do pacote. */
const ENTRADA_API = path.join("node_modules", "api", "dist", "index.js");

function compilarWorkspaces() {
  for (const nome of COMPILA) {
    const r = executar("npm", ["run", "build", "-w", nome], { cwd: RAIZ });
    if (!r.ok) {
      console.log(`COMPILACAO_FALHOU ${nome} rc=${r.codigo}\n${r.saida.slice(-1200)}`);
      return { ok: false, porque: `build de ${nome} falhou` };
    }
    console.log(`compilado ${nome}`);
  }
  return { ok: true };
}

/**
 * O pacote só serve se a API estiver dentro. `packages/desktop/src/api-lifecycle.ts:155-168`
 * resolve `app.asar/node_modules/api/dist/index.js` e, sem ele, devolve
 * `skipped` — a janela abre-se, mas `/auth/register` e `/auth/login` não existem.
 */
export function estadoApi(destDir) {
  const entrada = path.join(destDir, ENTRADA_API);
  return existsSync(entrada)
    ? { comApi: true, porque: "api/dist/index.js presente no palco do pacote" }
    : { comApi: false, porque: `falta ${ENTRADA_API} em ${path.relative(RAIZ, destDir)} — sem API o pacote não autentica` };
}

/** Constrói com a configuração Linux; `--publish never` não é negociável. */
function construir(alvos) {
  const compilado = compilarWorkspaces();
  if (!compilado.ok) return { ok: false, codigo: 1, saida: compilado.porque };
  const nativo = prepararNativoParaElectron();
  if (!nativo.ok) {
    console.log(`NATIVO_FALHOU ${nativo.porque} — nada foi escrito`);
    return { ok: false, codigo: 1, saida: nativo.porque };
  }
  console.log(`addon ${nativo.porque}`);
  const gate = gateAbiElectron();
  if (!gate.ok) {
    console.log(`GATE_ABI_FALHOU ${gate.porque} — nada foi escrito`);
    return { ok: false, codigo: 1, saida: gate.porque };
  }
  console.log(`GATE_ABI ${gate.porque}`);
  // O staging do renderer faz parte do pacote, não é um luxo do Windows: o
  // `vite build` do desktop só produz o shell, cujo `index.html` é
  // `<body></body>`. Sem o pré-passo empacotou-se uma janela vazia — medido no
  // pacote de 49eb4f3 pela sonda CDP (`root:-1, scripts:[]`, zero exceções).
  const estagio = executar("node", [path.join(RAIZ, "scripts", "stage-renderer.mjs")], { cwd: RAIZ });
  if (!estagio.ok) {
    console.log(`STAGING_FALHOU rc=${estagio.codigo}\n${estagio.saida.slice(-1500)}`);
    return estagio;
  }
  console.log("staging do renderer ok");
  // Depois do staging, e antes de qualquer escrita: é aqui que a casca vazia se
  // torna um obstáculo. Se o `stage-renderer.mjs` tiver saido 0 sem copiar o
  // React, o `electron-builder` escreveria um `.deb` que abre uma janela sem
  // interface — um artefacto construído com sucesso e inutilizável.
  const renderer = estadoRenderer(path.join(DESKTOP, "dist"));
  if (!renderer.comRenderer) {
    console.log(`STAGING_SEM_RENDERER ${renderer.porque} — nada foi escrito`);
    return { ok: false, codigo: 1, saida: `staging sem renderer: ${renderer.porque}` };
  }
  console.log(`renderer no pacote: ${renderer.porque}`);
  // A versão do pacote vem de `product-version.json`, não do
  // `packages/desktop/package.json`. Medido no pacote anterior: o `.deb` dizia
  // `Version: 0.1.2` (a versão INTERNA do workspace, que `app-version.mjs:17-19`
  // declara explicitamente «não é identidade do produto») enquanto o renderer
  // dentro dele dizia `0.1.11-internal.pap-r7.20261031`. O `apt`, o gestor de
  // pacotes e o `app.getVersion()` mostram a primeira ao utilizador — era
  // exatamente a divergência de três fontes que aquele módulo existe para evitar.
  // Vai por `--config`, não pelo YAML, para que a fonte continue a ser uma.
  const { version } = readProductVersion({ root: RAIZ });
  materializarWorkspaces();
  // A mesma lógica da guarda do renderer, aplicada à peça que o ecrã de login
  // precisa para poder autenticar: sem a entrada da API no palco, o
  // `startLocalApi` do pacote devolve `skipped` e a janela é uma fachada.
  const api = estadoApi(DESKTOP);
  if (!api.comApi) {
    console.log(`PALCO_SEM_API ${api.porque} — nada foi escrito`);
    return { ok: false, codigo: 1, saida: `palco sem API: ${api.porque}` };
  }
  console.log(`api no pacote: ${api.porque}`);
  const args = [
    "--config",
    "electron-builder.linux-lite.yml",
    `--config.extraMetadata.version=${version}`,
    ...(alvos[0] === "dir" ? ["--config.extraMetadata.license=LicenseRef-Pending", "--linux", "--dir"] : ["--linux", ...alvos]),
    "--x64",
    "--publish",
    "never",
  ];
  console.log(`$ electron-builder ${args.join(" ")}  (versão canónica ${version})`);
  return executar(path.join(RAIZ, "node_modules", ".bin", "electron-builder"), args, { cwd: DESKTOP });
}

/**
 * Prova do conteúdo, não do desejo: `.deb` aberto com dpkg-deb, AppImage
 * aberto pelo `offset` squashfs declarado no cabeçalho ELF. O que não puder
 * ser lido fica `DESCONHECIDO`, nunca «sem .exe».
 */
export function verificationPassed(inspections, required) {
  return inspections.length > 0 && inspections.every(({ ok }) => ok === true)
    && required.every((format) => inspections.some((entry) => entry.format === format));
}

function verificarArtefactos(alvos = []) {
  const inspections = [];
  if (!existsSync(SAIDA)) return { inspections, relatorio: ["sem diretório release-linux"] };
  const ficheiros = readdirSync(SAIDA).filter((f) => statSync(path.join(SAIDA, f)).isFile() && /\.(?:deb|AppImage)$/.test(f) && (!alvos.length || alvos.includes(f.endsWith(".deb") ? "deb" : "AppImage")));
  const relatorio = [];
  for (const nome of ficheiros) {
    const completo = path.join(SAIDA, nome);
    const bytes = statSync(completo).size;
    const hashes = sha256De(completo);
    // O `sha256` vai inteiro: um resumo de 16 caracteres serve para olhar para
    // um log, não para documentar um artefacto que outra pessoa há de comparar.
    relatorio.push(`ARTEFACTO ${JSON.stringify({ nome, bytes, sha256: hashes })}`);
    if (nome.endsWith(".deb")) {
      const info = executar("dpkg-deb", ["--info", completo]);
      // O `Depends:` é o que §14 pede documentado: é a lista que o `apt` exige.
      relatorio.push(`DEB_INFO ${info.ok ? info.saida.replace(/\s+/g, " ").slice(0, 1200) : "DESCONHECIDO " + info.saida.slice(0, 200)}`);
      // A identidade que o gestor de pacotes mostra tem de ser a canónica, e os
      // outros campos de `extraMetadata` têm de sobreviver ao `--config` da
      // linha de comandos (uma substituição rasa do objeto apagava-mo-los).
      const identidade = identidadeDoDeb(info);
      relatorio.push(identidade);
      const conteudo = executar("dpkg-deb", ["--contents", completo], { maxBuffer: 256 * 1024 * 1024 });
      relatorio.push(deComEXE(conteudo, "DEB_CONTEUDO"));
      inspections.push({ format: "deb", ok: identidade.includes('"versaoOk":true') && conteudo.ok
        && !/\.(exe|dll|sys|msi)(?:\s|$)/im.test(conteudo.saida)
        && /\/resources\/app\.asar(?:\s|$)/m.test(conteudo.saida)
        && /cybersafe-assistant-linux-lite\.desktop(?:\s|$)/m.test(conteudo.saida) });
    }
    if (nome.endsWith(".AppImage")) {
      // O «sem .exe» do AppImage tem de ser medido dentro do squashfs, não
      // presumido a partir do `.deb`. O offset declarado no cabeçalho ELF não é
      // legível por este `unsquashfs` (medido: «-b is an invalid option», e com
      // `-o` «can't find a valid SQUASHFS superblock»), por isso é o próprio
      // runtime do pacote a desembrulhar-se num diretório temporário nosso.
      const pasta = mkdtempSync(path.join(tmpdir(), "cs-linux-lite-"));
      const extraido = executar(completo, ["--appimage-extract"], { cwd: pasta });
      const raiz = path.join(pasta, "squashfs-root");
      const visto = existsSync(raiz) ? readdirSync(raiz, { recursive: true, encoding: "utf8" }) : null;
      inspections.push({ format: "AppImage", ok: extraido.ok && !!visto
        && visto.includes("AppRun") && visto.includes(path.join("resources", "app.asar"))
        && !visto.some((f) => /\.(exe|dll|sys|msi)$/i.test(f)) });
      relatorio.push(
        visto
          ? `APPIMAGE_CONTEUDO ${JSON.stringify({
              ficheiros: visto.filter((f) => !f.endsWith("/")).length,
              exe: visto.filter((f) => /\.exe$/i.test(f)).length,
              dll: visto.filter((f) => /\.dll$/i.test(f)).length,
              temAppRun: visto.includes("AppRun"),
            })}`
          : `APPIMAGE_CONTEUDO DESCONHECIDO ${extraido.saida.slice(0, 200)}`
      );
      rmSync(pasta, { recursive: true, force: true });
    }
  }
  return { inspections, relatorio };
}

/**
 * A identidade que o `apt` e o gestor de pacotes mostram, conferida com a fonte
 * única. `extraMetadata` vem de dois sítios (o YAML e o `--config` da linha de
 * comandos), por isso não basta o `Version:` estar certo — os campos do YAML
 * têm de lá estar todos, senão a linha de comandos substituiu o objeto inteiro.
 */
function identidadeDoDeb(info) {
  if (!info.ok) return `DEB_IDENTIDADE DESCONHECIDO ${info.saida.slice(0, 200)}`;
  const campo = (nome) => {
    // O `dpkg-deb --info` escreve os campos do control COM UM ESPAÇO à frente
    // (medido: um `^Version:` estrito devolveu `null` para um pacote cujo
    // `Version: 0.1.2` estava mesmo lá). O `^\s*` é o que evita uma verificação
    // que falha fechada para «desconhecido» em vez de mostrar o valor.
    const m = info.saida.match(new RegExp(`^\\s*${nome}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  let esperado = null;
  try {
    esperado = readProductVersion({ root: RAIZ }).version;
  } catch {
    esperado = null;
  }
  const obtido = campo("Version");
  // O `Version:` de um `.deb` não pode levar mais do que um `-` (é o separador
  // upstream/revision), por isso o fpm reescreve os restantes. Medido no pacote
  // de `7ae8b24`: entrei `0.1.11-internal.pap-r7.20261031`, saiu no control
  // `0.1.11~internal.pap~r7.20261031` — cada `-` virou `~`, os pontos ficaram.
  // Comparar a literally teria chamado «errado» a um pacote certo; a regra vem
  // dessa medição, não de uma suposição. (E é a semântica deb correta: `~`
  // ordena ANTES de nada, pelo que uma pré-lançamento fica mais antiga que a
  // versão final, exatamente como deve ser numa atualização.)
  const normalizada = esperado ? esperado.replace(/-/g, "~") : null;
  const forma =
    obtido === null ? "ausente"
      : obtido === esperado ? "literal"
        : obtido === normalizada ? "fpm:-para~"
          : "divergente";
  return `DEB_IDENTIDADE ${JSON.stringify({
    esperado,
    obtido,
    forma,
    versaoOk: forma === "literal" || forma === "fpm:-para~",
    // Os campos que só existem porque o YAML os declara: se algum for `null`
    // depois do `--config`, a fusão não foi profunda.
    homepage: campo("Homepage"),
    maintainer: campo("Maintainer"),
    section: campo("Section"),
    descricao: campo("Description"),
  })}`;
}

function deComEXE(resultado, rotulo) {
  if (!resultado.ok) return `${rotulo} DESCONHECIDO ${resultado.saida.slice(0, 200)}`;
  const linhas = resultado.saida.split("\n");
  const exes = linhas.filter((l) => /\.exe\b/i.test(l));
  return `${rotulo} ${JSON.stringify({
    linhas: linhas.length,
    exe: exes.length,
    amostraExe: exes.slice(0, 3),
    // Lançadores listados por onde, não um booleano. E «não está no arquivo»
    // NÃO quer dizer «não existe no sistema»: medido no `postinst` do pacote, é
    // ele que cria `/usr/bin/cybersafe-assistant-linux-lite`
    // (`update-alternatives --install`, com queda em `ln -sf`) na instalação.
    // Uma lista vazia aqui é o esperado para um `.deb` de Electron.
    usrBin: linhas.filter((l) => /\/usr\/bin\//.test(l)).slice(0, 3),
    temLauncher: linhas.some((l) => /usr\/bin\/cybersafe-assistant-linux-lite|AppRun/.test(l)),
    temDesktop: linhas.some((l) => /cybersafe-assistant-linux-lite\.desktop/.test(l)),
    temIco: linhas.some((l) => /\.png$/.test(l) && /icons\//.test(l)),
  })}`;
}

// O resto do ficheiro é a CLI. Um `import` deste módulo tem de ser inofensivo
// (é assim que `scripts/test/linux-lite-package-renderer-guard.test.mjs` consegue
// exercer o guarda); por isso nada aqui corre quando o ficheiro é importado.
// `process.exitCode` em vez de `process.exit`: o relatório do build é escrito
// por tubos e um exit imediato pode corta-lo antes de fazer flush.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));

export function selectLinuxTargets(argv) {
  const selected = [
    ["--arch-stage", "dir"],
    ["--deb-only", "deb"],
    ["--appimage-only", "AppImage"],
  ].filter(([flag]) => argv.includes(flag));
  if (selected.length > 1) throw new Error("Escolha um único alvo Linux.");
  return selected.length ? [selected[0][1]] : ["deb", "AppImage"];
}

export function main(argv) {
  const alvos = selectLinuxTargets(argv);
  const soCheck = argv.includes("--check");

  // Reler um pacote já escrito não precisa de ambiente de build nenhum.
  if (argv.includes("--verify-only")) {
    const resultado = verificarArtefactos();
    for (const linha of resultado.relatorio) console.log(linha);
    return verificationPassed(resultado.inspections, []) ? 0 : 1;
  }

  const falhas = preflight(alvos);
  for (const f of falhas) console.log(`PREFLIGHT_FALHA ${f}`);
  if (falhas.length) {
    console.log(`PREFLIGHT ${falhas.length} obstáculo(s) — nada foi construído.`);
    return 1;
  }
  console.log("PREFLIGHT ok");
  if (soCheck) return 0;

  const build = construir(alvos);
  console.log(build.saida.split("\n").slice(-40).join("\n"));
  if (!build.ok) {
    console.log(`BUILD_FALHOU codigo=${build.codigo}`);
    return 1;
  }
  console.log("BUILD ok");
  if (alvos[0] === "dir") {
    const palco = path.join(SAIDA, "linux-unpacked");
    const bin = path.join(palco, "cybersafe-assistant-linux-lite");
    const asar = path.join(palco, "resources", "app.asar");
    const ok = existsSync(bin) && lerCabeca(bin).equals(Buffer.from("7f454c46", "hex"))
      && existsSync(asar) && statSync(asar).size > 0
      && !readdirSync(palco, { recursive: true }).some((f) => /\.(exe|dll|sys|msi)$/i.test(f));
    console.log(ok ? "ARCH_STAGE ok (ELF e app.asar; não é um pacote Arch)" : "ARCH_STAGE inválido");
    return ok ? 0 : 1;
  }
  const resultado = verificarArtefactos(alvos);
  for (const linha of resultado.relatorio) console.log(linha);
  return verificationPassed(resultado.inspections, alvos) ? 0 : 1;
}
