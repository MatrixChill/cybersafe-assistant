import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class NativeEngineBridge {
  private static getBinaryPath(): string {
    // Check multiple potential locations for the binary
    const possiblePaths = [
      path.resolve(__dirname, "../../native-engine/build/Release/scan-engine.exe"),
      path.resolve(process.cwd(), 'packages/native-engine/build/Release/scan-engine.exe'),
      path.resolve(process.cwd(), 'packages/native-engine/build/scan-engine.exe'),
      path.resolve(process.cwd(), 'packages/native-engine/bin/scan-engine.exe'),
      path.resolve(process.cwd(), 'packages/native-engine/build/scan-engine.exe'),
      path.resolve(process.cwd(), 'packages/native-engine/bin/scan-engine.exe')
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Return the first one as default if none exist (will fail gracefully later)
    return possiblePaths[0];
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

  public static async scan(filePath: string): Promise<NativeScanResult | null> {
    const binPath = this.getBinaryPath();

    if (!fs.existsSync(binPath)) {
      console.warn(`[NativeEngine] Binary not found at ${binPath}. Skipping native scan.`);
      return null;
    }

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
        resolve(null);
      }, 30000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child);

        if (code !== 0 && code !== null) {
          console.error(`[NativeEngine] Process exited with code ${code}. Error: ${stderr}`);
          return resolve(null);
        }

        if (code === null) {
          // Process was killed
          return resolve(null);
        }

        try {
          const result = JSON.parse(stdout) as NativeScanResult;
          resolve(result);
        } catch (e) {
          console.error(`[NativeEngine] Failed to parse output: ${stdout}`, e);
          resolve(null);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child);
        console.error(`[NativeEngine] Failed to start process:`, err);
        resolve(null);
      });
    });
  }
}
