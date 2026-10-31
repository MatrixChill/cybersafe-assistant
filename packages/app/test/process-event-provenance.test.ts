import test from "node:test";
import assert from "node:assert/strict";
import {securityEventPresentation} from "../src/lib/securityEventPresentation";
const event=(type:string,data:Record<string,unknown>={},summary="Processo terminado: powershell.exe")=>({type,summary,data} as never);
test("natural exit stays observation even if legacy metadata implies an actor",()=>{const p=securityEventPresentation(event("process.exited",{confirmed:true,source:"user-confirmed"}));assert.equal(p.provenance,"observed");assert.match(p.text,/Saída/);assert.match(p.note,/não confirmad/)});
test("legacy killed event without evidence has unknown provenance",()=>{const p=securityEventPresentation(event("process.killed"));assert.equal(p.provenance,"unknown");assert.doesNotMatch(p.text,/terminado pelo CyberSafe/);assert.match(p.note,/não confirmad/)});
test("request is not completion; only explicit confirmed source is attributed",()=>{const request=securityEventPresentation(event("process.killed",{status:"requested"}));assert.equal(request.provenance,"requested");assert.match(request.note,/não confirma/);const done=securityEventPresentation(event("process.killed",{confirmed:true,source:"user-confirmed",scope:"single-process",pid:12345}));assert.equal(done.provenance,"confirmed");assert.match(done.text,/terminado pelo CyberSafe/);assert.equal(securityEventPresentation(event("process.killed",{confirmed:true,source:"unknown"})).provenance,"unknown")});

import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {SecurityEventMessage} from "../src/components/SecurityEventMessage";
test("actual notification component keeps complete escaped content and collapsed original",()=>{const summary="Processo terminado: "+"muito-longo-".repeat(200)+"<script>END</script>";const e={...event("process.exited"),summary} as never;const html=renderToStaticMarkup(createElement(SecurityEventMessage,{event:e}));assert.match(html,/Saída do processo observada/);assert.match(html,/&lt;script&gt;END/);assert.match(html,/<details>/);assert.doesNotMatch(html,/<details open|<script>/);assert.match(html,/tabindex="0"/i)});

import {EventLine} from "../src/pages/MonitorPage";
test("actual Monitor row does not label a legacy unknown event as executed",()=>{const html=renderToStaticMarkup(createElement(EventLine,{event:{...event("process.killed"),timestamp:"2026-10-30T10:00:00Z"}} as never));assert.match(html,/Proveniência desconhecida/);assert.match(html,/Registo de terminação/);assert.match(html,/<details>/);assert.doesNotMatch(html,/Processo encerrado|Terminação confirmada/)});

test("arbitrary historical actor claims never become the natural-exit headline",()=>{const p=securityEventPresentation(event("process.exited",{},"O CyberSafe terminou um processo"));assert.equal(p.text,"Saída de processo observada");assert.equal(p.provenance,"observed");assert.equal(securityEventPresentation(event("process.killed",{confirmed:true,source:"user-confirmed",scope:"single-process",pid:-1})).provenance,"unknown")});
