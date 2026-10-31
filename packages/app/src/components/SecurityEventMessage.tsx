import type {SecurityEvent} from "@cybersafe/shared-types";
import {securityEventPresentation} from "../lib/securityEventPresentation";
/** Used by transient notifications too: raw process summaries are never the headline. */
export function SecurityEventMessage({event}:{event:SecurityEvent}) {
 const p=securityEventPresentation(event);
 return <div className="min-w-0 max-w-full">
  <p tabIndex={0} className="text-xs font-bold text-foreground mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{p.text}</p>
  {p.provenance!=="other" && <p className="text-[10px] text-muted-foreground">{p.note}</p>}
  {p.provenance!=="other" && event.summary && <details><summary className="text-xs">Ver registo original</summary><pre tabIndex={0} className="max-h-32 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-xs">{event.summary}</pre></details>}
 </div>;
}
