/**
 * pricing.calculate — Calculate pricing for a deal.
 * Wraps: api/lib/pricing.js (pure functions)
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

// Import from the existing pricing engine
import {
  calculatePricing,
  checkApprovalRules,
  formatPricingSummary,
  normalizeChannel,
  DISCOUNT_TYPES,
  PAYMENT_TERMS,
} from '../../api/lib/pricing.js';

export const pricingCalculate: ToolAdapter = {
  contract: {
    name: 'pricing.calculate',
    version: 1,
    description: 'Calculate pricing for a deal based on GMV tier',
    category: 'proposal',
    source_system: 'internal',
    risk_level: 'safe',
    approval_required: false,
    idempotency: { strategy: 'natural' },
    side_effects: [],
    retry: { max_retries: 0, backoff: 'none', base_delay_ms: 0, retryable_errors: [] },
    timeout_ms: 1000,
  },

  async execute(inputs: {
    company_name: string;
    ltm_media_spend: number;
    enabled_channels: string[];
    payment_term?: string;
    discount_percent?: number;
    discount_type?: string;
    term_months?: number;
  }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();

    try {
      const normalizedChannels = (inputs.enabled_channels || [])
        .map((ch: string) => normalizeChannel(ch))
        .filter(Boolean);

      if (!normalizedChannels.length) {
        return {
          success: false, outputs: {}, events: [], side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: 'NO_CHANNELS', message: 'At least one valid sales channel required', retryable: false },
        };
      }

      const pricingInput = {
        brandName: inputs.company_name,
        ltmMediaSpend: inputs.ltm_media_spend,
        enabledChannels: normalizedChannels,
        numberOfRetailChannels: 1,
        requestedDiscountPercent: inputs.discount_percent || null,
        discountType: inputs.discount_type || DISCOUNT_TYPES.NONE,
        paymentTerms: inputs.payment_term || PAYMENT_TERMS.SEMI_ANNUAL_NET_7,
        termMonths: inputs.term_months || 12,
        optOutMonths: 6,
      };

      const pricing = calculatePricing(pricingInput);
      const approval = checkApprovalRules(pricingInput, pricing);
      const summary = formatPricingSummary(pricingInput, pricing, approval);

      return {
        success: true,
        outputs: {
          quote: {
            ...pricing,
            requires_deal_desk: approval.requiresDealdeskApproval,
            approval_status: approval.status,
            approval_reasons: approval.reasons,
          },
          summary,
        },
        events: [],
        side_effects_performed: [],
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'PRICING_ERROR', message: err.message, retryable: false },
      };
    }
  },
};
