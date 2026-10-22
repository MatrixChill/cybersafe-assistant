import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Comando de mutação do firewall. Injectável: os testes nunca chegam ao PowerShell real. */
export type WfpExecutor = (comando: string) => Promise<unknown>;
/** Leitura de volta: só um verificador verdadeiro pode confirmar o estado ativo. */
export type WfpVerificador = () => Promise<boolean>;

/**
 * Origem do estado, em vez de um booleano que não diz de onde veio.
 *
 * `solicitado_nao_verificado` existe porque o código de saída de um
 * `New-NetFirewallRule` com `-ErrorAction SilentlyContinue` não é uma medição
 * do Windows: é o resultado de um `await`.
 */
export type WfpEstado =
  | { estado: "nao_iniciado" }
  | { estado: "solicitado_nao_verificado" }
  | { estado: "ativo_confirmado" }
  | { estado: "parado" }
  | { estado: "falhou"; motivo: string };

export interface WfpFilterOpcoes {
  executar?: WfpExecutor;
  verificar?: WfpVerificador;
}

const REGRA = "CyberSafe Blocklist";
const CAMINHO_PESSOAL = /[A-Za-z]:[\\/](?:Users|users)[\\/][^\\/\s"']+/g;

/**
 * Causa legível SEM caminho de utilizador: o motivo vai ao ecrã (a finding do
 * pcstate publica `detail`). O placeholder não é ele próprio um caminho.
 */
function causaSanitizada(erro: unknown): string {
  const nome = erro instanceof Error ? erro.name : "";
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  const rotulo = nome && nome !== "Error" ? `${nome}: ` : "";
  return `${rotulo}${mensagem}`
    .replace(CAMINHO_PESSOAL, "<caminho>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export class WfpFilter {
  private blockedIps = new Set<string>();
  /**
   * A regra foi realmente criada por este `start()`? `stop()` só remove o que
   * nos pertence — ver o comentário no método.
   */
  private ruleCreated = false;
  private estadoAtual: WfpEstado = { estado: "nao_iniciado" };
  private readonly executar: WfpExecutor;
  private readonly verificar?: WfpVerificador;

  constructor(opcoes: WfpFilterOpcoes = {}) {
    this.executar = opcoes.executar ?? (async (comando) => execAsync(comando));
    this.verificar = opcoes.verificar;
  }

  /**
   * `true` só depois de um read-back verdadeiro. Um comando que terminou bem
   * não é observação do estado: ver `solicitado_nao_verificado`.
   */
  isActive(): boolean {
    return this.estadoAtual.estado === "ativo_confirmado";
  }

  estado(): WfpEstado {
    return this.estadoAtual;
  }

  /**
   * Inicializa o "WFP Filter" (usando o Windows Firewall por debaixo dos panos)
   */
  async start() {
    try {
      await this.executar(
        `powershell -Command "New-NetFirewallRule -DisplayName '${REGRA}' -Direction Outbound -Action Block -RemoteAddress 127.0.0.2 -ErrorAction SilentlyContinue"`,
      );
    } catch (erro) {
      // `-ErrorAction SilentlyContinue` pode ainda assim rebentar no processo:
      // quando rebenta, a exceção é a única coisa que diz PORQUE não está ativo.
      this.ruleCreated = false;
      this.estadoAtual = { estado: "falhou", motivo: causaSanitizada(erro) };
      return;
    }
    // Anotamos a INTENÇÃO para que o `stop()` saiba o que é seguro remover.
    this.ruleCreated = true;
    if (!this.verificar) {
      this.estadoAtual = { estado: "solicitado_nao_verificado" };
      return;
    }
    let confirmado = false;
    try {
      confirmado = (await this.verificar()) === true;
    } catch {
      // Verificação falhada não é a falha do `start()`: nada foi confirmado.
      confirmado = false;
    }
    this.estadoAtual = confirmado ? { estado: "ativo_confirmado" } : { estado: "solicitado_nao_verificado" };
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
    if (!this.ruleCreated) return;

    this.ruleCreated = false;
    try {
      await this.executar(
        `powershell -Command "Remove-NetFirewallRule -DisplayName '${REGRA}' -ErrorAction SilentlyContinue"`,
      );
    } catch (erro) {
      this.estadoAtual = { estado: "falhou", motivo: causaSanitizada(erro) };
      return;
    }
    this.estadoAtual = { estado: "parado" };
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
      await this.executar(
        `powershell -Command "Set-NetFirewallRule -DisplayName '${REGRA}' -RemoteAddress 127.0.0.2 -ErrorAction SilentlyContinue"`,
      );
      return;
    }

    const ips = Array.from(this.blockedIps).join(",");
    try {
      await this.executar(
        `powershell -Command "Set-NetFirewallRule -DisplayName '${REGRA}' -RemoteAddress ${ips} -ErrorAction SilentlyContinue"`,
      );
    } catch (e) {
      console.warn("[WfpFilter] Falha ao sincronizar regras de firewall:", e);
    }
  }
}
