import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `definitions.status` — o contrato de leitura das definições de segurança.
 *
 * Antes deste ficheiro não existia nenhuma forma de a UI saber o estado de cada
 * fonte: o único pedido era `definitions.update`, que responde «sucesso/falha» de
 * um ciclo, não a saúde das bases. As asserções abaixo são as que o requisito 5
 * pede, e a distinção que não pode ser perdida é a de honestidade:
 * «nunca verificado» ≠ «indisponível» ≠ «desactualizado» ≠ «degradado».
 */
const RAIZES = [];
function novoMotor() {
  const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cs-dstatus-"));
  RAIZES.push(raiz);
  return import("../dist/engine.js").then(({ ProtectionEngineService }) => {
    const servico = new ProtectionEngineService(raiz);
    return { servico, raiz };
  });
}
after(() => {
  for (const r of RAIZES) fs.rmSync(r, { recursive: true, force: true });
});

test("sem histórico nenhum: as três fontes dizem nunca_verificado, não indisponivel", async () => {
  const { servico } = await novoMotor();
  const r = await servico.definitionsStatus();
  assert.equal(r.fontes.length, 3, "clamav, yara e hashes");
  for (const f of r.fontes) {
    assert.equal(f.estado, "nunca_verificado", `${f.fonte}: ${JSON.stringify(f)}`);
    assert.equal(f.ultimaBemSucedidaAtMs, null);
    assert.equal(f.tentativasConsecutivas, 0);
    assert.ok(f.cadenciaMs > 0, "a cadência é por fonte e tem de vir no contrato");
  }
  assert.equal(r.cicloEmCurso, false);
});

test("a cadência dos hashes é a do feed (45 min), não a herda das outras fontes", async () => {
  const { servico } = await novoMotor();
  const r = await servico.definitionsStatus();
  const hashes = r.fontes.find((f) => f.fonte === "hashes");
  const yara = r.fontes.find((f) => f.fonte === "yara");
  assert.equal(hashes.cadenciaMs, 45 * 60 * 1000);
  assert.equal(yara.cadenciaMs, 6 * 60 * 60 * 1000);
  assert.ok(hashes.itensCarregados >= 0, "a contagem de assinaturas carregadas é medida, não estimada");
});

test("sucesso registado há mais do que a cadência vira desactualizado", async () => {
  const { servico, raiz } = await novoMotor();
  fs.mkdirSync(path.join(raiz, "definitions"), { recursive: true });
  fs.writeFileSync(
    path.join(raiz, "definitions", ".update-meta.json"),
    JSON.stringify({
      timestamp: Date.now() - 3 * 60 * 60 * 1000,
      components: { hashes: Date.now() - 3 * 60 * 60 * 1000 },
    }),
    "utf8",
  );
  const r = await servico.definitionsStatus();
  // A fonte é a dos hashes de caso: não tem motor com saúde própria, therefore
  // «desactualizado» é a única coisa que pode sair — que é justamente o que
  // distingue esta asserção do caso do YARA, onde a saúde do motor tem
  // precedência sobre a idade (um motor sem corpus não é «velho», é ausente).
  const hashes = r.fontes.find((f) => f.fonte === "hashes");
  assert.equal(hashes.estado, "desactualizado", JSON.stringify(hashes));
  assert.ok(hashes.ultimaBemSucedidaAtMs > 0);
  assert.ok(hashes.proximaVerificacaoAtMs < Date.now(), "a próxima janela já passou — o scheduler vai tentar");
});

test("backoff em vigor aparece como degradado com o erro e a próxima janela reais", async () => {
  const { servico, raiz } = await novoMotor();
  fs.mkdirSync(path.join(raiz, "definitions"), { recursive: true });
  const agora = Date.now();
  fs.writeFileSync(
    path.join(raiz, "definitions", ".update-meta.json"),
    JSON.stringify({
      timestamp: agora,
      components: { hashes: agora - 60 * 60 * 1000 },
      falhas: { hashes: { count: 3, nextAllowedAtMs: agora + 30 * 60 * 1000, lastError: "MalwareBazaar: sem chave", lastAttemptAtMs: agora - 60 * 1000 } },
    }),
    "utf8",
  );
  const r = await servico.definitionsStatus();
  const hashes = r.fontes.find((f) => f.fonte === "hashes");
  assert.equal(hashes.estado, "degradado", JSON.stringify(hashes));
  assert.equal(hashes.tentativasConsecutivas, 3);
  assert.match(hashes.ultimoErro, /sem chave/);
  assert.ok(
    hashes.proximaVerificacaoAtMs > agora + 25 * 60 * 1000,
    "a próxima verificação é o fim do backoff, não a cadência normal",
  );
});

test("o pedido passa pela fila de leitura independente (não espera um update em curso)", async () => {
  const { servico } = await novoMotor();
  const { INDEPENDENT_READ_METHODS } = await import("../dist/rpc-request-queue.js");
  assert.ok(INDEPENDENT_READ_METHODS.has("definitions.status"), "leitura barata não pode ficar atrás de uma descarga lenta");
  const viaDispatch = await servico.dispatch("definitions.status", undefined);
  assert.equal(viaDispatch.fontes.length, 3, "o dispatch responde pelo contrato novo");
});
