// DEV render export only. No preload, IPC, updater actions or installation.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
app.whenReady().then(async()=>{
 const output=process.env.CYBERSAFE_ORBITAL_EXPORT;
 if(!output||!path.isAbsolute(output))throw Error('Absolute CYBERSAFE_ORBITAL_EXPORT required');
 const win=new BrowserWindow({width:960,height:640,useContentSize:true,show:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 await win.loadURL('http://127.0.0.1:5183/?lab=updater&art=installer');
 for(let i=0;i<100;i++){
  const ready=await win.webContents.executeJavaScript(`!!document.querySelector('#installer-orbital-export [data-renderer="webgl"] canvas')`);
  if(ready)break;
  if(i===99)throw Error('Real WebGL scene unavailable; no fabricated export');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 await new Promise(resolve=>setTimeout(resolve,1500));
 const png=(await win.webContents.capturePage()).toPNG();
 fs.writeFileSync(output,png,{flag:'wx'});
 console.log(JSON.stringify({output,bytes:png.length,sha256:crypto.createHash('sha256').update(png).digest('hex'),scene:'UpdaterScene/CoreScene depth',liveAnimation:false}));
 win.destroy();app.quit();
}).catch(error=>{console.error(error.message);app.exit(1)});
