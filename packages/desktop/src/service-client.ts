import net from "node:net";
import { PIPE_NAME, decodeMessages, encodeMessage } from "@cybersafe/core";
import type {
  SecurityEvent,
  ServiceCommandMap,
  ServiceResponseMap,
} from "@cybersafe/shared-types";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
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

  private readonly pipeName: string;

  constructor(pipeName: string = PIPE_NAME) {
    this.pipeName = pipeName;
  }

  async connect() {
    if (this.isConnected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  get isConnected() {
    return this.socket !== null && !this.socket.destroyed;
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
    return new Promise<ServiceResponseMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
   * The service is started externally (via npm run dev:service),
   * so we just need to wait for the pipe to become available.
   */
  private async openSocket(retries = 30): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(this.pipeName, () => {
            this.socket = socket;
            resolve();
          });

          socket.on("data", (chunk) => this.handleData(chunk.toString()));
          socket.on("error", (err) => {
            if (this.socket === socket) {
              // Ligação já estabelecida: erro em runtime. EPIPE/ECONNRESET são
              // esperados no shutdown — fecha e liberta os pedidos pendentes.
              this.handleSocketClosed(socket);
            } else {
              // Ainda a ligar: deixa o retry do openSocket tratar disto.
              reject(err);
            }
          });
          socket.on("close", () => this.handleSocketClosed(socket));
        });
        this.connectionCount += 1;
        console.log(`[ServiceClient] Connected to pipe successfully! (ligação #${this.connectionCount})`);
        return;
      } catch (err: any) {
        if (i === retries - 1) throw err;
        console.log(`[ServiceClient] Pipe not ready, retrying (${i + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, 1_000));
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
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Service connection closed"));
    }
    this.pending.clear();
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
          pending.resolve(message.result);
        } else {
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
  }
}
