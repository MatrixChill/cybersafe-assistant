/**
 * Escolha do asset de tray por estado.
 *
 * O bug que estes testes trancam: as variantes `tray-icon-warning` e (na
 * altura) `critical` eram byte-identicas a `active` (md5 efa59f0a...), e o
 * ícone inicial usava `isServiceRunning` em vez do estado da proteção. O
 * resultado era uma bandeja que não distinguia nada.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveTrayIconAsset,
  trayProtectionLevel,
  TRAY_ICON_VARIANT,
} from "../src/tray-menu.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `assetsPath` no main.ts resolve para <dist>/assets/<segmentos>, e o primeiro
// segmento e "cybersafe". O stub tem de reproduzir isso — se fixar "cybersafe"
// dentro de ASSETS, o caminho duplica e o teste mede o ficheiro errado.
const ASSETS = path.join(HERE, "..", "src", "assets");
const assetsPath = (...seg) => path.join(ASSETS, ...seg);
const exists = (p) => fs.existsSync(p);

describe("seleção de asset por estado", () => {
  test("PROTEGIDO escolhe o asset active", () => {
    const r = resolveTrayIconAsset("protected", 16, exists, assetsPath);
    assert.match(r.path, /tray-symbol-active-16\.png$/);
    assert.equal(r.dedicated, true);
  });

  test("ATENÇÃO escolhe o asset warning", () => {
    const r = resolveTrayIconAsset("attention", 24, exists, assetsPath);
    assert.match(r.path, /tray-symbol-warning-24\.png$/);
  });

  test("NÃO PROTEGIDO escolhe o asset critical", () => {
    const r = resolveTrayIconAsset("unprotected", 24, exists, assetsPath);
    assert.match(r.path, /tray-symbol-critical-24\.png$/);
  });

  test("cada estado tem o seu nome de ficheiro (nada de dois estados no mesmo)", () => {
    const names = Object.values(TRAY_ICON_VARIANT);
    assert.equal(new Set(names).size, 3, "os três estados não podem partilhar ficheiro");
  });

  test("se o asset dedicado não existir, cai no tray-icon-<estado>.png", () => {
    // Só o `tray-symbol-*` falta; o `tray-icon-<estado>.png` existe. Um
    // `exists` que devolvesse sempre false testaria outra coisa (o último
    // recurso), que tem o seu próprio teste em baixo.
    const onlyFlat = (p) => !p.includes("tray-symbol-") && fs.existsSync(p);
    // "unprotected", não "critical": este é o NÍVEL. "critical" é o nome da
    // variante/ficheiro. Passar o nome dava undefined e caía no ícone errado.
    const r = resolveTrayIconAsset("unprotected", 20, onlyFlat, assetsPath);
    assert.match(r.path, /tray-icon-critical\.png$/);
    assert.equal(r.dedicated, false);
  });

  test("um nível desconhecido nunca se pinta de 'protegido'", () => {
    // `TRAY_ICON_VARIANT[level]` com um level fora do enum dá undefined. Isso
    // virava `tray-symbol-undefined-16.png` (não existe) e degradava para
    // `tray-icon-active.png` — o ícone de PROTEGIDO, sem medição nenhuma.
    // Desconhecido tem de cair em atenção, que é o que `trayProtectionLevel`
    // devolve quando não há prova de proteção.
    const r = resolveTrayIconAsset("estado-que-nao-existe", 16, exists, assetsPath);
    assert.doesNotMatch(r.path, /active/, "nível desconhecido caiu no ícone de protegido");
    assert.match(r.path, /tray-symbol-warning-16\.png$/);
  });

  test("nenhum estado produz um caminho com 'undefined' no nome", () => {
    for (const level of ["protected", "attention", "unprotected", "lixo"]) {
      const r = resolveTrayIconAsset(level, 20, exists, assetsPath);
      assert.doesNotMatch(r.path, /undefined/, `level=${level} gerou ${r.path}`);
      assert.ok(
        fs.existsSync(r.path),
        `level=${level} devolveu um caminho que não existe: ${r.path}`,
      );
    }
  });

  test("nunca devolve um caminho nulo: há sempre um ícone", () => {
    const r = resolveTrayIconAsset("unprotected", 32, () => false, assetsPath);
    assert.match(
      r.path,
      /tray-icon-active\.png$/,
      "sem assets, cai no active — nunca fica vazio",
    );
  });
});

describe("distinção visual real dos assets em disco", () => {
  // O ponto do teste: ficheiros com nomes diferentes mas o MESMO bitmap não
  // passe. O bug anterior passaria num teste que só olhasse para os nomes.
  for (const size of [16, 20, 24, 32]) {
    test(`os três estados são ficheiros distintos a ${size}px`, () => {
      const files = ["active", "warning", "critical"].map((k) =>
        path.join(ASSETS, "cybersafe", `tray-symbol-${k}-${size}.png`),
      );
      for (const f of files) {
        assert.ok(fs.existsSync(f), `asset em falta: ${path.basename(f)}`);
      }
      const [a, b, c] = files.map((f) => fs.readFileSync(f));
      assert.notEqual(a.equals(b), true, `active == warning a ${size}px (bitmaps iguais)`);
      assert.notEqual(a.equals(c), true, `active == critical a ${size}px (bitmaps iguais)`);
      assert.notEqual(b.equals(c), true, `warning == critical a ${size}px (bitmaps iguais)`);
    });
  }

  test("os assets de fallback tray-icon-<estado>.png também não são cópias", () => {
    const files = ["active", "warning", "critical"].map((k) =>
      path.join(ASSETS, "cybersafe", `tray-icon-${k}.png`),
    );
    for (const f of files) assert.ok(fs.existsSync(f), `asset em falta: ${path.basename(f)}`);
    const [a, b, c] = files.map((f) => fs.readFileSync(f));
    assert.ok(
      !a.equals(b) && !a.equals(c) && !b.equals(c),
      "tray-icon-* são cópias uns dos outros",
    );
  });

  test("o estado nunca vem do serviço de pé (o bug do ícone inicial)", () => {
    // Serviço de pé + proteção desligada tem de dar "não protegido", e portanto
    // o asset critical. Se alguém voltar a derivar do isServiceRunning, falha.
    const level = trayProtectionLevel({
      serviceRunning: true,
      status: "safe",
      protectionEnabled: false,
    });
    assert.equal(level, "unprotected");
    const r = resolveTrayIconAsset(level, 16, exists, assetsPath);
    assert.match(r.path, /critical/);
  });
});