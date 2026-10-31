import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * TP-QA2-READINESS-20261025 — credencial do pipe.
 *
 * Causa reproduzida em HOST/LANE (o estado reportado na VM QA1 é compatível com
 * ela, mas não há logs da VM para a provar): o `main.ts` gerava uma credencial
 * de pipe ALEATÓRIA POR PROCESSO e decidia "reutilizar o serviço que já está no
 * pipe" por um probe que só prova que HÁ um listener — nunca que o listener fala
 * a nossa credência. Um serviço filho que sobrevivesse a um boot anterior ficava
 * para sempre inautenticável: a janela abria, nada se confirmava, modo limitado.
 *
 * A credência passa a ser POR INSTALAÇÃO e persistida fora do pacote — o desenho
 * já provado para o segredo JWT da API (api-lifecycle.ts). O que se fixa aqui:
 *  1. estabilidade entre arranques (sem isto a causa volta);
 *  2. nunca dentro do artefacto, nunca através de link;
 *  3. ficheiro inválido NÃO é substituído em silêncio;
 *  4. criação CONCORRENTE adota o vencedor: o `main.ts` lê a credência antes de
 *     `requestSingleInstanceLock()`, por isso dois arranques podem chegar aqui em
 *     simultâneo, e uma publicação por cima recriava exatamente o lockout.
 *
 * Só fixtures públicas (`a64` / `b64`): nenhum segredo real neste ficheiro, e os
 * valores nunca são escritos em log.
 */

import {
  PIPE_CREDENTIAL_FILENAME,
  readOrCreatePipeCredential,
} from "../src/pipe-credential.ts";

function tempUserData(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cybersafe-qa2-${label}-`));
}

const CRED_A = "a".repeat(64);
const CRED_B = "b".repeat(64);

/** `lstat` de um caminho normal: nem link, nem hardlink. */
const lstatNormal = () => ({ isSymbolicLink: () => false, nlink: 1 });

describe("credencial do pipe — por instalação, não por processo", () => {
  it("o segundo arranque da mesma instalação lê a MESMA credencial", () => {
    const dir = tempUserData("stable");
    try {
      const primeiro = readOrCreatePipeCredential(dir);
      const segundo = readOrCreatePipeCredential(dir);
      assert.equal(primeiro.created, true, "o primeiro arranque cria a credencial");
      assert.equal(segundo.created, false, "o segundo arranque reutiliza, não recria");
      assert.equal(segundo.credential, primeiro.credential, "credencial estável entre arranques");
      assert.match(primeiro.credential, /^[a-f0-9]{64}$/, "a forma é a que o serviço exige");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("instalações diferentes têm credenciais diferentes", () => {
    const a = tempUserData("inst-a");
    const b = tempUserData("inst-b");
    try {
      assert.notEqual(readOrCreatePipeCredential(a).credential, readOrCreatePipeCredential(b).credential);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("vive no userData, nunca dentro do artefacto empacotado", () => {
    const dir = tempUserData("location");
    try {
      const info = readOrCreatePipeCredential(dir);
      assert.equal(info.credentialPath, path.join(dir, "secrets", PIPE_CREDENTIAL_FILENAME));
      assert.doesNotMatch(info.credentialPath, /app\.asar/i, "a credencial não pode viver no pacote");
      assert.ok(fs.existsSync(info.credentialPath), "fica em disco para o arranque seguinte");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa um userData dentro do pacote antes de qualquer escrita", () => {
    const dir = tempUserData("asar");
    try {
      const dentroDoPacote = path.join(dir, "resources", "app.asar");
      fs.mkdirSync(dentroDoPacote, { recursive: true });
      let tocado = false;
      const fake = {
        existsSync: () => { tocado = true; return false; },
        lstatSync: lstatNormal,
        readFileSync: () => "",
        mkdirSync: () => { tocado = true; },
        chmodSync: () => { tocado = true; },
        writeFileSync: () => { tocado = true; },
      };
      assert.throws(() => readOrCreatePipeCredential(dentroDoPacote, { fsImpl: fake }), /pacote|asar/i,
        "um caminho de pacote tem de ser recusado");
      assert.equal(tocado, false, "a recusa é antes de qualquer toque no disco");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não roda em silêncio uma credencial inválida: falha com razão legível", () => {
    const dir = tempUserData("invalid");
    try {
      const secrets = path.join(dir, "secrets");
      fs.mkdirSync(secrets, { recursive: true });
      fs.writeFileSync(path.join(secrets, PIPE_CREDENTIAL_FILENAME), "curta\n", "utf8");
      assert.throws(() => readOrCreatePipeCredential(dir), /inválid|não é substituída/i,
        "substituir em silêncio re-criava o lockout entre arranques");
      assert.equal(fs.readFileSync(path.join(secrets, PIPE_CREDENTIAL_FILENAME), "utf8").trim(), "curta",
        "nada é escrito quando a leitura falha");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não deixa ficheiro temporário: publica diretamente no destino", () => {
    const dir = tempUserData("sem-tmp");
    try {
      readOrCreatePipeCredential(dir);
      const restos = fs.readdirSync(path.join(dir, "secrets")).filter((n) => n.includes(".tmp-"));
      assert.deepEqual(restos, [], "sem tmp não há janela entre tmp e destino");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publica com criação exclusiva NO DESTINO, nunca por cima", () => {
    const dir = tempUserData("wx");
    try {
      const escritas = [];
      const fake = {
        existsSync: () => false,
        lstatSync: () => { throw new Error("ENOENT"); },
        readFileSync: () => "",
        mkdirSync: () => {},
        chmodSync: () => {},
        writeFileSync: (target, data, options) => { escritas.push({ target, flag: options?.flag }); },
      };
      readOrCreatePipeCredential(dir, { fsImpl: fake, generate: () => CRED_B });
      assert.equal(escritas.length, 1, "uma única escrita");
      assert.equal(escritas[0].flag, "wx", "criação exclusiva: substituir a credência alheia era o lockout");
      assert.equal(escritas[0].target, path.join(dir, "secrets", PIPE_CREDENTIAL_FILENAME),
        "a escrita exclusiva é no destino final, não num temporário");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outro criador publica A entre a leitura e a publicação: o vencido ADOTA A", () => {
    const dir = tempUserData("corrida");
    try {
      let publicado = false;
      // Determinístico: o concorrente publica A no instante em que este criador
      // tenta publicar — a janela que um `rename` por cima simplesmente apagava.
      const fake = {
        existsSync: () => false,
        lstatSync: lstatNormal,
        readFileSync: () => (publicado ? `${CRED_A}\n` : ""),
        mkdirSync: () => {},
        chmodSync: () => {},
        writeFileSync: () => {
          publicado = true;
          const error = new Error("EEXIST: file already exists");
          error.code = "EEXIST";
          throw error;
        },
      };
      const info = readOrCreatePipeCredential(dir, { fsImpl: fake, generate: () => CRED_B });
      assert.equal(publicado, true, "o destino passou a existir por outro criador");
      assert.equal(info.created, false, "quem perde a corrida não se declara criador");
      assert.equal(info.credential, CRED_A, "adota-se o vencedor em vez de inventar outra credência");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o vencedor da corrida é inválido: falha com razão, sem escrever por cima", () => {
    const dir = tempUserData("corrida-invalida");
    try {
      let publicado = false;
      const fake = {
        existsSync: () => false,
        lstatSync: lstatNormal,
        readFileSync: () => (publicado ? "curta\n" : ""),
        mkdirSync: () => {},
        chmodSync: () => {},
        writeFileSync: () => {
          publicado = true;
          const error = new Error("EEXIST: file already exists");
          error.code = "EEXIST";
          throw error;
        },
      };
      assert.throws(() => readOrCreatePipeCredential(dir, { fsImpl: fake, generate: () => CRED_B }),
        /inválid|não é substituída/i, "um vencedor inutilizável não se pisa em silêncio");
      assert.equal(publicado, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa uma credência partilhada por hardlink, sem a seguir nem a ler", () => {
    const dir = tempUserData("hardlink");
    try {
      const info = readOrCreatePipeCredential(dir);
      fs.linkSync(info.credentialPath, path.join(dir, "ligacao-extra"));
      assert.throws(() => readOrCreatePipeCredential(dir), /liga[cç][ãa]o f[ií]sica|hardlink/i,
        "um hardlink faria duas instalações partilharem a mesma credência");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa um symlink no lugar da credência (quando o sistema permite criá-lo)", (t) => {
    const dir = tempUserData("symlink");
    try {
      const secrets = path.join(dir, "secrets");
      fs.mkdirSync(secrets, { recursive: true });
      const alvo = path.join(dir, "alvo");
      fs.writeFileSync(alvo, `${CRED_A}\n`, "utf8");
      try {
        fs.symlinkSync(alvo, path.join(secrets, PIPE_CREDENTIAL_FILENAME), "file");
      } catch (error) {
        t.skip(`symlinks não são criáveis neste sistema (${error?.code ?? error})`);
        return;
      }
      assert.throws(() => readOrCreatePipeCredential(dir), /link simb[oó]lico/,
        "a posse é do próprio nodo, nunca do destino");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a credência do pipe não é o segredo JWT da API", async () => {
    const { INSTALLATION_SECRET_FILENAME } = await import("../src/api-lifecycle.ts");
    assert.notEqual(PIPE_CREDENTIAL_FILENAME, INSTALLATION_SECRET_FILENAME,
      "dois domínios de confiança não partilham o mesmo segredo");
  });

  it("dois processos que arrancam em simultâneo convergem para a mesma credência", async () => {
    const dir = tempUserData("corrida-real");
    try {
      const filho = fileURLToPath(new URL("./fixtures/le-credencial.mjs", import.meta.url));
      const run = () => new Promise((resolve, reject) => {
        execFile(process.execPath, [filho, dir], (error, stdout) =>
          error ? reject(error) : resolve(String(stdout).trim()));
      });
      const parsed = (await Promise.all([run(), run(), run()])).map((linha) => JSON.parse(linha));
      for (const r of parsed) {
        assert.equal(r.temForma, true, "cada processo vê a forma que o serviço exige");
        assert.equal(typeof r.digest, "string", "o processo devolve um digest, nunca o valor");
        assert.ok(!JSON.stringify(r).includes(CRED_A) && !JSON.stringify(r).includes(CRED_B),
          "nenhum valor de credência sai para stdout");
      }
      assert.equal(new Set(parsed.map((r) => r.digest)).size, 1,
        "arranques concorrentes não podem divergir — divergir era o lockout");
      const criadores = parsed.filter((r) => r.created).length;
      assert.ok(criadores <= 1, `no máximo um processo é o criador (foram ${criadores})`);
      assert.match(fs.readFileSync(path.join(dir, "secrets", PIPE_CREDENTIAL_FILENAME), "utf8").trim(),
        /^[a-f0-9]{64}$/, "em disco fica uma credência única e partilhada");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
