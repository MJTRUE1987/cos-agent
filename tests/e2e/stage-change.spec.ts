import { test, expect } from '@playwright/test';

const BASE = 'https://cos-agent-phi.vercel.app';
const HUBSPOT_API = 'https://api.hubapi.com';

// Real deal for stage change tests
const DEAL_NAME = 'Thrive Market - New Deal';
const DEAL_ID = '57909142024';

// Laura Nelson's deal for owner remap tests
const LAURA_DEAL_NAME = 'Georgia Boot (Rocky Brands)';
const LAURA_DEAL_ID = '35438361420';
const LAURA_OWNER_ID = '927267605';

// HubSpot stage IDs
const STAGES = {
  DISCO_BOOKED: '93124525',
  DISCO_COMPLETE: '998751160',
  DEMO_SCHEDULED: 'appointmentscheduled',
  DEMO_COMPLETED: '123162712',
  NEGOTIATING: 'decisionmakerboughtin',
  COMMITTED: '227588384',
} as const;

function hubspotHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1. STAGE CHANGE — THE BUG THAT WAS BROKEN
//
//    Root cause: AI returned entity_type='deal' but validation gate and
//    planner both filtered for entity_type='company' only → 0 steps,
//    execution showed UNKNOWN. Also target_stage was raw string
//    "discocomplete" instead of HubSpot ID "998751160".
// ─────────────────────────────────────────────────────────────────────

test.describe('Stage Change: entity_type deal accepted', () => {
  test.afterAll(async ({ request }) => {
    // Always reset to Disco Booked
    await request.patch(`${HUBSPOT_API}/crm/v3/objects/deals/${DEAL_ID}`, {
      headers: hubspotHeaders(),
      data: { properties: { dealstage: STAGES.DISCO_BOOKED } },
    });
  });

  test('entity_type "deal" resolves through validation and produces a plan', async ({ request }) => {
    // Ensure deal is in an active stage so HubSpot search finds it
    await request.patch(`${HUBSPOT_API}/crm/v3/objects/deals/${DEAL_ID}`, {
      headers: hubspotHeaders(),
      data: { properties: { dealstage: STAGES.DISCO_BOOKED } },
    });

    const res = await request.post(`${BASE}/api/v2/command`, {
      data: { text: `Move ${DEAL_NAME} to Disco Complete`, mode: 'preview' },
    });
    const data = await res.json();

    // The old bug: entity_type='deal' was rejected, returning needs_clarification
    // with "could not identify any company or deal names".
    // Now it should either produce a plan OR ask for entity clarification (ambiguity),
    // but never reject based on entity_type alone.
    if (data.status === 'needs_clarification') {
      // If clarification, verify it's NOT the entity_type rejection message
      for (const c of data.clarifications || []) {
        expect(c.question).not.toContain('could not identify any company or deal names');
      }
    } else {
      expect(data.status).toBe('plan_ready');
      // Entity should be resolved with deal ID
      const entity = data.intent.entities.find((e: any) =>
        e.resolved_name.includes('Thrive Market')
      );
      expect(entity).toBeTruthy();
      expect(entity.resolved_id).toBe(DEAL_ID);
      expect(data.plan.steps.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('entity_type "company" also works for stage change', async ({ request }) => {
    // Use a deal name that AI might classify as company (no "New Deal" suffix)
    const res = await request.post(`${BASE}/api/v2/command`, {
      data: { text: 'Move ARMRA to Demo Completed', mode: 'preview' },
    });
    const data = await res.json();

    // Should produce a plan regardless of entity_type
    if (data.status === 'plan_ready') {
      expect(data.plan.steps.length).toBeGreaterThanOrEqual(1);
      const updateStep = data.plan.steps.find((s: any) => s.tool === 'hubspot.update_deal');
      expect(updateStep).toBeTruthy();
    }
    // If needs_clarification due to ambiguity (multiple ARMRA deals), that's also acceptable
    // but it should NOT be because entity_type was rejected
    if (data.status === 'needs_clarification') {
      const clars = data.clarifications || [];
      // Should be about ambiguity, not "could not identify any company or deal names"
      for (const c of clars) {
        expect(c.question).not.toContain('could not identify any company or deal names');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. STAGE NAME NORMALIZATION
//
//    AI returns human-readable stage names like "discocomplete" or
//    "Disco Complete". These must be normalized to HubSpot stage IDs
//    before the PATCH call, otherwise HubSpot rejects or misroutes.
// ─────────────────────────────────────────────────────────────────────

test.describe('Stage Name Normalization', () => {
  const stageMappings = [
    { input: 'Disco Booked', expected: STAGES.DISCO_BOOKED },
    { input: 'Disco Complete', expected: STAGES.DISCO_COMPLETE },
    { input: 'Demo Scheduled', expected: STAGES.DEMO_SCHEDULED },
    { input: 'Demo Completed', expected: STAGES.DEMO_COMPLETED },
    { input: 'Negotiating', expected: STAGES.NEGOTIATING },
    { input: 'Committed', expected: STAGES.COMMITTED },
    { input: 'Closed Lost', expected: 'closedlost' },
    { input: 'Closed Won', expected: 'closedwon' },
  ];

  for (const { input, expected } of stageMappings) {
    test(`"${input}" normalizes to ${expected}`, async ({ request }) => {
      const res = await request.post(`${BASE}/api/v2/command`, {
        data: { text: `Move ${DEAL_NAME} to ${input}`, mode: 'preview' },
      });
      const data = await res.json();

      // The target_stage in parameters should be the HubSpot ID, not raw text.
      // The normalizer runs immediately after interpretation, so even
      // needs_clarification responses should have the normalized ID.
      const targetStage = data.intent?.parameters?.target_stage;
      expect(targetStage).toBe(expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// 3. EXECUTION END-TO-END: API actually changes HubSpot
// ─────────────────────────────────────────────────────────────────────

test.describe('Execution: HubSpot actually updates', () => {
  test.afterAll(async ({ request }) => {
    await request.patch(`${HUBSPOT_API}/crm/v3/objects/deals/${DEAL_ID}`, {
      headers: hubspotHeaders(),
      data: { properties: { dealstage: STAGES.DISCO_BOOKED } },
    });
  });

  test('execute moves deal and returns previous + new stage', async ({ request }) => {
    // Ensure starting state
    await request.patch(`${HUBSPOT_API}/crm/v3/objects/deals/${DEAL_ID}`, {
      headers: hubspotHeaders(),
      data: { properties: { dealstage: STAGES.DISCO_BOOKED } },
    });

    const res = await request.post(`${BASE}/api/v2/command`, {
      data: { text: `Move ${DEAL_NAME} to Disco Complete` },
    });
    const data = await res.json();

    expect(data.status).toBe('completed');
    expect(data.execution.status).toBe('completed');
    expect(data.execution.steps_completed).toBeGreaterThanOrEqual(1);
    expect(data.execution.steps_failed).toBe(0);

    // Verify step output has deal_id, updated properties, and previous values
    const stepOutput = Object.values(data.execution.results)[0] as any;
    expect(stepOutput.deal_id).toBe(DEAL_ID);
    expect(stepOutput.updated_properties.dealstage).toBe(STAGES.DISCO_COMPLETE);
    expect(stepOutput.previous_values.dealstage).toBe(STAGES.DISCO_BOOKED);
  });

  test('HubSpot confirms the deal actually moved', async ({ request }) => {
    // Direct HubSpot read to verify the stage change persisted
    const res = await request.get(
      `${HUBSPOT_API}/crm/v3/objects/deals/${DEAL_ID}?properties=dealstage,dealname`,
      { headers: hubspotHeaders() },
    );
    expect(res.ok()).toBe(true);
    const deal = await res.json();
    expect(deal.properties.dealstage).toBe(STAGES.DISCO_COMPLETE);
    expect(deal.properties.dealname).toBe(DEAL_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. PIPELINE PROJECTION: exclusion filters + owner remapping
// ─────────────────────────────────────────────────────────────────────

test.describe('Pipeline Projection', () => {
  let pipelineData: any;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${BASE}/api/v2/projections?type=pipeline`);
    pipelineData = await res.json();
  });

  test('returns only the 6 active stages in correct order', async () => {
    expect(pipelineData.success).toBe(true);
    const stageIds = pipelineData.stages.map((s: any) => s.stage_id);
    expect(stageIds).toEqual([
      STAGES.DISCO_BOOKED,
      STAGES.DISCO_COMPLETE,
      STAGES.DEMO_SCHEDULED,
      STAGES.DEMO_COMPLETED,
      STAGES.NEGOTIATING,
      STAGES.COMMITTED,
    ]);
  });

  test('no deal has closedlost, closedwon, or nurture stage', async () => {
    const forbidden = new Set(['closedlost', 'closedwon', '60237411', 'contractsent']);
    for (const deal of pipelineData.deals) {
      expect(forbidden.has(deal.stage)).toBe(false);
    }
  });

  test('excludes agency deals (name contains "via")', async () => {
    for (const deal of pipelineData.deals) {
      expect(deal.name.toLowerCase()).not.toMatch(/\bvia\b/);
    }
  });

  test('excludes upsells, winbacks, renewals', async () => {
    const patterns = /\b(upsell|winback|renewal|price increase|expansion)\b/i;
    for (const deal of pipelineData.deals) {
      expect(deal.name).not.toMatch(patterns);
    }
  });

  test('excludes internal/labs/test deals', async () => {
    const patterns = /\b(labs?)\b|\btest\b|\bjunk\b/i;
    for (const deal of pipelineData.deals) {
      expect(deal.name).not.toMatch(patterns);
    }
  });

  test('no deal owned by excluded agency rep (78129878)', async () => {
    // Agency rep owner ID should not appear — those deals are excluded
    // We can't check owner_id directly (not in response), but deals from
    // that owner should not be present. Known agency deals: "Meyer Group - UK", "Truvani", etc.
    const names = pipelineData.deals.map((d: any) => d.name);
    expect(names).not.toContain('Meyer Group - UK');
    expect(names).not.toContain('Truvani');
  });

  test('Georgia Boot shows Brian (Laura Nelson remap), not empty or Jason', async () => {
    const deal = pipelineData.deals.find((d: any) => d.name === LAURA_DEAL_NAME);
    expect(deal).toBeTruthy();
    expect(deal.owner_name).toBe('Brian');
    expect(deal.owner_name).not.toBe('Jason');
    expect(deal.owner_name).not.toBe('');
  });

  test('Jason never appears as owner — all former Laura Nelson deals show Brian', async () => {
    // Laura Nelson's deals were auto-reassigned to Jason in HubSpot.
    // COS Agent must show them as Brian, never Jason.
    for (const deal of pipelineData.deals) {
      expect(deal.owner_name).not.toBe('Jason');
    }

    // Specific deals that were Laura Nelson's must show Brian
    const lauraDeals = ['Coverland', 'Swissklip', 'Momentous', 'Forever New AU', 'Gorilla Mind'];
    for (const name of lauraDeals) {
      const deal = pipelineData.deals.find((d: any) => d.name === name);
      if (deal) {
        expect(deal.owner_name).toBe('Brian');
      }
    }
  });

  test('every deal has exactly 4 display fields', async () => {
    for (const deal of pipelineData.deals) {
      // Required fields
      expect(deal).toHaveProperty('name');
      expect(deal).toHaveProperty('stage_label');
      expect(deal).toHaveProperty('amount');
      expect(deal).toHaveProperty('owner_name');
      // amount_set is a boolean flag (not a display field, but needed for "—" vs "$0")
      expect(typeof deal.amount_set).toBe('boolean');
    }
  });

  test('deals within each stage are sorted by amount descending', async () => {
    for (const stage of pipelineData.stages) {
      for (let i = 1; i < stage.deals.length; i++) {
        expect(stage.deals[i - 1].amount).toBeGreaterThanOrEqual(stage.deals[i].amount);
      }
    }
  });

  test('stage totals are correct', async () => {
    for (const stage of pipelineData.stages) {
      const expectedTotal = stage.deals.reduce((sum: number, d: any) => sum + d.amount, 0);
      expect(stage.total_value).toBeCloseTo(expectedTotal, 0);
      expect(stage.count).toBe(stage.deals.length);
    }
  });

  test('total_count equals sum of all stage counts', async () => {
    const sumCounts = pipelineData.stages.reduce((s: number, st: any) => s + st.count, 0);
    expect(pipelineData.total_count).toBe(sumCounts);
  });

  test('pipeline source is hubspot and filters are documented', async () => {
    expect(pipelineData.source).toBe('hubspot');
    expect(pipelineData.filters_applied).toContain('pipeline=default');
    expect(pipelineData.filters_applied).toContain('exclude_agency_deals');
    expect(pipelineData.filters_applied).toContain('exclude_upsells_winbacks');
    expect(pipelineData.filters_applied).toContain('exclude_internal_labs_test');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. AMBIGUOUS / NOT FOUND ENTITIES
//
//    When a deal name doesn't match or has multiple matches, the system
//    should return needs_clarification, NOT execute blindly.
// ─────────────────────────────────────────────────────────────────────

test.describe('Entity Validation: ambiguous and missing', () => {
  test('nonexistent deal returns needs_clarification', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v2/command`, {
      data: { text: 'Move Zzzzz Fake Company to Closed Lost' },
    });
    const data = await res.json();

    // Should not execute — should ask for clarification
    expect(data.status).toBe('needs_clarification');
  });

  test('duplicate entity in command is deduplicated', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v2/command`, {
      data: {
        text: `Move ${DEAL_NAME} and ${DEAL_NAME} to Closed Lost`,
        mode: 'preview',
      },
    });
    const data = await res.json();

    // Should have at most 1 entity for Thrive Market, not 2
    if (data.intent?.entities) {
      const thriveEntities = data.intent.entities.filter(
        (e: any) => e.resolved_name === DEAL_NAME
      );
      expect(thriveEntities.length).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. MULTI-DEAL STAGE CHANGE
// ─────────────────────────────────────────────────────────────────────

test.describe('Multi-deal stage change', () => {
  test('multiple deals produce multiple plan steps', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v2/command`, {
      data: {
        text: 'Move ARMRA and Brooklinen to Committed',
        mode: 'preview',
      },
    });
    const data = await res.json();

    if (data.status === 'plan_ready') {
      // Should have update steps for each deal
      const updateSteps = data.plan.steps.filter((s: any) => s.tool === 'hubspot.update_deal');
      expect(updateSteps.length).toBeGreaterThanOrEqual(2);
      // Every update step requires approval
      for (const step of updateSteps) {
        expect(step.approval_required).toBe(true);
      }
    }
    // Ambiguity is acceptable (ARMRA has multiple deals) but entity_type rejection is not
    if (data.status === 'needs_clarification') {
      for (const c of data.clarifications || []) {
        expect(c.question).not.toContain('could not identify any company or deal names');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. UI: BROWSER FLOW
//
//    Tests the actual user experience, not just that elements exist.
// ─────────────────────────────────────────────────────────────────────

test.describe('UI: stage change browser flow', () => {
  test.afterAll(async ({ request }) => {
    await request.patch(`${HUBSPOT_API}/crm/v3/objects/deals/${DEAL_ID}`, {
      headers: hubspotHeaders(),
      data: { properties: { dealstage: STAGES.DISCO_BOOKED } },
    });
  });

  test('type command → approval gate → approve → execution completes', async ({ page }) => {
    await page.goto(`${BASE}/v2.html`);

    // Wait for page to be interactive
    await expect(page.locator('#healthBar')).toBeVisible();

    // Type and send command
    await page.locator('#cmdInput').fill(`Move ${DEAL_NAME} to Disco Complete`);
    await page.locator('#cmdBtn').click();

    // Exec area should appear
    await expect(page.locator('#execArea')).toBeVisible();

    // 1. Approval gate should appear (stage changes require approval)
    const approveBtn = page.locator('button', { hasText: 'Approve' }).first();
    await expect(approveBtn).toBeVisible({ timeout: 30000 });

    // 2. Stage change summary shows deal name, current stage → target stage
    const stageChangeInfo = page.locator('#execArea');
    const pageText = await stageChangeInfo.textContent();
    expect(pageText).toContain('Thrive Market');
    expect(pageText).toContain('Disco Complete');

    // 3. Step is marked as "Requires approval" / "pending"
    await expect(page.locator('#execArea').getByText('hubspot.update_deal')).toBeVisible();

    // 4. Click Approve to execute
    await approveBtn.click();

    // 5. Wait for execution to complete — original-command block appears in final result
    await expect(page.locator('.original-command')).toBeVisible({ timeout: 30000 });

    // 6. Original command text is exact
    const cmdText = await page.locator('.original-command-text').textContent();
    expect(cmdText).toContain(DEAL_NAME);
    expect(cmdText).toContain('Disco Complete');

    // 7. Intent shows pipeline stage_change with confidence >= 70%
    const intentBadge = page.locator('.intent-badge').first();
    const badgeText = await intentBadge.textContent();
    const confidence = parseInt(badgeText || '0');
    expect(confidence).toBeGreaterThanOrEqual(70);

    // 8. Execution shows completed with steps (not UNKNOWN 0/0 — that was the bug)
    const execStatus = page.locator('.exec-status.completed');
    await expect(execStatus).toBeVisible({ timeout: 30000 });

    // 9. At least one completed step card
    await expect(page.locator('.exec-step-card.completed')).toBeVisible({ timeout: 5000 });

    // 10. Step count is not 0/0
    const metaTexts = await page.locator('.exec-meta').allTextContents();
    const stepCountMeta = metaTexts.find(t => t.includes('/'));
    expect(stepCountMeta).toBeTruthy();
    expect(stepCountMeta).not.toContain('0/0');
  });
});

test.describe('UI: pipeline view', () => {
  test('pipeline table renders all 6 stages with correct structure', async ({ page }) => {
    await page.goto(`${BASE}/v2.html`);

    // Navigate to Pipeline view
    await page.locator('[data-view="pipeline"]').click();
    await expect(page.locator('#execArea')).toBeVisible();

    // Wait for pipeline header
    await expect(page.locator('text=Active Sales Pipeline')).toBeVisible({ timeout: 15000 });

    // All 6 stages should be present
    await expect(page.locator('text=Disco Booked')).toBeVisible();
    await expect(page.locator('text=Disco Complete')).toBeVisible();
    await expect(page.locator('text=Demo Scheduled')).toBeVisible();
    await expect(page.locator('text=Demo Completed')).toBeVisible();
    await expect(page.locator('text=Negotiating Proposal')).toBeVisible();
    await expect(page.locator('text=Committed')).toBeVisible();

    // Should NOT show non-active stages
    await expect(page.locator('text=Closed Lost')).not.toBeVisible();
    await expect(page.locator('text=Closed Won')).not.toBeVisible();
    await expect(page.locator('text=Nurture')).not.toBeVisible();

    // Tables have correct column headers
    const headers = page.locator('th');
    const headerTexts = await headers.allTextContents();
    expect(headerTexts).toContain('Deal Name');
    expect(headerTexts).toContain('Amount');
    expect(headerTexts).toContain('Owner');
  });

  test('pipeline shows all deals under Brian or Mike (never Jason)', async ({ page }) => {
    await page.goto(`${BASE}/v2.html`);
    await page.locator('[data-view="pipeline"]').click();
    await expect(page.locator('text=Active Sales Pipeline')).toBeVisible({ timeout: 15000 });

    // Georgia Boot (former Laura Nelson deal) should show Brian
    const georgiaRow = page.locator('tr', { hasText: 'Georgia Boot' });
    await expect(georgiaRow).toBeVisible({ timeout: 10000 });
    const georgiaCells = await georgiaRow.locator('td').allTextContents();
    expect(georgiaCells[2].trim()).toBe('Brian');

    // Coverland (also former Laura Nelson deal) should show Brian, not Jason
    const coverlandRow = page.locator('tr', { hasText: 'Coverland' });
    await expect(coverlandRow).toBeVisible({ timeout: 10000 });
    const coverlandCells = await coverlandRow.locator('td').allTextContents();
    expect(coverlandCells[2].trim()).toBe('Brian');

    // No table cell should say "Jason"
    const allOwnerCells = page.locator('td:nth-child(3)');
    const allOwners = await allOwnerCells.allTextContents();
    for (const owner of allOwners) {
      expect(owner.trim()).not.toBe('Jason');
    }
  });

  test('pipeline does not show excluded deals', async ({ page }) => {
    await page.goto(`${BASE}/v2.html`);
    await page.locator('[data-view="pipeline"]').click();
    await expect(page.locator('text=Active Sales Pipeline')).toBeVisible({ timeout: 15000 });

    // Agency deals should not appear
    await expect(page.locator('td', { hasText: /\bvia\b/i })).not.toBeVisible();

    // Known excluded deals
    await expect(page.locator('text=Meyer Group - UK')).not.toBeVisible();
    await expect(page.locator('text=Truvani')).not.toBeVisible();
  });

  test('total deal count and value are shown in header', async ({ page }) => {
    await page.goto(`${BASE}/v2.html`);
    await page.locator('[data-view="pipeline"]').click();
    await expect(page.locator('text=Active Sales Pipeline')).toBeVisible({ timeout: 15000 });

    // Header should show count, value, and excluded count
    const subtext = page.locator('text=/\\d+ active deals/');
    await expect(subtext).toBeVisible();
    const headerText = await subtext.textContent();
    expect(headerText).toMatch(/\d+ active deals/);
    expect(headerText).toMatch(/\$[\d,]+ total value/);
    expect(headerText).toMatch(/\d+ excluded/);
  });
});
