import { installNavigationPolicy } from "../src/navigation-policy.ts";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import {EventEmitter} from "node:events";
import ts from "typescript";
const main=fs.readFileSync(new URL("../src/main.ts",import.meta.url),"utf8");
const ast=ts.createSourceFile("main.ts",main,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const printer=ts.createPrinter();
const functions=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&["createWindow","revealMainWindow","requestMainWindowForeground"].includes(n.name?.text));
let second;
function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==="app.on"&&n.arguments[0]?.text==="second-instance")second=n.arguments[1];ts.forEachChild(n,visit)}visit(ast);
function fixture({hidden=false,synchronousReady=false}={}) {
 const timers=new Map();let serial=0;const windows=[];const calls=[];
 class Window extends EventEmitter {
  visible=false;minimized=false;destroyed=false;webContents=new EventEmitter();
  constructor(){super();windows.push(this);this.webContents.openDevTools=()=>{};this.webContents.setWindowOpenHandler=()=>{};this.webContents.session={webRequest:{onHeadersReceived(){}}}}
  show(){assert.equal(this.destroyed,false);this.visible=true;calls.push("show");this.emit("show")}
  hide(){this.visible=false;calls.push("hide")}
  focus(){calls.push("focus")}
  restore(){this.minimized=false;calls.push("restore")}
  isVisible(){return this.visible}isMinimized(){return this.minimized}isDestroyed(){return this.destroyed}
  loadFile(){if(synchronousReady)this.emit("ready-to-show");return Promise.resolve()}
  loadURL(){return this.loadFile()}reload(){}
 }
 const ctx={exports:{},mainWindow:null,initialWindowPresentation:null,pendingForegroundRequest:false,launchHidden:hidden,isQuitting:false,
  installNavigationPolicy,pathToFileURL,
  BrowserWindow:Window,preferences:{},path,__dirname:"C:/fixture",process:{platform:"win32"},os:{release:()=>"10.0.22631"},
  app:{isPackaged:true,isReady:()=>false},console:{log(){},error(){},warn(){}},logExitEvent(){},
  resolveWindowMaterial:()=>({options:{},reason:"fixture"}),resolveWindowIconPath:()=>"",titleBarOverlayWindowOptions:()=>({}),
  setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id)};
 vm.createContext(ctx);
 const helper=new URL("../src/window-foreground.ts",import.meta.url);
 if(fs.existsSync(helper)) {
  vm.runInContext(ts.transpileModule(fs.readFileSync(helper,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  Object.assign(ctx,ctx.exports);
 }
 const code=functions.map(n=>printer.printNode(ts.EmitHint.Unspecified,n,ast)).join("\n")+"\nthis.second="+printer.printNode(ts.EmitHint.Unspecified,second,ast);
 vm.runInContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 return {ctx,calls,windows,create:()=>vm.runInContext("createWindow()",ctx),flush:()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn())},get timers(){return timers.size}};
}
test("explicit first launch reveals and focuses after ready",()=>{const f=fixture();f.create();f.windows[0].emit("ready-to-show");assert.deepEqual(f.calls,["show","focus"])});
test("missing ready-to-show cannot strand an explicit launch indefinitely",()=>{const f=fixture();f.create();f.flush();assert.deepEqual(f.calls,["show","focus"]);assert.equal(f.timers,0)});
test("listeners precede loadFile, including a renderer that signals synchronously",()=>{const f=fixture({synchronousReady:true});f.create();assert.deepEqual(f.calls,["show","focus"]);f.flush();assert.equal(f.calls.length,2)});
test("did-finish-load is a one-shot reveal fallback; reload does not steal focus",()=>{const f=fixture();f.create();f.windows[0].webContents.emit("did-finish-load");assert.deepEqual(f.calls,["show","focus"]);f.windows[0].webContents.emit("did-finish-load");f.flush();assert.equal(f.calls.length,2)});
test("hidden autostart stays hidden, even if a later hidden launch arrives",()=>{const f=fixture({hidden:true});f.create();f.windows[0].emit("ready-to-show");f.windows[0].webContents.emit("did-finish-load");f.flush();f.ctx.second({},["cybersafe.exe","--hidden"]);assert.deepEqual(f.calls,[])});
test("explicit second instance restores and focuses the same existing window",()=>{const f=fixture({hidden:true});f.create();f.windows[0].minimized=true;f.ctx.second({},["cybersafe.exe"]);assert.deepEqual(f.calls,["restore","show","focus"]);assert.equal(f.windows.length,1)});
test("second instance before window creation preserves explicit open intent",()=>{const f=fixture({hidden:true});f.ctx.second({},["cybersafe.exe"]);f.create();f.windows[0].emit("ready-to-show");assert.deepEqual(f.calls,["show","focus"]);assert.equal(f.windows.length,1)});
test("user close/tray or minimization before first frame cancels delayed auto-reveal",()=>{for(const event of ["close","minimize"]){const f=fixture();f.create();f.windows[0].emit(event,{preventDefault(){}});f.windows[0].emit("ready-to-show");f.flush();assert.equal(f.calls.includes("show"),false,event)}});
test("shutdown or destruction does not trigger delayed show/focus",()=>{for(const state of ["shutdown","destroyed"]){const f=fixture();f.create();if(state==="shutdown")f.ctx.isQuitting=true;else{f.windows[0].destroyed=true;f.windows[0].emit("closed")}f.flush();assert.deepEqual(f.calls,[])}});

test("a tray/user show before the deadline consumes the delayed reveal",()=>{const f=fixture();f.create();f.windows[0].show();f.windows[0].focus();f.flush();assert.deepEqual(f.calls,["show","focus"])});
test("a destroyed previous window is replaced once for an explicit new launch",()=>{const f=fixture({hidden:true});f.create();f.windows[0].destroyed=true;f.windows[0].emit("closed");f.ctx.app.isReady=()=>true;f.ctx.second({},["cybersafe.exe"]);assert.equal(f.windows.length,2);f.windows[1].emit("ready-to-show");assert.deepEqual(f.calls,["show","focus"])});

test("early explicit launch followed by normal bootstrap never creates duplicate windows",()=>{const f=fixture({hidden:true});f.ctx.app.isReady=()=>true;f.ctx.second({},["cybersafe.exe"]);f.create();assert.equal(f.windows.length,1);f.windows[0].emit("ready-to-show");assert.deepEqual(f.calls,["show","focus"])});
