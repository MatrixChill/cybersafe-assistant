import { EventEmitter } from "node:events";
export class AmsiProvider extends EventEmitter {
    isStarted = false;
    async start() {
        this.isStarted = true;
        // Em um cenário real de kernel/COM, aqui iniciaríamos o servidor NamedPipe
        // para ouvir as requisições do AmsiProvider.dll registrado no Windows.
        console.log("[AMSI] Provider aguardando conexões (Modo user-space simulação)");
    }
    async stop() {
        this.isStarted = false;
    }
    /**
     * Chamado (simulado) quando um script está prestes a ser executado via PowerShell, VBS, etc.
     */
    async handleScanRequest(request) {
        if (!this.isStarted)
            return "safe";
        // Simula a detecção baseada em assinaturas simples
        const contentLower = request.content.toLowerCase();
        if (contentLower.includes("invoke-mimikatz") || contentLower.includes("bypass") || contentLower.includes("enc")) {
            this.emit("script.blocked", {
                appName: request.appName,
                contentName: request.contentName,
                reason: "Malicious signature matched in AMSI buffer"
            });
            return "malicious";
        }
        return "safe";
    }
}
