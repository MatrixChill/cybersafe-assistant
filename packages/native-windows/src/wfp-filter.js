import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
export class WfpFilter {
    blockedIps = new Set();
    /**
     * Inicializa o "WFP Filter" (usando o Windows Firewall por debaixo dos panos)
     */
    async start() {
        // Garante que a regra base do CyberSafe existe
        try {
            await execAsync('powershell -Command "New-NetFirewallRule -DisplayName \'CyberSafe Blocklist\' -Direction Outbound -Action Block -RemoteAddress 127.0.0.2 -ErrorAction SilentlyContinue"');
        }
        catch (e) {
            // Ignora, regra pode já existir ou requerer Admin
        }
    }
    async stop() {
        // Limpa a regra ao parar
        try {
            await execAsync('powershell -Command "Remove-NetFirewallRule -DisplayName \'CyberSafe Blocklist\' -ErrorAction SilentlyContinue"');
        }
        catch (e) { }
    }
    /**
     * Bloqueia um IP adicionando-o à regra do Firewall
     */
    async blockIp(ip) {
        if (this.blockedIps.has(ip))
            return;
        this.blockedIps.add(ip);
        await this.syncRules();
    }
    async unblockIp(ip) {
        if (!this.blockedIps.has(ip))
            return;
        this.blockedIps.delete(ip);
        await this.syncRules();
    }
    async syncRules() {
        if (this.blockedIps.size === 0) {
            await execAsync('powershell -Command "Set-NetFirewallRule -DisplayName \'CyberSafe Blocklist\' -RemoteAddress 127.0.0.2 -ErrorAction SilentlyContinue"');
            return;
        }
        const ips = Array.from(this.blockedIps).join(",");
        try {
            await execAsync(`powershell -Command "Set-NetFirewallRule -DisplayName 'CyberSafe Blocklist' -RemoteAddress ${ips} -ErrorAction SilentlyContinue"`);
        }
        catch (e) {
            console.warn("[WfpFilter] Falha ao sincronizar regras de firewall:", e);
        }
    }
}
