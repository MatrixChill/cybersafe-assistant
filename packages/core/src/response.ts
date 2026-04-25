import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { AnalysisResult, QuarantineEntry } from "@cybersafe/shared-types";

export class QuarantineManager {
  private readonly quarantineDir: string;
  private readonly manifestPath: string;
  private entries = new Map<string, QuarantineEntry>();

  constructor(baseDir: string) {
    this.quarantineDir = path.join(baseDir, "quarantine");
    this.manifestPath = path.join(this.quarantineDir, "manifest.json");
  }

  async init() {
    await fs.mkdir(this.quarantineDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as QuarantineEntry[];
      this.entries = new Map(parsed.map((entry) => [entry.id, entry]));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  private async flush() {
    await fs.writeFile(
      this.manifestPath,
      JSON.stringify(Array.from(this.entries.values()), null, 2),
      "utf-8",
    );
  }

  async quarantine(analysis: AnalysisResult): Promise<QuarantineEntry | null> {
    try {
      const id = crypto.randomUUID();
      const quarantinePath = path.join(this.quarantineDir, `${id}.quarantine`);
      await fs.rename(analysis.artifactPath, quarantinePath);
      const entry: QuarantineEntry = {
        id,
        originalPath: analysis.artifactPath,
        quarantinePath,
        fileName: analysis.fileName,
        sha256: analysis.sha256,
        verdict: analysis.verdict,
        riskScore: analysis.riskScore,
        quarantinedAt: new Date().toISOString(),
      };
      this.entries.set(id, entry);
      await this.flush();
      return entry;
    } catch {
      return null;
    }
  }

  async restore(id: string, restoredBy = "user"): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;

    try {
      await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });
      await fs.rename(entry.quarantinePath, entry.originalPath);
      entry.restoredAt = new Date().toISOString();
      entry.restoredBy = restoredBy;
      this.entries.delete(id);
      await this.flush();
      return true;
    } catch {
      return false;
    }
  }

  async delete(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    try {
      await fs.rm(entry.quarantinePath, { force: true });
      this.entries.delete(id);
      await this.flush();
      return true;
    } catch {
      return false;
    }
  }

  list(): QuarantineEntry[] {
    return Array.from(this.entries.values()).sort((a, b) =>
      b.quarantinedAt.localeCompare(a.quarantinedAt),
    );
  }
}

export async function killProcessTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
