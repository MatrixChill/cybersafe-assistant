/**
 * Resolução dos binários YARA clássicos POR PLATAFORMA.
 *
 * O defeito que isto fecha é medido, não hipotético: em WSL2, antes desta
 * alteração, `resolveYaraClassicBinaries()` devolvia
 * `vendor/yara/yara64.exe` (magic `MZ`) como se fosse o motor Linux, e o
 * `YaraEngine` declarava-se disponível. Um scanner que corre um PE de Windows
 * num host Linux não é o Scanner Linux — e no WSL pode mesmo executar, pela
 * interop. Aqui o critério é o oposto: em POSIX um `.exe`, uma imagem `MZ` ou
 * um ficheiro sem bit de execução NÃO é motor, e a ausência vira indisponibi-
 * lidade declarada (nunca «sem deteções»).
 *
 * Os testes são deterministas em qualquer host: usam um leitor de disco
 * injectado, salvo o do disco real do repositório, que só afirma um invariante
 * (nada de `.exe`/PE em POSIX) e por isso passa também numa máquina Windows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  YARA_BINARIOS_POR_PLATAFORMA,
  YARA_BINARY_ENV,
  YARA_CLASSIC_VERSION,
  candidateDirectories,
  descricaoProcuraYara,
  leitorBinarioReal,
  missingBinaryDiagnostic,
  nomesExecutaveisYara,
  recusaExecutavelPosix,
  resolveYaraClassicBinaries,
} from "../dist/yara-classic.js";

/** Par de binários POSIX válidos (ELF, executável) dentro de `dir`. */
const parPosixValido = (dir) => ({
  [path.join(dir, "yara")]: { magic: "\u007fE", executavel: true },
  [path.join(dir, "yarac")]: { magic: "\u007fE", executavel: true },
});

const parWindowsVendor = (dir) => ({
  [path.join(dir, "yara64.exe")]: { magic: "MZ", executavel: false },
  [path.join(dir, "yarac64.exe")]: { magic: "MZ", executavel: false },
});

function leitorFixo(ficheiros) {
  const mapa = new Map(Object.entries(ficheiros));
  return {
    isFile: (candidato) => mapa.has(candidato),
    executavel: (candidato) => mapa.get(candidato)?.executavel === true,
    magic: (candidato) => (mapa.has(candidato) ? mapa.get(candidato).magic ?? null : null),
  };
}

/** Directório sem nada: uma raiz de módulo sem `vendor/yara` ao cima. */
const RAIZ_VAZIA = path.join(path.sep + "sem-yara", "projeto", "packages", "core", "dist");

test("os nomes do executável são os de cada plataforma", () => {
  assert.deepEqual(nomesExecutaveisYara("win32"), { yara: "yara64.exe", yarac: "yarac64.exe" });
  assert.deepEqual(nomesExecutaveisYara("linux"), { yara: "yara", yarac: "yarac" });
  assert.deepEqual(nomesExecutaveisYara("darwin"), { yara: "yara", yarac: "yarac" });
  assert.equal(YARA_BINARIOS_POR_PLATAFORMA.win32.yara, "yara64.exe");
});

test("Linux: os binários vendorizados de Windows NÃO são o motor", () => {
  // Mesma árvore de `vendor/yara` que existe no repositório, vista como Linux.
  const vendor = path.join(path.sep + "repo", "vendor", "yara");
  const resolvido = resolveYaraClassicBinaries(
    {},
    "linux",
    leitorFixo(parWindowsVendor(vendor)),
    path.join(vendor, "packages", "core", "dist"),
  );
  assert.equal(
    resolvido,
    null,
    "um PE de Windows sob nomes .exe não pode ser aceite como motor em Linux",
  );
});

test("Linux: aceita o par POSIX executável e declara a origem", () => {
  const vendor = path.join(path.sep + "repo", "vendor", "yara");
  const leitor = leitorFixo(parPosixValido(vendor));
  const resolvido = resolveYaraClassicBinaries({}, "linux", leitor, path.join(vendor, "packages", "core", "dist"));
  assert.ok(resolvido, "o par POSIX válido tem de resolver");
  assert.equal(resolvido.yarac, path.join(vendor, "yarac"));
  assert.equal(resolvido.origem, "vendor");
});

test("Linux: recusa um binário sem bit de execução", () => {
  const vendor = path.join(path.sep + "repo", "vendor", "yara");
  const leitor = leitorFixo({
    [path.join(vendor, "yara")]: { magic: "\u007fE", executavel: false },
    [path.join(vendor, "yarac")]: { magic: "\u007fE", executavel: true },
  });
  assert.equal(resolveYaraClassicBinaries({}, "linux", leitor, path.join(vendor, "packages", "core", "dist")), null);
});

test("Linux: recusa uma imagem PE camuflada com nome POSIX", () => {
  // `yara64.exe` renomeado para `yara` continua a ser um executável Windows.
  const vendor = path.join(path.sep + "repo", "vendor", "yara");
  const leitor = leitorFixo({
    [path.join(vendor, "yara")]: { magic: "MZ", executavel: true },
    [path.join(vendor, "yarac")]: { magic: "MZ", executavel: true },
  });
  assert.equal(resolveYaraClassicBinaries({}, "linux", leitor, path.join(vendor, "packages", "core", "dist")), null);
});

test("Linux: um YARA instalado pelo pacotes entra pela PATH com origem «sistema»", () => {
  const bin = path.join(path.sep + "opt", "custom", "bin");
  const leitor = leitorFixo(parPosixValido(bin));
  const resolvido = resolveYaraClassicBinaries({ PATH: `${bin}:/outra/coisa` }, "linux", leitor, RAIZ_VAZIA);
  assert.ok(resolvido, "sem vendor, o PATH é o caminho legítimo para um motor instalado");
  assert.equal(resolvido.dir, bin);
  assert.equal(resolvido.origem, "sistema");
  assert.equal(resolvido.yara.includes("yara64"), false);
});

test("Linux: CYBERSAFE_YARA_BIN_DIR continua autoritativo e não cai para a PATH", () => {
  const pinado = path.join(path.sep + "pinado", "sem", "nada");
  const bin = path.join(path.sep + "opt", "custom", "bin");
  // O directório indicado está vazio; existe um YARA perfeitamente válido na
  // PATH. Autoridade significa recusar o binário encontrado «por acaso».
  const leitor = leitorFixo(parPosixValido(bin));
  const resolvido = resolveYaraClassicBinaries(
    { [YARA_BINARY_ENV]: pinado, PATH: bin },
    "linux",
    leitor,
    RAIZ_VAZIA,
  );
  assert.equal(resolvido, null);
});

test("Windows: o contrato histórico é preservado (.exe sem bit de execução nem magic)", () => {
  const vendor = path.join(path.sep + "repo", "vendor", "yara");
  // O leitor marca os .exe como NÃO executáveis e com magic MZ: em win32 nada
  // disso é pedido — a presença do ficheiro é o critério de sempre.
  const leitor = leitorFixo(parWindowsVendor(vendor));
  const resolvido = resolveYaraClassicBinaries({}, "win32", leitor, path.join(vendor, "packages", "core", "dist"));
  assert.ok(resolvido, "a alteração não pode partir a resolução em Windows");
  assert.equal(resolvido.yara, path.join(vendor, "yara64.exe"));
  assert.equal(resolvido.yarac, path.join(vendor, "yarac64.exe"));
  assert.equal(resolvido.origem, "vendor");
});

test("candidatos: só POSIX procura directórios de sistema e PATH", () => {
  const posix = candidateDirectories({ PATH: "/a:/b" }, "linux", RAIZ_VAZIA);
  assert.ok(posix.some((entrada) => entrada.dir === "/a" && entrada.origem === "sistema"));
  assert.ok(posix.some((entrada) => entrada.dir === "/usr/bin" && entrada.origem === "sistema"));
  assert.ok(posix.some((entrada) => entrada.dir === path.join(RAIZ_VAZIA, "..", "..", "..", "vendor", "yara")));

  const windows = candidateDirectories({ PATH: "C:\\a;C:\\b" }, "win32", RAIZ_VAZIA);
  assert.equal(
    windows.some((entrada) => entrada.origem === "sistema"),
    false,
    "em Windows nada é procurado na PATH nem em directórios de sistema",
  );
});

test("recusaExecutavelPosix nomeia cada razão de recusa", () => {
  assert.equal(recusaExecutavelPosix("/x/yara", "\u007fE", true), null);
  assert.match(recusaExecutavelPosix("/x/yara64.exe", "\u007fE", true), /\.exe/);
  assert.match(recusaExecutavelPosix("/x/yara", "MZ", true), /PE de Windows/);
  assert.match(recusaExecutavelPosix("/x/yara", "\u007fE", false), /permissão de execução/);
  assert.match(recusaExecutavelPosix("/x/yara", null, true), /não é legível/);
  // A extensão vence o magic: um `.exe` é recusado mesmo sem ler o ficheiro.
  assert.match(recusaExecutavelPosix("/x/yara.EXE", null, false), /\.exe/);
});

test("a frase de procura diz o que foi procurado no sistema que corre", () => {
  assert.match(descricaoProcuraYara("win32"), /yara64\.exe/);
  assert.equal(descricaoProcuraYara("win32").includes("Windows não são aceites"), false);
  assert.match(descricaoProcuraYara("linux"), /resources\/yara e vendor\/yara \(procura em yara e yarac\)/);
  assert.match(descricaoProcuraYara("linux"), /em POSIX os binários de Windows não são aceites/);
});

test("a indisponibilidade é declarada como indisponibilidade, por plataforma", () => {
  const diagnostico = missingBinaryDiagnostic("linux");
  assert.equal(diagnostico.severity, "error");
  assert.equal(diagnostico.code, "io-error");
  assert.match(diagnostico.message, /não encontrado para este sistema/);
  assert.match(diagnostico.message, /procura em yara e yarac/);
  // A frase proibida: um motor ausente nunca pode ler-se como «ficheiro limpo».
  assert.match(diagnostico.message, /não é «limpo»/);
  assert.ok(YARA_CLASSIC_VERSION.length > 0);
});

test("disco real do repositório: POSIX nunca resolve um binário Windows", () => {
  // Este é o caso medido em WSL2. O invariante é afirmado (e não o resultado
  // concreto) porque o host pode ou não ter YARA instalado: o que não pode
  // acontecer, em parte nenhuma, é o resolutor devolver um `.exe` ou um PE.
  const raizModulo = path.resolve();
  for (const plataforma of ["linux", "darwin"]) {
    const resolvido = resolveYaraClassicBinaries({}, plataforma, leitorBinarioReal, raizModulo);
    if (!resolvido) continue;
    for (const caminho of [resolvido.yara, resolvido.yarac]) {
      assert.equal(/\.exe$/i.test(caminho), false, `${plataforma} não pode resolver ${caminho}`);
      assert.notEqual(leitorBinarioReal.magic(caminho), "MZ", `${caminho} é uma imagem PE de Windows`);
      assert.equal(leitorBinarioReal.executavel(caminho), true, `${caminho} tem de ser executável`);
    }
  }
});
