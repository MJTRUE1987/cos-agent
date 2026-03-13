import { test, expect } from '@playwright/test';

const BASE = 'https://cos-agent-phi.vercel.app';

/**
 * Command Corpus E2E Tests
 *
 * Tests the full command corpus against the LIVE production API.
 * Each test sends a natural-language command and validates:
 * - raw_text preservation
 * - intent classification
 * - response status
 * - structural correctness of the response payload
 * - no 500 errors or HTML responses
 */

// ── Helpers ──────────────────────────────────────────────────────

async function sendCommand(request: any, text: string, mode?: string) {
  const body: any = { text };
  if (mode) body.mode = mode;
  const res = await request.post(`${BASE}/api/v2/command`, { data: body });
  expect(res.status()).toBeLessThan(500);
  const contentType = res.headers()['content-type'] || '';
  expect(contentType).toContain('application/json');
  const data = await res.json();
  return { res, data };
}

// ─────────────────────────────────────────────────────────────────
// READ / QUERY
// ─────────────────────────────────────────────────────────────────

test.describe('Command Corpus: Read / Query', () => {
  test('pull up my latest email from Thrive Market → read.email', async ({ request }) => {
    const { data } = await sendCommand(request, 'pull up my latest email from Thrive Market');
    expect(data.raw_text).toBe('pull up my latest email from Thrive Market');
    expect(data.intent?.intent || data.intent).toMatch(/read\.email/);
    expect(['read_result', 'read_error', 'recommendation']).toContain(data.status);
    if (data.status === 'read_result') {
      expect(data.read_result).toBeTruthy();
    }
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });

  test('show me Brian\'s deals in Demo Completed → read.pipeline', async ({ request }) => {
    const { data } = await sendCommand(request, "show me Brian's deals in Demo Completed");
    expect(data.raw_text).toBe("show me Brian's deals in Demo Completed");
    expect(data.intent?.intent || data.intent).toMatch(/read\.(pipeline|deal)/);
    expect(['read_result', 'read_error', 'needs_clarification']).toContain(data.status);
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });

  test('what meetings do I have tomorrow → read.calendar', async ({ request }) => {
    const { data } = await sendCommand(request, 'what meetings do I have tomorrow');
    expect(data.raw_text).toBe('what meetings do I have tomorrow');
    expect(data.intent?.intent || data.intent).toMatch(/read\.calendar/);
    expect(['read_result', 'read_error']).toContain(data.status);
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });

  test('find my last email from Matt Bahr → read.email', async ({ request }) => {
    const { data } = await sendCommand(request, 'find my last email from Matt Bahr');
    expect(data.raw_text).toBe('find my last email from Matt Bahr');
    expect(data.intent?.intent || data.intent).toMatch(/read\.email/);
    expect(['read_result', 'read_error']).toContain(data.status);
    if (data.status === 'read_result') {
      expect(data.read_result).toBeTruthy();
    }
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────
// ASSIST / RECOMMEND
// ─────────────────────────────────────────────────────────────────

test.describe('Command Corpus: Assist / Recommend', () => {
  test('email context recommendation for Thrive Market', async ({ request }) => {
    const { data } = await sendCommand(
      request,
      'I just got an email from Thrive Market. What do you recommend we do?'
    );
    expect(data.raw_text).toBe('I just got an email from Thrive Market. What do you recommend we do?');
    expect(data.intent?.intent || data.intent).toMatch(/email_context\.recommendation|assist|recommend/);
    expect(['recommendation', 'recommendation_error', 'read_result', 'needs_clarification']).toContain(data.status);
    if (data.status === 'recommendation') {
      expect(data.recommendation).toBeTruthy();
    }
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });

  test('top pipeline actions today', async ({ request }) => {
    const { data } = await sendCommand(request, 'what are my top pipeline actions today?');
    expect(data.raw_text).toBe('what are my top pipeline actions today?');
    // Could classify as pipeline read or assist
    const intent = data.intent?.intent || data.intent || '';
    expect(intent).not.toBe('unknown');
    expect(['read_result', 'recommendation', 'plan_ready', 'completed', 'needs_clarification', 'read_error', 'recommendation_error']).toContain(data.status);
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });

  test('prep me for tomorrow\'s external meetings', async ({ request }) => {
    const { data } = await sendCommand(request, "prep me for tomorrow's external meetings");
    expect(data.raw_text).toBe("prep me for tomorrow's external meetings");
    const intent = data.intent?.intent || data.intent || '';
    expect(intent).toMatch(/meeting\.prep|assist\.meeting_prep|read\.calendar|email_context/);
    // May produce read_result, plan_ready, or completed depending on execution path
    expect(['read_result', 'recommendation', 'plan_ready', 'completed', 'needs_clarification', 'read_error', 'recommendation_error']).toContain(data.status);
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────
// WORKFLOW / MUTATION
// ─────────────────────────────────────────────────────────────────

test.describe('Command Corpus: Workflow / Mutation', () => {
  test('move Thrive Market to Disco Complete → pipeline.stage_change (preview)', async ({ request }) => {
    const { data } = await sendCommand(request, 'move Thrive Market to Disco Complete', 'preview');
    expect(data.raw_text).toBe('move Thrive Market to Disco Complete');
    expect(data.intent?.intent || data.intent).toMatch(/pipeline\.stage_change/);
    expect(['plan_ready', 'needs_clarification']).toContain(data.status);
    if (data.status === 'plan_ready') {
      expect(data.plan).toBeTruthy();
      expect(data.plan.steps.length).toBeGreaterThanOrEqual(1);
    }
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });

  test('move Hotel Collection and 2K Games to Closed Lost → pipeline.stage_change (preview)', async ({ request }) => {
    const { data } = await sendCommand(
      request,
      'move Hotel Collection and 2K Games to Closed Lost',
      'preview'
    );
    expect(data.raw_text).toBe('move Hotel Collection and 2K Games to Closed Lost');
    expect(data.intent?.intent || data.intent).toMatch(/pipeline\.stage_change/);
    expect(['plan_ready', 'needs_clarification']).toContain(data.status);
    if (data.status === 'plan_ready') {
      expect(data.plan.steps.length).toBeGreaterThanOrEqual(1);
    }
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });

  test('add Granola summary to Uresta and update next steps → pipeline.stage_update_with_notes (preview)', async ({ request }) => {
    const { data } = await sendCommand(
      request,
      'add Granola summary to Uresta and update next steps',
      'preview'
    );
    expect(data.raw_text).toBe('add Granola summary to Uresta and update next steps');
    expect(data.intent?.intent || data.intent).toMatch(/pipeline\.stage_update_with_notes|pipeline\.stage_change/);
    expect(['plan_ready', 'needs_clarification']).toContain(data.status);
    if (data.status === 'plan_ready') {
      expect(data.plan.steps.length).toBeGreaterThanOrEqual(1);
    }
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────
// CREATE / WIZARD
// ─────────────────────────────────────────────────────────────────

test.describe('Command Corpus: Create / Wizard', () => {
  test('create opportunity in HubSpot under Disco Complete for Carda Health → wizard', async ({ request }) => {
    const { data } = await sendCommand(
      request,
      'create opportunity in HubSpot under Disco Complete for Carda Health',
      'preview'
    );
    expect(data.raw_text).toBe('create opportunity in HubSpot under Disco Complete for Carda Health');
    expect(data.intent?.intent || data.intent).toMatch(/opportunity\.create/);
    expect(data.status).toBe('wizard');
    expect(data.wizard).toBeTruthy();
    expect(data.wizard.type).toBe('opportunity_create');
    expect(data.wizard.steps).toBeTruthy();
    expect(data.wizard.steps.length).toBeGreaterThanOrEqual(1);
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });

  test('create deal for Thrive Market → wizard', async ({ request }) => {
    const { data } = await sendCommand(
      request,
      'create deal for Thrive Market',
      'preview'
    );
    expect(data.raw_text).toBe('create deal for Thrive Market');
    expect(data.intent?.intent || data.intent).toMatch(/opportunity\.create/);
    expect(data.status).toBe('wizard');
    expect(data.wizard).toBeTruthy();
    expect(data.wizard.type).toBe('opportunity_create');
    expect(data.intent?.confidence ?? data.confidence ?? 1).toBeGreaterThanOrEqual(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────
// AMBIGUOUS / FOLLOW UP
// ─────────────────────────────────────────────────────────────────

test.describe('Command Corpus: Ambiguous / Follow Up', () => {
  test('update thrive → should detect intent (not unknown)', async ({ request }) => {
    const { data } = await sendCommand(request, 'update thrive');
    expect(data.raw_text).toBe('update thrive');
    const intent = data.intent?.intent || data.intent || '';
    // Should detect some intent — not flat-out unknown
    expect(intent).not.toBe('unknown');
    // Acceptable statuses for ambiguous commands
    expect([
      'read_result', 'plan_ready', 'needs_clarification',
      'recommendation', 'wizard', 'completed',
      'read_error', 'recommendation_error',
    ]).toContain(data.status);
  });

  test('what should we do here → should detect intent (not unknown)', async ({ request }) => {
    const { data } = await sendCommand(request, 'what should we do here');
    expect(data.raw_text).toBe('what should we do here');
    const intent = data.intent?.intent || data.intent || '';
    expect(intent).not.toBe('unknown');
    // May ask for clarification — that's OK as long as it's not a 500
    expect([
      'read_result', 'plan_ready', 'needs_clarification',
      'recommendation', 'recommendation_error',
    ]).toContain(data.status);
  });
});

// ─────────────────────────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────────────────────────

test.describe('Command Corpus: Error Handling', () => {
  test('empty command returns 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v2/command`, {
      data: { text: '' },
    });
    // Should be 400 for missing/empty text
    expect(res.status()).toBe(400);
    const contentType = res.headers()['content-type'] || '';
    expect(contentType).toContain('application/json');
    const data = await res.json();
    expect(data.success).toBe(false);
  });

  test('missing text field returns 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v2/command`, {
      data: {},
    });
    expect(res.status()).toBe(400);
    const contentType = res.headers()['content-type'] || '';
    expect(contentType).toContain('application/json');
    const data = await res.json();
    expect(data.success).toBe(false);
  });

  test('command endpoint returns JSON, not HTML', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v2/command`, {
      data: { text: 'hello' },
    });
    const contentType = res.headers()['content-type'] || '';
    expect(contentType).toContain('application/json');
    expect(res.status()).toBeLessThan(500);
  });

  test('projections endpoint returns JSON, not HTML', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v2/projections?type=pipeline`);
    const contentType = res.headers()['content-type'] || '';
    expect(contentType).toContain('application/json');
    expect(res.status()).toBeLessThan(500);
  });

  test('invalid projection type returns 400 JSON', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v2/projections?type=nonexistent`);
    const contentType = res.headers()['content-type'] || '';
    expect(contentType).toContain('application/json');
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
  });
});
