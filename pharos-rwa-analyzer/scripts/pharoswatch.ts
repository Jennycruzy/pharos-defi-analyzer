/**
 * pharoswatch.ts — client for the Pharos Watch NAV/depeg API.
 *
 * VERIFIED in Step 0 + with a live key (2026-06-16): base https://api.pharos.watch.
 *   - `GET /api/health` is key-exempt.
 *   - All data routes require `X-API-Key`.
 *   - `GET /api/peg-summary` returns `{ coins: [...] }`; each coin carries the
 *     canonical depeg metrics we use: `currentDeviationBps`, `pegScore`,
 *     `activeDepeg`, `worstDeviationBps`, `priceUpdatedAt` — field names confirmed
 *     against the live response, not guessed.
 *
 * The client fetches peg-summary at most once per instance (cached), so resolving
 * several reference stablecoins costs a single request.
 */

import { PHAROS_WATCH } from './config.js';

const TIMEOUT_MS = 12_000;

export interface WatchHealth {
  reachable: boolean;
  status: string | null;
  upstreamProvider: string | null;
  raw: unknown;
}

export interface PegResult {
  stablecoinId: string;
  available: boolean;
  /** USD price implied by the peg deviation (1 + bps/10000). */
  priceUsd: number | null;
  /** Drift from $1.00 in %, = currentDeviationBps / 100. */
  driftPct: number | null;
  /** Raw deviation in basis points (negative = below peg). */
  deviationBps: number | null;
  /** Pharos Watch peg health score 0–100 (higher = healthier). */
  pegScore: number | null;
  /** True if Pharos Watch currently classifies the asset as actively depegged. */
  activeDepeg: boolean | null;
  /** Worst historical deviation in bps (context). */
  worstDeviationBps: number | null;
  note: string;
}

/** Subset of a /api/peg-summary coin entry we rely on (verified live). */
interface PegSummaryCoin {
  id: string;
  symbol?: string;
  currentDeviationBps?: number;
  pegScore?: number;
  activeDepeg?: boolean;
  worstDeviationBps?: number;
  priceConfidence?: string;
  priceUpdatedAt?: number;
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body };
}

export class PharosWatchClient {
  private pegCache: Map<string, PegSummaryCoin> | null = null;
  private pegError: string | null = null;

  constructor(private readonly cfg = PHAROS_WATCH) {}

  isConfigured(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  private authHeaders(): Record<string, string> {
    return this.isConfigured() ? { 'X-API-Key': this.cfg.apiKey } : {};
  }

  /** Key-exempt reachability check. */
  async health(): Promise<WatchHealth> {
    try {
      const { status, body } = await getJson(`${this.cfg.baseUrl}/api/health`, {});
      const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const caches = obj['caches'] as Record<string, { upstreamProvider?: string }> | undefined;
      const upstream = caches?.['stablecoins']?.upstreamProvider ?? null;
      return {
        reachable: status === 200,
        status: typeof obj['status'] === 'string' ? (obj['status'] as string) : null,
        upstreamProvider: upstream,
        raw: body,
      };
    } catch (err) {
      return { reachable: false, status: null, upstreamProvider: null, raw: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Fetch + cache /api/peg-summary, keyed by stablecoin id. */
  private async loadPegSummary(): Promise<Map<string, PegSummaryCoin> | null> {
    if (this.pegCache) return this.pegCache;
    if (this.pegError) return null;
    try {
      const { status, body } = await getJson(`${this.cfg.baseUrl}/api/peg-summary`, this.authHeaders());
      if (status !== 200) {
        this.pegError = `peg-summary HTTP ${status}`;
        return null;
      }
      const coins = (body as { coins?: PegSummaryCoin[] })?.coins ?? [];
      const map = new Map<string, PegSummaryCoin>();
      for (const c of coins) if (c && typeof c.id === 'string') map.set(c.id, c);
      this.pegCache = map;
      return map;
    } catch (err) {
      this.pegError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * Peg/NAV reference for a global stablecoin id (e.g. "usdc-circle"). Requires a
   * key; without one returns available:false with a clear reason (never faked).
   */
  async getPeg(stablecoinId: string): Promise<PegResult> {
    const base: PegResult = {
      stablecoinId,
      available: false,
      priceUsd: null,
      driftPct: null,
      deviationBps: null,
      pegScore: null,
      activeDepeg: null,
      worstDeviationBps: null,
      note: '',
    };

    if (!this.isConfigured()) {
      return { ...base, note: 'Pharos Watch API key not set — set PHAROS_WATCH_API_KEY to enable. Falling back to on-chain drift.' };
    }

    const map = await this.loadPegSummary();
    if (!map) {
      return { ...base, note: `Pharos Watch peg-summary unavailable: ${this.pegError ?? 'unknown error'}.` };
    }
    const coin = map.get(stablecoinId);
    if (!coin) {
      return { ...base, note: `"${stablecoinId}" not present in Pharos Watch peg-summary.` };
    }

    const bps = typeof coin.currentDeviationBps === 'number' ? coin.currentDeviationBps : null;
    return {
      stablecoinId,
      available: true,
      priceUsd: bps === null ? null : 1 + bps / 10_000,
      driftPct: bps === null ? null : bps / 100,
      deviationBps: bps,
      pegScore: typeof coin.pegScore === 'number' ? coin.pegScore : null,
      activeDepeg: typeof coin.activeDepeg === 'boolean' ? coin.activeDepeg : null,
      worstDeviationBps: typeof coin.worstDeviationBps === 'number' ? coin.worstDeviationBps : null,
      note:
        `Pharos Watch peg-summary: deviation ${bps ?? '—'} bps, pegScore ${coin.pegScore ?? '—'}/100` +
        (coin.activeDepeg ? ', ACTIVE DEPEG' : '') +
        (coin.priceConfidence ? ` (confidence ${coin.priceConfidence})` : '') +
        '.',
    };
  }
}
