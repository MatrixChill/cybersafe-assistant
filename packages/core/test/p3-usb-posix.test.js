// §10 Linux Lite — a deteção USB lida sysfs + mountinfo, não letras nem CIM.
// Os testes correm em qualquer sistema: o filesystem é uma árvore em memória.
import test from "node:test";
import assert from "node:assert/strict";

import { temTransporteUsb, detetarUsbPosix } from "../dist/usb-posix.js";

/**
 * Árvore em memória. Um nó de `/sys/block/<dev>` é AS DUAS COISAS em sysfs real:
 * um symlink (para a topologia, que é donde se lê o `usb<N>`) e um diretório
 * (donde se leem `dev`, `removable` e as partições). O nó aceita os dois papéis.
 */
function arvore(nos) {
  return {
    readdirSync(diretorio) {
      const no = nos[diretorio];
      if (!no || !no.children) throw new Error(`ENOTDIR: cannot read directory '${diretorio}'`);
      return [...no.children];
    },
    readlinkSync(caminho) {
      const no = nos[caminho];
      if (!no || typeof no.target !== "string") throw new Error(`EINVAL: not a symlink '${caminho}'`);
      return no.target;
    },
    readFileSync(caminho) {
      const no = nos[caminho];
      if (!no || typeof no.content !== "string") throw new Error(`ENOENT: no such file '${caminho}'`);
      return no.content;
    },
  };
}

const file = (content) => ({ content });
const dir = (...children) => ({ children });
const link = (target) => ({ target });
const linkdir = (target, ...children) => ({ target, children });

const USB_SDB = "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-1/1-1:1.0/host0/target0:0:0/0:0:0:0:0/block/sdb";
const NVME_N1 = "/sys/devices/pci0000:00/0000:00:1e.0/nvme/nvme0/nvme0n1/block/nvme0n1";

/**
 * Um pen `sdb` (serial, partição `sdb1` montada em dois sítios), um `nvme0n1` do
 * sistema, um leitor de cartões USB sem serial e sem montagem, um pen montado
 * como disco inteiro e um disco USB cuja única montagem é um `tmpfs`.
 * `queue`/`device`/`holders` existem de propósito: são diretórios sem `dev`.
 */
function mundoBase(entradasSysBlock) {
  return {
    "/sys/block": dir(...entradasSysBlock),
    "/sys/block/sdb": linkdir(USB_SDB, "dev", "removable", "queue", "device", "holders", "sdb1"),
    "/sys/block/sdb/dev": file("8:16\n"),
    "/sys/block/sdb/removable": file("1\n"),
    "/sys/block/sdb/queue": dir("rotational"),
    "/sys/block/sdb/device": link(USB_SDB.replace("/block/sdb", "/0:0:0:0:0")),
    "/sys/block/sdb/holders": dir(),
    "/sys/block/sdb/sdb1": link(USB_SDB.replace("/block/sdb", "/block/sdb/sdb1")),
    "/sys/block/sdb/sdb1/dev": file("8:17\n"),
    "/sys/block/sdb/device/serial": file("ABCD1234EFGH\n"),
    "/sys/block/nvme0n1": linkdir(NVME_N1, "dev", "removable", "queue"),
    "/sys/block/nvme0n1/dev": file("259:0\n"),
    "/sys/block/nvme0n1/removable": file("0\n"),
    "/sys/block/nvme0n1/queue": dir(),
    "/sys/block/sdc": linkdir(
      "/sys/devices/pci0000:00/0000:00:14.0/usb2/2-2/2-2:1.0/host1/target1:0:0/1:0:0:0:0/block/sdc",
      "dev",
    ),
    "/sys/block/sdc/dev": file("8:32\n"),
    "/sys/block/sdd": linkdir(
      "/sys/devices/pci0000:00/0000:00:14.0/usb3/3-1/3-1:1.0/host2/target2:0:0/2:0:0:0:0/block/sdd",
      "dev",
      "removable",
    ),
    "/sys/block/sdd/dev": file("8:48\n"),
    "/sys/block/sdd/removable": file("1\n"),
    "/sys/block/sde": linkdir(
      "/sys/devices/pci0000:00/0000:00:14.0/usb4/4-1/4-1:1.0/host3/target3:0:0/3:0:0:0:0/block/sde",
      "dev",
    ),
    "/sys/block/sde/dev": file("8:64\n"),
    "/sys/block/sdf": linkdir(
      "/sys/devices/pci0000:00/0000:00:14.0/usb5/5-1/5-1:1.0/host4/target4:0:0/4:0:0:0:0/block/sdf",
      "dev",
    ),
    "/sys/block/sdf/dev": file("8:80\n"),
    "/proc/self/mountinfo": file(""),
  };
}

function montaLinhas(linhas) {
  return `${linhas.join("\n")}\n`;
}

const LINHA_RAIZ = "3 0 259:0 / / rw,relatime - ext4 /dev/nvme0n1p2 rw";

test("o transporte USB vem do caminho do sysfs, não do nome do disco", () => {
  assert.equal(temTransporteUsb(USB_SDB), true);
  assert.equal(temTransporteUsb(NVME_N1), false);
  // `usb1:1.0` é a interface, não o controlador: sem `usb<N>` isolado não é USB.
  assert.equal(temTransporteUsb("/sys/devices/pci0000:00/usb1:1.0/block/sdb"), false);
  assert.equal(temTransporteUsb("/sys/devices/virtual/block/loop0"), false);
});

test("um pen com serial é um dispositivo com identidade de serial e raiz mais curta", () => {
  const mundo = mundoBase(["sdb", "nvme0n1"]);
  mundo["/proc/self/mountinfo"] = file(
    montaLinhas([
      "9 3 8:17 / /mnt/pen/docs rw,nosuid - vfat /dev/sdb1 rw",
      "8 3 8:17 / /mnt/pen rw,relatime - vfat /dev/sdb1 rw",
      LINHA_RAIZ,
    ]),
  );
  const r = detetarUsbPosix(arvore(mundo));
  assert.equal(r.ok, true);
  assert.equal(r.dispositivos.length, 1);
  const pen = r.dispositivos[0];
  assert.equal(pen.id, "usb-serial:ABCD1234EFGH");
  assert.equal(pen.identityProvenance, "sysfs-serial");
  assert.equal(pen.rootPath, "/mnt/pen");
  assert.deepEqual(pen.rootPaths, ["/mnt/pen", "/mnt/pen/docs"]);
  assert.equal(pen.nomeBloco, "sdb");
  assert.equal(pen.dispositivo, "8:16");
  assert.equal(pen.amovivel, true);
  assert.equal(pen.serial, "ABCD1234EFGH");
  assert.equal("label" in pen, false);
});

test("sem serial a identidade é o índice, marcado como reciclável para o monitor", () => {
  const mundo = mundoBase(["sdd"]);
  mundo["/proc/self/mountinfo"] = file(montaLinhas(["11 0 8:48 / /mnt/cartao rw - vfat /dev/sdd1 rw"]));
  const r = detetarUsbPosix(arvore(mundo));
  assert.deepEqual(
    r.dispositivos.map((d) => [d.id, d.identityProvenance, d.rootPath]),
    [["usb-index:sdd", "disk-index-fallback", "/mnt/cartao"]],
  );
  assert.equal("serial" in r.dispositivos[0], false);
});

test("discos fora de USB são declarados como não atribuídos, não escondidos", () => {
  const mundo = mundoBase(["sdb", "nvme0n1"]);
  mundo["/proc/self/mountinfo"] = file(montaLinhas(["8 0 8:17 / /mnt/pen rw - vfat /dev/sdb1 rw", LINHA_RAIZ]));
  const r = detetarUsbPosix(arvore(mundo));
  assert.deepEqual(r.naoAtribuidos, ["nvme0n1"]);
  assert.equal(r.dispositivos.length, 1);
  const linhaNvme = r.observados.find((o) => o.nomeBloco === "nvme0n1");
  assert.equal(linhaNvme.usb, false);
  assert.equal(linhaNvme.montagens, 1, "o contador de montagens é facto, não seleção");
});

test("USB sem volume montado fica em semVolume e nunca é alvo", () => {
  const mundo = mundoBase(["sdc"]);
  mundo["/proc/self/mountinfo"] = file(montaLinhas([LINHA_RAIZ]));
  const r = detetarUsbPosix(arvore(mundo));
  assert.deepEqual(r.semVolume, ["sdc"]);
  assert.deepEqual(r.dispositivos, []);
  assert.equal(r.ok, true, "não há dispositivo, mas a leitura foi bem sucedida");
});

test("a única montagem ser pseudo-FS não faz do disco um volume", () => {
  const mundo = mundoBase(["sdf"]);
  mundo["/proc/self/mountinfo"] = file(montaLinhas(["12 0 8:80 / /media/tmp rw - tmpfs tmpfs rw"]));
  const r = detetarUsbPosix(arvore(mundo));
  assert.deepEqual(r.semVolume, ["sdf"]);
  assert.deepEqual(r.dispositivos, []);
});

test("um pen sem tabela de partições monta-se como disco inteiro", () => {
  const mundo = mundoBase(["sdd"]);
  mundo["/proc/self/mountinfo"] = file(montaLinhas(["13 0 8:48 / /mnt/raiz rw - vfat /dev/sdd ro,relatime"]));
  const r = detetarUsbPosix(arvore(mundo));
  assert.deepEqual(r.dispositivos.map((d) => d.rootPath), ["/mnt/raiz"]);
});

test("um disco ilegível não apaga os outros e é contado", () => {
  const mundo = mundoBase(["sdb", "sdg"]);
  delete mundo["/sys/block/sdg"];
  mundo["/proc/self/mountinfo"] = file(montaLinhas(["8 0 8:17 / /mnt/pen rw - vfat /dev/sdb1 rw"]));
  const r = detetarUsbPosix(arvore(mundo));
  assert.equal(r.ok, true);
  assert.equal(r.ilegiveis, 1);
  assert.equal(r.dispositivos.length, 1);
});

test("sem `/sys/block` não há lista vazia: há falha com motivo que nomeia a tabela", () => {
  const r = detetarUsbPosix(arvore({ "/proc/self/mountinfo": file("") }), "/proc/self/mountinfo", "/sys/block-inexistente");
  assert.equal(r.ok, false);
  assert.match(r.motivo, /sys\/block-inexistente/);
  assert.deepEqual(r.dispositivos, []);
});

test("sem tabela de montagens o motivo nomeia a tabela, não os dispositivos", () => {
  const mundo = mundoBase(["sdb"]);
  delete mundo["/proc/self/mountinfo"];
  const r = detetarUsbPosix(arvore(mundo), "/proc/nao-existe/mountinfo");
  assert.equal(r.ok, false);
  assert.match(r.motivo, /montagens/);
  assert.match(r.motivo, /nao-existe/);
});

test("diretórios de sysfs sem `dev` não contam como partições", () => {
  const mundo = mundoBase(["sdb"]);
  mundo["/proc/self/mountinfo"] = file(montaLinhas(["8 0 8:17 / /mnt/pen rw - vfat /dev/sdb1 rw"]));
  const r = detetarUsbPosix(arvore(mundo));
  assert.deepEqual(r.dispositivos[0].rootPaths, ["/mnt/pen"]);
  assert.equal(r.dispositivos[0].amovivel, true);
});

test("`removable` ausente é desconhecido, não `false`", () => {
  const mundo = mundoBase(["sdd"]);
  delete mundo["/sys/block/sdd/removable"];
  mundo["/proc/self/mountinfo"] = file(montaLinhas(["14 0 8:48 / /mnt/x rw - ext4 /dev/sdd rw"]));
  const r = detetarUsbPosix(arvore(mundo));
  assert.equal(r.dispositivos[0].amovivel, null);
});
