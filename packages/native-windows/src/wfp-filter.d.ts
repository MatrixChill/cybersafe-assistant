export declare class WfpFilter {
    private blockedIps;
    /**
     * Inicializa o "WFP Filter" (usando o Windows Firewall por debaixo dos panos)
     */
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Bloqueia um IP adicionando-o à regra do Firewall
     */
    blockIp(ip: string): Promise<void>;
    unblockIp(ip: string): Promise<void>;
    private syncRules;
}
