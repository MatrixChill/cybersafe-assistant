/**
 * Apresentação da atividade medida de armazenamento.
 *
 * O motor já media e publicava velocidades por volume (PDH, mesma fonte do
 * Monitor de Recursos) e nenhuma superfície as mostrava: os números existiam no
 * contrato e morriam no snapshot. Este ficheiro fixa as regras dessa
 * apresentação ANTES de ela existir no ecrã — sobretudo a distinção que o
 * requisito §1 exige entre «0 B/s medido» (um volume descansado) e «sem
 * leitura» (contador indisponível), porque pintar os dois com o mesmo `0` é
 * precisamente o tipo de indicador que parece funcional e não é.
 *
 * FIXTURES: valores de teste; as leituras reais desta máquina estão na entrega.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DiskActivityReading, DiskSnapshot } from "@cybersafe/shared-types";
import {
  DISK_AGGREGADO_ROTULO,
  DISK_ATIVIDADE_FONTE,
  DISK_TEXTO_SEM_LEITURA,
  diskActivityRows,
  diskAtividadeIndisponivelTexto,
  diskAtividadeResumo,
  formatOperacoesDisco,
  formatPercentagemDisco,
  formatTaxaDiscos,
} from "../src/lib/diskActivityDisplay";

const leitura = (parcial: Partial<DiskActivityReading> & { mount: string | null }): DiskActivityReading => ({
  device: null,
  readBytesPerSec: null,
  writeBytesPerSec: null,
  readsPerSec: null,
  writesPerSec: null,
  idlePercent: null,
  status: "available",
  source: `PDH LogicalDisk(${parcial.mount ?? "_Total"})`,
  ...parcial,
});

const disco = (atividade: DiskActivityReading[], estado: string, detalhe: string | null = null): DiskSnapshot =>
  ({ activity: atividade, activityStatus: estado, activityDetail: detalhe }) as unknown as DiskSnapshot;

describe("PC Center — atividade de disco", () => {
  test("taxas: unidade binária, vírgula decimal PT e traço quando não medido", () => {
    assert.equal(formatTaxaDiscos(0), "0 B/s", "zero medido é um número, não uma ausência");
    assert.equal(formatTaxaDiscos(98), "98 B/s");
    assert.equal(formatTaxaDiscos(1024), "1 KB/s");
    assert.equal(formatTaxaDiscos(1536), "1,5 KB/s");
    assert.equal(formatTaxaDiscos(11_264), "11 KB/s");
    assert.equal(formatTaxaDiscos(1024 ** 2), "1 MB/s");
    assert.equal(formatTaxaDiscos(2 * 1024 ** 3), "2 GB/s");
    assert.equal(formatTaxaDiscos(-5), "0 B/s", "contra-valores não desenham taxas negativas");
    assert.equal(formatTaxaDiscos(null), DISK_TEXTO_SEM_LEITURA);
    assert.equal(formatTaxaDiscos(Number.NaN), DISK_TEXTO_SEM_LEITURA);
    assert.equal(formatOperacoesDisco(66), "66 ops/s");
    assert.equal(formatOperacoesDisco(null), DISK_TEXTO_SEM_LEITURA);
    assert.equal(formatPercentagemDisco(99.75), "99,8 %");
    assert.equal(formatPercentagemDisco(null), DISK_TEXTO_SEM_LEITURA);
  });

  test("linhas: volumes por ordem e o agregado por último, identificado como agregado", () => {
    const linhas = diskActivityRows(
      disco([
        leitura({ mount: null, readBytesPerSec: 98, writeBytesPerSec: 11_264 }),
        leitura({ mount: "F:", readBytesPerSec: 0, writeBytesPerSec: 0 }),
        leitura({ mount: "C:", readBytesPerSec: 11_264, writeBytesPerSec: 770_048, idlePercent: 99.75 }),
      ], "available"),
    );
    assert.deepEqual(linhas.map((l) => l.rotulo), ["C:", "F:", DISK_AGGREGADO_ROTULO]);
    assert.equal(linhas[0].leituraTexto, "11 KB/s");
    assert.equal(linhas[0].escritaTexto, "752 KB/s");
    assert.equal(linhas[0].tempoOciosoTexto, "99,8 %");
    assert.equal(linhas[1].leituraTexto, "0 B/s", "volume sem tráfego mostra o zero medido");
    assert.equal(linhas[2].agregado, true);
    assert.equal(linhas[2].tempoOcioso, null, "sem idle medido não se inventa percentagem");
    assert.match(linhas[0].fonte, /^PDH LogicalDisk\(C:\)$/);
  });

  test("linha não medida nunca herda um zero: as quatro colunas vão para traço", () => {
    const [linha] = diskActivityRows(
      disco([leitura({
        mount: "C:",
        readBytesPerSec: null,
        writeBytesPerSec: null,
        readsPerSec: null,
        writesPerSec: null,
        idlePercent: null,
        status: "unavailable",
      })], "available"),
    );
    assert.equal(linha.leituraTexto, DISK_TEXTO_SEM_LEITURA);
    assert.equal(linha.escritaTexto, DISK_TEXTO_SEM_LEITURA);
    assert.equal(linha.operacoesEscritaTexto, DISK_TEXTO_SEM_LEITURA);
    assert.equal(linha.tempoOciosoTexto, DISK_TEXTO_SEM_LEITURA);
    assert.equal(linha.estado, "unavailable");
  });

  test("estado da aquisição manda: sem `available` não há linhas, logo não há números velhos", () => {
    const medida = disco([leitura({ mount: "C:", readBytesPerSec: 11_264, writeBytesPerSec: 0 })], "available");
    assert.equal(diskActivityRows(medida).length, 1);
    const parada = disco([leitura({ mount: "C:", readBytesPerSec: 11_264, writeBytesPerSec: 0 })], "unavailable", "contadores PDH sem intervalo medido ainda");
    assert.deepEqual(diskActivityRows(parada), []);
    assert.deepEqual(diskActivityRows(disco([], "unavailable", null)), []);
    assert.deepEqual(diskActivityRows(null), [], "snapshot ausente não rebenta a vista");
  });

  test("os três motivos de indisponibilidade dizem coisas diferentes", () => {
    assert.match(
      diskAtividadeIndisponivelTexto(disco([], "unavailable", "contadores PDH sem intervalo medido ainda")),
      /A medir — os contadores de taxa precisam de duas amostras/,
    );
    assert.match(
      diskAtividadeIndisponivelTexto(disco([], "unavailable", "ffi-indisponivel:koffi em falta")),
      /Sem contadores de desempenho nativos nesta máquina \(ffi-indisponivel:koffi em falta\)/,
    );
    assert.match(
      diskAtividadeIndisponivelTexto(disco([], "unavailable", "nenhum contador LogicalDisk disponível")),
      /Nenhum contador de disco acessível nesta máquina/,
    );
    assert.match(
      diskAtividadeIndisponivelTexto(disco([], "unavailable", "nenhuma instância de disco pedida")),
      /Sem atividade de disco medida \(nenhuma instância de disco pedida\)/,
    );
    assert.equal(diskAtividadeIndisponivelTexto(disco([], "unavailable", null)), "Sem atividade de disco medida.");
    assert.equal(diskAtividadeIndisponivelTexto(null), "Sem atividade de disco medida.");
  });

  test("resumo compacto usa o agregado quando existe", () => {
    assert.equal(
      diskAtividadeResumo(disco([
        leitura({ mount: "C:", readBytesPerSec: 11_264, writeBytesPerSec: 770_048 }),
        leitura({ mount: null, readBytesPerSec: 98, writeBytesPerSec: 770_048 }),
      ], "available")),
      "↓ 98 B/s · ↑ 752 KB/s",
    );
    assert.equal(diskAtividadeResumo(disco([leitura({ mount: "C:", readBytesPerSec: 11_264, writeBytesPerSec: 0 })], "available")), "↓ 11 KB/s · ↑ 0 B/s");
    assert.equal(diskAtividadeResumo(disco([], "unavailable")), null);
    assert.match(DISK_ATIVIDADE_FONTE, /Monitor de Recursos/);
  });
});
