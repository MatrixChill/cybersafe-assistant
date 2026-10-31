import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paintedCssColorToHex,resolveTitleBarColors} from '../src/lib/titlebarColor';
function browser(pixel:number[],fail=false){
 let painted='';
 (globalThis as any).CSS={supports:(_property:string,value:string)=>value.startsWith('oklch(')||value.startsWith('color(')};
 (globalThis as any).document={createElement:()=>({width:0,height:0,getContext:()=>({clearRect(){},set fillStyle(v:string){painted=v;},fillRect(){},getImageData(){if(fail)throw Error('unavailable');return {data:pixel};}})})};
 return ()=>{delete (globalThis as any).CSS;delete (globalThis as any).document;return painted;};
}
test('cores CSS modernas usam o pixel sRGB pintado, não a reserva escura',()=>{
 const restore=browser([246,247,248,255]);try{
 const colors=resolveTitleBarColors('oklch(0.98 0.01 240)',null,undefined,paintedCssColorToHex);
 assert.equal(colors.color,'#f6f7f8');assert.equal(colors.symbolColor,'#1b232c');
 }finally{assert.equal(restore(),'oklch(0.98 0.01 240)');}
});
test('rasterização falhada e superfície transparente usam a reserva existente',()=>{
 let restore=browser([0,0,0,0]);try{assert.equal(paintedCssColorToHex('oklch(0 0 0 / 0)'),null);}finally{restore();}
 restore=browser([0,0,0,255],true);try{assert.equal(resolveTitleBarColors('color(srgb 1 1 1)',null,undefined,paintedCssColorToHex).color,'#090b12');}finally{restore();}
});
test('rgb continua a resolver sem DOM ou canvas',()=>assert.equal(paintedCssColorToHex('rgb(24, 26, 30)'),'#181a1e'));
