import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {interpretProtectionToggle} from '../../desktop/src/protection-toggle-result';
(globalThis as any).React=React;
const {default:ProtectionControl}=await import('../src/components/ProtectionControl');
function render(flag:'confirmada'|'nao_confirmada'){
 const result=interpretProtectionToggle({ok:true,protectionEnabled:false,revogacaoRetoma:flag},'stop');
 return renderToStaticMarkup(React.createElement(ProtectionControl,{realtime:{disponivel:true,enabled:result.protectionEnabled===true},pending:null,connected:true,onSet:()=>{},onPause:()=>{},error:result.reason}));
}
test('OFF observado e aviso de persistência coexistem no controlo real',()=>{const html=render('nao_confirmada');assert.match(html,/Desativada/);assert.match(html,/role="alert"/);assert.match(html,/voltar a iniciar/);});
test('revogação confirmada não mostra aviso',()=>{const html=render('confirmada');assert.match(html,/Desativada/);assert.doesNotMatch(html,/voltar a iniciar/);});
