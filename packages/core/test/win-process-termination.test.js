import test from 'node:test';
import assert from 'node:assert/strict';
import { bindWindowsTermination, ordinaryUserImage } from '../dist/win-process-termination.js';
function fake(options={}) {
 const pointers=new WeakMap(),calls=[];let exited=false;
 const self={sid:[1,2,3,4,5,6,7,8],session:1,elevated:0,level:8192};
 const target={...self,...options};const processHandle={target:true};
 const check=(condition,fn)=>{if(!condition)return false;fn?.();return true};
 const methods={
  OpenProcess:(access,inherit,pid)=>{calls.push(['open',access,inherit,pid]);return options.denied?null:processHandle},
  CloseHandle:h=>{calls.push(['close',h]);return true},GetLastError:()=>5,
  GetCurrentProcess:()=>({self:true}),
  GetProcessTimes:(h,c)=>{c.writeBigUInt64LE(134062848000001234n);return true},
  QueryFullProcessImageNameW:(h,flags,text,size)=>{const image=options.path??'C:\\Apps\\notepad.exe';text.write(image,0,'utf16le');size.writeUInt32LE(image.length);return true},
  IsProcessCritical:(h,out)=>check(!options.criticalUnknown,()=>out.writeUInt32LE(options.critical?1:0)),
  GetProcessInformation:(h,kind,out)=>{assert.equal(kind,7);out.writeUInt32LE(options.protection??0xfffffffe);return true},
  WaitForSingleObject:(h,ms)=>{assert.equal(h,processHandle);assert.equal(ms,0);return exited?0:258},
  TerminateProcess:(h,code)=>{calls.push(['terminate',h,code]);exited=true;return true},
  OpenProcessToken:(h,access,out)=>{assert.equal(access,8);pointers.set(out,h===processHandle?target:self);return true},
  GetTokenInformation:(token,kind,out)=>{
   if(kind===1)pointers.set(out,Uint8Array.from(token.sid));
   else if(kind===12)out.writeUInt32LE(token.session);
   else if(kind===20)out.writeUInt32LE(token.elevated);
   else if(kind===25){const b=Buffer.alloc(12);b.writeUInt32LE(token.level,8);pointers.set(out,b);}
   else throw Error('unexpected token class');return true;
  },GetLengthSid:sid=>sid.length,
 };
 const ffi={load:()=>({func:signature=>{const name=/__stdcall (\w+)\(/.exec(signature)[1];assert.ok(methods[name],name);return methods[name]}}),decode:(buffer,type)=>type==='void *'?pointers.get(buffer):buffer};
 return {open:bindWindowsTermination(ffi),calls};
}
test('single retained handle, exact creation time, narrow rights, no inheritance or tree API',()=>{
 const f=fake();const h=f.open(12345);const i=h.read();assert.equal(i.eligible,true);assert.equal(i.creation,'134062848000001234');assert.match(i.startedAt,/\.0001234Z$/);assert.deepEqual(f.calls[0],['open',0x101001,false,12345]);
 assert.equal(f.calls.some(c=>c[0]==='terminate'),false);h.terminate();assert.equal(h.exited(),true);h.close();h.close();assert.equal(f.calls.filter(c=>c[0]==='terminate').length,1);assert.equal(f.calls.filter(c=>c[0]==='close'&&c[1]?.target).length,1);
});
test('critical, PPL, other user/session, service, elevated or high integrity are denied',()=>{
 for(const overrides of [{critical:true},{protection:0},{sid:[8,7,6,5,4,3,2,1]},{session:0},{session:2},{elevated:1},{level:16384},{path:'C:\\Defender\\notepad.exe'},{path:'C:\\Apps\\unknown.exe'}]) {
  const f=fake(overrides),h=f.open(12345);assert.equal(h.read().eligible,false,JSON.stringify(overrides));h.close();assert.equal(f.calls.some(c=>c[0]==='terminate'),false);
 }
});
test('unknown criticality or access denied never falls back to shell/taskkill',()=>{assert.throws(()=>fake({denied:true}).open(12345),e=>e.win32Code===5);const h=fake({criticalUnknown:true}).open(12345);assert.throws(()=>h.read());h.close();});
test('security/own/unknown/network images fail closed; ordinary image is a limited allowlist',()=>{
 for(const image of ['C:\\CyberSafe\\notepad.exe','C:\\Security\\chrome.exe','C:\\Apps\\MsMpEng.exe','C:\\Apps\\scan-engine.exe','C:\\Apps\\random.exe','\\\\server\\notepad.exe'])assert.equal(ordinaryUserImage(image),false,image);
 assert.equal(ordinaryUserImage('C:\\Windows\\System32\\notepad.exe'),true);
});

test('own service, parent and system PID cannot become eligible even with an ordinary image',()=>{for(const pid of [process.pid,process.ppid,4]){const f=fake(),lease=f.open(pid);assert.equal(lease.read().eligible,false);lease.close();assert.equal(f.calls.some(c=>c[0]==='terminate'),false)}});
