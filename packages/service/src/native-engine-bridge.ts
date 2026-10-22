import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type { EngineSubsystemHealth } from '@cybersafe/shared-types';

export interface NativeScanResult {
  path: string;
  file_size: number;
  sha256: string;
  entropy: number;
  score: number;
  level: string;
  reasons: string[];
  pe: {
    valid_pe: boolean;
    is_64: boolean;
    machine: number;
    sections: number;
    writable_executable_section: boolean;
    no_imports: boolean;
    suspicious_section: boolean;
  };
}

export interface NativeScanOutcome {
  ok: boolean;
  result: NativeScanResult | null;
  error?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class NativeEngineBridge {
  private static _health: EngineSubsystemHealth = { status: "unavailable", detail: "Ainda não verificado" };
  private static binaryPath: string | null = null;
  private static checked = false;

  private static getBinaryPath(): string {
    // Build empacotado: o electron-builder copia o binario via extraResources para
    // <resources>/scan-engine.exe (fora do asar). Em dev resourcesPath nao existe
    // e os 4 candidatos de arvore de repo abaixo continuam a resolver.
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    // Check multiple potential locations for the binary
    const possiblePaths = [
      ...(resourcesPath ? [path.resolve(resourcesPath, "scan-engine.exe")] : []),
      path.resolve(__dirname, "../../native-engine/build/Release/scan-engine.exe"),
      path.resolve(process.cwd(), 'packages/native-engine/build/Release/scan-engine.exe'),
      path.resolve(process.cwd(), 'packages/native-engine/build/scan-engine.exe'),
      path.resolve(process.cwd(), 'packages/native-engine/bin/scan-engine.exe'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return possiblePaths[0];
  }

  /** Verifica a disponibilidade do binário e expõe o estado de saúde do motor. */
  public static checkAvailability(): EngineSubsystemHealth {
    this.binaryPath = this.getBinaryPath();
    this.checked = true;
    if (fs.existsSync(this.binaryPath)) {
      this._health = { status: "active", detail: `Motor nativo ativo (${this.binaryPath})` };
    } else {
      this._health = { status: "unavailable", detail: "scan-engine.exe não foi encontrado (não integrado)" };
    }
    return this._health;
  }

  public static get health(): EngineSubsystemHealth {
    if (!this.checked) return this.checkAvailability();
    return this._health;
  }

  private static activeProcesses = new Set<import('child_process').ChildProcess>();

  public static dispose() {
    console.log(`[NativeEngine] Terminando ${this.activeProcesses.size} processos de scan pendentes...`);
    for (const child of this.activeProcesses) {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        // ignore errors during kill
      }
    }
    this.activeProcesses.clear();
  }

  public static async scan(filePath: string): Promise<NativeScanOutcome> {
    const health = this.checkAvailability();

    if (health.status !== "active") {
      const unavailable: NativeScanOutcome = {
        ok: false,
        result: null,
        error: health.detail ?? "Native engine unavailable",
      };
      return unavailable;
    }

    const binPath = this.binaryPath!;

    return new Promise((resolve) => {
      const child = spawn(binPath, [filePath], { windowsHide: true });
      this.activeProcesses.add(child);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // 30 second timeout
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        console.error(`[NativeEngine] Timeout scanning ${filePath}`);
        this.activeProcesses.delete(child);
        this._health = { status: "degraded", detail: "Timeout durante scan nativo" };
        resolve({ ok: false, result: null, error: "Native engine timeout" });
      }, 30000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child);

        if (code !== 0 && code !== null) {
          console.error(`[NativeEngine] Process exited with code ${code}. Error: ${stderr}`);
          this._health = { status: "degraded", detail: `Native engine exit code ${code}` };
          return resolve({ ok: false, result: null, error: stderr.trim() || `exit code ${code}` });
        }

        if (code === null) {
          // Process was killed
          return resolve({ ok: false, result: null, error: "Native engine killed" });
        }

        try {
          const result = JSON.parse(stdout) as NativeScanResult;
          resolve({ ok: true, result });
        } catch (e) {
          console.error(`[NativeEngine] Failed to parse output: ${stdout}`, e);
          this._health = { status: "degraded", detail: "Output nativo não parseável" };
          resolve({ ok: false, result: null, error: "Failed to parse native output" });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child);
        console.error(`[NativeEngine] Failed to start process:`, err);
        this._health = { status: "error", detail: `O arranque do motor nativo falhou: ${err.message}` };
        resolve({ ok: false, result: null, error: err.message });
      });
    });
  }
}