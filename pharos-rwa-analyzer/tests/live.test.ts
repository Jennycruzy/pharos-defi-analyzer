/**
 * live.test.ts — LIVE integration tests against Pharos mainnet. NO MOCKS.
 *
 * These assert invariants (not exact balances, which drift) that would catch the
 * classic failure modes called out in AGENTS.md: wrong network, wrong decimals,
 * wrong ray scaling (the "4,000,000% APY" bug), wrong oracle base unit, and broken
 * source-labeling. Run with `npm test`. Requires network access to rpc.pharos.xyz.
 *
 * If the RPC is unreachable the suite fails loudly (rather than passing silently),
 * because "can't reach mainnet" is itself a real problem worth surfacing.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PHAROS, TOKENS, AA_PREDEPLOYS } from '../scripts/config.js';
import { assertPharosNetwork, getProvider } from '../scripts/rpc.js';
import { collectWalletScan } from '../scripts/collect.js';
import { analyzeEligibility } from '../scripts/layers/eligibility.js';
import { analyzeRisk } from '../scripts/layers/risk.js';
import { analyzeNav } from '../scripts/layers/nav.js';
import { analyzeTrueYield } from '../scripts/layers/trueyield.js';

const OWNER = '0x0Ac6bf160e208e67AF06d7F00c92AEfBbf089f95';

// One shared scan for the whole suite (keeps RPC load down).
const scanPromise = (async () => {
  await assertPharosNetwork(false);
  return collectWalletScan(OWNER, false);
})();

test('connects to Pharos mainnet (chain 1672)', async () => {
  const net = await assertPharosNetwork(false);
  assert.equal(net.chainId, PHAROS.mainnetChainId, 'must be on Pharos mainnet 1672');
  assert.ok(net.isMainnet);
  assert.ok(net.blockNumber > 0, 'should read a positive block number');
});

test('USDC reserve has correct decimals (6) on both venues', async () => {
  const scan = await scanPromise;
  assert.ok(scan.lending.length >= 1, 'expected at least one lending venue');
  for (const l of scan.lending) {
    const usdc = l.reserves.find((r) => r.symbol === 'USDC');
    assert.ok(usdc, `${l.product} should list a USDC reserve`);
    assert.equal(usdc.decimals, 6, `${l.product} USDC decimals must be 6`);
    assert.equal(usdc.address.toLowerCase(), TOKENS.USDC.address.toLowerCase());
  }
});

test('supply APYs are sane — catches ray-scaling bugs (no 4,000,000% APY)', async () => {
  const scan = await scanPromise;
  for (const l of scan.lending) {
    for (const r of l.reserves) {
      assert.ok(r.supplyAprPct >= 0, `${l.product} ${r.symbol} APR must be >= 0`);
      assert.ok(r.supplyApyPct >= 0, `${l.product} ${r.symbol} APY must be >= 0`);
      // A correctly ray-scaled supply rate on these markets is well under 100%.
      assert.ok(r.supplyApyPct < 100, `${l.product} ${r.symbol} APY=${r.supplyApyPct}% looks unscaled (ray bug?)`);
    }
  }
});

test('oracle prices USDC near $1 with 8-decimal base — catches base-unit bugs', async () => {
  const scan = await scanPromise;
  let checked = 0;
  for (const l of scan.lending) {
    const price = l.assetUsd[TOKENS.USDC.address.toLowerCase()];
    if (price === undefined) continue;
    checked++;
    assert.ok(price > 0.9 && price < 1.1, `${l.product} USDC oracle price ${price} not near $1 (base-unit bug?)`);
  }
  assert.ok(checked > 0, 'at least one venue should price USDC');
});

test('Tulipa is ERC-4626 with USDC asset and a sane share price', async () => {
  const scan = await scanPromise;
  assert.ok(scan.vault, 'Tulipa should respond as ERC-4626');
  assert.equal(scan.vault.info.assetAddress.toLowerCase(), TOKENS.USDC.address.toLowerCase());
  assert.equal(scan.vault.info.decimals, 6);
  // Share price should be a positive number near 1 (RWA vault, USDC-denominated).
  assert.ok(scan.vault.info.sharePrice > 0.5 && scan.vault.info.sharePrice < 5, `share price ${scan.vault.info.sharePrice} out of sane band`);
});

test('incentives are read on-chain (controller present, rewards list array)', async () => {
  const scan = await scanPromise;
  for (const l of scan.lending) {
    for (const r of l.reserves) {
      const inc = l.incentives[r.address.toLowerCase()];
      assert.ok(inc, `${l.product} ${r.symbol} should have an incentive read`);
      assert.ok(Array.isArray(inc.rewardStreams), 'rewardStreams must be an array');
      assert.equal(typeof inc.hasActiveRewards, 'boolean');
    }
  }
});

test('all ERC-4337 / AA predeploys are deployed (Phase-2 readiness)', async () => {
  const provider = getProvider();
  for (const c of AA_PREDEPLOYS) {
    const code = await provider.getCode(c.address);
    assert.notEqual(code, '0x', `${c.name} (${c.address}) should be deployed`);
  }
});

test('every reported value carries a source label (honesty invariant)', async () => {
  const scan = await scanPromise;
  for (const e of analyzeEligibility(scan).entries) {
    assert.ok(['on-chain', 'api', 'static'].includes(e.reason.source), 'eligibility reason needs a source');
  }
  for (const e of analyzeTrueYield(scan, null).entries) {
    assert.ok(['on-chain', 'api', 'static'].includes(e.baseApyPct.source));
    assert.ok(['on-chain', 'api', 'static'].includes(e.incentiveApyNote.source));
  }
  const risk = analyzeRisk(scan);
  assert.ok(['on-chain', 'api', 'static'].includes(risk.totalUsd.source));
  assert.ok(risk.totalUsd.value !== null && risk.totalUsd.value >= 0, 'total USD must be >= 0');
});

test('nav layer flags share-price and stablecoin drift, never throws without a key', async () => {
  const scan = await scanPromise;
  const nav = await analyzeNav(scan);
  assert.ok(Array.isArray(nav.flags));
  for (const f of nav.flags) {
    assert.ok(['on-chain', 'api', 'static'].includes(f.value.source));
    assert.equal(typeof f.depegged, 'boolean');
  }
});
