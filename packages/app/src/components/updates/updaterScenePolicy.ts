/** Presentation only; never changes protection, engines or update policy. */
import type {UpdaterPhase} from "./updaterWindowModel";
export function updaterScenePolicy(input:{gpu:boolean;animate:boolean;systemReduced:boolean;forceStatic:boolean;phase:UpdaterPhase}){
 // A failed update stops updater work, not the user's chosen visual motion.
 return {render3d:input.gpu&&!input.systemReduced&&!input.forceStatic,animate:input.animate&&!input.systemReduced&&!input.forceStatic,maxFps:30,dpr:1.25};
}
