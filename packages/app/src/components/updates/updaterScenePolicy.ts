/** Presentation only; never changes protection, engines or update policy. */
export function updaterScenePolicy(input:{gpu:boolean;animate:boolean;systemReduced:boolean;forceStatic:boolean}){
 return {render3d:input.gpu&&!input.systemReduced&&!input.forceStatic,animate:input.animate&&!input.systemReduced&&!input.forceStatic,maxFps:30,dpr:1.25};
}
