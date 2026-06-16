/**
 * fixture.ts — shared constants + normalizer for the golden-snapshot test.
 *
 * The golden test pins a FIXED historical block and asserts the report still
 * matches a committed JSON, catching silent numeric drift from dependency/ABI
 * changes. To stay deterministic we normalize out the parts that legitimately
 * vary run-to-run:
 *   - meta.generatedAt (wall clock)
 *   - the Pharos Watch [api] nav flags + apiNote/apiAvailable (a LIVE off-chain
 *     service, not bound to the pinned block — so not reproducible by design)
 *
 * Everything else is on-chain and deterministic at the pinned block/hash.
 * If the RPC ever stops serving this block, regenerate with `npm run golden:gen`.
 */

import type { FullReport } from '../../scripts/api.js';

/** Fixed, archive-served Pharos mainnet block the golden report is pinned to. */
export const GOLDEN_BLOCK = 10_000_000;

/** Wallet the golden report is built for (the verified demo owner). */
export const GOLDEN_OWNER = '0x0Ac6bf160e208e67AF06d7F00c92AEfBbf089f95';

/** Strip the legitimately-variable fields so two runs at the same block compare equal. */
export function normalizeReport(report: FullReport): unknown {
  const c = structuredClone(report) as FullReport;
  c.meta.generatedAt = 0;
  c.snapshot.takenAt = 0; // wall-clock when the snapshot object was assembled
  // Pharos Watch is live and not block-bound — exclude it from the deterministic golden.
  c.nav.flags = c.nav.flags.filter((f) => f.value.source !== 'api');
  c.nav.apiNote = '<normalized: live api excluded>';
  c.nav.apiAvailable = false;
  return c;
}
