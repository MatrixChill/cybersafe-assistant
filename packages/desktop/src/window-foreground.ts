/** Initial reveal is bounded and independent from service/API readiness.
 * All effects are window-local; Windows may still deny foreground activation. */
export const INITIAL_REVEAL_DEADLINE_MS = 1500;
interface WindowLike {
  isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean;
  show(): void; focus(): void; restore(): void;
  once(event:string,listener:()=>void):unknown;
  on(event:string,listener:()=>void):unknown;
  removeListener(event:string,listener:()=>void):unknown;
  webContents: {once(event:string,listener:()=>void):unknown;removeListener(event:string,listener:()=>void):unknown};
}
export function installInitialWindowReveal(win:WindowLike,options:{hidden:boolean;isQuitting:()=>boolean}) {
  let pending=!options.hidden;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const cancel=()=>{
    pending=false;
    if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    win.removeListener("ready-to-show",initial);
    if(!win.isDestroyed())win.webContents.removeListener("did-finish-load",initial);
    win.removeListener("close",cancel);
    win.removeListener("minimize",cancel);
    win.removeListener("show",cancel);
  };
  const reveal=()=>{
    if(options.isQuitting()||win.isDestroyed())return;
    if(win.isMinimized())win.restore();
    if(!win.isVisible())win.show();
    win.focus();
  };
  const initial=()=>{if(!pending)return;cancel();reveal();};
  const dispose=()=>{cancel();if(!win.isDestroyed())win.removeListener("closed",dispose);};
  // Register before loadFile/loadURL: a fast renderer must not outrun listeners.
  if(pending){
    win.once("ready-to-show",initial);
    win.webContents.once("did-finish-load",initial);
    win.on("close",cancel);
    win.on("minimize",cancel);
    win.on("show",cancel);
    timer=setTimeout(initial,INITIAL_REVEAL_DEADLINE_MS);
    timer.unref?.();
  }
  win.once("closed",dispose);
  return {requestForeground:()=>{cancel();reveal();},dispose};
}
