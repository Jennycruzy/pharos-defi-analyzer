/**
 * pharoswatch.ts — client for the Pharos Watch NAV/depeg API.
 *
 * VERIFIED in Step 0: base https://api.pharos.watch. `GET /api/health` is
 * key-exempt; all data routes (/api/peg-summary, /api/stablecoin/{id}, …) return
 * 401 without `X-API-Key`. So this client:
 *   - ALWAYS confirms reachability via /api/health (no key, proves the wiring),
 *   - uses the key for data routes ONLY when PHAROS_WATCH_API_KEY is set,
 *   - returns explicit, labeled "unavailable" results otherwise — never faked.
 *
 * The exact JSON field layout of the key-gated routes could not be shape-verified
 * without a key, so peg extraction is defensive (tries common field names) and is
 * labeled medium-confidence; missing/odd shapes degrade to a clear note.
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
  /** USD price if the API exposed one we could locate. */
  priceUsd: number | null;
  /** Drift from $1.00 in %, if priceUsd known. */
  driftPct: number | null;
  note: string;
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
      const obj = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {});
      const caches = obj['caches'] as Record<string, { upstreamProvider?: string }> | undefined;
      const upstream = caches?.['stablecoins']?.upstreamProvider ?? null;
      return {
        reachable: status === 200,
        status: typeof obj['status'] === 'string' ? (obj['status'] as string) : null,
        upstreamProvider: upstream,
        raw: body,
      };
    } catch (err) {
      return {
        reachable: false,
        status: null,
        upstreamProvider: null,
        raw: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Peg/NAV reference for a global stablecoin id (e.g. "usdc-circle"). Requires a
   * key; without one returns available:false with a clear reason (never faked).
   */
  async getPeg(stablecoinId: string): Promise<PegResult> {
    if (!this.isConfigured()) {
      return {
        stablecoinId,
        available: false,
        priceUsd: null,
        driftPct: null,
        note: 'Pharos Watch API key not set — set PHAROS_WATCH_API_KEY to enable. Falling back to on-chain drift.',
      };
    }
    try {
      const { status, body } = await getJson(
        `${this.cfg.baseUrl}/api/stablecoin/${encodeURIComponent(stablecoinId)}`,
        this.authHeaders(),
      );
      if (status === 401 || status === 403) {
        return { stablecoinId, available: false, priceUsd: null, driftPct: null, note: `API rejected key (HTTP ${status}).` };
      }
      if (status === 404) {
        return { stablecoinId, available: false, priceUsd: null, driftPct: null, note: `Not tracked by Pharos Watch (HTTP 404).` };
      }
      if (status !== 200) {
        return { stablecoinId, available: false, priceUsd: null, driftPct: null, note: `Unexpected HTTP ${status}.` };
      }
      const price = locatePrice(body);
      if (price === null) {
        return {
          stablecoinId,
          available: true,
          priceUsd: null,
          driftPct: null,
          note: 'API responded but no recognizable USD price field was found.',
        };
      }
      return {
        stablecoinId,
        available: true,
        priceUsd: price,
        driftPct: (price - 1) * 100,
        note: 'Live Pharos Watch price (issuer-level reference, DefiLlama-sourced).',
      };
    } catch (err) {
      return {
        stablecoinId,
        available: false,
        priceUsd: null,
        driftPct: null,
        note: `Pharos Watch request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/** Defensively locate a near-$1 USD price in an unknown-shape JSON body. */
function locatePrice(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  const candidates = ['price', 'priceUsd', 'price_usd', 'usdPrice', 'currentPrice', 'peg', 'pegPrice'];
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  // Look one level into a nested data/result object.
  for (const nestKey of ['data', 'result', 'stablecoin']) {
    const nested = obj[nestKey];
    if (nested && typeof nested === 'object') {
      const found = locatePrice(nested);
      if (found !== null) return found;
    }
  }
  return null;
}
