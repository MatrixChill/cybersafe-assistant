import { createRequire } from "node:module";
import path from "node:path";
import type { TerminationIdentity, TerminationLease } from "./safe-process-termination.js";
// Closed first-release policy: unknown applications are refused, including
// unknown security products. This is deliberately narrower than Windows ACLs.
export const TERMINABLE_USER_APPS: ReadonlySet<string> = new Set([
    "notepad.exe", "mspaint.exe", "calculatorapp.exe", "notepad++.exe",
    "winword.exe", "excel.exe", "powerpnt.exe", "firefox.exe", "chrome.exe",
    "msedge.exe", "vlc.exe", "7zfm.exe", "termination-fixture.exe",
]);
export function ordinaryUserImage(image: string): boolean {
    const name = path.win32.basename(image).toLowerCase();
    return path.win32.isAbsolute(image) && !image.startsWith("\\\\") &&
        TERMINABLE_USER_APPS.has(name) && !/cybersafe|defender|antivirus|security|crowdstrike|sentinel|kaspersky|eset|avast|avg|sophos|bitdefender|malwarebytes/i.test(image);
}
type Fn = (...args: any[]) => any;
interface Ffi {
    load(name: string): {
        func(signature: string): Fn;
    };
    decode(pointer: any, type: string, count?: number): any;
}
/** Lazy binding: importing this module never opens or terminates a process. */
export function createWindowsTerminationOpener(): (pid: number) => TerminationLease {
    if (process.platform !== "win32" || process.arch !== "x64")
        throw new Error("native-unavailable");
    const ffi = createRequire(import.meta.url)("koffi") as Ffi;
    return bindWindowsTermination(ffi);
}
/** Exported for FFI-contract mocks. There is no shell/subprocess fallback. */
export function bindWindowsTermination(ffi: Ffi): (pid: number) => TerminationLease {
    const k = ffi.load("kernel32.dll"), a = ffi.load("advapi32.dll");
    const open = k.func("void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
    const close = k.func("bool __stdcall CloseHandle(void *handle)");
    const last = k.func("uint32 __stdcall GetLastError()");
    const times = k.func("bool __stdcall GetProcessTimes(void *handle, void *creation, void *exitTime, void *kernel, void *user)");
    const image = k.func("bool __stdcall QueryFullProcessImageNameW(void *handle, uint32 flags, void *name, void *size)");
    const critical = k.func("bool __stdcall IsProcessCritical(void *handle, void *critical)");
    const protection = k.func("bool __stdcall GetProcessInformation(void *handle, int kind, void *info, uint32 size)");
    const wait = k.func("uint32 __stdcall WaitForSingleObject(void *handle, uint32 milliseconds)");
    const terminate = k.func("bool __stdcall TerminateProcess(void *handle, uint32 exitCode)");
    const current = k.func("void * __stdcall GetCurrentProcess()");
    const tokenOpen = a.func("bool __stdcall OpenProcessToken(void *process, uint32 access, void *token)");
    const tokenInfo = a.func("bool __stdcall GetTokenInformation(void *token, int kind, void *data, uint32 size, void *needed)");
    const sidLength = a.func("uint32 __stdcall GetLengthSid(void *sid)");
    const fail = (): never => { throw Object.assign(new Error("windows-process-operation"), { win32Code: Number(last()) }); };
    const token = (h: unknown) => {
        const out = Buffer.alloc(8);
        if (!tokenOpen(h, 8, out))
            fail();
        const t = ffi.decode(out, "void *");
        try {
            const get = (kind: number, size = 4096) => { const data = Buffer.alloc(size); if (!tokenInfo(t, kind, data, size, Buffer.alloc(4)))
                fail(); return data; };
            const user = get(1);
            const sid = ffi.decode(user, "void *");
            const length = Number(sidLength(sid));
            if (length < 8 || length > 68)
                throw new Error("invalid-sid");
            const sidHex = Buffer.from(ffi.decode(sid, "uint8_t", length)).toString("hex");
            const session = get(12, 4).readUInt32LE(0), elevated = get(20, 4).readUInt32LE(0) !== 0;
            const integrity = get(25);
            const isid = ffi.decode(integrity, "void *");
            const ilen = Number(sidLength(isid));
            if (ilen < 12 || ilen > 68)
                throw new Error("invalid-integrity");
            const ibytes = Buffer.from(ffi.decode(isid, "uint8_t", ilen));
            const level = ibytes.readUInt32LE(ilen - 4);
            return { sidHex, session, elevated, level };
        }
        finally {
            close(t);
        }
    };
    return (pid: number) => {
        // PROCESS_TERMINATE | QUERY_LIMITED_INFORMATION | SYNCHRONIZE only.
        const h = open(0x00101001, false, pid);
        if (!h)
            fail();
        let closed = false;
        const exited = () => { const r = Number(wait(h, 0)); if (r === 0)
            return true; if (r === 258)
            return false; return fail(); };
        return {
            exited,
            read: () => {
                const c = Buffer.alloc(8);
                if (!times(h, c, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)))
                    fail();
                const size = Buffer.alloc(4);
                size.writeUInt32LE(32768);
                const text = Buffer.alloc(65536);
                if (!image(h, 0, text, size))
                    fail();
                const full = text.subarray(0, size.readUInt32LE(0) * 2).toString("utf16le");
                const crit = Buffer.alloc(4), prot = Buffer.alloc(4);
                if (!critical(h, crit) || !protection(h, 7, prot, 4))
                    fail();
                const self = token(current()), target = token(h);
                const eligible = pid > 100 && pid !== process.pid && pid !== process.ppid && !exited() && ordinaryUserImage(full) &&
                    crit.readUInt32LE(0) === 0 && prot.readUInt32LE(0) === 0xfffffffe &&
                    self.sidHex === target.sidHex && self.session > 0 && self.session === target.session &&
                    !self.elevated && !target.elevated && self.level === 8192 && target.level <= 8192;
                const creation = c.readBigUInt64LE(0);
                return { pid, name: path.win32.basename(full), path: full, creation: creation.toString(),
                    startedAt: new Date(Number(creation / 10000n - 11644473600000n)).toISOString().replace(/\.(\d{3})Z$/, (_match, ms: string) => `.${ms}${(creation % 10000n).toString().padStart(4, "0")}Z`), eligible } satisfies TerminationIdentity;
            },
            terminate: () => { if (!terminate(h, 0x43534101))
                fail(); },
            close: () => { if (!closed) {
                closed = true;
                close(h);
            } },
        };
    };
}
