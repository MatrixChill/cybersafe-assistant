import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { PIPE_NAME, decodeMessages, encodeMessage } from "@cybersafe/core";
import type {
  SecurityEvent,
  ServiceCommandMap,
  ServiceResponseMap,
} from "@cybersafe/shared-types";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  /** Só para o registo de tempos (`CYBERSAFE_DEBUG_BRIDGE=1`): método e instante de criação. */
  method?: string;
  t0?: number;
}

export class ServiceClient {
  private socket: net.Socket | null = null;
  /**
   * Ligação em curso (memoizada). No arranque, o poll da tray e o boot da app
   * podem chamar connect() quase ao mesmo tempo; sem isto cada chamada abria o
   * seu próprio socket (daí os dois "Connected to pipe successfully!") e o
   * primeiro ficava órfão — a receber eventos que ninguém lia.
   */
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = "";
  private listeners = new Set<(event: SecurityEvent) => void>();
  private requestSequence = 0;
  /** Contador de ligações abertas — distingue o arranque de uma reconexão. */
  private connectionCount = 0;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private connectedState = false;
  private recovering = false;
  private stopped = false;
  private shuttingDown = false;
  private lifecycle = new AbortController();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 250;

  private readonly pipeName: string;

  private readonly pipeToken?: string;

  constructor(pipeName: string = PIPE_NAME, pipeToken?: string) {
    this.pipeName = pipeName;
    this.pipeToken = pipeToken;
  }

  async connect() {
    if (this.isConnected) return;
    if (this.socket) this.handleSocketClosed(this.socket);
    // Após uma queda, só o loop de fundo tenta ligar. Polls não esperam nem
    // criam ciclos próprios. O arranque e um connect após disconnect explícito
    // conservam a tolerância inicial.
    if (this.recovering) throw new Error("Service client is not connected");
    if (this.stopped) {
      this.stopped = false;
      this.lifecycle = new AbortController();
    }
    if (this.connecting) return this.connecting;
    const flight = this.openSocket(30, this.lifecycle.signal).finally(() => {
      if (this.connecting === flight) this.connecting = null;
    });
    this.connecting = flight;
    return flight;
  }

  get isConnected() {
    return this.socket !== null && !this.socket.destroyed;
  }

  onConnectionState(listener: (connected: boolean) => void) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  private emitConnectionState(connected: boolean) {
    if (this.connectedState === connected) return;
    this.connectedState = connected;
    if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
      console.log(`[ipc-timing] estado-conexao connected=${connected} at=${new Date().toISOString()}`);
    }
    for (const listener of this.connectionListeners) listener(connected);
  }

  private scheduleReconnect() {
    if (this.stopped || this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      const signal = this.lifecycle.signal;
      try {
        await this.openSocket(1, signal);
      } catch {
        if (!signal.aborted) {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
          this.scheduleReconnect();
        }
      }
    }, this.reconnectDelay);
    this.reconnectTimer.unref?.();
  }

  onEvent(listener: (event: SecurityEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<K extends keyof ServiceCommandMap>(
    method: K,
    payload: ServiceCommandMap[K],
  ): Promise<ServiceResponseMap[K]> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("Service client is not connected");
    }
    const id = `req-${++this.requestSequence}`;
    // Tempos de ida-e-volta, opt-in e sem payload: é o que permite dizer SE uma
    // resposta criada antes de uma perda do serviço chegou depois dela (a última
    // leitura legítima a aterrar) ou se alguém mediu depois de o serviço estar morto.
    const t0 = Date.now();
    if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
      console.log(`[ipc-timing] criado id=${id} method=${method} at=${new Date(t0).toISOString()}`);
    }
    return new Promise<ServiceResponseMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, t0 });
      try {
        socket.write(encodeMessage({
          id,
          type: "request",
          method,
          payload,
        }), (err) => {
          // Se o pipe morreu no write, o pedido não pode ficar pendurado.
          if (err) {
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /**
   * Try to connect to the named pipe with retries.
   * The desktop provisions the child credential and waits for authentication
   * before exposing the connection to callers.
   */
  private async openSocket(retries = 30, signal = this.lifecycle.signal): Promise<void> {
    for (let i = 0; i < retries; i++) {
      signal.throwIfAborted();
      try {
        await new Promise<void>((resolve, reject) => {

          let settled = false;
          let authBuffer = "";
          let deadline: NodeJS.Timeout | undefined;
          const finishFailure = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            signal.removeEventListener("abort", abort);
            socket.destroy();
            reject(error);
          };
          const abort = () => finishFailure(new Error("Service client disconnected"));
          const accept = () => {
            if (signal.aborted) { abort(); return; }
            settled = true;
            clearTimeout(deadline);
            signal.removeEventListener("abort", abort);
            this.socket = socket;
            this.buffer = "";
            this.recovering = false;
            this.reconnectDelay = 250;
            this.emitConnectionState(true);
            resolve();
          };
          const socket = net.createConnection(this.pipeName, () => {
            if (signal.aborted) { abort(); return; }
            if (this.pipeToken === undefined) { accept(); return; }
            if (!/^[a-f0-9]{64}$/.test(this.pipeToken)) {
              finishFailure(new Error("Credencial do pipe inválida")); return;
            }
            socket.write(encodeMessage({ type: "auth", token: this.pipeToken }));
          });
          deadline = setTimeout(() => finishFailure(new Error("Autenticação do pipe expirou")), 3000);
          deadline.unref();
          signal.addEventListener("abort", abort, { once: true });
          socket.on("data", (chunk) => {
            if (this.socket === socket) { this.handleData(chunk.toString()); return; }
            if (settled || this.pipeToken === undefined) return;
            authBuffer += chunk.toString();
            if (Buffer.byteLength(authBuffer) > 65536) {
              finishFailure(new Error("Resposta de autenticação inválida")); return;
            }
            const newline = authBuffer.indexOf("\n");
            if (newline < 0) return;
            let ack: any;
            try { ack = JSON.parse(authBuffer.slice(0, newline)); }
            catch { finishFailure(new Error("Resposta de autenticação inválida")); return; }
            if (ack?.type !== "auth" || ack.ok !== true) {
              finishFailure(new Error("Autenticação do pipe recusada")); return;
            }
            accept();
            const rest = authBuffer.slice(newline + 1);
            if (rest && this.socket === socket) this.handleData(rest);
          });
          socket.on("error", (err) => {
            if (this.socket === socket) this.handleSocketClosed(socket);
            else finishFailure(err);
          });
          socket.on("close", () => {
            if (!settled) finishFailure(new Error("Pipe fechado antes da autenticação"));
            this.handleSocketClosed(socket);
          });
        });
        this.connectionCount += 1;
        console.log(`[ServiceClient] Connected to pipe successfully! (ligação #${this.connectionCount})`);
        return;
      } catch (err: any) {
        if (signal.aborted) throw err;
        if (i === retries - 1) throw err;
        console.log(`[ServiceClient] Pipe not ready, retrying (${i + 1}/${retries})...`);
        await delay(1_000, undefined, { signal });
      }
    }
  }

  /**
   * Fecho do pipe: limpa a referência ativa e rejeita pedidos pendentes para
   * nunca deixar promises penduradas quando o serviço fecha a ligação.
   */
  private handleSocketClosed(socket: net.Socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    socket.destroy();
    this.buffer = "";
    if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
      const emVoo = Array.from(this.pending.entries())
        .map(([rid, p]) => `${rid}:${p.method ?? "?"}@${Date.now() - (p.t0 ?? NaN)}ms`).join(",");
      console.log(`[ipc-timing] pipe-encerrado at=${new Date().toISOString()} pendentes=${this.pending.size} emVoo=[${emVoo}]`);
    }
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Service connection closed"));
    }
    this.pending.clear();
    this.recovering = true;
    this.emitConnectionState(false);
    this.scheduleReconnect();
  }

  private handleData(chunk: string) {
    if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
      console.log(`[ServiceClient] raw chunk len=${chunk.length} at=${new Date().toISOString()}`);
    }
    this.buffer += chunk;
    const decoded = decodeMessages(this.buffer);
    this.buffer = decoded.rest;
    for (const message of decoded.messages) {
      if (message?.type === "event" && message.event) {
        const ev = message.event as SecurityEvent;
        if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
          const scanId = (ev.data as any)?.id ?? ev.id ?? "n/a";
          console.log(`[ServiceClient] event received type=${ev.type} scanId=${scanId} at=${new Date().toISOString()}`);
        }
        for (const listener of this.listeners) {
          listener(ev);
        }
        continue;
      }

      if (message?.type === "response" && message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
          console.log(`[ServiceClient] response id=${message.id} ok=${message.ok} at=${new Date().toISOString()}`);
        }
        if (message.ok) {
          if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
            const r = message.result as { timestamp?: unknown } | undefined;
            const amostra = r && typeof r.timestamp === "string" ? r.timestamp : "-";
            console.log(`[ipc-timing] resolvido id=${message.id} method=${pending.method ?? "?"} emMs=${Date.now() - (pending.t0 ?? NaN)} amostraTimestamp=${amostra} ok=true at=${new Date().toISOString()}`);
          }
          pending.resolve(message.result);
        } else {
          if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
            console.log(`[ipc-timing] rejeitado id=${message.id} method=${pending.method ?? "?"} emMs=${Date.now() - (pending.t0 ?? NaN)} ok=false at=${new Date().toISOString()}`);
          }
          pending.reject(new Error(message.error ?? "Service request failed"));
        }
      }
    }
  }

  /**
   * Pede o encerramento ao serviço e fecha a ligação.
   *
   * O ACK confirma que o serviço recebeu o pedido (o engine responde antes de
   * começar a desmontagem), mas nunca bloqueamos o quit do Electron à espera
   * dele: se o pipe morrer ou o ACK se perder, o deadline garante que seguimos.
   */
  async requestShutdown() {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 3000);
      timer.unref?.();
    });
    await Promise.race([
      this.request("service.shutdown", undefined).then(() => undefined).catch(() => undefined),
      deadline,
    ]);
    if (timer) clearTimeout(timer);
    this.disconnect();
  }

  disconnect() {
    this.stopped = true;
    this.recovering = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.lifecycle.abort();
    this.connecting = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      // destroy() pode emitir "error"/"close"; como this.socket já é null,
      // handleSocketClosed é no-op e não reentra na limpeza.
      socket.destroy();
    }
    // Rejeita pedidos pendentes para não deixar promises penduradas.
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Service client disconnected"));
    }
    this.pending.clear();
    this.buffer = "";
    this.emitConnectionState(false);
  }
}
