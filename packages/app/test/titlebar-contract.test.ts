import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const appSrc = join(import.meta.dirname, '../src');
const appTitleBarRaw = readFileSync(join(appSrc, 'components/AppTitleBar.tsx'), 'utf8');

describe('AppTitleBar — contrato de contexto da página', () => {
  it('expõe setTitlebarPageLabel como função exportada', () => {
    const match = appTitleBarRaw.match(/export function setTitlebarPageLabel\(/);
    assert.ok(match);
  });

  it('expõe TitlebarPageLabel como tipo exportado', () => {
    const match = appTitleBarRaw.match(/export type TitlebarPageLabel =/);
    assert.ok(match);
  });

  it('o App.tsx importa e usa a exportação', () => {
    // O App.tsx é compilado pelo fluxo normal do app; neste teste de contrato
    // verificamo-lo como fonte estável em vez de acoplar o teste ao runtime.
    const appRaw = readFileSync(join(appSrc, 'App.tsx'), 'utf8');
    assert.ok(appRaw.includes('import { setTitlebarPageLabel'));
    assert.ok(appRaw.includes('setTitlebarPageLabel('));

    // Verificamos o filho de roteamento sem executar React: o App.tsx define
    // conformidade com o tipo TitlebarPageLabel e o valor real por rota.
    assert.match(appRaw, /setTitlebarPageLabel\(activePageTitle\)/);
    assert.match(appRaw, /activePageTitle: TitlebarPageLabel/);
    assert.match(appRaw, /case "dashboard"/);
    assert.match(appRaw, /Painel/);
  });
});
