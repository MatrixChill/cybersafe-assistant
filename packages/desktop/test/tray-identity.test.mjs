/**
 * TP-OBJ-TRAY-IDENTITY — teste da identidade DEV (puro, sem Electron).
 *
 * RED: contra o produto antes da integração não existia sufixo de identidade =>
 * o DEV isolado era indistinguível da produção. GREEN: com o helper integrado,
 * os 6 contratos passam.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { devTrayIdentitySuffix, trayTooltipWithIdentity } from "../src/tray-identity.ts";
import { trayTooltip } from "../src/tray-menu.ts";

test("DEV isolado: o tooltip identifica o PID da instância", () => {
  const s = devTrayIdentitySuffix({ isPackaged: false, devIsolated: true, pid: 4242 });
  assert.match(s, /DEV PID 4242/);
  assert.notEqual(s, "", "a identidade tem de aparecer");
});

test("DEV isolado: duas instâncias dão identidades diferentes", () => {
  const a = devTrayIdentitySuffix({ isPackaged: false, devIsolated: true, pid: 4242 });
  const b = devTrayIdentitySuffix({ isPackaged: false, devIsolated: true, pid: 5151 });
  assert.notEqual(a, b, "o PID tem de distinguir as instâncias");
});

test("empacotado: o tooltip do produto fica INALTERADO", () => {
  const s = devTrayIdentitySuffix({ isPackaged: true, devIsolated: true, pid: 4242 });
  assert.equal(s, "");
  const t = trayTooltipWithIdentity(trayTooltip("protected"), {
    isPackaged: true,
    devIsolated: true,
    pid: 4242,
  });
  assert.equal(t, trayTooltip("protected"), "produção: byte a byte igual");
  assert.doesNotMatch(t, /DEV PID/);
});

test("perfil DEV normal (não isolado): o tooltip fica inalterado", () => {
  const s = devTrayIdentitySuffix({ isPackaged: false, devIsolated: false, pid: 4242 });
  assert.equal(s, "");
});

test("sem PID válido: não há identidade (não se inventa)", () => {
  for (const pid of [undefined, 0, -1, 1.5, Number.NaN]) {
    assert.equal(devTrayIdentitySuffix({ isPackaged: false, devIsolated: true, pid }), "");
  }
});

test("a identidade não expõe caminhos, tokens nem raízes de perfil", () => {
  const s = devTrayIdentitySuffix({ isPackaged: false, devIsolated: true, pid: 4242 });
  assert.doesNotMatch(s, /[\\/]|Users|APPDATA|LOCALAPPDATA|token|secret|password|key/i);
  assert.match(s, /DEV PID \d+$/, "só o rótulo e o PID, nada mais");
});
