/**
 * P3-LINUX — o gesto «Analisar» do PC Center, provado no markup.
 *
 * A regra vive em `diskVolumeScanActions`; este ficheiro prova que o cartão a
 * respeita: uma linha Linux medida agora ganha o botão, e nenhuma das recusas
 * (Windows, sem leitura fresca, partição de sistema, sem callback) imprime um
 * botão que não faria nada. Renderizar o cartão em vez da página inteira é
 * preciso porque o PC Center abre na «Visão Simples», onde não há lista de
 * volumes — não porque o componente seja privado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiskSnapshot, DiskVolumeSnapshot } from "@cybersafe/shared-types";
import { StorageCard } from "../src/pages/PCCenterPage";

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const agora = new Date("2026-11-02T09:00:00.000Z").toISOString();

function volume(over: Partial<DiskVolumeSnapshot> & { mount: string }): DiskVolumeSnapshot {
  return {
    fileSystem: "ext4",
    totalGb: 460,
    usedGb: 100,
    freeGb: 360,
    usagePercent: 21.7,
    kind: "working",
    readOnly: false,
    ...over,
  };
}

function disco(volumes: DiskVolumeSnapshot[], readStatus: DiskSnapshot["readStatus"] = "ok"): DiskSnapshot {
  return {
    readStatus,
    reason: readStatus === "ok" ? null : "sem leitura",
    lastGoodAt: agora,
    volumes,
    primary: volumes[0] ?? null,
    usagePercent: volumes.length ? volumes[0].usagePercent : null,
    usedGb: volumes.length ? volumes[0].usedGb : null,
    totalGb: volumes.length ? volumes[0].totalGb : null,
  } as unknown as DiskSnapshot;
}

const Botao = 'data-testid="disk-volume-analisar"';
const contar = (html: string) => html.split(Botao).length - 1;

const naoUsa = () => {
  throw new Error("o markup não pode invadir o callback");
};

test("Linux com medição de agora: cada volume de trabalho tem o seu botão", () => {
  const html = renderToStaticMarkup(
    createElement(StorageCard, {
      disk: disco([volume({ mount: "/" }), volume({ mount: "/mnt/usb" })]),
      platform: "linux",
      onAnalisarVolume: naoUsa,
    }),
  );
  assert.equal(contar(html), 2, `esperava dois botões, obtive ${contar(html)}`);
  assert.match(html, /Analisar \/mnt\/usb com os motores disponíveis/);
  assert.match(html, /Analisar \/ com os motores disponíveis/);
});

test("Windows: nenhuma linha recebe botão", () => {
  const html = renderToStaticMarkup(
    createElement(StorageCard, {
      disk: disco([volume({ mount: "C:", fileSystem: "NTFS" }), volume({ mount: "D:", fileSystem: "NTFS" })]),
      platform: "Windows",
      onAnalisarVolume: naoUsa,
    }),
  );
  assert.equal(contar(html), 0, "o Linux Lite não põe botões no PC Center do Windows");
});

test("sem callback não há botão: a página não oferece o que ninguém processa", () => {
  const html = renderToStaticMarkup(
    createElement(StorageCard, { disk: disco([volume({ mount: "/mnt/usb" })]), platform: "linux" }),
  );
  assert.equal(contar(html), 0);
});

test("leitura stale ou indisponível não oferece análise", () => {
  for (const readStatus of ["stale", "unavailable"] as const) {
    const html = renderToStaticMarkup(
      createElement(StorageCard, {
        disk: disco([volume({ mount: "/mnt/usb" })], readStatus),
        platform: "linux",
        onAnalisarVolume: naoUsa,
      }),
    );
    assert.equal(contar(html), 0, `${readStatus} não é medição de agora`);
  }
});

test("partição de sistema fica de fora; o volume de trabalho ao lado mantém o botão", () => {
  const html = renderToStaticMarkup(
    createElement(StorageCard, {
      disk: disco([
        volume({ mount: "/boot/efi", kind: "system-reserved", fileSystem: "vfat" }),
        volume({ mount: "/mnt/usb" }),
      ]),
      platform: "linux",
      onAnalisarVolume: naoUsa,
    }),
  );
  assert.equal(contar(html), 1, "só o volume de trabalho é oferecido como alvo");
});

test("montagem read-only continua analisável: ler não é escrever", () => {
  const html = renderToStaticMarkup(
    createElement(StorageCard, {
      disk: disco([volume({ mount: "/mnt/usb", readOnly: true })]),
      platform: "linux",
      onAnalisarVolume: naoUsa,
    }),
  );
  assert.equal(contar(html), 1);
});
