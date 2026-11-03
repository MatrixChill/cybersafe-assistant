import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { HardwareHealthEngine } from "../dist/hardware.js";
import { lerMontagensPosix } from "../dist/mounts-posix.js";

/**
 * P3 ARMAZENAMENTO / LIGACÃO — em Linux o PC Center tem de ler a tabela de
 * montagens do kernel, não `si.fsSize()`.
 *
 * Porque este teste existe (medido em WSL2, 2026-11-02): `si.fsSize()` FUNCIONA
 * em Linux — 10 entradas em 1055 ms — mas as entradas são as erradas: um volume
 * por MONTAGEM em vez de um por sistema de ficheiros (o mesmo 9p `C:\134` sai
 * como `/mnt/c` E como `/usr/lib/wsl/drivers`; o mesmo `overlay` sai quatro
 * vezes), `overlay` conta como disco, e `/mnt/d` — um leitor de cartões sem
 * cartão — vem como «0 GB, 64% usado». Além disso não há `major:minor`, portanto
 * nada diz que duas linhas são o mesmo disco.
 *
 * O que é provado aqui, e nada mais:
 *  1. com `process.platform === "linux"` o motor CONSOME a fonte POSIX (a
 *     sequência de montagens publicada é a da tabela, não a do sistema real);
 *  2. o volume principal em Linux é `/`, não o mais cheio (`/mnt/c`);
 *  3. um volume só-leitura não gera o alarme de «pouco espaço», porque a
 *     recomendação («apague ficheiros neste volume») é inexecutável nele.
 *
 * A leitura do SO não é tocada: `lerMontagens()` é o mesmo tipo de seam que
 * `pollDiskActivity()`, e por isso este teste corre em Windows, em WSL2 e num
 * contentor sem disco nenhum.
 */

const GiB = 1024 ** 3;

/** Excerto REAL de `/proc/self/mountinfo` de WSL2 (40 linhas → as 9 que importam). */
const MOUNTINFO = [
  "77 80 0:34 / /usr/lib/wsl/drivers ro,nosuid,nodev,noatime - 9p drivers ro,aname=drivers;fmask=222,cache=5",
  "80 65 8:48 / / rw,relatime - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered",
  "82 81 8:48 / /mnt/wslg/distro ro,relatime shared:3 - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered",
  "110 80 0:5 / /dev rw,nosuid,relatime shared:14 - devtmpfs none rw,size=7892104k",
  "112 80 0:59 / /proc rw,nosuid,nodev,noexec,noatime shared:16 - proc proc rw",
  "120 111 0:23 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:23 - cgroup2 cgroup2 rw,nsdelegate",
  "132 80 0:70 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000;gid=1000,cache=5",
  "133 80 0:71 / /mnt/d rw,noatime - 9p D:\\134 rw,aname=drvfs;path=D:\\;uid=1000;gid=1000,cache=5",
  "144 80 0:79 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw,size=7897116k",
].join("\n");

/** As capacidades medidas no mesmo apontamento (`/mnt/d` = leitor vazio). */
const MEDICOES = {
  "/": { bsize: 4096, blocks: (1007 * GiB) / 4096, bfree: (991 * GiB) / 4096, bavail: (940 * GiB) / 4096 },
  "/mnt/c": { bsize: 4096, blocks: (953 * GiB) / 4096, bfree: (147 * GiB) / 4096, bavail: (147 * GiB) / 4096 },
  "/usr/lib/wsl/drivers": { bsize: 4096, blocks: (953 * GiB) / 4096, bfree: (147 * GiB) / 4096, bavail: (147 * GiB) / 4096 },
  "/mnt/d": { bsize: 4096, blocks: 0, bfree: 0, bavail: 0 },
};

const comPlataforma = async (plataforma, corpo) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: plataforma, configurable: true });
  try {
    return await corpo();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
};

class MotorComMontagens extends HardwareHealthEngine {
  constructor(montagens) {
    super();
    this.montagensFalsas = montagens;
    this.chamadas = 0;
  }

  lerMontagens() {
    this.chamadas += 1;
    return lerMontagensPosix({
      readFileSync: () => this.montagensFalsas,
      statfsSync: (caminho) => MEDICOES[caminho] ?? null,
    });
  }
}

describe("armazenamento em Linux — o motor consome a tabela de montagens", () => {
  test("a lista publicada vem de `mountinfo`: sem duplicados, sem `/mnt/d`, sem pseudo-fs", async () => {
    await comPlataforma("linux", async () => {
      const engine = new MotorComMontagens(MOUNTINFO);
      const snap = await engine.getSnapshot([]);

      assert.equal(snap.disk.readStatus, "ok", `falhou: ${snap.disk.reason}`);
      assert.equal(engine.chamadas >= 1, true, "a fonte POSIX não foi consultada");
      assert.deepEqual(
        snap.disk.volumes.map((volume) => volume.mount).sort(),
        ["/", "/mnt/c", "/usr/lib/wsl/drivers"],
        "só os três sistemas de ficheiros reais, um por `major:minor` (a ordem é por ocupação, não aqui o contrato)",
      );
      // A tabela real reporta `/mnt/wslg/distro` como OUTRO ponto do MESMO
      // `8:48`: é uma montagem do mesmo disco, não um disco novo.
      assert.equal(
        snap.disk.volumes.some((volume) => volume.mount === "/mnt/wslg/distro"),
        false,
        "o mesmo sistema de ficheiros não pode aparecer duas vezes",
      );
      assert.equal(snap.disk.volumes.some((volume) => volume.mount === "/mnt/d"), false, "leitor vazio não é disco");
      assert.equal(snap.disk.volumes.every((volume) => !["tmpfs", "proc", "cgroup2", "devtmpfs"].includes(volume.fileSystem)), true);

      const raiz = snap.disk.volumes.find((volume) => volume.mount === "/");
      // O espaço livre publicado é o UTILIZÁVEL (`bavail`), não `bfree`: nesta
      // montagem `bfree` era 991 GiB e `bavail` 940 GiB — a diferença é a
      // reserva de root, que o utilizador não pode ocupar.
      assert.equal(raiz.freeGb, 940, `esperado 940 GB utilizáveis, veio ${raiz.freeGb}`);
    });
  });

  test("o volume principal em Linux é `/`, e a leitura boa não traz motivo de falha", async () => {
    await comPlataforma("linux", async () => {
      const snap = await new MotorComMontagens(MOUNTINFO).getSnapshot([]);
      assert.equal(snap.disk.primary?.mount, "/", "o mais cheio (`/mnt/c`, 84,6%) não é a máquina");
      assert.equal(snap.disk.usagePercent, snap.disk.primary.usagePercent);
      assert.equal(snap.disk.reason, null);
    });
  });

  test("nenhum alarme de espaço aponta para um volume só-leitura", async () => {
    await comPlataforma("linux", async () => {
      const snap = await new MotorComMontagens(MOUNTINFO).getSnapshot([]);
      const discos = snap.alerts.filter((alerta) => alerta.category === "disk");
      for (const alerta of discos) {
        assert.doesNotMatch(
          `${alerta.title} ${alerta.description} ${alerta.recommendation}`,
          /usr\/lib\/wsl\/drivers/,
          "um `ro` não pode seguir a recomendação de libertar espaço",
        );
      }
      const drivers = snap.disk.volumes.find((volume) => volume.mount === "/usr/lib/wsl/drivers");
      assert.equal(drivers.readOnly, true, "a montagem `ro` tem de chegar marcada à UI");
    });
  });

  test("sem nenhum volume utilizável o estado é `unavailable` COM motivo, nunca 0", async () => {
    // Uma máquina só com pseudo-fs (contentor sem volume próprio): a tabela é
    // legível, mas não há discos. «Não há» é diferente de «não li».
    const somentePseudo = [
      "110 80 0:5 / /dev rw,nosuid,relatime shared:14 - devtmpfs none rw,size=7892104k",
      "112 80 0:59 / /proc rw,nosuid,nodev,noexec,noatime shared:16 - proc proc rw",
      "120 111 0:23 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:23 - cgroup2 cgroup2 rw,nsdelegate",
      "144 80 0:79 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw,size=7897116k",
    ].join("\n");
    await comPlataforma("linux", async () => {
      const snap = await new MotorComMontagens(somentePseudo).getSnapshot([]);

      assert.equal(snap.disk.readStatus, "unavailable");
      assert.match(snap.disk.reason, /montagem/i, `motivo devia nomear a fonte: ${snap.disk.reason}`);
      assert.doesNotMatch(snap.disk.reason, /Windows/, "o motivo não pode culpar um serviço que não existe aqui");
      assert.equal(snap.disk.usagePercent, null, "ausência não é zero");
      assert.equal(snap.disk.totalGb, null);
    });
  });

  test("em Windows o motor não consulta a fonte POSIX", async () => {
    await comPlataforma("win32", async () => {
      const engine = new MotorComMontagens(MOUNTINFO);
      const snap = await engine.getSnapshot([]);
      assert.equal(engine.chamadas, 0, "o caminho Windows não pode tocar em /proc");
      assert.equal(snap.disk.readStatus, "ok", `leitura Windows falhou: ${snap.disk.reason}`);
    });
  });
});
