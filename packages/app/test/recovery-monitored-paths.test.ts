import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ProtectionDetails from '../src/components/ProtectionDetails.tsx';
(globalThis as any).React=React;
test('protection details presents backend confirmed paths and dropped event warning',()=>{
 const html=renderToStaticMarkup(React.createElement(ProtectionDetails,{open:true,onClose:()=>{},level:'degraded',engine:{serviceRunning:true,monitoredPaths:['C:\\isolated-downloads'],realtimeDroppedEvents:5,realtimeQueueDepth:2} as any}));
 assert.match(html,/Pastas monitorizadas/);assert.match(html,/isolated-downloads/);assert.match(html,/5 eventos/);assert.match(html,/antes da execução/);
});
test('empty confirmed path list is explicit and does not fabricate defaults',()=>{
 const html=renderToStaticMarkup(React.createElement(ProtectionDetails,{open:true,onClose:()=>{},level:'degraded',engine:{serviceRunning:true,monitoredPaths:[]} as any}));
 assert.match(html,/Nenhuma pasta confirmada/);assert.doesNotMatch(html,/C:\\Users|Downloads/);
});
