import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDiskRead, escolheMontagemPrincipal, lerMontagensPosix, parseMountinfo } from "../dist/index.js";

/**
 * Fixtures tiradas da tabela REAL de um WSL2 medido (Linux
 * 6.6.114.1-microsoft-standard-WSL2, x86_64, uid 1000): `ext4` em `/` com
 * origem `/dev/sdd`, os `9p` dos discos Windows em `/mnt/{c,d,e,f}` com origem
 * `C:\134` etc., `9p` só-leitura em `/usr/lib/wsl/drivers` e `/dev/sdd`
 * remontado em `/mnt/wslg/distro`. Reproduzível com
 * `scripts/linux-lite/wsl-p3-montes.sh`.
 */
const MOUNTINFO_WSL = [
  "76 80 0:32 / /mnt/wsl rw,relatime shared:1 - tmpfs none rw",
  "77 80 0:34 / /usr/lib/wsl/drivers ro,nosuid,nodev,noatime - 9p drivers ro,aname=drivers;fmask=222,cache=5",
  "80 65 8:48 / / rw,relatime - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered",
  "82 81 8:48 / /mnt/wslg/distro ro,relatime shared:3 - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered",
  "109 80 0:2 /init /init ro - rootfs rootfs rw,size=7892104k",
  "110 80 0:5 / /dev rw,nosuid,relatime shared:14 - devtmpfs none rw,size=7892104k",
  "111 80 0:22 / /sys rw,nosuid,nodev,noexec,noatime shared:15 - sysfs sysfs rw",
  "112 80 0:59 / /proc rw,nosuid,nodev,noexec,noatime shared:16 - proc proc rw",
  "114 80 0:61 / /run rw,nosuid,nodev shared:18 - tmpfs none rw,mode=755",
  "120 111 0:23 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:23 - cgroup2 cgroup2 rw,nsdelegate",
  "132 80 0:70 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000;gid=1000,cache=5",
  "133 80 0:71 / /mnt/d rw,noatime - 9p D:\\134 rw,aname=drvfs;path=D:\\;uid=1000;gid=1000,cache=5",
  "144 80 0:79 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw,size=7897116k",
].join("\n");

const GiB = 1024 ** 3;
const statfs = (total, livre, disponivel = livre) => ({ bsize: 4096, blocks: total / 4096, bfree: livre / 4096, bavail: disponivel / 4096 });
const fsFake = (medicoes, erroLeitura = null) => ({
  readFileSync: () => {
    if (erroLeitura) throw erroLeitura;
    return MOUNTINFO_WSL;
  },
  statfsSync: (caminho) => {
    if (!(caminho in medicoes)) return null;
    const valor = medicoes[caminho];
    if (valor instanceof Error) throw valor;
    return valor;
  },
});

test("a tabela real produce os volumes reais, sem letras de unidade no ponto de montagem", () => {
  const r = lerMontagensPosix(fsFake({
    "/": statfs(1000 * GiB, 400 * GiB, 350 * GiB),
    "/mnt/c": statfs(500 * GiB, 100 * GiB),
    "/mnt/d": statfs(500 * GiB, 250 * GiB),
    "/usr/lib/wsl/drivers": statfs(64 * GiB, 32 * GiB),
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.volumes.map((v) => v.mount).sort(),
    ["/", "/mnt/c", "/mnt/d", "/usr/lib/wsl/drivers"],
    "cada sistema de ficheiros uma vez, pelos pontos de montagem que o kernel reportou",
  );
  const c = r.volumes.find((v) => v.mount === "/mnt/c");
  assert.equal(c.fileSystem, "9p");
  assert.equal(c.source, "C:\\134", "a letra Windows é DADO de origem, nunca o mount");
  assert.equal(c.readOnly, false);
  assert.equal(r.volumes.find((v) => v.mount === "/usr/lib/wsl/drivers").readOnly, true);
});

test("o mesmo dispositivo montado em vários sítios é UM volume, com as montagens registadas", () => {
  const r = lerMontagensPosix(fsFake({
    "/": statfs(1000 * GiB, 400 * GiB, 350 * GiB),
    "/mnt/wslg/distro": statfs(1000 * GiB, 400 * GiB, 350 * GiB),
  }));
  const ext4 = r.volumes.filter((v) => v.dispositivo === "8:48");
  assert.equal(ext4.length, 1, "ext4 em / e em /mnt/wslg/distro é o mesmo sistema de ficheiros");
  assert.equal(ext4[0].mount, "/", "a montagem mais curta representa o volume");
  assert.deepEqual(ext4[0].montagens.sort(), ["/", "/mnt/wslg/distro"]);
});

test("capacidade: total e usado de blocos reais, livre é o que o UTILIZADOR pode escrever", () => {
  // 1000 GiB, 200 em uso, 300 livres mas só 250 disponíveis (reserva de root).
  const r = lerMontagensPosix(fsFake({ "/": statfs(1000 * GiB, 200 * GiB, 250 * GiB) }));
  const volume = r.volumes.find((v) => v.mount === "/");
  assert.equal(volume.size, 1000 * GiB);
  assert.equal(volume.used, 800 * GiB);
  assert.equal(volume.available, 250 * GiB, "usar bfree inflacionaria o espaço utilizável");
  const snapshot = describeDiskRead(r.volumes);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.volumes.find((v) => v.mount === "/").usagePercent, 80, "a classificação continua a viver em disk.ts");
});

test("pseudo-sistemas de ficheiros são excluídos E contados; sem eles «zero volumes» diria outra coisa", () => {
  const r = lerMontagensPosix(fsFake({ "/": statfs(100 * GiB, 50 * GiB, 50 * GiB) }));
  const tipos = new Map(r.excluidos.map((e) => [e.fileSystem, e.montantes]));
  for (const pseudo of ["tmpfs", "proc", "sysfs", "devtmpfs", "cgroup2", "rootfs"]) {
    assert.ok(tipos.has(pseudo), `${pseudo} tinha de ser excluído e contado`);
    assert.ok(!r.volumes.some((v) => v.fileSystem === pseudo));
  }
  assert.ok(tipos.get("tmpfs") >= 2, "as três linhas tmpfs da tabela contam-se todas");
});

test("um statfs que falha tira ESSE volume e diz qual, sem apagar os outros", () => {
  const r = lerMontagensPosix(fsFake({
    "/": statfs(100 * GiB, 50 * GiB, 50 * GiB),
    "/mnt/c": statfs(500 * GiB, 100 * GiB),
    "/usr/lib/wsl/drivers": statfs(64 * GiB, 32 * GiB),
    "/mnt/d": null,
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.naoMedidos, ["/mnt/d"]);
  assert.ok(r.volumes.some((v) => v.mount === "/"));
  assert.ok(!r.volumes.some((v) => v.mount === "/mnt/d"));
});

test("montagens reais mas todas sem leitura de capacidade são FALHA com motivo, nunca lista vazia", () => {
  const r = lerMontagensPosix(fsFake({}));
  assert.equal(r.ok, false);
  assert.equal(r.volumes.length, 0);
  assert.match(r.reason, /Nenhum volume pôde ser medido/);
});

test("a tabela ilegível é um motivo que nomeia a tabela; ausência de leitura não é «sem discos»", () => {
  const r = lerMontagensPosix({ readFileSync: () => { throw new Error("EACCES"); }, statfsSync: () => null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tabela de montagens[\s\S]*EACCES/i);
});

test("caminhos com espaços escapados são desescapados antes do statfs", () => {
  // O kernel escreve a sequência de 4 caracteres `\x20` (não um byte de espaço):
  // é exatamente por isso que os campos podem ser separados por espaços.
  const linha = "200 80 8:99 / /mnt/Meu\\x20Volume rw,noatime - ext4 /dev/sdz1 rw";
  const { entradas } = parseMountinfo(linha);
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0].mount, "/mnt/Meu Volume");
  let pedido = null;
  const r = lerMontagensPosix({
    readFileSync: () => linha,
    statfsSync: (caminho) => { pedido = caminho; return statfs(32 * GiB, 8 * GiB, 8 * GiB); },
  });
  assert.equal(pedido, "/mnt/Meu Volume", "o caminho passado ao statfs tem de existir no disco");
  assert.equal(r.volumes[0].mount, "/mnt/Meu Volume");
});

test("um 9p sem suporte montado não é disco de trabalho nem «reservado pelo sistema»", () => {
  // Caso medido em WSL2: `/mnt/d` com ~20 MiB reportados e 64% de «uso».
  const linha = "133 80 0:71 / /mnt/d rw,noatime - 9p D:\\134 rw,aname=drvfs;path=D:\\";
  const r = lerMontagensPosix({
    readFileSync: () => linha,
    statfsSync: () => ({ bsize: 4096, blocks: 5120, bfree: 1900, bavail: 1900 }),
  });
  assert.equal(r.ok, false, "uma máquina cujo único «disco» é um leitor vazio não tem volumes");
  assert.deepEqual(r.volumes.map((v) => v.mount), []);
  assert.deepEqual(r.semCapacidadeUtil, ["/mnt/d"]);
  assert.match(r.reason, /sem capacidade útil/);
});

test("o volume que representa a máquina é o que hospeda a raiz, não o mais cheio", () => {
  const r = lerMontagensPosix(fsFake({
    "/": statfs(1000 * GiB, 980 * GiB, 940 * GiB),
    "/mnt/c": statfs(500 * GiB, 20 * GiB),
    "/usr/lib/wsl/drivers": statfs(500 * GiB, 20 * GiB),
  }));
  assert.equal(describeDiskRead(r.volumes).volumes[0].mount, "/mnt/c", "a ordem por ocupação mantém-se");
  assert.equal(escolheMontagemPrincipal(r.volumes).mount, "/", "mas o primário é o que hospeda o sistema");
  assert.equal(escolheMontagemPrincipal([]), null);
});

test("uma linha sem o separador ou sem fstype não se torna num volume inventado", () => {
  const { entradas, ilegiveis } = parseMountinfo("lixo sem formato\n76 80 0:32 / /mnt/wsl rw - tmpfs none\n");
  assert.equal(entradas.length, 1);
  assert.equal(ilegiveis, 1);
  assert.equal(entradas[0].fileSystem, "tmpfs");
});
