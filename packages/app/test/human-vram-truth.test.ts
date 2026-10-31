import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardPage from '../src/pages/DashboardPage';
import { AppearanceProvider } from '../src/contexts/AppearanceContext';
const hardware = (vramUsedMb: number | null) => ({cpu:{usage:1,model:'CPU',temperature:null},ram:{usagePercent:20,usedGb:4,totalGb:20},disk:{volumes:[],primary:null},network:{rxSec:0,txSec:0,readStatus:'unavailable'},gpu:{model:'RX5600XT',available:true,usagePercent:null,temperature:null,vramTotalMb:6144,vramUsedMb},alerts:[]});
const dashboard={riskScore:0,totalEvents:0,highSeverityEvents:0,downloadRisk:'low',recentThreats:[],alerts:[],systemStatus:'critical'};
function render(value: number|null) {return renderToStaticMarkup(createElement(AppearanceProvider,null,createElement(DashboardPage,{dashboard,hardware:hardware(value),isLoading:false} as never)));}
it('VRAM não medida não é apresentada como zero usado',()=>{ const html=render(null);assert.doesNotMatch(html,/VRAM 0,0 de/);assert.match(html,/VRAM[^<]*uso sem leitura/);assert.match(html,/6,0 GB/); });
it('zero medido e capacidade conhecida continuam distintos de ausência',()=>{ assert.match(render(0),/VRAM 0,0 de 6,0 GB/);assert.match(render(1024),/VRAM 1,0 de 6,0 GB/); });

it('VRAM inválida não vira leitura numérica',()=>{ for (const value of [NaN,Infinity,-1,7000]) {const html=render(value);assert.match(html,/VRAM[^<]*uso sem leitura/);assert.doesNotMatch(html,/VRAM (?:NaN|Infinity|-|0,0 de)/);} });
