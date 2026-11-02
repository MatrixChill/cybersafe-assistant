import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AppearanceProvider} from '../src/contexts/AppearanceContext';
import {ENGINES} from '../src/v2/dashboard/model';
import {BrandScene} from '../src/v2/dashboard/effects/Effects';

test('normal product presentation starts with approved depth variant without comparison controls',()=>{
  const html=renderToStaticMarkup(createElement(AppearanceProvider,{children:createElement(BrandScene,{states:Object.fromEntries(ENGINES.map(e=>[e.key,'UNAVAILABLE' as const]))})}));
  assert.ok(html.includes('data-orbital-variant="depth"'),'B must be the default in the real consumer');
  assert.equal(html.includes('data-orbital-select'),false,'comparison is restricted to the laboratory');
  assert.equal(html.includes('NÃO APROVADA'),false,'approved product must not carry the proposal caption');
});
