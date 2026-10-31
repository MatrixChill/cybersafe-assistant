// TCP state mapping medido 15/10 (evidencia Freebuff + MIB_TCP_STATE).
// Protege contra o regressao do mapa anterior (1->Listen falso, 100 cru na UI).
//
// TcpState (.NET / MIB_TCP_STATE) sao 12 valores: 1..12. O valor "100" NAO e
// um TcpState valido: PowerShell/Get-NetTCPConnection nao devolve "100" como
// State num cmdlet saudavel. Quando "100" aparece (coluna extendida, falha de
// serializacao, ou fallback netstat), e um valor NAO DOCUMENTADO — deve virar
// "Desconhecido", NUNCA "Bound" (afirmacao correcta: "Bound" nao e um State
// devolvido pelo cmdlet; Get-NetTCPConnection devolve "Bound" como string, mas
// nunca como codigo numerico 100).O commentario original do teste ("evidencia
// Freebuff") referia-se ao caso onde "100" aparecia crudo na UI; a assercao
// akeito ao mapa e um BITE de regressao documental, nao da realidade do .NET.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTcpState, TCP_STATE_MAP } from "../dist/index.js";

test("mapa medido: numeros 0..12 -> nomes reais do .NET TcpState (.NET TcpState enum, RFC 793)", () => {
  assert.equal(normalizeTcpState("0"), "Unknown");
  assert.equal(normalizeTcpState("1"), "Closed");
  assert.equal(normalizeTcpState("2"), "Listen");
  assert.equal(normalizeTcpState("3"), "SynSent");
  assert.equal(normalizeTcpState("4"), "SynReceived");
  assert.equal(normalizeTcpState("5"), "Established");
  assert.equal(normalizeTcpState("6"), "FinWait1");
  assert.equal(normalizeTcpState("7"), "FinWait2");
  assert.equal(normalizeTcpState("8"), "CloseWait");
  assert.equal(normalizeTcpState("9"), "Closing");
  assert.equal(normalizeTcpState("10"), "LastAck");
  assert.equal(normalizeTcpState("11"), "TimeWait");
  assert.equal(normalizeTcpState("12"), "DeleteTcb");
});

test("stringings diretos do PowerShell continuam a funcionar (incl. 'Bound' de listening socket)", () => {
  assert.equal(normalizeTcpState("Established"), "Established");
  assert.equal(normalizeTcpState("Bound"), "Bound");
  assert.equal(normalizeTcpState("DeleteTcb"), "DeleteTcb");
});

test("codigo 100 NAO e TcpState valido (.NET TcpState so vai a 12) -> Desconhecido, nunca 'Bound'", () => {
  assert.equal(normalizeTcpState("100"), "Desconhecido", "100 nao e TcpState .NET (max=12); nao pode virar label inventado");
  assert.equal(TCP_STATE_MAP["100"], undefined, "100 nao pode existir no mapa real");
});

test("codigo desconhecido NUNCA e impresso cru nem vira percentagem", () => {
  for (const v of ["999", "42", "QualquerCoisa", "", "100%"]) {
    assert.equal(normalizeTcpState(v), "Desconhecido", `valor '${v}' deveria ser Desconhecido`);
  }
  assert.equal(TCP_STATE_MAP["42"], undefined, "42 nao pode existir no mapa");
});

test("mapa nao pode regressar ao alinhamento antigo (1 era 'Listen')", () => {
  assert.notEqual(TCP_STATE_MAP["1"], "Listen");
  assert.notEqual(TCP_STATE_MAP["12"], "Bound");
  assert.notEqual(TCP_STATE_MAP["5"], "FinWait1");
});
