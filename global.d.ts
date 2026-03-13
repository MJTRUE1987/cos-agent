// Ambient module declarations for JS files that lack types

declare module '*/api/lib/pricing.js' {
  export function calculatePricing(input: any): any;
  export function checkApprovalRules(input: any, pricing: any): any;
  export function formatPricingSummary(input: any, pricing: any, approval: any): string;
  export function normalizeChannel(input: string): string | null;
  export const DISCOUNT_TYPES: Record<string, string>;
  export const PAYMENT_TERMS: Record<string, string>;
  export const SALES_CHANNELS: Record<string, string>;
  export const APPROVAL_STATUSES: Record<string, string>;
}
