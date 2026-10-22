export interface SignatureRecord {
    sha256: string;
    family: string;
    severity: "low" | "medium" | "high" | "critical";
    source: string;
}
export declare class SignatureDatabase {
    private records;
    load(filePath: string): Promise<void>;
    save(filePath: string): Promise<void>;
    match(sha256: string): SignatureRecord | undefined;
    add(record: SignatureRecord): void;
}
