import {test} from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {AppearanceProvider} from "../src/contexts/AppearanceContext";
import {UpdaterScene} from "../src/components/updates/UpdaterScene";
import {updaterScenePolicy} from "../src/components/updates/updaterScenePolicy";
import {updaterCopy,mapUpdaterSnapshot} from "../src/components/updates/updaterWindowModel";
test("reduced motion and unsupported WebGL never request an animated renderer",()=>{
 assert.equal(updaterScenePolicy({gpu:true,animate:true,systemReduced:true,forceStatic:false,phase:"downloading"}).render3d,false);
 assert.equal(updaterScenePolicy({gpu:false,animate:true,systemReduced:false,forceStatic:false,phase:"downloading"}).render3d,false);
 assert.equal(updaterScenePolicy({gpu:true,animate:true,systemReduced:false,forceStatic:true,phase:"downloading"}).render3d,false);
 assert.equal(updaterScenePolicy({gpu:true,animate:true,systemReduced:false,forceStatic:false,phase:"downloading"}).render3d,true);
});
test("an error state does not freeze Orbital B when the user's motion settings allow animation",()=>{
 assert.equal(updaterScenePolicy({gpu:true,animate:true,systemReduced:false,forceStatic:false,phase:"error"}).animate,true);
 assert.equal(updaterScenePolicy({gpu:true,animate:true,systemReduced:false,forceStatic:false,phase:"downloading"}).animate,true);
 assert.equal(updaterScenePolicy({gpu:true,animate:true,systemReduced:true,forceStatic:false,phase:"error"}).animate,false);
});
test("scene fallback uses official symbol and does not assert engine health",()=>{
 const html=renderToStaticMarkup(createElement(AppearanceProvider,{children:createElement(UpdaterScene,{phase:"downloading",forceStatic:true})}));
 assert.match(html,/brand\/symbol.png/);assert.doesNotMatch(html,/<canvas/);assert.doesNotMatch(html,/Ativo|Protegido/);assert.match(html,/estático/);
});
test("twelve visual stages exist without fabricating backend transitions",()=>{
 for(const phase of ["checking","available","downloading","verifying","authenticating","preparing","confirming","installing","restarting","completed","error","current"] as const)assert.ok(updaterCopy[phase].title);
 const v=mapUpdaterSnapshot({status:"downloaded",channel:"stable",installed:{version:"0.2.0"},canInstall:true,automaticCheckEnabled:false});
 assert.equal(v.phase,"confirming");assert.equal(v.percent,null);
});
