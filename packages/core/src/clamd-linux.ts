import net from "node:net";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ClamavFileOutcome } from "./clamav.js";

export interface ClamdResult {
  outcome: ClamavFileOutcome;
  /** A closed client connection does NOT prove that clamd stopped scanning. */
  uncertain: boolean;
  /** Only a complete protocol response proves terminal server work. */
  completion: Promise<boolean>;
}

/** Local INSTREAM only. No path commands, TCP, daemon management or root.
 * The operator must use the supplied clamd configuration (archive/limit alerts).
 * Socket and parent ownership protect contents from unrelated local users. */
export class ClamdUnixClient {
  private sockets = new Set<net.Socket>();
  private disposed = false;
  constructor(private readonly socketPath: string) {}

  dispose() { this.disposed = true; for (const socket of this.sockets) socket.destroy(); }

  async scan(file: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ClamdResult> {
    const error = (reason: ClamavFileOutcome["reason"] = "exit-unknown"): ClamavFileOutcome => ({
      file, verdict: "error", reason, detail: "ClamAV persistente não concluiu a análise; cobertura não confirmada.",
    });
    const refused = (reason?: ClamavFileOutcome["reason"]): ClamdResult => ({ outcome: error(reason), uncertain: false, completion: Promise.resolve(true) });
    if (this.disposed || options.signal?.aborted) return refused("aborted");
    let input: Awaited<ReturnType<typeof fs.open>>;
    try {
      if (process.platform !== "linux" || !path.isAbsolute(this.socketPath)) return refused();
      const uid = process.getuid!();
      const parent = path.dirname(this.socketPath);
      const p = await fs.lstat(parent), s = await fs.lstat(this.socketPath);
      if (!p.isDirectory() || await fs.realpath(parent) !== parent || (p.uid !== 0 && p.uid !== uid)
        || (p.mode & 0o022) || !s.isSocket() || (s.uid !== 0 && s.uid !== uid) || (s.mode & 0o077)) return refused();
      input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await input.stat();
      if (!stat.isFile() || stat.size > 100 * 1024 * 1024) { await input.close(); return refused("limits-exceeded"); }
    } catch { return refused("file-unreadable"); }
    if (this.disposed || options.signal?.aborted) { await input.close(); return refused("aborted"); }

    return new Promise<ClamdResult>(resolve => {
      const socket = net.createConnection(this.socketPath);
      this.sockets.add(socket);
      let settled = false, sent = false, response = Buffer.alloc(0), terminal = false;
      let complete!: (value: boolean) => void;
      const completion = new Promise<boolean>(r => { complete = r; });
      const finish = (outcome: ClamavFileOutcome, uncertain: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        resolve({ outcome, uncertain, completion });
      };
      // Do not close on timeout: a late complete response is the only safe way
      // to return the global slot. The socket is unref'd, not a shutdown blocker.
      const expire = (reason: "timeout" | "aborted") => {
        finish(error(reason), sent && !terminal);
        if (!sent) socket.destroy(); else socket.unref();
      };
      const abort = () => expire("aborted");
      const timer = setTimeout(() => expire("timeout"), Math.max(1, options.timeoutMs));
      options.signal?.addEventListener("abort", abort, { once: true });
      socket.on("data", chunk => {
        response = Buffer.concat([response, chunk]);
        if (response.length > 8192) { socket.destroy(); return; }
        const end = response.indexOf(0);
        if (end < 0) return;
        terminal = true; complete(true);
        const line = response.subarray(0, end).toString("utf8");
        let outcome = error();
        if (line === "stream: OK") outcome = { file, verdict: "clean" };
        const found = /^stream: ([^\r\n\0]{1,256}) FOUND$/.exec(line);
        if (found) outcome = /^Heuristics\.Limits\.Exceeded\b/.test(found[1])
          ? error("limits-exceeded") : { file, verdict: "detected", signature: found[1] };
        finish(outcome, false); socket.end();
      });
      socket.on("error", () => finish(error(), sent && !terminal));
      socket.on("close", () => {
        this.sockets.delete(socket); complete(terminal);
        finish(error(), sent && !terminal);
      });
      const write = (bytes: Buffer) => new Promise<void>((done, reject) => {
        if (socket.destroyed) return reject(new Error("socket closed"));
        socket.write(bytes, e => e ? reject(e) : done());
      });
      socket.on("connect", () => { void (async () => {
        try {
          if (settled) { socket.destroy(); return; }
          sent = true;
          await write(Buffer.from("zINSTREAM\0"));
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            if (socket.destroyed) return;
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            const length = Buffer.alloc(4); length.writeUInt32BE(bytesRead);
            await write(length); await write(buffer.subarray(0, bytesRead));
          }
          await write(Buffer.alloc(4));
        } catch { socket.destroy(); }
        finally { await input.close().catch(() => undefined); }
      })(); });
      socket.once("close", () => { void input.close().catch(() => undefined); });
    });
  }
}
