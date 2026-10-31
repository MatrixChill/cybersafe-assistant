import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { AiCredentialsStore } from "./ai-credentials-store.js";

/** Private parent/child IPC; no HTTP endpoint, argv, URL, env or logging of keys. */
export async function configureAiChild(child: ChildProcess | null, store: AiCredentialsStore): Promise<boolean> {
  if (!child?.connected || !child.send || child.exitCode !== null || child.signalCode !== null) return false;
  const id = randomUUID();
  const apiKey = store.readKey();
  const provider = store.getProvider();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true; clearTimeout(timer);
      child.off("message", onMessage); child.off("exit", onExit); child.off("disconnect", onExit);
      resolve(ok);
    };
    const onExit = () => finish(false);
    const onMessage = (message: unknown) => {
      const m = message as { type?: string; id?: string; ok?: boolean } | null;
      if (m?.type === "cybersafe-ai-configured" && m.id === id) finish(m.ok === true);
    };
    const timer = setTimeout(() => finish(false), 5000);
    child.on("message", onMessage); child.once("exit", onExit); child.once("disconnect", onExit);
    try { child.send!({ type: "cybersafe-ai-configure", id, provider, apiKey }, (error) => { if (error) finish(false); }); }
    catch { finish(false); }
  });
}
