import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import ExclusionsSection from '../src/components/ExclusionsSection';
(globalThis as Record<string,unknown>).React=React;

test('sem bridge não afirma lista vazia nem permite guardar',()=>{
  const html=renderToStaticMarkup(createElement(ExclusionsSection));
  assert.match(html,/Exclusões de análise/);
  assert.match(html,/serviço de ambiente de trabalho/);
  assert.doesNotMatch(html,/Nenhuma regra do utilizador/);
  assert.match(html,/não são analisados/);
});
test('leitura pendente não é confirmação de lista vazia',()=>{
  Object.assign(globalThis,{window:{electronAPI:{getExclusions:async()=>null,updateExclusions:async()=>null}}});
  try {
    const html=renderToStaticMarkup(createElement(ExclusionsSection));
    assert.match(html,/A ler as exclusões/);
    assert.doesNotMatch(html,/Nenhuma regra do utilizador/);
  }finally{Reflect.deleteProperty(globalThis,'window');}
});
test('Definições inclui a secção e a escrita só ocorre na confirmação',()=>{
  const page=readFileSync(new URL('../src/pages/SettingsPage.tsx',import.meta.url),'utf8');
  const source=readFileSync(new URL('../src/components/ExclusionsSection.tsx',import.meta.url),'utf8');
  assert.match(page,/<ExclusionsSection\s*\/>/);
  assert.match(source,/Confirmar exclusões/);
  assert.match(source,/updateExclusions\(\{ rules: pending \}\)/);
  assert.match(source,/getExclusions\(\)/);
});
