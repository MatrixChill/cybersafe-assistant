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
export function preflight() {
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
  for (const ferramenta of ["dpkg-deb", "mksquashfs"]) {
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

/** Constrói com a configuração Linux; `--publish never` não é negociável. */
function construir(alvos) {
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
  const args = [
    "--config",
    "electron-builder.linux-lite.yml",
    `--config.extraMetadata.version=${version}`,
    "--linux",
    ...alvos,
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
function verificarArtefactos() {
  if (!existsSync(SAIDA)) return { ficheiros: [], relatorio: ["sem diretório release-linux"] };
  const ficheiros = readdirSync(SAIDA).filter((f) => statSync(path.join(SAIDA, f)).isFile() && !f.endsWith(".yml"));
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
      relatorio.push(identidadeDoDeb(info));
      const conteudo = executar("dpkg-deb", ["--contents", completo], { maxBuffer: 256 * 1024 * 1024 });
      relatorio.push(deComEXE(conteudo, "DEB_CONTEUDO"));
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
  return { ficheiros, relatorio };
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

export function main(argv) {
  const alvos = argv.includes("--appimage-only")
    ? ["AppImage"]
    : argv.includes("--deb-only")
      ? ["deb"]
      : ["deb", "AppImage"];
  const soCheck = argv.includes("--check");

  // Reler um pacote já escrito não precisa de ambiente de build nenhum.
  if (argv.includes("--verify-only")) {
    for (const linha of verificarArtefactos().relatorio) console.log(linha);
    return 0;
  }

  const falhas = preflight();
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
  for (const linha of verificarArtefactos().relatorio) console.log(linha);
  return 0;
}
