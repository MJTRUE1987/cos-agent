/**
 * Prescient AI Pricing Engine — V3 GMV-tier model fees + flat media fee.
 * Ported from prescient-pricing-agent (Python) into COS Agent (JS/ESM).
 *
 * Pure functions, no side effects, no dependencies.
 */

// ── Enums / Constants ──────────────────────────────────────────────

export const SALES_CHANNELS = Object.freeze({
  DTC: 'DTC',
  AMAZON: 'Amazon',
  TIKTOK_SHOP: 'TikTok Shop',
  RETAIL: 'Retail',
});

const CHANNEL_ALIASES = new Map([
  ['dtc', SALES_CHANNELS.DTC],
  ['direct to consumer', SALES_CHANNELS.DTC],
  ['direct-to-consumer', SALES_CHANNELS.DTC],
  ['d2c', SALES_CHANNELS.DTC],
  ['shopify', SALES_CHANNELS.DTC],
  ['salesforce commerce cloud', SALES_CHANNELS.DTC],
  ['sfcc', SALES_CHANNELS.DTC],
  ['commerce cloud', SALES_CHANNELS.DTC],
  ['bigcommerce', SALES_CHANNELS.DTC],
  ['magento', SALES_CHANNELS.DTC],
  ['woocommerce', SALES_CHANNELS.DTC],
  ['amazon', SALES_CHANNELS.AMAZON],
  ['amz', SALES_CHANNELS.AMAZON],
  ['retail', SALES_CHANNELS.RETAIL],
  ['tiktok shop', SALES_CHANNELS.TIKTOK_SHOP],
  ['tiktok', SALES_CHANNELS.TIKTOK_SHOP],
  ['tik tok shop', SALES_CHANNELS.TIKTOK_SHOP],
]);

export const PAYMENT_TERMS = Object.freeze({
  SEMI_ANNUAL_NET_7: 'Semi-Annual Net 7',
  QUARTERLY_NET_7: 'Quarterly Net 7',
  QUARTERLY_NET_30: 'Quarterly Net 30',
  MONTHLY_NET_7: 'Monthly Net 7',
  MONTHLY_NET_30: 'Monthly Net 30',
  ANNUAL_NET_7: 'Annual Net 7',
  ANNUAL_NET_30: 'Annual Net 30',
});

export const DISCOUNT_TYPES = Object.freeze({
  NONE: 'none',
  BASE_FEE: 'base_fee',
  VARIABLE_FEE: 'variable_fee',
  BOTH: 'both',
});

export const APPROVAL_STATUSES = Object.freeze({
  AUTO_APPROVED: 'auto_approved',
  REQUIRES_DEALDESK: 'requires_dealdesk',
  HARD_STOP: 'hard_stop',
});

export const MAX_AUTO_DISCOUNT_PERCENT = 15;
const STANDARD_TERM_MONTHS = 12;
const MEDIA_RATE = 0.005; // 0.5%

// ── V3 GMV Tier Grid ───────────────────────────────────────────────

const V3_GMV_TIERS = [
  { tier: 'Tier 1',  min: 0,           max: 10_000_000,  rate: 500 },
  { tier: 'Tier 2',  min: 10_000_000,  max: 25_000_000,  rate: 600 },
  { tier: 'Tier 3',  min: 25_000_000,  max: 50_000_000,  rate: 700 },
  { tier: 'Tier 4',  min: 50_000_000,  max: 75_000_000,  rate: 800 },
  { tier: 'Tier 5',  min: 75_000_000,  max: 100_000_000, rate: 900 },
  { tier: 'Tier 6',  min: 100_000_000, max: 150_000_000, rate: 1_000 },
  { tier: 'Tier 7',  min: 150_000_000, max: 200_000_000, rate: 1_100 },
  { tier: 'Tier 8',  min: 200_000_000, max: 250_000_000, rate: 1_200 },
  { tier: 'Tier 9',  min: 250_000_000, max: 300_000_000, rate: 1_300 },
  { tier: 'Tier 10', min: 300_000_000, max: 350_000_000, rate: 1_400 },
  { tier: 'Tier 11', min: 350_000_000, max: 400_000_000, rate: 1_500 },
  { tier: 'Tier 12', min: 400_000_000, max: Infinity,    rate: 1_600 },
];

const MODEL_DESCRIPTIONS = {
  DTC: {
    granularity: 'Campaign',
    run: 'Daily',
    description: 'Measure top-of-funnel impact through Revenue / ROAS and New Customers / CAC attribution models. Simulate media spend based on specific budgets and predicted incremental growth.',
  },
  Amazon: {
    granularity: 'Campaign',
    run: 'Daily',
    description: 'Measure top-of-funnel impact through Revenue / ROAS attribution models. Simulate media spend based on specific budgets and predicted incremental growth.',
  },
  'TikTok Shop': {
    granularity: 'Campaign',
    run: 'Daily',
    description: 'Measure top-of-funnel impact through Revenue / ROAS and New Customers / CAC attribution models. Simulate media spend based on specific budgets and predicted incremental growth.',
  },
  Retail: {
    granularity: 'Campaign',
    run: 'Weekly',
    description: 'Measure top-of-funnel impact through Revenue / ROAS attribution models. Simulate media spend based on specific budgets and predicted incremental growth.',
  },
};

const CHANNEL_GMV_FIELD = {
  [SALES_CHANNELS.DTC]: 'dtcGmv',
  [SALES_CHANNELS.AMAZON]: 'amazonGmv',
  [SALES_CHANNELS.TIKTOK_SHOP]: 'tiktokGmv',
  [SALES_CHANNELS.RETAIL]: 'retailGmv',
};

const AUTO_APPROVED_PAYMENT_TERMS = new Set([
  PAYMENT_TERMS.SEMI_ANNUAL_NET_7,
  PAYMENT_TERMS.QUARTERLY_NET_7,
  PAYMENT_TERMS.ANNUAL_NET_7,
  PAYMENT_TERMS.ANNUAL_NET_30,
]);

const DEALDESK_PAYMENT_TERMS = new Set([
  PAYMENT_TERMS.QUARTERLY_NET_30,
  PAYMENT_TERMS.MONTHLY_NET_7,
  PAYMENT_TERMS.MONTHLY_NET_30,
]);

// ── Helpers ────────────────────────────────────────────────────────

export function normalizeChannel(input) {
  const normalized = (input || '').trim().toLowerCase();
  if (CHANNEL_ALIASES.has(normalized)) return CHANNEL_ALIASES.get(normalized);
  for (const ch of Object.values(SALES_CHANNELS)) {
    if (ch.toLowerCase() === normalized) return ch;
  }
  return null;
}

export function getGmvTier(gmv) {
  for (const t of V3_GMV_TIERS) {
    if (gmv < t.max) return t;
  }
  return V3_GMV_TIERS[V3_GMV_TIERS.length - 1];
}

export function getModelDescription(channelName) {
  return MODEL_DESCRIPTIONS[channelName] || MODEL_DESCRIPTIONS.Retail;
}

function roundToHundred(value) {
  return Math.round(value / 100) * 100;
}

function roundUpToHundred(value) {
  return Math.ceil(value / 100) * 100;
}

function countChannels(input) {
  let count = 0;
  for (const ch of input.enabledChannels) {
    count += ch === SALES_CHANNELS.RETAIL ? (input.numberOfRetailChannels || 1) : 1;
  }
  return count;
}

function getChannelGmv(input, channel) {
  const field = CHANNEL_GMV_FIELD[channel];
  return field ? (input[field] || 0) : 0;
}

function formatMoney(n) {
  if (!n) return '$0';
  return n >= 1_000_000
    ? '$' + (n / 1_000_000).toFixed(1) + 'M'
    : '$' + Math.round(n / 1000) + 'K';
}

// ── Validation ─────────────────────────────────────────────────────

export function validatePricingInput(input) {
  const errors = [];
  if (!input.brandName) errors.push('brandName is required');
  if (!input.ltmMediaSpend || input.ltmMediaSpend <= 0) errors.push('ltmMediaSpend must be > 0');
  if (!input.enabledChannels || !input.enabledChannels.length) errors.push('At least one channel is required');
  if (input.requestedDiscountPercent != null && (input.requestedDiscountPercent < 0 || input.requestedDiscountPercent > 100)) {
    errors.push('requestedDiscountPercent must be 0-100');
  }
  if (input.termMonths != null && input.termMonths < 1) errors.push('termMonths must be >= 1');
  if (input.optOutMonths != null && input.optOutMonths < 0) errors.push('optOutMonths must be >= 0');
  return { valid: errors.length === 0, errors };
}

// ── Calculator ─────────────────────────────────────────────────────

export function calculateBaseFees(input, discountPercent = 0, applyDiscount = false) {
  const breakdown = [];
  let monthlyTotal = 0;
  let discountedMonthlyTotal = 0;
  const useFlatRate = input.customBaseFeeMonthly != null;

  for (const channel of input.enabledChannels) {
    const iterations = channel === SALES_CHANNELS.RETAIL ? (input.numberOfRetailChannels || 1) : 1;

    for (let i = 0; i < iterations; i++) {
      let label;
      if (channel === SALES_CHANNELS.RETAIL) {
        if (input.retailerNames && i < input.retailerNames.length) {
          label = input.retailerNames[i];
        } else if (iterations > 1) {
          label = `Retail Channel ${i + 1}`;
        } else {
          label = 'Retail';
        }
      } else {
        label = channel;
      }

      let monthly, tierName = null, channelGmv = null;
      if (useFlatRate) {
        monthly = input.customBaseFeeMonthly;
      } else {
        const gmv = getChannelGmv(input, channel);
        const tier = getGmvTier(gmv);
        monthly = tier.rate;
        tierName = tier.tier;
        channelGmv = gmv;
      }

      let discountedMonthlyFee = null;
      let discountedAnnualFee = null;
      if (applyDiscount && discountPercent > 0) {
        const rawDiscounted = monthly * (1 - discountPercent / 100);
        discountedMonthlyFee = roundToHundred(rawDiscounted);
        discountedAnnualFee = discountedMonthlyFee * 12;
        discountedMonthlyTotal += discountedMonthlyFee;
      } else {
        discountedMonthlyTotal += monthly;
      }

      breakdown.push({
        channel: label,
        monthlyFee: monthly,
        annualFee: monthly * 12,
        discountedMonthlyFee,
        discountedAnnualFee,
        gmvTier: tierName,
        channelGmv,
      });
      monthlyTotal += monthly;
    }
  }

  const annualTotal = monthlyTotal * 12;
  const discountedAnnualTotal = discountedMonthlyTotal * 12;

  if (applyDiscount && discountPercent > 0) {
    return { monthlyTotal: discountedMonthlyTotal, annualTotal: discountedAnnualTotal, breakdown };
  }
  return { monthlyTotal, annualTotal, breakdown };
}

export function calculateVariableFee(ltmSpend, discountPercent = 0, applyDiscount = false, rateMultiplier = 1.0) {
  const rate = MEDIA_RATE * rateMultiplier;
  const totalFee = ltmSpend * rate;
  const discountMult = applyDiscount ? (1 - discountPercent / 100) : 1;

  let discountedRate = null;
  let discountedFee = null;
  if (applyDiscount && discountPercent > 0) {
    discountedRate = rate * discountMult;
    discountedFee = ltmSpend * discountedRate;
  }

  const breakdown = [{
    tierLabel: 'All Spend',
    tierFloor: 0,
    tierCeiling: ltmSpend,
    spendInTier: ltmSpend,
    rate,
    fee: totalFee,
    discountedRate,
    discountedFee,
  }];

  if (applyDiscount && discountPercent > 0) {
    const monthlyDiscounted = discountedFee / 12;
    const monthlyRounded = roundUpToHundred(monthlyDiscounted);
    return { annualFee: monthlyRounded * 12, breakdown };
  }

  const monthlyFee = totalFee / 12;
  const monthlyRounded = roundUpToHundred(monthlyFee);
  return { annualFee: monthlyRounded * 12, breakdown };
}

export function calculatePricing(input) {
  const discountPercent = input.requestedDiscountPercent || 0;
  const discountType = input.discountType || DISCOUNT_TYPES.NONE;
  const rateMultiplier = input.variableRateMultiplier || 1.0;
  const additionalDiscount = input.additionalDiscountAmount || 0;

  const applyToBase = (discountType === DISCOUNT_TYPES.BASE_FEE || discountType === DISCOUNT_TYPES.BOTH) && discountPercent > 0;
  const applyToVariable = (discountType === DISCOUNT_TYPES.VARIABLE_FEE || discountType === DISCOUNT_TYPES.BOTH) && discountPercent > 0;

  // Model fees (V3 GMV-tier based)
  const base = calculateBaseFees(input, discountPercent, applyToBase);

  // Media fee
  const variable = calculateVariableFee(input.ltmMediaSpend, discountPercent, applyToVariable, rateMultiplier);
  const variableMonthly = variable.annualFee / 12;

  // List prices (before any discount, but with custom rates)
  const listBase = calculateBaseFees(input);
  const listVariable = calculateVariableFee(input.ltmMediaSpend, 0, false, rateMultiplier);
  const listPriceAnnual = listBase.annualTotal + listVariable.annualFee;
  const listPriceMonthly = listPriceAnnual / 12;

  // Totals (after discount)
  let totalAnnual = base.annualTotal + variable.annualFee;
  if (additionalDiscount > 0) totalAnnual -= additionalDiscount;
  const totalMonthly = totalAnnual / 12;

  // Discount amount
  const discountAmount = (discountPercent > 0 || additionalDiscount > 0) ? listPriceAnnual - totalAnnual : null;

  // Effective rate
  const effectiveRatePercent = (totalAnnual / input.ltmMediaSpend) * 100;

  return {
    brandName: input.brandName,
    ltmMediaSpend: input.ltmMediaSpend,
    baseFeeMonthly: listBase.monthlyTotal,
    baseFeeAnnual: listBase.annualTotal,
    baseFeeBreakdown: base.breakdown,
    variableFeeAnnual: listVariable.annualFee,
    variableFeeMonthly: listVariable.annualFee / 12,
    tierBreakdown: variable.breakdown,
    listPriceMonthly,
    listPriceAnnual,
    totalMonthly,
    totalAnnual,
    effectiveRatePercent,
    discountPercent: discountPercent > 0 ? discountPercent : null,
    discountType,
    discountAmount,
    additionalDiscountAmount: additionalDiscount > 0 ? additionalDiscount : null,
    discountedBaseFeeAnnual: applyToBase ? base.annualTotal : null,
    discountedVariableFeeAnnual: applyToVariable ? variable.annualFee : null,
    customBaseFeeMonthly: input.customBaseFeeMonthly || null,
    variableRateMultiplier: rateMultiplier !== 1.0 ? rateMultiplier : null,
    paymentTerms: input.paymentTerms || PAYMENT_TERMS.SEMI_ANNUAL_NET_7,
    termMonths: input.termMonths || 12,
    optOutMonths: input.optOutMonths != null ? input.optOutMonths : 6,
    calculatedAt: new Date().toISOString(),
  };
}

/**
 * Reverse-calculate: given a target annual price, find the balanced discount %
 * that applies equally to both model fees and media fees to hit the target.
 * Uses binary search because rounding ($100 increments) makes it non-linear.
 */
export function reverseFromTarget(input, targetAnnual) {
  // Get list price first
  const listResult = calculatePricing({ ...input, requestedDiscountPercent: 0, discountType: DISCOUNT_TYPES.NONE, additionalDiscountAmount: 0 });
  const listPrice = listResult.listPriceAnnual;

  if (targetAnnual >= listPrice) {
    return { discountPercent: 0, discountType: DISCOUNT_TYPES.NONE, achievedAnnual: listPrice, listPriceAnnual: listPrice };
  }
  if (targetAnnual <= 0) {
    return { discountPercent: 100, discountType: DISCOUNT_TYPES.BOTH, achievedAnnual: 0, listPriceAnnual: listPrice };
  }

  // Binary search for the discount % that gets closest to target
  let lo = 0, hi = 100, bestPct = 0, bestDiff = Infinity, bestAnnual = listPrice;

  for (let iter = 0; iter < 50; iter++) {
    const mid = (lo + hi) / 2;
    const trial = calculatePricing({
      ...input,
      requestedDiscountPercent: mid,
      discountType: DISCOUNT_TYPES.BOTH,
      additionalDiscountAmount: 0,
    });
    const diff = Math.abs(trial.totalAnnual - targetAnnual);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestPct = mid;
      bestAnnual = trial.totalAnnual;
    }
    if (trial.totalAnnual > targetAnnual) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (diff < 50) break; // close enough (within $50 due to rounding)
  }

  // Round to 2 decimal places
  bestPct = Math.round(bestPct * 100) / 100;

  return {
    discountPercent: bestPct,
    discountType: DISCOUNT_TYPES.BOTH,
    achievedAnnual: bestAnnual,
    listPriceAnnual: listPrice,
  };
}

// ── Approval Rules ─────────────────────────────────────────────────

export function checkApprovalRules(input, pricing) {
  const reasons = [];
  let requiresDealdesk = false;

  // Hard stops
  if (!input.ltmMediaSpend || input.ltmMediaSpend <= 0) {
    return {
      status: APPROVAL_STATUSES.HARD_STOP,
      reasons: [{ code: 'NO_LTM_SPEND', message: 'LTM media spend is required and must be greater than 0', severity: 'hard_stop' }],
      canProceed: false,
      requiresDealdeskApproval: false,
    };
  }
  if (!input.enabledChannels || !input.enabledChannels.length) {
    return {
      status: APPROVAL_STATUSES.HARD_STOP,
      reasons: [{ code: 'NO_CHANNELS', message: 'At least one sales channel must be enabled', severity: 'hard_stop' }],
      canProceed: false,
      requiresDealdeskApproval: false,
    };
  }

  // Discount rules
  const discountPercent = input.requestedDiscountPercent || 0;
  if (discountPercent > 0) {
    const typeLabel = (input.discountType || 'none').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (discountPercent <= MAX_AUTO_DISCOUNT_PERCENT) {
      reasons.push({ code: 'DISCOUNT_AUTO_APPROVED', message: `Discount of ${discountPercent}% on ${typeLabel} (within ${MAX_AUTO_DISCOUNT_PERCENT}% limit)`, severity: 'info' });
    } else {
      requiresDealdesk = true;
      reasons.push({ code: 'DISCOUNT_OVER_LIMIT', message: `Discount of ${discountPercent}% on ${typeLabel} exceeds ${MAX_AUTO_DISCOUNT_PERCENT}% auto-approval limit`, severity: 'dealdesk' });
    }
  }

  // Payment terms
  const paymentTerms = input.paymentTerms || PAYMENT_TERMS.SEMI_ANNUAL_NET_7;
  if (DEALDESK_PAYMENT_TERMS.has(paymentTerms)) {
    requiresDealdesk = true;
    reasons.push({ code: 'PAYMENT_TERMS_DEALDESK', message: `Payment terms '${paymentTerms}' requires deal desk approval`, severity: 'dealdesk' });
  } else if (AUTO_APPROVED_PAYMENT_TERMS.has(paymentTerms) && paymentTerms !== PAYMENT_TERMS.SEMI_ANNUAL_NET_7) {
    reasons.push({ code: 'PAYMENT_TERMS_OK', message: `Payment terms '${paymentTerms}' is auto-approved`, severity: 'info' });
  }

  // Non-standard term
  const termMonths = input.termMonths || 12;
  if (termMonths !== STANDARD_TERM_MONTHS) {
    requiresDealdesk = true;
    reasons.push({ code: 'NON_STANDARD_TERM', message: `Non-standard term of ${termMonths} months (standard is ${STANDARD_TERM_MONTHS})`, severity: 'dealdesk' });
  }

  // Excluded spend
  if (input.excludedOrNonManagedSpend) {
    requiresDealdesk = true;
    reasons.push({ code: 'EXCLUDED_SPEND', message: `Excluded/non-managed spend of $${input.excludedOrNonManagedSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}`, severity: 'dealdesk' });
  }

  // Opt-out period
  const optOutMonths = input.optOutMonths != null ? input.optOutMonths : 6;
  if (optOutMonths < 6) {
    requiresDealdesk = true;
    reasons.push({ code: 'OPT_OUT_PERIOD_SHORT', message: `Opt-out period of ${optOutMonths} months is less than standard 6 months`, severity: 'dealdesk' });
  }

  // Final status
  const status = requiresDealdesk ? APPROVAL_STATUSES.REQUIRES_DEALDESK : APPROVAL_STATUSES.AUTO_APPROVED;
  if (status === APPROVAL_STATUSES.AUTO_APPROVED && reasons.length === 0) {
    reasons.push({ code: 'STANDARD_PRICING', message: 'Standard pricing with no deviations - auto-approved', severity: 'info' });
  }

  return { status, reasons, canProceed: true, requiresDealdeskApproval: requiresDealdesk };
}

// ── Summary Formatter ──────────────────────────────────────────────

export function formatPricingSummary(input, pricing, approval) {
  const channelsStr = input.enabledChannels.join(', ');
  const discountOnBase = pricing.discountType === DISCOUNT_TYPES.BASE_FEE && pricing.discountPercent;
  const discountOnVariable = pricing.discountType === DISCOUNT_TYPES.VARIABLE_FEE && pricing.discountPercent;

  const lines = [
    `# Prescient AI Pricing Proposal`,
    `## ${input.brandName}`,
    '', '---', '',
    '## Investment Summary',
    '',
    `**Global LTM Media Spend:** $${pricing.ltmMediaSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `**Enabled Models:** ${channelsStr}`,
    '', '---', '',
    '### Model Fees (per GMV Tier)',
    '',
  ];

  const defaultedChannels = [];
  for (const b of pricing.baseFeeBreakdown) {
    const tierLabel = b.gmvTier ? ` (${b.gmvTier})` : '';
    if (b.gmvTier === 'Tier 1' && (!b.channelGmv || b.channelGmv === 0)) defaultedChannels.push(b.channel);
    if (discountOnBase && b.discountedMonthlyFee != null) {
      lines.push(`- ${b.channel}${tierLabel}: ~~$${b.monthlyFee.toLocaleString()}~~ $${b.discountedMonthlyFee.toLocaleString()}/month (~~$${b.annualFee.toLocaleString()}~~ $${b.discountedAnnualFee.toLocaleString()}/year)`);
    } else {
      lines.push(`- ${b.channel}${tierLabel}: $${b.monthlyFee.toLocaleString()}/month ($${b.annualFee.toLocaleString()}/year)`);
    }
  }

  if (defaultedChannels.length) {
    lines.push(`\n> *${defaultedChannels.join(', ')}* defaulted to Tier 1 — provide GMV per channel for accurate pricing`);
  }

  if (discountOnBase && pricing.discountedBaseFeeAnnual != null) {
    const bmd = pricing.discountedBaseFeeAnnual / 12;
    lines.push('', `**Total Model Fees:** ~~$${pricing.baseFeeMonthly.toLocaleString()}~~ $${bmd.toLocaleString()}/month | ~~$${pricing.baseFeeAnnual.toLocaleString()}~~ $${pricing.discountedBaseFeeAnnual.toLocaleString()}/year`);
  } else {
    lines.push('', `**Total Model Fees:** $${pricing.baseFeeMonthly.toLocaleString()}/month | $${pricing.baseFeeAnnual.toLocaleString()}/year`);
  }

  lines.push('', '---', '', '### Media Fee (Based on LTM Media Spend)', '');

  const tier = pricing.tierBreakdown[0];
  if (tier) {
    if (discountOnVariable && tier.discountedRate != null) {
      lines.push(`**Rate:** ~~${(tier.rate * 100).toFixed(2)}%~~ **${(tier.discountedRate * 100).toFixed(3)}%** of LTM Media Spend (${pricing.discountPercent}% discount)`, '');
      const vmd = pricing.discountedVariableFeeAnnual / 12;
      lines.push(`**Total Media Fee:** ~~$${pricing.variableFeeMonthly.toLocaleString()}~~ $${vmd.toLocaleString()}/month | ~~$${pricing.variableFeeAnnual.toLocaleString()}~~ $${pricing.discountedVariableFeeAnnual.toLocaleString()}/year`);
    } else {
      lines.push(`**Rate:** ${(tier.rate * 100).toFixed(2)}% of LTM Media Spend`, '');
      lines.push(`**Total Media Fee:** $${pricing.variableFeeMonthly.toLocaleString()}/month | $${pricing.variableFeeAnnual.toLocaleString()}/year`);
    }
  }

  lines.push('', '---', '', '### Total Investment', '');

  if (pricing.discountPercent) {
    const typeLabel = pricing.discountType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`~~**List Price:** $${pricing.listPriceAnnual.toLocaleString()}/year~~`);
    lines.push(`**Discount Applied:** ${pricing.discountPercent}% on ${typeLabel} (-$${pricing.discountAmount.toLocaleString()})`, '');
  }

  lines.push(
    `**Monthly:** $${pricing.totalMonthly.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `**Annual:** $${pricing.totalAnnual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    '',
    `**Effective Rate:** ${pricing.effectiveRatePercent.toFixed(3)}% of LTM Media Spend`,
    '', '---', '',
    `**Contract Term:** ${pricing.termMonths} months`,
    `**Payment Terms:** ${pricing.paymentTerms}`,
    '',
  );

  // Scenarios table
  lines.push(...buildScenariosTable(input, pricing));

  // Approval status
  if (approval.status === APPROVAL_STATUSES.AUTO_APPROVED) {
    lines.push('*Standard pricing - Auto-approved*');
  } else if (approval.status === APPROVAL_STATUSES.REQUIRES_DEALDESK) {
    lines.push('*Note: This pricing requires Deal Desk approval*');
    for (const r of approval.reasons) {
      if (r.severity === 'dealdesk' || r.severity === 'hard_stop') {
        lines.push(`- ${r.message}`);
      }
    }
  }

  return lines.join('\n');
}

function buildScenariosTable(input, pricing) {
  const ltm = input.ltmMediaSpend;
  const multiplier = input.variableRateMultiplier || 1.0;
  const modelFeesAnnual = pricing.baseFeeAnnual;
  const numChannels = countChannels(input);

  const scenarios = [
    ['-40%', 0.60], ['-20%', 0.80], ['Base', 1.00], ['+20%', 1.20], ['+40%', 1.40],
  ];

  function row(label, spend, modelAnnual) {
    const { annualFee: varAnnual } = calculateVariableFee(spend, 0, false, multiplier);
    const total = modelAnnual + varAnnual;
    const eff = spend ? (total / spend) * 100 : 0;
    const bold = label === 'Base' ? '**' : '';
    return `| ${bold}${label}${bold} | $${spend.toLocaleString()} | $${modelAnnual.toLocaleString()} | $${varAnnual.toLocaleString()} | ${bold}$${total.toLocaleString()}${bold} | ${bold}${eff.toFixed(2)}%${bold} |`;
  }

  const channelsStr = input.enabledChannels.join(', ');
  const lines = [
    '---', '',
    '### Illustrative Pricing Scenarios', '',
    `#### ${numChannels} Models (${channelsStr})`, '',
    '| Spend Change | LTM Spend | Model Fees | Media Fee | Total Annual | Eff. Rate |',
    '|:---:|---:|---:|---:|---:|---:|',
  ];
  for (const [label, factor] of scenarios) {
    lines.push(row(label, Math.round(ltm * factor), modelFeesAnnual));
  }

  // +1 Retailer table
  const extraModelAnnual = modelFeesAnnual + 6_000;
  lines.push('', `#### ${numChannels + 1} Models (+1 Retailer)`, '',
    '| Spend Change | LTM Spend | Model Fees | Media Fee | Total Annual | Eff. Rate |',
    '|:---:|---:|---:|---:|---:|---:|',
  );
  for (const [label, factor] of scenarios) {
    lines.push(row(label, Math.round(ltm * factor), extraModelAnnual));
  }

  lines.push('', '');
  return lines;
}
