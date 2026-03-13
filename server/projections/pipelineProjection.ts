/**
 * Pipeline Projection — Strict active sales pipeline from HubSpot.
 *
 * Rules:
 * - ONLY 6 active stages: Disco Booked → Committed
 * - ONLY default sales pipeline
 * - EXCLUDES: agency deals, upsells, winbacks, labs, internal, test, junk
 * - Bias toward under-inclusion
 * - 4 fields only: deal name, stage, amount, owner
 */

import { getEvents } from '../event-log/eventStore.js';

export interface PipelineDeal {
  deal_id: string;
  name: string;
  stage: string;
  stage_label: string;
  amount: number;
  amount_set: boolean;
  owner_name: string;
}

export interface StageGroup {
  stage_id: string;
  stage_label: string;
  display_order: number;
  deals: PipelineDeal[];
  total_value: number;
  count: number;
}

export interface PipelineView {
  deals: PipelineDeal[];
  stages: StageGroup[];
  total_value: number;
  total_count: number;
  generated_at: string;
  source: 'hubspot';
  filters_applied: string[];
  excluded_count: number;
}

const HUBSPOT_BASE = 'https://api.hubapi.com';

// The ONLY 6 stages we show, in display order
const ACTIVE_STAGES: { id: string; label: string; order: number }[] = [
  { id: '93124525',              label: 'Disco Booked',        order: 1 },
  { id: '998751160',             label: 'Disco Complete',      order: 2 },
  { id: 'appointmentscheduled',  label: 'Demo Scheduled',      order: 3 },
  { id: '123162712',             label: 'Demo Completed',      order: 4 },
  { id: 'decisionmakerboughtin', label: 'Negotiating Proposal', order: 5 },
  { id: '227588384',             label: 'Committed',           order: 6 },
];

const ACTIVE_STAGE_IDS = new Set(ACTIVE_STAGES.map(s => s.id));
const STAGE_META = Object.fromEntries(ACTIVE_STAGES.map(s => [s.id, s]));

// Owner map
const OWNERS: Record<string, string> = {
  '151853665':  'Mike',
  '82490290':   'Brian',
  '743878021':  'Will',
  '84289936':   'Michael O',
  '82544484':   'Jason N',
};

// Owner remapping: deactivated reps and reassigned reps → Brian
// Laura Nelson's deals were auto-reassigned to Jason (1003618676) in HubSpot,
// but the correct owner is Brian. Remap both Laura's original ID and Jason's ID.
const OWNER_REMAP: Record<string, string> = {
  '927267605':  '82490290',   // Laura Nelson (deactivated) → Brian
  '1003618676': '82490290',   // Jason (has Laura's reassigned deals) → Brian
};

function resolveOwnerName(ownerId: string | undefined | null): string {
  if (!ownerId) return '';
  const remappedId = OWNER_REMAP[ownerId] || ownerId;
  return OWNERS[remappedId] || '';
}

// ── Exclusion rules ──────────────────────────────────────────────

// Agency signals in deal name (case-insensitive)
const AGENCY_PATTERNS = [
  /\bvia\b/i,                    // "via Darkroom", "via Glossy", "via ABG"
];

// Upsell / expansion / winback signals
const UPSELL_PATTERNS = [
  /\bupsell\b/i,
  /\bwinback\b/i,
  /\bprice increase\b/i,
  /\brenewal\b/i,
  /\bexpansion\b/i,
  /\bretail upsell\b/i,
  /\bretail attribution\b/i,
  /\bauto upsell\b/i,
];

// Internal / labs / test signals
const INTERNAL_PATTERNS = [
  /\(labs?\)/i,                   // "(Labs)", "(labs)"
  /\blabs\b/i,                   // "Prescient Labs"
  /^prescient\s+ai\b/i,          // Internal deals
  /\btest\b/i,
  /\bjunk\b/i,
  /\bdemo account\b/i,
];

// Owner IDs to exclude (agency reps, unknown)
const EXCLUDED_OWNERS = new Set([
  '78129878',    // agency rep
]);

function shouldExclude(deal: any): string | null {
  const name = (deal.properties?.dealname || '').trim();
  const ownerId = deal.properties?.hubspot_owner_id;
  const amount = parseFloat(deal.properties?.amount);

  // Blank / malformed name
  if (!name || name.length < 2) return 'blank_name';

  // Agency deal patterns
  for (const p of AGENCY_PATTERNS) {
    if (p.test(name)) return 'agency';
  }

  // Upsell / expansion patterns
  for (const p of UPSELL_PATTERNS) {
    if (p.test(name)) return 'upsell_expansion';
  }

  // Internal / labs / test
  for (const p of INTERNAL_PATTERNS) {
    if (p.test(name)) return 'internal_test';
  }

  // Excluded owners (agency reps)
  if (ownerId && EXCLUDED_OWNERS.has(ownerId)) return 'excluded_owner';

  // $1 or less with amount set — likely test
  if (!isNaN(amount) && amount > 0 && amount <= 1) return 'test_amount';

  return null; // include
}

// ── Main projection ──────────────────────────────────────────────

export async function buildPipelineProjection(): Promise<PipelineView> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new IntegrationError('hubspot', 'HUBSPOT_ACCESS_TOKEN not configured');
  }

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Fetch deals in active stages only
  const rawDeals = await fetchActiveDeals(headers);

  // Apply exclusion filters
  let excludedCount = 0;
  const includedDeals: any[] = [];

  for (const deal of rawDeals) {
    const reason = shouldExclude(deal);
    if (reason) {
      excludedCount++;
    } else {
      includedDeals.push(deal);
    }
  }

  // Build clean deal objects
  const deals: PipelineDeal[] = includedDeals.map(deal => {
    const props = deal.properties || {};
    const stageId = props.dealstage || '';
    const meta = STAGE_META[stageId];
    const rawAmount = props.amount;
    const amount = rawAmount !== null && rawAmount !== undefined ? parseFloat(rawAmount) || 0 : -1;

    return {
      deal_id: deal.id,
      name: (props.dealname || '').trim(),
      stage: stageId,
      stage_label: meta?.label || stageId,
      amount: amount === -1 ? 0 : amount,
      amount_set: amount !== -1,
      owner_name: resolveOwnerName(props.hubspot_owner_id),
    };
  });

  // Group by stage
  const stageMap = new Map<string, PipelineDeal[]>();
  for (const deal of deals) {
    const arr = stageMap.get(deal.stage) || [];
    arr.push(deal);
    stageMap.set(deal.stage, arr);
  }

  const stages: StageGroup[] = ACTIVE_STAGES.map(s => {
    const stageDeals = stageMap.get(s.id) || [];
    stageDeals.sort((a, b) => b.amount - a.amount);
    return {
      stage_id: s.id,
      stage_label: s.label,
      display_order: s.order,
      deals: stageDeals,
      total_value: stageDeals.reduce((sum, d) => sum + d.amount, 0),
      count: stageDeals.length,
    };
  });

  return {
    deals,
    stages,
    total_value: deals.reduce((sum, d) => sum + d.amount, 0),
    total_count: deals.length,
    generated_at: new Date().toISOString(),
    source: 'hubspot',
    filters_applied: [
      'pipeline=default',
      'stages=disco_booked,disco_complete,demo_scheduled,demo_completed,negotiating,committed',
      'exclude_agency_deals',
      'exclude_upsells_winbacks',
      'exclude_internal_labs_test',
      'exclude_agency_owners',
      'exclude_test_amounts',
      'exclude_blank_names',
    ],
    excluded_count: excludedCount,
  };
}

// ── Fetch deals in active stages ─────────────────────────────────

async function fetchActiveDeals(headers: Record<string, string>): Promise<any[]> {
  const allResults: any[] = [];
  let after: string | undefined;

  for (let page = 0; page < 5; page++) {
    const body: any = {
      filterGroups: [{
        filters: [
          { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          { propertyName: 'dealstage', operator: 'IN', values: [...ACTIVE_STAGE_IDS] },
        ],
      }],
      properties: ['dealname', 'dealstage', 'amount', 'hubspot_owner_id'],
      sorts: [{ propertyName: 'amount', direction: 'DESCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;

    let r: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (r.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      break;
    }

    if (!r || !r.ok) {
      const errBody = r ? await r.text() : 'No response';
      throw new IntegrationError('hubspot', `HubSpot search returned ${r?.status || 0}: ${errBody.slice(0, 200)}`);
    }

    const data = await r.json();
    allResults.push(...(data.results || []));

    const nextAfter = data.paging?.next?.after;
    if (!nextAfter || (data.results || []).length < 100) break;
    after = nextAfter;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return allResults;
}

export class IntegrationError extends Error {
  source: string;
  constructor(source: string, message: string) {
    super(message);
    this.source = source;
    this.name = 'IntegrationError';
  }
}
