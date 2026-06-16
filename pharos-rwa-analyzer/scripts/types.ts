/**
 * Shared types for the Pharos RWA Analyzer.
 *
 * The single most important type here is `Sourced<T>` — it forces every value
 * the analyzer reports to carry an explicit data-source label and confidence,
 * so an `[on-chain]` reading is never silently blurred into a `[static]` guess.
 * HARD RULE #5 (honesty in output) is enforced structurally by this type.
 */

/** Where a value came from. Printed verbatim next to the value. */
export type DataSource =
  | 'on-chain' // read live from a Pharos mainnet contract this run
  | 'api' //      fetched live from the Pharos Watch API this run
  | 'static'; //  known/off-chain, NOT live-verifiable (e.g. a published date)

/** A value plus its provenance. `null` value = we could not source it (omit, never fake). */
export interface Sourced<T> {
  value: T | null;
  source: DataSource;
  /** Low when degraded/approximated; high when a direct live read. */
  confidence: 'high' | 'medium' | 'low';
  /** Optional plain-language note explaining caveats or why value is null. */
  note?: string;
}

export function sourced<T>(
  value: T | null,
  source: DataSource,
  confidence: Sourced<T>['confidence'] = 'high',
  note?: string,
): Sourced<T> {
  return note === undefined ? { value, source, confidence } : { value, source, confidence, note };
}

/** A position the wallet holds (or could hold) in one product. */
export interface Position {
  product: string; // e.g. "OpenFi", "ZonaLend", "Tulipa"
  venue: string; // human venue label
  asset: string; // token symbol, e.g. "USDC"
  assetAddress: string;
  /** Underlying-asset units the wallet supplied/holds (human decimal, not wei). */
  suppliedAmount: number;
  /** Underlying-asset units borrowed (human decimal). 0 if none. */
  borrowedAmount: number;
  /** USD value of the supplied amount, via the venue oracle (8-decimal base). */
  suppliedUsd: Sourced<number>;
  /** USD value of debt. */
  borrowedUsd: Sourced<number>;
  decimals: number;
  kind: 'lending' | 'vault';
}

/** Kept deliberately small — the CLI prints these, the --json flag emits them. */
export interface AnalyzerError {
  scope: string;
  message: string;
}
