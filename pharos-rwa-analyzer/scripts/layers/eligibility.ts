/**
 * Layer 1 — eligibility. For each product: can THIS wallet act, or is it gated?
 *
 * Derived from real reads (is the market active/frozen, did the vault respond)
 * plus the known access map. OpenFi + ZonaLend = permissionless; Tulipa = gated
 * deposit but the owner already holds a position (open to them); pAlpha = gated.
 */

import { PALPHA } from '../config.js';
import type { WalletScan } from '../collect.js';
import { sourced, type Sourced } from '../types.js';

export interface EligibilityEntry {
  product: string;
  access: 'permissionless' | 'gated' | 'gated-but-owned';
  actionable: boolean;
  reason: Sourced<string>;
}

export interface EligibilityResult {
  layer: 'eligibility';
  entries: EligibilityEntry[];
}

export function analyzeEligibility(scan: WalletScan): EligibilityResult {
  const entries: EligibilityEntry[] = [];

  // Lending venues — permissionless if at least one reserve is active and not frozen.
  for (const l of scan.lending) {
    const usable = l.reserves.filter((r) => r.isActive && !r.isFrozen);
    const frozen = l.reserves.filter((r) => r.isFrozen);
    const actionable = usable.length > 0;
    const reason = actionable
      ? `Permissionless: ${usable.length}/${l.reserves.length} reserves active & not frozen (${usable
          .map((r) => r.symbol)
          .join(', ')}).` + (frozen.length ? ` Frozen: ${frozen.map((r) => r.symbol).join(', ')}.` : '')
      : `No active, non-frozen reserves found — not actionable right now.`;
    entries.push({
      product: l.product,
      access: 'permissionless',
      actionable,
      reason: sourced(reason, 'on-chain', 'high'),
    });
  }

  // Tulipa — deposits are signature-gated, but the owner already holds shares.
  if (scan.vault) {
    const holds = scan.vault.position.shares > 0;
    entries.push({
      product: scan.vault.info.product,
      access: 'gated-but-owned',
      actionable: holds,
      reason: sourced(
        holds
          ? `Holds ${scan.vault.position.shares} ${scan.vault.info.symbol} shares — position is open to this wallet. ` +
              `New deposits are signature-gated (deposit selector 0x50921b23 requires an allowlisted signer).`
          : `Vault is ERC-4626 and readable, but deposits are signature-gated; this wallet holds no shares.`,
        'on-chain',
        'high',
      ),
    });
  }

  // pAlpha — gated institutional benchmark; never actionable for this wallet, no on-chain read.
  entries.push({
    product: PALPHA.product,
    access: 'gated',
    actionable: false,
    reason: sourced(PALPHA.note, 'static', 'medium'),
  });

  return { layer: 'eligibility', entries };
}
