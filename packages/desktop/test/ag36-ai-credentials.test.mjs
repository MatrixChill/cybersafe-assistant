import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createAiCredentialsStore } from "../src/ai-credentials-store.ts";
import { registerAiCredentialsIpc } from "../src/ai-credentials-ipc.ts";
import { configureAiChild } from "../src/ai-api-channel.ts";
import { trustedIpcHandler } from "../src/ipc-guard.ts";
const secret = "synthetic-fixture-not-a-provider-key";
const aes = randomBytes(32);
const encryption = { isEncryptionAvailable: () => true,
 encryptString(text) { const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",aes,iv); const data=Buffer.concat([cipher.update(text),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),data]); },
 decryptString(data) { const decipher=createDecipheriv("aes-256-gcm",aes,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString(); } };
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cs-ag36-creds-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,store:createAiCredentialsStore(dir,encryption)}; }
test("encrypted persistence restores provider after restart and clear removes it", t=>{const {dir,store}=fixture(t);store.writeKey(secret,"openai");assert.equal(fs.readFileSync(path.join(dir,"secrets/ai-credentials.bin")).includes(secret),false);const next=createAiCredentialsStore(dir,encryption);assert.equal(next.getProvider(),"openai");assert.equal(next.readKey(),secret);next.clear();assert.equal(createAiCredentialsStore(dir,encryption).hasKey(),false);});
test("no encryption and custom provider fail closed without plaintext fallback",t=>{const {dir,store}=fixture(t);assert.throws(()=>store.writeKey(secret,"custom"));assert.throws(()=>createAiCredentialsStore(dir,{...encryption,isEncryptionAvailable:()=>false}).writeKey(secret));assert.equal(fs.existsSync(path.join(dir,"secrets")),false);});
test("IPC save configures API but does not claim online or return the secret; clear reconfigures",async t=>{const {store}=fixture(t);const handlers=new Map();const values=[];registerAiCredentialsIpc((c,h)=>handlers.set(c,h),()=>store,async s=>{values.push(s.readKey());return true;});const saved=await handlers.get("ai-credentials:save")({},secret,"groq");assert.equal(saved.state,"configured");assert.equal(saved.applied,true);assert.equal(JSON.stringify(saved).includes(secret),false);assert.equal(JSON.stringify(handlers.get("ai-credentials:get-status")()).includes(secret),false);await handlers.get("ai-credentials:clear")({});assert.deepEqual(values,[secret,null]);});
test("IPC serializes configuration changes and reports missing API explicitly",async t=>{const {store}=fixture(t);const handlers=new Map();let finish;registerAiCredentialsIpc((c,h)=>handlers.set(c,h),()=>store,()=>new Promise(r=>finish=r));const first=handlers.get("ai-credentials:save")({},secret,"groq");assert.equal((await handlers.get("ai-credentials:clear")({})).ok,false);finish(false);assert.equal((await first).state,"pending-api");});
test("trusted-frame guard prevents credential mutation by another sender",()=>{const contents={mainFrame:{url:"file:///app/index.html"},isDestroyed:()=>false};let called=false;const h=trustedIpcHandler(()=>contents,()=>"file:///app/index.html",()=>called=true);assert.throws(()=>h({sender:{},senderFrame:contents.mainFrame}));assert.equal(called,false);h({sender:contents,senderFrame:contents.mainFrame});assert.equal(called,true);});
test("private API channel requires matching ack and cleans listeners",async t=>{const {store}=fixture(t);store.writeKey(secret,"groq");const child=new EventEmitter();Object.assign(child,{connected:true,exitCode:null,signalCode:null,send(m,cb){assert.equal(m.apiKey,secret);cb(null);queueMicrotask(()=>{child.emit("message",{type:"cybersafe-ai-configured",id:"wrong",ok:true});child.emit("message",{type:"cybersafe-ai-configured",id:m.id,ok:true});});}});assert.equal(await configureAiChild(child,store),true);assert.equal(child.listenerCount("message"),0);child.connected=false;assert.equal(await configureAiChild(child,store),false);});
test("private API channel refuses child exit before acknowledgement",async t=>{const {store}=fixture(t);const child=new EventEmitter();Object.assign(child,{connected:true,exitCode:null,signalCode:null,send(_m,cb){cb(null);queueMicrotask(()=>child.emit("exit"));}});assert.equal(await configureAiChild(child,store),false);assert.equal(child.listenerCount("message"),0);});
