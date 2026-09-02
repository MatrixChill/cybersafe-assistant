import type { HardwareSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";
export declare class HardwareHealthEngine {
    private lastSnapshot;
    private fastMetrics;
    private mediumMetrics;
    private slowMetrics;
    private staticMetrics;
    private initialized;
    private lastFastTick;
    private lastMediumTick;
    private lastSlowTick;
    /** Convert Windows OS version to human-readable name */
    private getWindowsVersionName;
    /** Get actual physical CPU cores (not logical threads on Windows) */
    private getPhysicalCores;
    /** Try to detect GPU with fallbacks */
    private detectGpu;
    init(): Promise<void>;
    getSnapshot(processes?: ProcessSnapshot[]): Promise<HardwareSnapshot>;
    getLastSnapshot(): HardwareSnapshot | null;
    private calculateStress;
}
