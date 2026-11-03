import { test } from "node:test";
import assert from "node:assert/strict";
import { lerMontagensPosix, lerPontosDeMontagem } from "../dist/index.js";

/**
 * A MESMA tabela real de WSL2 medida em `p3-montes-posix.test.js` (Linux
 * 6.6.114.1-microsoft-standard-WSL2). Repetir o texto em vez de importar o
 * fixture: são duas perguntas diferentes sobre a mesma fonte, e partilhar o
 * literal faria uma alteração de fixture mudar silenciosamente dois testes.
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

/** Só `readFileSync`: provar que esta pergunta não precisa de `statfs`. */
const fsSoLeitura = (texto = MOUNTINFO_WSL, erro = null) => ({
  readFileSync: () => {
    if (erro) throw erro;
    return texto;
  },
});

test("a tabela de montagens devolve TODOS os pontos de montagem, pseudo-FS incluídos", () => {
  const r = lerPontosDeMontagem(fsSoLeitura());
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.equal(r.ilegiveis, 0);
  for (const esperado of ["/", "/dev", "/proc", "/run", "/sys", "/sys/fs/cgroup", "/tmp", "/mnt/wsl", "/mnt/c", "/mnt/d", "/init", "/mnt/wslg/distro", "/usr/lib/wsl/drivers"]) {
    assert.ok(r.montagens.includes(esperado), `em falta: ${esperado}`);
  }
});

test("a diferença face aos volumes é o ponto: `/sys` é montagem e não é volume", () => {
  const montagens = lerPontosDeMontagem(fsSoLeitura()).montagens;
  const blocosPorGiB = 1024 ** 3 / 4096;
  const volumes = lerMontagensPosix({
    readFileSync: () => MOUNTINFO_WSL,
    // Capacidade suficiente para que nada fique de fora por `statfs`.
    statfsSync: () => ({ bsize: 4096, blocks: 40 * blocosPorGiB, bfree: 20 * blocosPorGiB, bavail: 20 * blocosPorGiB }),
  }).volumes.flatMap((volume) => volume.montagens);
  assert.ok(montagens.includes("/sys"));
  assert.ok(!volumes.includes("/sys"), "um sysfs não deve aparecer como volume de armazenamento");
  assert.ok(montagens.length > volumes.length, `${montagens.length} montagens vs ${volumes.length} volumes`);
});

test("o `/` da raiz continua a ser `/`, não uma string vazia", () => {
  const r = lerPontosDeMontagem(fsSoLeitura("80 65 8:48 / / rw,relatime - ext4 /dev/sdd rw\n"));
  assert.deepEqual(r.montagens, ["/"]);
});

test("um nome com espaço volta a ser o caminho real, não o texto escapado", () => {
  const r = lerPontosDeMontagem(fsSoLeitura("90 80 8:49 / /mnt/pen\\x20usb rw,relatime - vfat /dev/sde1 rw"));
  assert.deepEqual(r.montagens, ["/mnt/pen usb"]);
});

test("a mesma montagem repetida conta uma vez, e a lista é ordenada", () => {
  const r = lerPontosDeMontagem(fsSoLeitura([
    "1 80 0:1 / /run rw - tmpfs none rw",
    "2 80 0:1 / /run rw - tmpfs none rw",
    "3 80 0:2 / /mnt/z rw - vfat /dev/sdf1 rw",
    "4 80 0:3 / /mnt/a rw - vfat /dev/sdg1 rw",
  ].join("\n")));
  assert.deepEqual(r.montagens, ["/mnt/a", "/mnt/z", "/run"]);
});

test("linha ilegível é contada como cobertura incompleta, não como ausência", () => {
  const r = lerPontosDeMontagem(fsSoLeitura([
    "80 65 8:48 / / rw,relatime - ext4 /dev/sdd rw",
    "isto não é uma linha de mountinfo",
    "91 80 0:99 / /mnt/ok rw,relatime - ext4 /dev/sdg rw",
  ].join("\n")));
  assert.equal(r.ok, true);
  assert.equal(r.ilegiveis, 1);
  assert.match(r.reason ?? "", /1 linha/);
  assert.deepEqual(r.montagens, ["/", "/mnt/ok"]);
});

test("sem tabela não há lista: falha declarada, reason com o motivo", () => {
  const r = lerPontosDeMontagem(fsSoLeitura("", new Error("ENOENT: no such file or directory")));
  assert.equal(r.ok, false);
  assert.deepEqual(r.montagens, []);
  assert.equal(r.ilegiveis, 0);
  assert.match(r.reason ?? "", /não pôde ser lida/);
  assert.match(r.reason ?? "", /ENOENT/);
});

test("a tabela vazia não é uma falha de leitura", () => {
  const r = lerPontosDeMontagem(fsSoLeitura(""));
  assert.equal(r.ok, true);
  assert.deepEqual(r.montagens, []);
  assert.equal(r.ilegiveis, 0);
});
