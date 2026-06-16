/**
 * generate.ts — regenerate the committed golden report.
 *
 * Run with `npm run golden:gen` when the report shape intentionally changes, or if
 * the RPC stops serving GOLDEN_BLOCK and you must move to a new pinned block.
 * It reads real on-chain state at the fixed block — no mocks.
 */

import { writeFile } from 'node:fs/promises';
import { collectWalletScan } from '../../scripts/collect.js';
import { buildReport, toJson } from '../../scripts/api.js';
import { GOLDEN_BLOCK, GOLDEN_OWNER, normalizeReport } from './fixture.js';

async function main(): Promise<void> {
  const scan = await collectWalletScan(GOLDEN_OWNER, false, GOLDEN_BLOCK);
  if (scan.block !== GOLDEN_BLOCK) throw new Error(`expected block ${GOLDEN_BLOCK}, pinned ${scan.block}`);
  if (!scan.blockHash) throw new Error('pinned block has no hash — RPC may not serve this historical block');
  const report = await buildReport(scan, null);
  const out = new URL('./report.json', import.meta.url);
  await writeFile(out, toJson(normalizeReport(report)) + '\n');
  console.error(`Wrote golden for block ${scan.block} (${scan.blockHash}); ${report.meta.proof.reads.length} reads.`);
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
