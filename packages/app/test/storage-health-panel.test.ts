import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiskSnapshot } from "@cybersafe/shared-types";
import { StorageHealthPanel } from "../src/components/StorageHealthPanel";

/**
 * P1 — apresentação da saúde física no PC Center (teste de componente).
 *
 * Verifica o HTML realmente renderizado, não só o helper: o Codex pediu prova
 * de que a interface distingue «Healthy» de contadores SMART indisponíveis.
 */

const disco = (over: Record<string, unknown> = {}) => ({
  deviceId: "2",
  model: "SAMSUNG MZVLB1T0HALR-00000",
  mediaType: "ssd" as const,
  busType: "NVMe",
  sizeGb: 953.9,
  healthStatus: "healthy" as const,
  operationalStatus: "OK",
  temperatureC: 41,
  wearPercent: 7,
  powerOnHours: 12345,
  readErrorsTotal: 0,
  readErrorsUncorrected: 0,
  writeErrorsTotal: 2,
  writeErrorsUncorrected: 0,
  countersStatus: "available" as const,
  countersDetail: null,
  ...over,
});

const snapshot = (over: Partial<DiskSnapshot> = {}): DiskSnapshot =>
  ({
    readStatus: "ok",
    reason: null,
    lastGoodAt: null,
    volumes: [],
    primary: null,
    usagePercent: null,
    usedGb: null,
    totalGb: null,
    fsType: "ntfs",
    ...over,
  }) as DiskSnapshot;

const render = (
  disk: DiskSnapshot | null,
  nowMs?: number,
  mode?: "full" | "summary" | "details",
) => renderToStaticMarkup(createElement(StorageHealthPanel, { disk, nowMs, mode }));

const AGORA = Date.parse("2026-10-23T01:10:00.000Z");

describe("PC Center: painel de saúde física (componente)", () => {
  it("mostra modelo, tipo, capacidade, saúde do Windows e contadores", () => {
    const html = render(
      snapshot({
        physical: [disco()],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.match(html, /SAMSUNG MZVLB1T0HALR-00000/);
    assert.match(html, /SSD · NVMe · 953,9 GB/);
    assert.match(html, /Windows: saudável/);
    assert.match(html, /Contadores de fiabilidade: disponíveis/);
    assert.match(html, /Temperatura: 41 °C/);
    assert.match(html, /Desgaste: 7%/);
    assert.match(html, /Horas de utilização: 12345 h/);
    assert.match(html, /Última leitura há 30 s/);
  });

  it("Healthy do Windows com contadores indisponíveis NÃO parece tudo bem", () => {
    const html = render(
      snapshot({
        physical: [disco({ wearPercent: null, temperatureC: null, powerOnHours: null, countersStatus: "unsupported", countersDetail: null })],
        physicalStatus: "unsupported",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.match(html, /Windows: saudável/, "o estado do Windows continua visível");
    assert.match(html, /Contadores SMART não suportados/);
    assert.match(html, /Contadores de fiabilidade: não suportados/);
    assert.doesNotMatch(html, /Desgaste:/, "não se mostra desgaste sem leitura");
    assert.doesNotMatch(html, /0%/, "nunca 0% inventado");
  });

  it("sem permissões: diz «Sem permissões» e não mostra números", () => {
    const html = render(
      snapshot({
        physical: [disco({ temperatureC: null, wearPercent: null, powerOnHours: null, countersStatus: "denied", countersDetail: "Exige elevação." })],
        physicalStatus: "denied",
        physicalDetail: "O Windows exige elevação para ler os contadores de fiabilidade.",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.match(html, /Sem permissões para contadores SMART/);
    // O aviso global de `denied` já foi dado uma vez: não se repete por disco,
    // nem na linha de contadores nem na nota de detalhe.
    assert.doesNotMatch(html, /Contadores de fiabilidade: sem permissões/);
    assert.doesNotMatch(html, /Sem permissões para ler temperatura, desgaste e horas/);
    assert.doesNotMatch(html, /Temperatura:/);
  });

  it("suporte parcial é dito com o número real", () => {
    const html = render(
      snapshot({
        physical: [disco(), disco({ deviceId: "0", model: "SAMSUNG HD642JJ", mediaType: "unknown", countersStatus: "unsupported" })],
        physicalStatus: "partial",
        physicalDetail: "Suporte parcial: 1 de 2 discos expõem contadores de fiabilidade.",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.match(html, /Contadores SMART parciais/);
    assert.match(html, /1 de 2 discos/);
    assert.match(html, /Tipo não reportado/, "HDD \"Unspecified\" não é adivinhado");
  });

  it("dados expirados são anunciados sem fabricar leitura nova", () => {
    const html = render(
      snapshot({
        physical: [disco()],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:00:00.000Z",
        physicalStale: true,
      }),
      AGORA,
    );
    assert.match(html, /Dados expirados/);
    assert.match(html, /Última leitura há 10 min/);
  });

  it("erro da última tentativa aparece sem apagar os valores anteriores", () => {
    const html = render(
      snapshot({
        physical: [disco()],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:00:00.000Z",
        physicalStale: true,
        physicalErrorDetail: "O serviço de armazenamento não respondeu.",
      }),
      AGORA,
    );
    assert.match(html, /O serviço de armazenamento não respondeu/);
    assert.match(html, /Temperatura: 41 °C/);
  });

  it("sem leitura nenhuma: estado honesto, sem disco inventado", () => {
    const html = render(snapshot(), AGORA);
    assert.match(html, /Saúde física indisponível/);
    assert.match(html, /Ainda não há leitura da saúde física dos discos/);
    assert.doesNotMatch(html, /Windows:/);
  });

  it("disco sem modelo usa o identificador em vez de um nome falso", () => {
    const html = render(
      snapshot({
        physical: [disco({ model: "", sizeGb: null, busType: null })],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.match(html, /Disco 2/);
    assert.match(html, /Capacidade não reportada/);
  });

  it("detalhes ficam dentro de <details>, com o resumo sempre visível", () => {
    const html = render(
      snapshot({
        physical: [disco()],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.match(html, /<details[^>]*data-testid="storage-disk-details"/);
    assert.match(html, /<summary[^>]*>Detalhes<\/summary>/);
    // O resumo continua fora do bloco expansível.
    const resumo = html.slice(0, html.indexOf("<details"));
    assert.match(resumo, /SAMSUNG MZVLB1T0HALR-00000/);
    assert.match(resumo, /SSD · NVMe · 953,9 GB/);
    assert.match(resumo, /Windows: saudável/);
    assert.match(resumo, /Contadores de fiabilidade: disponíveis/);
    // As leituras e motivos estão no detalhe.
    assert.match(html.slice(html.indexOf("<details")), /Temperatura: 41 °C/);
    assert.match(html.slice(html.indexOf("<details")), /Desgaste: 7%/);
    assert.match(html.slice(html.indexOf("<details")), /Horas de utilização: 12345 h/);
  });

  it("global denied é dito uma vez; o disco só repete se diferir", () => {
    const html = render(
      snapshot({
        physical: [
          disco({ deviceId: "2", countersStatus: "denied" }),
          disco({ deviceId: "3", model: "S3SSDC512", countersStatus: "available" }),
        ],
        physicalStatus: "denied",
        physicalDetail: "O Windows exige elevação para ler os contadores de fiabilidade.",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.equal((html.match(/Sem permissões para contadores SMART/g) ?? []).length, 1);
    assert.equal((html.match(/Contadores de fiabilidade: sem permissões/g) ?? []).length, 0);
    // O disco que difere continua a declarar o seu estado real.
    assert.match(html, /Contadores de fiabilidade: disponíveis/);
  });

  it("estado Windows desconhecido não é escondido", () => {
    const html = render(
      snapshot({
        physical: [disco({ healthStatus: "unknown" })],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.match(html, /Windows: desconhecido/);
  });

  it("ocupação e espaço livre ficam separados quando o contrato não liga volume a disco", () => {
    const html = render(
      snapshot({
        volumes: [
          {
            mount: "C:",
            fileSystem: "NTFS",
            totalGb: 952.9,
            usedGb: 846.1,
            freeGb: 106.8,
            usagePercent: 88.8,
            kind: "working",
            readOnly: false,
          },
        ],
        physical: [disco()],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.match(html, /storage-occupation-note/);
    assert.match(html, /não associa cada volume a um disco físico/);
    // Nenhuma associação inventada: o painel não mostra espaço livre por disco.
    assert.doesNotMatch(html, /SAMSUNG[\s\S]{0,200}106,8 GB/);
  });

  it("sem volumes não se inventa uma nota de ocupação", () => {
    const html = render(
      snapshot({
        physical: [disco()],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
    );
    assert.doesNotMatch(html, /storage-occupation-note/);
  });

  it("modo resumo: compacto, com contagem de discos e sem <details>", () => {
    const html = render(
      snapshot({
        physical: [disco(), disco({ deviceId: "3", model: "S3SSDC512" })],
        physicalStatus: "partial",
        physicalDetail: "Suporte parcial: 1 de 2 discos expõem contadores.",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
      "summary",
    );
    assert.match(html, /data-mode="summary"/);
    assert.match(html, /2 discos físicos/);
    assert.match(html, /Contadores SMART parciais/);
    assert.match(html, /Windows: saudável \(2\)/);
    assert.match(html, /Última leitura há 30 s/);
    assert.doesNotMatch(html, /<details/, "o resumo não pode trazer os detalhes expansíveis");
    assert.doesNotMatch(html, /Temperatura: 41 °C/, "as leituras ficam na superfície de detalhes");
    assert.doesNotMatch(html, /SAMSUNG|SSD · NVMe|S3SSDC512/, "o resumo agregado não lista cada disco");
  });

  it("resumo agregado alerta heterogeneidade sem perder o estado geral", () => {
    const html = render(
      snapshot({
        physical: [
          disco(),
          disco({
            deviceId: "3",
            model: "S3SSDC512",
            healthStatus: "unknown",
            countersStatus: "denied",
            countersDetail: "Exige elevação.",
          }),
        ],
        physicalStatus: "partial",
        physicalDetail: "Suporte parcial: 1 de 2 discos expõem contadores.",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
      "summary",
    );
    assert.match(html, /Contadores SMART parciais/);
    assert.match(html, /Windows: saudável \(1\) · desconhecido \(1\)/);
    assert.match(html, /Estados diferentes por disco/);
    assert.match(html, /Suporte parcial: 1 de 2 discos/);
    assert.doesNotMatch(html, /SAMSUNG|S3SSDC512/, "a identificação por disco fica nos detalhes");
  });

  it("modo detalhes: leituras reais fora do resumo, sem inventar valores", () => {
    const html = render(
      snapshot({
        physical: [disco()],
        physicalStatus: "available",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
      "details",
    );
    assert.match(html, /data-mode="details"/);
    assert.match(html, /<div[^>]*data-testid="storage-disk-details"/, "a superfície exterior já é a divulgação");
    assert.doesNotMatch(html, /<details/, "não se pede um segundo clique por disco");
    assert.match(html, /SAMSUNG MZVLB1T0HALR-00000/);
    assert.match(html, /SSD · NVMe · 953,9 GB/);
    assert.match(html, /Windows: saudável/);
    assert.match(html, /Contadores de fiabilidade: disponíveis/);
    assert.match(html, /Temperatura: 41 °C/);
    assert.match(html, /Desgaste: 7%/);
    assert.doesNotMatch(html, /0%/, "nenhum contador em falta vira 0%");
  });

  it("modo detalhes preserva stale, erro e o motivo por disco", () => {
    const html = render(
      snapshot({
        physical: [disco({ countersStatus: "unsupported", countersDetail: null })],
        physicalStatus: "unsupported",
        physicalUpdatedAt: "2026-10-23T01:00:00.000Z",
        physicalStale: true,
        physicalErrorDetail: "O serviço de armazenamento não respondeu.",
      }),
      AGORA,
      "details",
    );
    assert.match(html, /Dados expirados/);
    assert.match(html, /O serviço de armazenamento não respondeu/);
    assert.match(html, /Este disco não expõe temperatura, desgaste nem horas/);
    assert.doesNotMatch(html, /Temperatura:/);
  });

  it("modo detalhes identifica TODOS os discos mesmo com denied global e sem leituras", () => {
    const html = render(
      snapshot({
        physical: [
          disco({
            deviceId: "2",
            countersStatus: "denied",
            countersDetail: "Exige elevação.",
            temperatureC: null,
            wearPercent: null,
            powerOnHours: null,
            readErrorsTotal: null,
            writeErrorsTotal: null,
          }),
          disco({
            deviceId: "3",
            model: "S3SSDC512",
            mediaType: "hdd",
            busType: null,
            sizeGb: 512,
            healthStatus: "warning",
            countersStatus: "denied",
            countersDetail: "Exige elevação.",
            temperatureC: null,
            wearPercent: null,
            powerOnHours: null,
            readErrorsTotal: null,
            writeErrorsTotal: null,
          }),
        ],
        physicalStatus: "denied",
        physicalDetail: "O Windows exige elevação para ler os contadores de fiabilidade.",
        physicalUpdatedAt: "2026-10-23T01:09:30.000Z",
      }),
      AGORA,
      "details",
    );
    // Identificação individual completa, mesmo sem nenhuma leitura própria.
    assert.match(html, /SAMSUNG MZVLB1T0HALR-00000/);
    assert.match(html, /SSD · NVMe · 953,9 GB/);
    assert.match(html, /Windows: saudável/);
    assert.match(html, /S3SSDC512/);
    assert.match(html, /HDD · 512 GB/);
    assert.match(html, /Windows: aviso/);
    assert.equal((html.match(/data-testid="storage-disk-details"/g) ?? []).length, 2);
    assert.equal((html.match(/data-testid="storage-disk-subtitle"/g) ?? []).length, 2);
    // O aviso global é dito uma vez e não se transforma em contadores por disco.
    assert.equal((html.match(/Sem permissões para contadores SMART/g) ?? []).length, 1);
    assert.doesNotMatch(html, /Contadores de fiabilidade: sem permissões/);
    assert.doesNotMatch(html, /Sem permissões para ler temperatura, desgaste e horas/);
    assert.doesNotMatch(html, /data-testid="storage-disk-counters"/);
    // Nenhum valor inventado e sem segundo <details>.
    assert.doesNotMatch(html, /Temperatura:|Desgaste:|Horas de utilização:|Erros de leitura:|Erros de escrita:/);
    assert.doesNotMatch(html, /\b0%/);
    // QA3: per-disk metrics still need no second disclosure; raw diagnostics
    // now require an explicit action even inside the independent surface.
    assert.doesNotMatch(html, /<details[^>]*data-testid="storage-disk-details"/);
    assert.match(html, /data-testid="technical-diagnostic"/);
    assert.doesNotMatch(html, /<details[^>]* open/);
  });
});
