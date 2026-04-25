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
  private pending = new Map<string, PendingRequest>();
  private buffer = "";
  private listeners = new Set<(event: SecurityEvent) => void>();
  private requestSequence = 0;

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    await this.openSocket();
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
    const id = `req-${++this.requestSequence}`;
    return new Promise<ServiceResponseMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket?.write(encodeMessage({
        id,
        type: "request",
        method,
        payload,
      }));
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
          const socket = net.createConnection(PIPE_NAME, () => {
            this.socket = socket;
            resolve();
          });

          socket.on("data", (chunk) => this.handleData(chunk.toString()));
          socket.on("error", reject);
          socket.on("close", () => {
            this.socket = null;
          });
        });
        console.log("[ServiceClient] Connected to pipe successfully!");
        return;
      } catch (err: any) {
        if (i === retries - 1) throw err;
        console.log(`[ServiceClient] Pipe not ready, retrying (${i + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    const decoded = decodeMessages(this.buffer);
    this.buffer = decoded.rest;
    for (const message of decoded.messages) {
      if (message?.type === "event" && message.event) {
        for (const listener of this.listeners) {
          listener(message.event as SecurityEvent);
        }
        continue;
      }

      if (message?.type === "response" && message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error ?? "Service request failed"));
        }
      }
    }
  }
}
