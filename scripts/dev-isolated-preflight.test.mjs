import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync, spawn} from "node:child_process";
import net from "node:net";

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"cybersafe-preflight-test-"));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const user=path.join(root,"electron");fs.mkdirSync(user);
 const env={...process.env,CYBERSAFE_DEV_ISOLATION:"1",CYBERSAFE_DEV_SERVICE_DIR:root,CYBERSAFE_DEV_PIPE_NAME:`\\\\.\\pipe\\cybersafe-test-${process.pid}-${Math.random().toString(16).slice(2)}`,CYBERSAFE_DB_PATH:path.join(root,"test.db"),CYBERSAFE_DEV_USER_DATA_DIR:user};
 return {root,env};
}
function run(env){return spawnSync(process.execPath,["scripts/dev-isolated-preflight.mjs"],{env,encoding:"utf8",timeout:10000});}
test("complete isolated fixture can pass without starting any app",t=>{const {env}=fixture(t);const r=run(env);assert.equal(r.status,0,r.stdout+r.stderr);});
test("missing API DB must block, never claim GO",t=>{const {env}=fixture(t);delete env.CYBERSAFE_DB_PATH;const r=run(env);assert.equal(r.status,2,r.stdout);});
test("missing explicit Electron profile must block",t=>{const {env}=fixture(t);delete env.CYBERSAFE_DEV_USER_DATA_DIR;const r=run(env);assert.equal(r.status,2,r.stdout);});
test("service root must be a directory, not an existing regular file",t=>{const {root,env}=fixture(t);const file=path.join(root,"regular");fs.writeFileSync(file,"benign");env.CYBERSAFE_DEV_SERVICE_DIR=file;const r=run(env);assert.equal(r.status,2,r.stdout);});
test("personal API DB path must block",t=>{const {env}=fixture(t);env.CYBERSAFE_DB_PATH=path.join(os.homedir(),".cybersafe-service","cybersafe.db");const r=run(env);assert.equal(r.status,2,r.stdout);});

test("occupied isolated pipe must block rather than attach to an unknown service",async t=>{
 const {env}=fixture(t);
 const server=net.createServer(socket=>socket.end());
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(env.CYBERSAFE_DEV_PIPE_NAME,resolve);});
 try {
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,["scripts/dev-isolated-preflight.mjs"],{env});let stdout="";
   child.stdout.on("data",b=>stdout+=b);child.once("error",reject);child.once("close",status=>resolve({status,stdout}));
  });
  assert.equal(result.status,2,result.stdout);
 } finally {await new Promise(resolve=>server.close(resolve));}
});
