import { EventEmitter } from "node:events";

export interface EtwProcessEvent {
  pid: number;
  ppid: number;
  imageFileName: string;
  commandLine: string;
  timestamp: string;
}

export class EtwConsumer extends EventEmitter {
  private isStarted = false;

  async start() {
    this.isStarted = true;
    console.log("[ETW] Consumer started (listening to Microsoft-Windows-Kernel-Process)");
    // Em um cenário real com Node-Addon-API (C++), aqui iniciaríamos uma sessão
    // ETW usando KrabsETW ou a API nativa OpenTrace/ProcessTrace.
    // Como requer compilação pesada e WDK, o monitoramento por ETW envia eventos "push".
  }

  async stop() {
    this.isStarted = false;
  }
}
