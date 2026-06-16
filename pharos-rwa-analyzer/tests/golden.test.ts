/**
 * golden.test.ts — deterministic regression test against a PINNED historical block.
 *
 * Re-builds the report at GOLDEN_BLOCK (archive-served) and asserts it still matches
 * the committed tests/golden/report.json (after normalizing out wall-clock + the live
 * Pharos Watch [api] data). This catches silent numeric drift that ordinary live
 * tests miss, because live values always change — here they must NOT, at a fixed block.
 *
 * No mocks: it reads real on-chain state at a real, immutable block. If the RPC ever
 * stops serving GOLDEN_BLOCK, regenerate the golden (see fixture.ts).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { collectWalletScan } from '../scripts/collect.js';
import { buildReport } from '../scripts/api.js';
import { GOLDEN_BLOCK, GOLDEN_OWNER, normalizeReport } from './golden/fixture.js';

const goldenPath = new URL('./golden/report.json', import.meta.url);

test('report at the pinned block matches the committed golden (deterministic replay)', async () => {
  const scan = await collectWalletScan(GOLDEN_OWNER, false, GOLDEN_BLOCK);
  assert.equal(scan.block, GOLDEN_BLOCK, 'scan must be pinned to the golden block');
  assert.ok(scan.blockHash, 'pinned block must have a hash');

  const report = await buildReport(scan, null);
  const actual = normalizeReport(report);
  const golden = JSON.parse(await readFile(goldenPath, 'utf8'));

  // Deep-equal the whole normalized report — any on-chain numeric drift fails here.
  assert.deepEqual(actual, golden);
});

test('proof anchors the report to the pinned block + hash and lists real reads', async () => {
  const scan = await collectWalletScan(GOLDEN_OWNER, false, GOLDEN_BLOCK);
  const { proof } = (await buildReport(scan, null)).meta;
  assert.equal(proof.blockNumber, GOLDEN_BLOCK);
  assert.equal(proof.chainId, '1672');
  assert.match(proof.blockHash ?? '', /^0x[0-9a-f]{64}$/, 'block hash should be a 32-byte hex');
  assert.ok(proof.reads.length > 0, 'proof should record the reads performed');
  for (const r of proof.reads) {
    assert.match(r.target, /^0x[0-9a-f]{40}$/, 'read target is a lowercased address');
    assert.match(r.selector, /^0x[0-9a-f]{8}$/, 'read selector is a 4-byte hex');
    assert.ok(r.count >= 1);
  }
});
