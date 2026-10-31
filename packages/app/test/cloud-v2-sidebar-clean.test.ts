import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Sidebar from '../src/components/Sidebar';
import type {AuthUser} from '../src/contexts/AuthContext';
import {AppearanceProvider} from '../src/contexts/AppearanceContext';
import SettingsPage from '../src/pages/SettingsPage';
import {SIDEBAR_COLLAPSED_KEY} from '../src/lib/sidebarState';

const values:Record<string,string> = {};
Object.assign(globalThis,{localStorage:{getItem:(key:string)=>values[key]??null,setItem:(key:string,value:string)=>{values[key]=value;}}});
// framer-motion (layout) regista listeners de resize em `window`: o stub precisa do API mínima.
Object.assign(globalThis,{window:{electronAPI:undefined,addEventListener:()=>{},removeEventListener:()=>{}}});
const demoUser:AuthUser={id:'demo',name:'Utilizador DEMO',email:'demo@example.invalid',plan:'free',type:'personal',role:'user',createdAt:'2026-10-19T00:00:00Z'};
const props={activePage:'dashboard' as const,onNavigate:()=>{},theme:'dark' as const,onThemeChange:()=>{},accent:'cyan' as const,onAccentChange:()=>{},identity:'cybersafe-core' as const,onIdentityChange:()=>{},level:'attention' as const,user:demoUser,onLogout:()=>{}};
const renderSidebar=()=>renderToStaticMarkup(createElement(AppearanceProvider,null,createElement(Sidebar,props)));
test('Sidebar centra navegação e conta sem personalização ou build permanente',()=>{
  delete values[SIDEBAR_COLLAPSED_KEY];
  const html=renderSidebar();
  assert.match(html,/Navegação principal/);
  assert.match(html,/Utilizador DEMO/);
  assert.match(html,/Configurações/);
  assert.match(html,/aria-current="page"/);
  assert.doesNotMatch(html,/Cor de destaque|Tema base|Ativar modo claro|Ativar modo escuro/);
  assert.doesNotMatch(html,/desenvolvimento|commit desconhecido|vdesconhecida/);
});
test('Sidebar recolhida mantém nomes acessíveis e estado persistido',()=>{
  values[SIDEBAR_COLLAPSED_KEY]='1';
  const html=renderSidebar();
  assert.match(html,/aria-expanded="false"/);
  assert.match(html,/aria-label="Configurações"/);
  assert.match(html,/aria-label="Terminar sessão"/);
  assert.doesNotMatch(html,/Cor de destaque|Tema base|Abrir Aparência/);
});
test('Aparência conserva identidades, destaques e materiais em Configurações',()=>{
  const html=renderToStaticMarkup(createElement(AppearanceProvider,null,createElement(SettingsPage)));
  for(const label of ['Aparência','Núcleo','Neon','Terminal','Líquido','Belbete','Ciano','Âmbar','Sólido','Reduzido','Vidro'])assert.ok(html.includes(label),label);
});

test('Configurações mantém sete destaques e marca o escolhido sem depender só de cor',()=>{
  values.cybersafe_accent='blue';
  const html=renderToStaticMarkup(createElement(AppearanceProvider,null,createElement(SettingsPage)));
  const buttons=[...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match=>match[0]);
  const blue=buttons.find(button=>button.includes('>Azul<'));
  assert.ok(blue);
  assert.match(blue,/aria-pressed="true"/);
  assert.match(blue,/style="background:[^"]*var\(--accent-blue\)/);
  for(const label of ['Ciano','Verde Matrix','Azul','Roxo','Rosa','Âmbar','Vinho'])assert.ok(buttons.some(button=>button.includes('>'+label+'<')),label);
  delete values.cybersafe_accent;
});
