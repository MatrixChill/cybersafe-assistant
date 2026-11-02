import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DiskSnapshot, DiskVolumeSnapshot } from "@cybersafe/shared-types";
import { diskVolumeScanActions } from "../src/lib/diskDisplay";

/**
 * «Analisar este volume» — quando é que a linha da lista de montagens pode
 * ter botão.
 *
 * O §10 do Linux Lite pede «permitir selecionar um volume montado e analisá-lo
 * com os motores disponíveis». A lista já chega correta ao `DiskSnapshot`
 * (montes reais, sem letras inventadas); o que estava em falta era o gesto.
 * Um gesto destes só tem uma maneira de ser mentira: existir na tela e não
 * produzir análise — ou produzir análise sobre um caminho que já não existe.
 *
 * Por isso as réguas são duas e independentes:
 *   1. **plataforma com alvo por montagem** — só Linux neste corte; em Windows
 *      não há medição nenhuma do alvo por volume e o produto já tem o diálogo
 *      de pastas, logo nenhuma linha leva botão;
 *   2. **a lista é uma medição de agora** — `readStatus !== "ok"` significa que
 *      o ponto de montagem pode ter desaparecido desde a última leitura, e
 *      oferecer análise aí é prometer trabalho que o motor não pode fazer.
 *
 * O `platform` é o valor PUBLICADO pelo serviço (`hardware.system.platform`,
 * que vem de `osInfo().platform`: "linux" / "Windows"), não um `process.platform`
 * do renderer — o Electron isolado não o tem — nem um palpite pelo formato do
 * caminho.
 */

const volume = (overrides: Partial<DiskVolumeSnapshot> = {}): DiskVolumeSnapshot => ({
  mount: "/mnt/c",
  fileSystem: "9p",
  totalGb: 952.9,
  usedGb: 846.1,
  freeGb: 106.8,
  usagePercent: 88.8,
  kind: "working",
  readOnly: false,
  ...overrides,
});

const disco = (
  volumes: DiskVolumeSnapshot[],
  readStatus: DiskSnapshot["readStatus"] = "ok",
): DiskSnapshot => ({
  readStatus,
  reason: readStatus === "ok" ? null : "falha de leitura",
  lastGoodAt: "2026-11-02T10:00:00.000Z",
  volumes,
  primary: volumes[0] ?? null,
  usagePercent: readStatus === "ok" ? 88.8 : null,
  usedGb: readStatus === "ok" ? 846.1 : null,
  totalGb: readStatus === "ok" ? 952.9 : null,
  freeGb: readStatus === "ok" ? 106.8 : null,
} as DiskSnapshot);

describe("diskVolumeScanActions: a linha só tem botão quando a análise é realizável", () => {
  test("Linux, leitura de agora, volume de trabalho: há análise e sem motivo", () => {
    const [acao] = diskVolumeScanActions(disco([volume()]), "linux");
    assert.equal(acao?.podeAnalisar, true);
    assert.equal(acao?.motivo, null);
    assert.equal(acao?.mount, "/mnt/c");
  });

  test("Windows não é Linux Lite: nenhuma linha leva botão (contrato preservado)", () => {
    const disk = disco([volume({ mount: "C:", fileSystem: "NTFS" }), volume({ mount: "D:" })]);
    const acoes = diskVolumeScanActions(disk, "Windows");
    assert.equal(acoes.length, 2);
    for (const acao of acoes) {
      assert.equal(acao.podeAnalisar, false);
      assert.ok(acao.motivo, "sem botão há-de haver porquê");
    }
  });

  test("plataforma em falta é desconhecida, não é Linux", () => {
    for (const platform of [null, undefined, "unknown", "", "Linux"]) {
      const [acao] = diskVolumeScanActions(disco([volume()]), platform);
      assert.equal(acao?.podeAnalisar, false, `platform ${JSON.stringify(platform)}`);
    }
  });

  test("leitura desatualizada: sem botão, com motivo que diz que não há medição nova", () => {
    const [acao] = diskVolumeScanActions(disco([volume()], "stale"), "linux");
    assert.equal(acao?.podeAnalisar, false);
    assert.match(acao?.motivo ?? "", /desatualiz|última leitura/);
  });

  test("leitura indisponível: idem — e não se aproveita o volume fantasma da lista", () => {
    const [acao] = diskVolumeScanActions(disco([volume()], "unavailable"), "linux");
    assert.equal(acao?.podeAnalisar, false);
    assert.match(acao?.motivo ?? "", /sem leitura/);
  });

  test("partição de sistema não é volume de análise", () => {
    const [acao] = diskVolumeScanActions(
      disco([volume({ mount: "/mnt/d", kind: "system-reserved", totalGb: 0.05 })]),
      "linux",
    );
    assert.equal(acao?.podeAnalisar, false);
    assert.match(acao?.motivo ?? "", /sistema/);
  });

  test("montagem sem caminho absoluto não se envia ao motor", () => {
    for (const mount of ["", "mnt/c", "C:", "  /mnt/c"]) {
      const [acao] = diskVolumeScanActions(disco([volume({ mount })]), "linux");
      assert.equal(acao?.podeAnalisar, false, `mount ${JSON.stringify(mount)}`);
      assert.match(acao?.motivo ?? "", /absoluto/);
    }
  });

  test("volume só-leitura CONTINUA analisável: ler não é escrever", () => {
    // O alarme de pouco espaço exclui `ro` porque manda «libertar espaço» — o
    // texto é que é inexecutável, não a leitura. Um scanner não escreve no
    // alvo, logo um espelho só-leitura (o `/usr/lib/wsl/drivers` do WSL, um
    // DVD montado em Windows) é alvo legítimo.
    const [acao] = diskVolumeScanActions(
      disco([volume({ mount: "/usr/lib/wsl/drivers", readOnly: true })]),
      "linux",
    );
    assert.equal(acao?.podeAnalisar, true);
  });

  test("a ordem e o número de linhas preservam a lista publicada", () => {
    const disk = disco([
      volume({ mount: "/" }),
      volume({ mount: "/mnt/c", readOnly: false }),
      volume({ mount: "/mnt/wslg/distro", kind: "system-reserved" }),
    ]);
    const acoes = diskVolumeScanActions(disk, "linux");
    assert.deepEqual(
      acoes.map((a) => a.mount),
      ["/", "/mnt/c", "/mnt/wslg/distro"],
    );
    assert.deepEqual(
      acoes.map((a) => a.podeAnalisar),
      [true, true, false],
    );
  });

  test("lista vazia devolve lista vazia (sem leitura não há volumes, e não há botões)", () => {
    assert.deepEqual(diskVolumeScanActions(disco([], "unavailable"), "linux"), []);
  });
});
