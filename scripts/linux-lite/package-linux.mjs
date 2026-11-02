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
    ["packages/desktop", "dist/index.html"],
    ["packages/desktop", "dist/preload.cjs"],
  ]) {
    verificar(
      `build-${path.basename(ficheiro)}`,
      existsSync(path.join(RAIZ, p, ficheiro)),
      `falta ${p}/${ficheiro}; correr primeiro ` + "npm run build:all"
    );
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
  materializarWorkspaces();
  const args = ["--config", "electron-builder.linux-lite.yml", "--linux", ...alvos, "--x64", "--publish", "never"];
  console.log(`$ electron-builder ${args.join(" ")}`);
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
    relatorio.push(`ARTEFACTO ${JSON.stringify({ nome, bytes, sha256: hashes.slice(0, 16) })}`);
    if (nome.endsWith(".deb")) {
      const info = executar("dpkg-deb", ["--info", completo]);
      // O `Depends:` é o que §14 pede documentado: é a lista que o `apt` exige.
      relatorio.push(`DEB_INFO ${info.ok ? info.saida.replace(/\s+/g, " ").slice(0, 1200) : "DESCONHECIDO " + info.saida.slice(0, 200)}`);
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

function deComEXE(resultado, rotulo) {
  if (!resultado.ok) return `${rotulo} DESCONHECIDO ${resultado.saida.slice(0, 200)}`;
  const linhas = resultado.saida.split("\n");
  const exes = linhas.filter((l) => /\.exe\b/i.test(l));
  return `${rotulo} ${JSON.stringify({
    linhas: linhas.length,
    exe: exes.length,
    amostraExe: exes.slice(0, 3),
    // Lançadores listados por onde, não um booleano: o `.deb` medido não tinha
    // nenhuma entrada em /usr/bin e o booleano mascarava isso como «false».
    usrBin: linhas.filter((l) => /\/usr\/bin\//.test(l)).slice(0, 3),
    temLauncher: linhas.some((l) => /usr\/bin\/cybersafe-assistant-linux-lite|AppRun/.test(l)),
    temDesktop: linhas.some((l) => /cybersafe-assistant-linux-lite\.desktop/.test(l)),
    temIco: linhas.some((l) => /\.png$/.test(l) && /icons\//.test(l)),
  })}`;
}

const alvos = process.argv.includes("--appimage-only")
  ? ["AppImage"]
  : process.argv.includes("--deb-only")
    ? ["deb"]
    : ["deb", "AppImage"];
const soCheck = process.argv.includes("--check");

// Reler um pacote já escrito não precisa de ambiente de build nenhum.
if (process.argv.includes("--verify-only")) {
  for (const linha of verificarArtefactos().relatorio) console.log(linha);
  process.exit(0);
}

const falhas = preflight();
for (const f of falhas) console.log(`PREFLIGHT_FALHA ${f}`);
if (falhas.length) {
  console.log(`PREFLIGHT ${falhas.length} obstáculo(s) — nada foi construído.`);
  process.exit(1);
}
console.log("PREFLIGHT ok");
if (soCheck) process.exit(0);

const build = construir(alvos);
console.log(build.saida.split("\n").slice(-40).join("\n"));
if (!build.ok) {
  console.log(`BUILD_FALHOU codigo=${build.codigo}`);
  process.exit(1);
}
console.log("BUILD ok");
for (const linha of verificarArtefactos().relatorio) console.log(linha);
