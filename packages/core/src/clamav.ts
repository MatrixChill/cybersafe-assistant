import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { EngineSubsystemHealth } from "@cybersafe/shared-types";

const execAsync = promisify(exec);

export interface ClamavScanResult {
  detected: boolean;
  status: EngineSubsystemHealth;
}

export class ClamavBridge {
  private _health: EngineSubsystemHealth = { status: "unavailable", detail: "Not checked" };
  private probePromise: Promise<boolean> | null = null;

  get health(): EngineSubsystemHealth {
    return this._health;
  }

  /** Verifica se o binário clamscan existe e responde. Resultado em cache. */
  async isAvailable(force = false): Promise<boolean> {
    if (this.probePromise && !force) return this.probePromise;
    this.probePromise = this.probe();
    return this.probePromise;
  }

  private async probe(): Promise<boolean> {
    try {
      const { stdout } = await execAsync("clamscan --version", { timeout: 5000, windowsHide: true });
      const ok = stdout.includes("ClamAV");
      this._health = ok
        ? { status: "active", detail: "ClamAV binary available" }
        : { status: "unavailable", detail: "clamscan --version did not report ClamAV" };
      return ok;
    } catch (err: any) {
      this._health = {
        status: "unavailable",
        detail: `clamscan not found or failed: ${err?.message ?? "unknown"}`,
      };
      return false;
    }
  }

  /**
   * Executa clamscan num ficheiro. Apenas invocado se o binário existir;
   * caso contrário reporta unavailable em vez de simular proteção.
   */
  async scanFile(filePath: string): Promise<ClamavScanResult> {
    const available = await this.isAvailable();
    if (!available) {
      return { detected: false, status: this._health };
    }

    try {
      await execAsync(`clamscan --no-summary "${filePath}"`, { timeout: 10000, windowsHide: true });
      return { detected: false, status: this._health };
    } catch (error: any) {
      if (error?.status === 1) {
        this._health = { status: "active", detail: "ClamAV binary available" };
        return { detected: true, status: this._health };
      }
      if (error?.code === "ENOENT") {
        this._health = { status: "unavailable", detail: "clamscan não encontrado" };
        return { detected: false, status: this._health };
      }
      this._health = { status: "degraded", detail: `clamscan exit ${error?.status ?? error?.code ?? "unknown"}` };
      return { detected: false, status: this._health };
    }
  }
}