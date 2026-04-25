import fs from "node:fs/promises";
import path from "node:path";

export interface YaraRule {
  id: string;
  label: string;
  severity: "high" | "critical";
  strings: string[];
}

export interface YaraMatch {
  ruleId: string;
  label: string;
  severity: "high" | "critical";
}

export class YaraEngine {
  private rules: YaraRule[] = [];

  async load(filePath: string) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      this.rules = JSON.parse(raw) as YaraRule[];
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async save(filePath: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(this.rules, null, 2), "utf-8");
  }

  match(buffer: Buffer): YaraMatch[] {
    const haystack = buffer.toString("latin1").toLowerCase();
    return this.rules
      .filter((rule) => rule.strings.some((entry) => haystack.includes(entry.toLowerCase())))
      .map((rule) => ({
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
      }));
  }
}
