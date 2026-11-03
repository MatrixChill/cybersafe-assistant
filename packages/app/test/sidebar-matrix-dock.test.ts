import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import LabSidebar from '../src/v2/LabSidebar';

test('production sidebar exposes the measured dock slot before its footer',()=>{
  const html=renderToStaticMarkup(createElement(LabSidebar,{activePage:'dashboard',onNavigate:()=>{}}));
  const slot=html.indexOf('data-cs-matrix-dock=""');
  const footer=html.indexOf('data-cs-reserve="matrix"');
  assert.ok(slot>=0,'docked MATRIX needs a real layout slot');
  assert.ok(footer>slot,'dock cannot overlap footer controls');
  assert.ok(html.includes('--matrix-dock-slot-h'));
});
