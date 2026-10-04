import type { VirusTotalResult, VirusTotalEngine } from "@cybersafe/shared-types";

interface CacheEntry {
  result: VirusTotalResult;
  cachedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MS = 15_500; // ~4 requests per minute (free tier)

export class VirusTotalClient {
  private apiKey: string;
  private cache = new Map<string, CacheEntry>();
  private lastRequestAt = 0;
  private enabled: boolean;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private readonly rateLimitMs: number;
  private readonly cooldownMs: number;
  private readonly failureThreshold: number;

  constructor(apiKey?: string, options?: { rateLimitMs?: number; cooldownMs?: number; failureThreshold?: number }) {
    this.apiKey = apiKey || "";
    this.enabled = this.apiKey.length > 0;
    this.rateLimitMs = options?.rateLimitMs ?? RATE_LIMIT_MS;
    this.cooldownMs = options?.cooldownMs ?? 5 * 60 * 1000;
    this.failureThreshold = options?.failureThreshold ?? 3;
  }

  private isCircuitOpen(): boolean {
    if (this.openUntil === 0) return false;
    if (Date.now() < this.openUntil) return true;
    this.openUntil = 0;
    this.consecutiveFailures = 0;
    return false;
  }

  private recordFailure(reason: string): void {
    if (this.isCircuitOpen()) return;
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      console.warn(`[VirusTotal] Circuit breaker open for ${this.cooldownMs}ms: ${reason}`);
    }
  }

  private pruneCache() {
    const MAX = 1000;
    while (this.cache.size > MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
      else break;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setApiKey(key: string) {
    this.apiKey = key;
    this.enabled = key.length > 0;
  }

  async scanHash(sha256: string, sourceTag = "unknown"): Promise<VirusTotalResult | null> {
    if (!this.enabled) return null;

    if (process.env.CYBERSAFE_DEBUG_VT === "1") {
      console.log(`[VT_CALL] source=${sourceTag} sha8=${sha256.slice(0, 8)} ts=${Date.now()}`);
    }

    const normalizedHash = sha256.toLowerCase();

    // Check cache first
    const cached = this.cache.get(normalizedHash);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return { ...cached.result, cached: true };
    }

    if (this.isCircuitOpen()) return null;

    // Rate limiting
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.rateLimitMs) {
      await new Promise((resolve) => setTimeout(resolve, this.rateLimitMs - elapsed));
      // Another lookup may have opened the circuit while this one waited.
      if (this.isCircuitOpen()) return null;
    }

    try {
      this.lastRequestAt = Date.now();

      const response = await fetch(`https://www.virustotal.com/api/v3/files/${normalizedHash}`, {
        headers: {
          "x-apikey": this.apiKey,
          "Accept": "application/json",
        },
      });

      if (response.status === 404) {
        this.consecutiveFailures = 0;
        // File not in VT database — return a clean result
        const cleanResult: VirusTotalResult = {
          sha256: normalizedHash,
          positives: 0,
          total: 0,
          detectionRatio: "0/0",
          engines: [],
          scanDate: new Date().toISOString(),
          permalink: "",
          reputation: 0,
          cached: false,
        };
        this.cache.set(normalizedHash, { result: cleanResult, cachedAt: Date.now() });
        this.pruneCache();
        return cleanResult;
      }

      if (response.status === 429) {
        // Rate limited — return null, don't cache
        console.warn("[VirusTotal] Rate limited, skipping");
        this.recordFailure("HTTP 429");
        return null;
      }

      if (!response.ok) {
        console.error(`[VirusTotal] API error: ${response.status}`);
        this.recordFailure(`HTTP ${response.status}`);
        return null;
      }

      const data = (await response.json()) as any;
      this.consecutiveFailures = 0;
      const attributes = data?.data?.attributes;

      if (!attributes) return null;

      const lastAnalysisResults = attributes.last_analysis_results || {};
      const engines: VirusTotalEngine[] = [];
      let positives = 0;
      let total = 0;

      for (const [engineName, engineResult] of Object.entries(lastAnalysisResults)) {
        const result = engineResult as any;
        const detected = result.category === "malicious" || result.category === "suspicious";
        if (detected) positives++;
        total++;

        // Only include engines that actually detected something
        if (detected) {
          engines.push({
            name: engineName,
            detected: true,
            result: result.result || null,
          });
        }
      }

      const vtResult: VirusTotalResult = {
        sha256: normalizedHash,
        positives,
        total,
        detectionRatio: `${positives}/${total}`,
        engines: engines.slice(0, 20), // Top 20 detections
        scanDate: attributes.last_analysis_date
          ? new Date(attributes.last_analysis_date * 1000).toISOString()
          : new Date().toISOString(),
        permalink: `https://www.virustotal.com/gui/file/${normalizedHash}`,
        reputation: attributes.reputation ?? 0,
        cached: false,
      };

      this.cache.set(normalizedHash, { result: vtResult, cachedAt: Date.now() });
      this.pruneCache();
      return vtResult;
    } catch (error) {
      console.error("[VirusTotal] Request failed:", error);
      this.recordFailure("request exception");
      return null;
    }
  }

  clearCache() {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
