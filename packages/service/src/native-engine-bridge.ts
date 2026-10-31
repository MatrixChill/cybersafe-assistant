import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import type { EngineSubsystemHealth } from '@cybersafe/shared-types';
import { WINDOWS_READONLY_ENV } from "./dev-windows-readonly.js";
import { FIXTURE_SCAN_FLAG } from "./dev-fixture-gate.js";

export interface NativeScanResult {
  path: string;
  file_size: number;
  sha256: string;
  entropy: number;
  score: number;
  level: string;
  reasons: string[];
  pe: {
    valid_pe: boolean;
    is_64: boolean;
    machine: number;
    sections: number;
    writable_executable_section: boolean;
    no_imports: boolean;
    suspicious_section: boolean;
  };
}

/** Porque é que uma invocação do motor nativo não produziu resultado. */
export type NativeScanFailure = "unavailable" | "timeout" | "cancelled" | "spawn" | "exit" | "output";

export interface NativeScanOutcome {
  ok: boolean;
  result: NativeScanResult | null;
  error?: string;
  /** Tipificado: o chamador não tem de interpretar a mensagem. */
  failure?: NativeScanFailure;
  cancelled?: boolean;
}

export interface NativeScanOptions {
  /** Cancelamento do scan (o filho é morto; nada é aplicado). */
  signal?: AbortSignal;
  /** Prazo por invocação. Por omissão 30 s, como sempre. */
  timeoutMs?: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Uma invocação observada — a ÚNICA prova de que o binário é utilizável. */
interface InvocationEvidence {
  ok: boolean;
  failure?: NativeScanFailure;
  detail: string;
  at: number;
}

export class NativeEngineBridge {
  private static _health: EngineSubsystemHealth = { status: "unavailable", detail: "Ainda não verificado" };
  private static binaryPath: string | null = null;
  private static checked = false;
  /**
   * Evidência da última invocação real.
   *
   * `fs.existsSync(exe)` prova que existe um ficheiro, não que existe um
   * motor. Antes, cada leitura de saúde fazia `checkAvailability()` e
   * reescrevia `active` a partir da presença: uma falha medida (timeout, exit
   * != 0, output ilegível) era apagada pela leitura seguinte, sem nenhuma
   * invocação nova. `active` passa a exigir uma invocação bem-sucedida, e uma
   * falha fica registada até haver uma invocação que a contradiga.
   */
  private static lastInvocation: InvocationEvidence | null = null;
  private static probeInFlight: Promise<EngineSubsystemHealth> | null = null;

  private static getBinaryPath(): string {
    // Build empacotado: o electron-builder copia o binario via extraResources para
    // <resources>/scan-engine.exe (fora do asar). Em dev resourcesPath nao existe
    // e os 4 candidatos de arvore de repo abaixo continuam a resolver.
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    // Check multiple potential locations for the binary
    const possiblePaths = [
      ...(resourcesPath ? [path.resolve(resourcesPath, "scan-engine.exe")] : []),
      path.resolve(__dirname, "../../native-engine/build/Release/scan-engine.exe"),
      path.resolve(process.cwd(), 'packages/native-engine/build/Release/scan-engine.exe'),
      path.resolve(process.cwd(), 'packages/native-engine/build/scan-engine.exe'),
      path.resolve(process.cwd(), 'packages/native-engine/bin/scan-engine.exe'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return possiblePaths[0];
  }

  /**
   * Verifica a disponibilidade do binário e expõe o estado de saúde do motor.
   *
   * NÃO spawna nada (é chamada no caminho síncrono de `engine.getProtectionState`
   * e em cada scan). A invocação é provada por `probe()` ou por um `scan()`
   * bem-sucedido; até lá o estado é `degraded`, não `active`.
   */
  public static checkAvailability(): EngineSubsystemHealth {
    this.binaryPath = this.getBinaryPath();
    this.checked = true;

    if (!fs.existsSync(this.binaryPath)) {
      this._health = { status: "unavailable", detail: "scan-engine.exe não foi encontrado (não integrado)" };
      return this._health;
    }

    const evidence = this.lastInvocation;
    if (!evidence) {
      this._health = {
        status: "degraded",
        detail: `scan-engine.exe presente; invocação real ainda não confirmada (${this.binaryPath})`,
      };
      return this._health;
    }

    if (evidence.ok) {
      this._health = { status: "active", detail: `Motor nativo ativo — invocação confirmada em ${new Date(evidence.at).toISOString()}` };
      return this._health;
    }

    this._health = {
      status: evidence.failure === "unavailable" ? "unavailable" : "degraded",
      detail: `Motor nativo presente mas a última invocação falhou (${evidence.failure ?? "erro"}): ${evidence.detail}`,
    };
    return this._health;
  }

  public static get health(): EngineSubsystemHealth {
    if (!this.checked) return this.checkAvailability();
    return this._health;
  }

  /**
   * Prova que o binário é UTILIZÁVEL, correndo-o sobre uma fixture benigna
   * gerada por nós (nunca sobre um ficheiro do utilizador). Single-flight: a
   * primeira chamada faz o trabalho, as concorrentes esperam o mesmo resultado.
   */
  /**
   * O probe de arranque spawna um processo. Nos modos em que a lane corre sobre
   * um Windows real em LEITURA (`CYBERSAFE_DEV_WINDOWS_READONLY=1`) ou sobre uma
   * fixture controlada (`CYBERSAFE_REALDEV_FIXTURE_SCAN=1`), e em testes, não o
   * faz: o contrato é o dos módulos que já definem estes modos. Sem esta guarda,
   * o init do serviço spawnava `scan-engine.exe` em ambientes que não autorizam
   * execução — e um `fs.existsSync`/`spawn` a mais é exactamente o que estes
   * modos existem para impedir.
   */
  public static probePermitida(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.NODE_ENV === "test") return false;
    return env[WINDOWS_READONLY_ENV] !== "1" && env[FIXTURE_SCAN_FLAG] !== "1";
  }

  public static probe(): Promise<EngineSubsystemHealth> {
    if (!this.probePermitida()) {
      this._health = {
        status: "degraded",
        detail: "Probe nativo desativado neste modo (read-only/fixture/teste); invocação real não confirmada",
      };
      return Promise.resolve(this._health);
    }
    if (this.probeInFlight) return this.probeInFlight;
    this.probeInFlight = (async () => {
      const availability = this.checkAvailability();
      if (availability.status === "unavailable") return availability;

      const fixture = path.join(os.tmpdir(), `cybersafe-native-probe-${process.pid}-${Date.now()}.txt`);
      try {
        await fsp.writeFile(fixture, "CyberSafe native engine probe fixture (benign, not user data).\n", "utf-8");
        const outcome = await this.scan(fixture, { timeoutMs: 15_000 });
        if (!outcome.ok || !outcome.result) {
          this.lastInvocation = {
            ok: false,
            failure: outcome.failure ?? "output",
            detail: outcome.error ?? "sem resultado",
            at: Date.now(),
          };
        }
      } finally {
        await fsp.unlink(fixture).catch(() => undefined);
      }
      return this.checkAvailability();
    })();
    return this.probeInFlight.finally(() => {
      this.probeInFlight = null;
    });
  }

  private static activeProcesses = new Set<import('child_process').ChildProcess>();

  /** Processos que continuam registados (observabilidade de teste e de dispose). */
  public static get pendingChildren(): number {
    return this.activeProcesses.size;
  }

  /**
   * `true` só quando o sinal foi aceite pelo SO. Um `kill` que lança ou devolve
   * `false` NÃO prova que o filho morreu — e retirá-lo do registo nessa altura
   * seria declarar limpo um processo que pode continuar a correr.
   */
  private static terminar(child: import('child_process').ChildProcess): boolean {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    try {
      return child.kill('SIGKILL') !== false;
    } catch {
      return false;
    }
  }

  public static dispose() {
    console.log(`[NativeEngine] Terminando ${this.activeProcesses.size} processos de scan pendentes...`);
    for (const child of this.activeProcesses) {
      if (this.terminar(child)) {
        this.activeProcesses.delete(child);
      } else {
        // Não se apaga o registo para "ficar limpo": se o kill falhou, o filho
        // pode estar vivo e quem chamar dispose tem de o saber.
        console.error(`[NativeEngine] Não foi possível terminar (pid ${child.pid ?? "?"}); pode continuar vivo`);
      }
    }
  }

  private static record(evidence: InvocationEvidence): void {
    this.lastInvocation = evidence;
    this._health = evidence.ok
      ? { status: "active", detail: `Motor nativo ativo — invocação confirmada em ${new Date(evidence.at).toISOString()}` }
      : {
          status: evidence.failure === "unavailable" ? "unavailable" : "degraded",
          detail: `Scan nativo sem resultado (${evidence.failure ?? "erro"}): ${evidence.detail}`,
        };
  }

  public static async scan(filePath: string, options: NativeScanOptions = {}): Promise<NativeScanOutcome> {
    // Só a PRESENÇA do binário é verificada aqui. Não se reescreve `active`:
    // a evidência é atualizada pelo resultado desta invocação, no fim.
    this.binaryPath = this.getBinaryPath();
    this.checked = true;
    if (!fs.existsSync(this.binaryPath)) {
      this._health = { status: "unavailable", detail: "scan-engine.exe não foi encontrado (não integrado)" };
      return { ok: false, result: null, error: "scan-engine.exe não foi encontrado", failure: "unavailable" };
    }
    if (options.signal?.aborted) {
      return { ok: false, result: null, error: "cancelled before start", failure: "cancelled", cancelled: true };
    }

    const binPath = this.binaryPath;

    return new Promise((resolve) => {
      const child = spawn(binPath, [filePath], { windowsHide: true });
      this.activeProcesses.add(child);

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;

      const finish = (outcome: NativeScanOutcome, evidence: InvocationEvidence | null, releaseChild = true): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortListener) options.signal?.removeEventListener("abort", abortListener);
        // Resolver a promessa NÃO é prova de que o filho morreu. Se o kill não
        // foi aceite, o registo fica até ao `close`/`exit` (ou até dispose).
        if (releaseChild) this.activeProcesses.delete(child);
        if (evidence) this.record(evidence);
        resolve(outcome);
      };

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutMs = options.timeoutMs ?? 30_000;
      timer = setTimeout(() => {
        const morto = this.terminar(child);
        if (!morto) console.error(`[NativeEngine] Timeout: kill não confirmado (pid ${child.pid ?? "?"}) — processo mantido no registo`);
        console.error(`[NativeEngine] Timeout scanning ${filePath}`);
        finish(
          { ok: false, result: null, error: "Native engine timeout", failure: "timeout" },
          { ok: false, failure: "timeout", detail: "timeout", at: Date.now() },
          morto,
        );
      }, timeoutMs);

      // Cancelamento: mata o filho e devolve `cancelled`. O resultado é
      // descartado — um scan cancelado não autoriza veredicto nenhum.
      if (options.signal) {
        abortListener = () => {
          const morto = this.terminar(child);
          if (!morto) console.error(`[NativeEngine] Cancelamento: kill não confirmado (pid ${child.pid ?? "?"})`);
          finish(
            { ok: false, result: null, error: "cancelled", failure: "cancelled", cancelled: true },
            // Cancelamento não é uma falha do motor: não degrada a saúde.
            null,
            morto,
          );
        };
        options.signal.addEventListener("abort", abortListener, { once: true });
      }

      child.on('close', (code) => {
        // A morte confirmada é AQUI, não na resolução da promessa.
        this.activeProcesses.delete(child);
        if (code !== 0 && code !== null) {
          console.error(`[NativeEngine] Process exited with code ${code}. Error: ${stderr}`);
          finish(
            { ok: false, result: null, error: stderr.trim() || `exit code ${code}`, failure: "exit" },
            { ok: false, failure: "exit", detail: `exit code ${code}`, at: Date.now() },
          );
          return;
        }

        if (code === null) {
          // Process was killed
          finish(
            { ok: false, result: null, error: "Native engine killed", failure: "exit" },
            { ok: false, failure: "exit", detail: "killed", at: Date.now() },
          );
          return;
        }

        try {
          const result = JSON.parse(stdout) as NativeScanResult;
          // Um JSON válido sem os campos mínimos não é um resultado: é um
          // output que não conseguimos interpretar. Tratá-lo como sucesso
          // misturaria "o motor correu" com "o motor produziu uma análise".
          // `level: "error"` e uma falha de analise reportada pelo motor (ex.: ficheiro
          // inexistente): nunca pode chegar ao servico como resultado valido.
          if (typeof result?.sha256 !== "string" || typeof result?.score !== "number" || result.level === "error") {
            finish(
              { ok: false, result: null, error: "Failed to parse native output", failure: "output" },
              { ok: false, failure: "output", detail: "campos obrigatórios em falta", at: Date.now() },
            );
            return;
          }
          finish(
            { ok: true, result },
            { ok: true, detail: "ok", at: Date.now() },
          );
        } catch (e) {
          console.error(`[NativeEngine] Failed to parse output: ${stdout}`, e);
          finish(
            { ok: false, result: null, error: "Failed to parse native output", failure: "output" },
            { ok: false, failure: "output", detail: "output não parseável", at: Date.now() },
          );
        }
      });

      child.on('error', (err) => {
        console.error(`[NativeEngine] Failed to start process:`, err);
        finish(
          { ok: false, result: null, error: err.message, failure: "spawn" },
          { ok: false, failure: "spawn", detail: err.message, at: Date.now() },
        );
      });
    });
  }
}
