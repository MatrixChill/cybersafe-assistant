import type { HardwareSnapshot } from "@cybersafe/shared-types";
export declare class HardwareHealthEngine {
    private lastSnapshot;
    getSnapshot(): Promise<HardwareSnapshot>;
    getLastSnapshot(): HardwareSnapshot | null;
    private calculateStress;
}
