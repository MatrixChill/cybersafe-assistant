import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export class WfpFilter {
  private blockedIps = new Set<string>();
  private active = false;
  /**
   * A regra foi realmente criada por este `start()`? `stop()` so remove o que
   * nos pertence — ver o comentario no método.
   */
  private ruleCreated = false;

  isActive(): boolean {
    return this.active;
  }

  /**
   * Inicializa o "WFP Filter" (usando o Windows Firewall por debaixo dos panos)
   */
  async start() {
    // Garante que a regra base do CyberSafe existe
    try {
      await execAsync(
        'powershell -Command "New-NetFirewallRule -DisplayName \'CyberSafe Blocklist\' -Direction Outbound -Action Block -RemoteAddress 127.0.0.2 -ErrorAction SilentlyContinue"'
      );
      this.active = true;
      // `-ErrorAction SilentlyContinue` nao distingue "criada agora" de "ja
      // existia", e o comando pode ter falhado inteiro. Anotamos a INTENCAO
      // para que o `stop()` saiba o que e seguro remover.
      this.ruleCreated = true;
    } catch (e) {
      this.active = false;
      // Ignora, regra pode já existir ou requerer Admin
    }
  }

  /**
   * Remove a regra do Firewall.
   *
   * ── Porquê o early-return ────────────────────────────────────────────────
   * Este `stop()` faz `spawn` de um PowerShell: ~1,1 s medidos, e o mesmo
   * depois de frio. O `dispose()` do engine chama-o, e o `shutdown()` dá-lhe
   * um deadline de 2 s. Com o `spawn` dentro, o deadline ficava a ~900 ms do
   * limite — e o pior caso (PowerShell bloqueado, sem timeout no `exec`)
   * fazia o `dispose()` nunca completar, deixando sockets abertos.
   *
   * Se nunca houve `start()`, nunca houve regra nossa para remover: o
   * comando seria um no-op que custa um `spawn` de um segundo. E o
   * `-ErrorAction SilentlyContinue` tornava o seu sucesso irrelevante.
   *
   * Isto NAO enfraquece o contrato de shutdown: um `stop()` que não tem o
   * que fazer resolve instantaneamente, o que é EXACTAMENTE o que o
   * `shutdown()` precisa. O deadline de 2 s continua a ser a rede de
   * segurança para um PowerShell genuinamente pendurado.
   */
  async stop() {
    this.active = false;
    if (!this.ruleCreated) return;

    this.ruleCreated = false;
    try {
      await execAsync(
        'powershell -Command "Remove-NetFirewallRule -DisplayName \'CyberSafe Blocklist\' -ErrorAction SilentlyContinue"'
      );
    } catch (e) {}
  }

  /**
   * Bloqueia um IP adicionando-o à regra do Firewall
   */
  async blockIp(ip: string) {
    if (this.blockedIps.has(ip)) return;
    this.blockedIps.add(ip);
    await this.syncRules();
  }

  async unblockIp(ip: string) {
    if (!this.blockedIps.has(ip)) return;
    this.blockedIps.delete(ip);
    await this.syncRules();
  }

  private async syncRules() {
    if (this.blockedIps.size === 0) {
      await execAsync(
        'powershell -Command "Set-NetFirewallRule -DisplayName \'CyberSafe Blocklist\' -RemoteAddress 127.0.0.2 -ErrorAction SilentlyContinue"'
      );
      return;
    }

    const ips = Array.from(this.blockedIps).join(",");
    try {
      await execAsync(
        `powershell -Command "Set-NetFirewallRule -DisplayName 'CyberSafe Blocklist' -RemoteAddress ${ips} -ErrorAction SilentlyContinue"`
      );
    } catch (e) {
      console.warn("[WfpFilter] Falha ao sincronizar regras de firewall:", e);
    }
  }
}
