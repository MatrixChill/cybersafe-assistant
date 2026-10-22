import fs from "node:fs/promises";
import path from "node:path";
export class SignatureDatabase {
    records = new Map();
    async load(filePath) {
        try {
            const raw = await fs.readFile(filePath, "utf-8");
            const parsed = JSON.parse(raw);
            this.records = new Map(parsed.map((record) => [record.sha256.toLowerCase(), record]));
        }
        catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
    async save(filePath) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(Array.from(this.records.values()), null, 2), "utf-8");
    }
    match(sha256) {
        return this.records.get(sha256.toLowerCase());
    }
    add(record) {
        this.records.set(record.sha256.toLowerCase(), record);
    }
}
