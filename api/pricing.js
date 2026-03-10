// Pricing Calculator API
// Accepts brand details, returns calculated pricing + approval status + summary

import {
  normalizeChannel,
  validatePricingInput,
  calculatePricing,
  reverseFromTarget,
  checkApprovalRules,
  formatPricingSummary,
  PAYMENT_TERMS,
  DISCOUNT_TYPES,
} from './lib/pricing.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // Normalize channels
  const rawChannels = body.enabledChannels || [];
  const enabledChannels = [];
  const unknownChannels = [];
  for (const ch of rawChannels) {
    const normalized = normalizeChannel(ch);
    if (normalized) {
      if (!enabledChannels.includes(normalized)) enabledChannels.push(normalized);
    } else {
      unknownChannels.push(ch);
    }
  }
  if (unknownChannels.length) {
    return res.status(400).json({ error: `Unknown channels: ${unknownChannels.join(', ')}` });
  }

  // Build input
  const input = {
    brandName: body.brandName,
    ltmMediaSpend: body.ltmMediaSpend,
    enabledChannels,
    numberOfRetailChannels: body.numberOfRetailChannels || 1,
    retailerNames: body.retailerNames || null,
    dtcGmv: body.dtcGmv || null,
    amazonGmv: body.amazonGmv || null,
    retailGmv: body.retailGmv || null,
    tiktokGmv: body.tiktokGmv || null,
    customerType: body.customerType || 'new',
    requestedDiscountPercent: body.requestedDiscountPercent || null,
    discountType: body.discountType || DISCOUNT_TYPES.NONE,
    paymentTerms: body.paymentTerms || PAYMENT_TERMS.SEMI_ANNUAL_NET_7,
    termMonths: body.termMonths || 12,
    optOutMonths: body.optOutMonths != null ? body.optOutMonths : 6,
    customBaseFeeMonthly: body.customBaseFeeMonthly || null,
    variableRateMultiplier: body.variableRateMultiplier || null,
    additionalDiscountAmount: body.additionalDiscountAmount || null,
    excludedOrNonManagedSpend: body.excludedOrNonManagedSpend || null,
    notes: body.notes || null,
  };

  // Validate
  const { valid, errors } = validatePricingInput(input);
  if (!valid) {
    return res.status(400).json({ error: 'Validation failed', validationErrors: errors });
  }

  try {
    // If targetAnnual provided, reverse-calculate balanced discount first
    let reverseResult = null;
    if (body.targetAnnual && body.targetAnnual > 0) {
      reverseResult = reverseFromTarget(input, body.targetAnnual);
      input.requestedDiscountPercent = reverseResult.discountPercent;
      input.discountType = reverseResult.discountType;
    }

    const pricing = calculatePricing(input);
    const approval = checkApprovalRules(input, pricing);
    const summary = formatPricingSummary(input, pricing, approval);

    return res.status(200).json({ success: true, pricing, approval, summary, reverseResult });
  } catch (err) {
    console.error('Pricing calculation error:', err);
    return res.status(500).json({ error: 'Pricing calculation failed: ' + err.message });
  }
}
