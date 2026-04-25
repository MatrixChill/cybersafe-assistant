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

  constructor(apiKey?: string) {
    this.apiKey = apiKey || "";
    this.enabled = this.apiKey.length > 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setApiKey(key: string) {
    this.apiKey = key;
    this.enabled = key.length > 0;
  }

  async scanHash(sha256: string): Promise<VirusTotalResult | null> {
    if (!this.enabled) return null;

    const normalizedHash = sha256.toLowerCase();

    // Check cache first
    const cached = this.cache.get(normalizedHash);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return { ...cached.result, cached: true };
    }

    // Rate limiting
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
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
        return cleanResult;
      }

      if (response.status === 429) {
        // Rate limited — return null, don't cache
        console.warn("[VirusTotal] Rate limited, skipping");
        return null;
      }

      if (!response.ok) {
        console.error(`[VirusTotal] API error: ${response.status}`);
        return null;
      }

      const data = await response.json();
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
      return vtResult;
    } catch (error) {
      console.error("[VirusTotal] Request failed:", error);
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
