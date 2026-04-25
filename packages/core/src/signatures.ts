import fs from "node:fs/promises";
import path from "node:path";

export interface SignatureRecord {
  sha256: string;
  family: string;
  severity: "low" | "medium" | "high" | "critical";
  source: string;
}

export class SignatureDatabase {
  private records = new Map<string, SignatureRecord>();

  async load(filePath: string) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as SignatureRecord[];
      this.records = new Map(parsed.map((record) => [record.sha256.toLowerCase(), record]));
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async save(filePath: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(Array.from(this.records.values()), null, 2),
      "utf-8",
    );
  }

  match(sha256: string): SignatureRecord | undefined {
    return this.records.get(sha256.toLowerCase());
  }

  add(record: SignatureRecord) {
    this.records.set(record.sha256.toLowerCase(), record);
  }
}
