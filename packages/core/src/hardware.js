import * as si from "systeminformation";
import * as os from "os";
export class HardwareHealthEngine {
    lastSnapshot = null;
    fastMetrics = {
        cpuUsage: 0,
        ramPercent: 0,
        usedRamGb: 0,
        totalRamGb: 0,
    };
    mediumMetrics = {
        diskPercent: 0,
        diskUsedGb: 0,
        diskTotalGb: 0,
        fsType: "unknown",
    };
    slowMetrics = {
        rxSec: 0,
        txSec: 0,
        interfaceName: "unknown",
        gpu: null,
    };
    staticMetrics = {
        cpuModel: "Unknown",
        cpuCores: 0,
        cpuSpeed: 0,
        platform: "unknown",
        osVersion: "unknown",
        hostname: "unknown",
        hasBattery: false,
        batteryPercent: 0,
        isCharging: false,
        timeRemaining: null,
    };
    initialized = false;
    lastFastTick = 0;
    lastMediumTick = 0;
    lastSlowTick = 0;
    /** Convert Windows OS version to human-readable name */
    getWindowsVersionName(release) {
        if (!release)
            return "Unknown";
        // Parse Windows version numbers
        const match = release.match(/^(\d+)/);
        if (!match)
            return release;
        const major = parseInt(match[1]);
        // Windows NT versions
        if (major === 10)
            return "Windows 10/11";
        if (major === 11)
            return "Windows 11";
        if (major >= 20)
            return `Windows ${major / 10}`;
        if (major === 6)
            return "Windows Vista/7/8";
        return release;
    }
    /** Get actual physical CPU cores (not logical threads on Windows) */
    getPhysicalCores(cpuInfo) {
        if (!cpuInfo)
            return 0;
        // Prefer physical cores if available, otherwise use logical cores
        if (cpuInfo.physicalCores && cpuInfo.physicalCores > 0) {
            return cpuInfo.physicalCores;
        }
        // Fallback: on Windows, try to detect hyperthreading
        if (cpuInfo.cores && cpuInfo.cores > 0) {
            // If we have hyperthreading info, use it
            if (cpuInfo.hyperthreading) {
                return cpuInfo.cores / 2;
            }
            return cpuInfo.cores;
        }
        return cpuInfo.cores ?? cpuInfo.logicalCores ?? 0;
    }
    /** Try to detect GPU with fallbacks */
    async detectGpu() {
        try {
            // First try: graphics() which returns controllers
            const graphics = await si.graphics().catch(() => null);
            if (graphics?.controllers && graphics.controllers.length > 0) {
                const gpu = graphics.controllers[0];
                return {
                    usagePercent: gpu.utilizationGpu ?? null,
                    vramTotalMb: gpu.vram ?? null,
                    vramUsedMb: null,
                    temperature: gpu.temperatureGpu ?? null,
                    model: gpu.model ?? "Unknown",
                };
            }
            // Second try: osInfo sometimes has GPU info
            const osInfo = await si.osInfo().catch(() => null);
            if (osInfo?.distro && osInfo.distro.includes("NVIDIA")) {
                return { model: "NVIDIA GPU (detected)" };
            }
            // No GPU detected
            return null;
        }
        catch (err) {
            console.error("[Hardware] GPU detection error", err);
            return null;
        }
    }
    async init() {
        if (this.initialized)
            return;
        try {
            const [cpuInfo, osInfo, battery] = await Promise.all([
                si.cpu().catch(() => null),
                si.osInfo().catch(() => null),
                si.battery().catch(() => null)
            ]);
            this.staticMetrics.cpuModel = cpuInfo?.brand ?? "Unknown";
            this.staticMetrics.cpuCores = this.getPhysicalCores(cpuInfo);
            this.staticMetrics.cpuSpeed = cpuInfo?.speed ?? 0;
            this.staticMetrics.platform = osInfo?.platform ?? "unknown";
            // Convert OS version to human-readable format
            this.staticMetrics.osVersion = osInfo?.distro
                ? osInfo.distro
                : this.getWindowsVersionName(osInfo?.release ?? "unknown");
            this.staticMetrics.hostname = osInfo?.hostname ?? "unknown";
            this.staticMetrics.hasBattery = battery?.hasBattery ?? false;
            this.staticMetrics.batteryPercent = battery?.percent ?? 0;
            this.staticMetrics.isCharging = battery?.isCharging ?? false;
            this.staticMetrics.timeRemaining = battery?.timeRemaining && battery.timeRemaining > 0 ? battery.timeRemaining : null;
            this.initialized = true;
        }
        catch (err) {
            console.error("[Hardware] Init error", err);
        }
    }
    async getSnapshot(processes = []) {
        if (!this.initialized) {
            await this.init();
        }
        const now = Date.now();
        // 1. TICK RÁPIDO (Aprox. 1 segundo)
        // Coleta apenas métricas ultra-leves que não usam WMI. Bloqueia minimamente o snapshot.
        if (now - this.lastFastTick >= 1000) {
            this.lastFastTick = now;
            try {
                const cpuLoad = await si.currentLoad().catch(() => null);
                this.fastMetrics.cpuUsage = Math.round(cpuLoad?.currentLoad ?? 0);
                const total = os.totalmem();
                const free = os.freemem();
                const used = total - free;
                this.fastMetrics.totalRamGb = total / (1024 ** 3);
                this.fastMetrics.usedRamGb = used / (1024 ** 3);
                this.fastMetrics.ramPercent = total > 0 ? Math.round((used / total) * 100) : 0;
            }
            catch (err) {
                console.error("[Hardware] Fast tick error", err);
            }
        }
        // 2. TICK MÉDIO (Aprox. 5 segundos)
        // Dispara em background para não bloquear a entrega do snapshot (Fire-and-forget)
        if (now - this.lastMediumTick >= 5000) {
            this.lastMediumTick = now;
            si.fsSize().then((fsSize) => {
                try {
                    if (!fsSize || fsSize.length === 0) {
                        // No filesystems found
                        this.mediumMetrics.diskTotalGb = 0;
                        this.mediumMetrics.diskUsedGb = 0;
                        this.mediumMetrics.diskPercent = 0;
                        this.mediumMetrics.fsType = "unknown";
                        return;
                    }
                    // On Windows, look for C: drive first, otherwise use the first available
                    let primaryFs = fsSize.find(fs => fs.mount === "C:" || fs.mount === "C:\\");
                    if (!primaryFs) {
                        // Try to find any mounted filesystem (not system mounts)
                        primaryFs = fsSize.find(fs => fs.mount &&
                            !fs.mount.includes("Node") &&
                            !fs.mount.includes("Snapshot") &&
                            fs.size && fs.size > 0);
                    }
                    if (!primaryFs && fsSize.length > 0) {
                        primaryFs = fsSize[0];
                    }
                    if (primaryFs && primaryFs.size && primaryFs.size > 0) {
                        this.mediumMetrics.diskTotalGb = primaryFs.size / (1024 ** 3);
                        this.mediumMetrics.diskUsedGb = (primaryFs.used ?? 0) / (1024 ** 3);
                        this.mediumMetrics.diskPercent = Math.max(0, Math.min(100, Math.round(primaryFs.use ?? 0)));
                        this.mediumMetrics.fsType = primaryFs.type ?? "unknown";
                    }
                    else {
                        // Fallback: show UNKNOWN instead of wrong values
                        this.mediumMetrics.diskTotalGb = 0;
                        this.mediumMetrics.diskUsedGb = 0;
                        this.mediumMetrics.diskPercent = 0;
                        this.mediumMetrics.fsType = "unknown";
                    }
                }
                catch (err) {
                    console.error("[Hardware] FS Size processing error", err);
                }
            }).catch(err => console.error("[Hardware] Medium tick error", err));
        }
        // 3. TICK LENTO (Aprox. 10 segundos)
        // Dispara chamadas ultra-pesadas (WMI) em background (Fire-and-forget)
        if (now - this.lastSlowTick >= 10000) {
            this.lastSlowTick = now;
            // Network stats with better error handling
            si.networkStats().then(netStats => {
                try {
                    if (!netStats || netStats.length === 0) {
                        this.slowMetrics.rxSec = 0;
                        this.slowMetrics.txSec = 0;
                        this.slowMetrics.interfaceName = "unknown";
                        return;
                    }
                    // Look for primary network interface (not loopback)
                    const primaryNet = netStats.find(n => n.iface &&
                        !n.iface.toLowerCase().includes("loopback") &&
                        !n.iface.toLowerCase().includes("lo")) || netStats[0];
                    if (primaryNet) {
                        this.slowMetrics.rxSec = primaryNet.rx_sec ?? 0;
                        this.slowMetrics.txSec = primaryNet.tx_sec ?? 0;
                        this.slowMetrics.interfaceName = primaryNet.iface ?? "unknown";
                    }
                }
                catch (err) {
                    console.error("[Hardware] Net stats processing error", err);
                }
            }).catch(err => console.error("[Hardware] Slow tick net error", err));
            // GPU detection with fallbacks
            this.detectGpu().then(gpu => {
                this.slowMetrics.gpu = gpu;
            }).catch(err => console.error("[Hardware] GPU detection error", err));
        }
        const uptime = os.uptime();
        // Processos vêm injetados da chamada (cache do ProtectionEngine)
        const topProcessesByCpu = [...processes].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
        const topProcessesByRam = [...processes].sort((a, b) => b.memoryMb - a.memoryMb).slice(0, 5);
        // Stress Score (Temperatura explicitly null as it costs 270ms and always fails)
        const { stressScore, alerts } = this.calculateStress(this.fastMetrics.cpuUsage, this.fastMetrics.ramPercent, this.mediumMetrics.diskPercent, null, topProcessesByCpu, topProcessesByRam);
        const snapshot = {
            cpu: {
                usage: this.fastMetrics.cpuUsage,
                model: this.staticMetrics.cpuModel,
                cores: this.staticMetrics.cpuCores,
                speed: this.staticMetrics.cpuSpeed,
                temperature: null,
            },
            ram: {
                usagePercent: this.fastMetrics.ramPercent,
                usedGb: Math.round(this.fastMetrics.usedRamGb * 10) / 10,
                totalGb: Math.round(this.fastMetrics.totalRamGb * 10) / 10,
            },
            disk: {
                usagePercent: this.mediumMetrics.diskPercent,
                usedGb: Math.round(this.mediumMetrics.diskUsedGb * 10) / 10,
                totalGb: Math.round(this.mediumMetrics.diskTotalGb * 10) / 10,
                fsType: this.mediumMetrics.fsType,
            },
            network: {
                rxSec: Math.round(this.slowMetrics.rxSec),
                txSec: Math.round(this.slowMetrics.txSec),
                interfaceName: this.slowMetrics.interfaceName,
            },
            battery: {
                hasBattery: this.staticMetrics.hasBattery,
                percent: this.staticMetrics.batteryPercent,
                isCharging: this.staticMetrics.isCharging,
                timeRemaining: this.staticMetrics.timeRemaining,
            },
            gpu: this.slowMetrics.gpu,
            system: {
                uptime,
                platform: this.staticMetrics.platform,
                osVersion: this.staticMetrics.osVersion,
                hostname: this.staticMetrics.hostname,
            },
            topProcessesByCpu,
            topProcessesByRam,
            stressScore,
            alerts,
            timestamp: new Date().toISOString(),
        };
        this.lastSnapshot = snapshot;
        return snapshot;
    }
    getLastSnapshot() {
        return this.lastSnapshot;
    }
    calculateStress(cpuUsage, ramPercent, diskPercent, temperature, topCpu, topRam) {
        let score = 0;
        const alerts = [];
        // CPU stress
        if (cpuUsage > 90) {
            score += 30;
            const topProcess = topCpu.length > 0 && topCpu[0].cpu > 30 ? topCpu[0] : undefined;
            alerts.push({
                severity: cpuUsage > 95 ? "critical" : "high",
                category: "cpu",
                title: "Utilização de CPU elevada",
                description: topProcess ? `O processo ${topProcess.name} está consumindo ${topProcess.cpu}% da CPU.` : "A CPU está sob forte carga, o que pode causar lentidão no sistema.",
                process: topProcess,
                recommendation: "Feche aplicações pesadas que não estejam em uso. Se for um processo desconhecido, execute uma análise de segurança.",
            });
        }
        else if (cpuUsage > 75) {
            score += 15;
        }
        // RAM stress
        if (ramPercent > 85) {
            score += 25;
            const topProcess = topRam.length > 0 && topRam[0].memoryMb > 1000 ? topRam[0] : undefined;
            alerts.push({
                severity: ramPercent > 95 ? "critical" : "high",
                category: "ram",
                title: "Memória RAM próxima do limite",
                description: topProcess ? `O processo ${topProcess.name} está utilizando muita memória (${Math.round(topProcess.memoryMb)} MB).` : "Resta pouca memória RAM disponível para novas aplicações.",
                process: topProcess,
                recommendation: "Feche abas do navegador ou programas minimizados para libertar memória.",
            });
        }
        else if (ramPercent > 70) {
            score += 10;
        }
        // Disk stress
        if (diskPercent > 90) {
            score += 20;
            alerts.push({
                severity: diskPercent > 95 ? "critical" : "high",
                category: "disk",
                title: "Espaço em disco baixo",
                description: "O disco principal está quase cheio, o que pode impedir o sistema de funcionar corretamente.",
                recommendation: "Apague ficheiros temporários, esvazie a reciclagem ou desinstale aplicações desnecessárias.",
            });
        }
        else if (diskPercent > 80) {
            score += 10;
        }
        // Temperature stress
        if (temperature !== null) {
            if (temperature > 80) {
                score += 20;
                alerts.push({
                    severity: temperature > 90 ? "critical" : "high",
                    category: "cpu",
                    title: "Temperatura elevada",
                    description: `A temperatura da CPU atingiu ${temperature}°C.`,
                    recommendation: "Verifique a ventilação do computador. Evite bloquear as saídas de ar.",
                });
            }
        }
        return {
            stressScore: Math.min(100, score),
            alerts,
        };
    }
}
