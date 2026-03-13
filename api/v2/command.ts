/**
 * POST /api/v2/command — Main agent entry point.
 *
 * Safety rules:
 * - Always returns raw_text so the UI can show the exact user command
 * - For destructive CRM actions (stage changes), validates entities against
 *   HubSpot before allowing plan execution
 * - If entity resolution is ambiguous or mismatched, returns needs_clarification
 */

import { safeHandler } from './_handler.js';
import { interpretCommand } from '../../server/agent/commandInterpreter.js';
import type { ResolvedEntity } from '../../server/agent/commandInterpreter.js';
import { classifyIntent } from '../../server/agent/intentRouter.js';
import { generatePlan } from '../../server/agent/planner.js';
import { runPlan } from '../../server/agent/executor.js';
import { appendEvent, generateId } from '../../server/event-log/eventStore.js';
import { captureFailure } from '../../server/failure/failureStore.js';
import { logAction } from '../../server/failure/actionLogger.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const READ_INTENTS = new Set([
  'read.email',
  'read.deal',
  'read.pipeline',
  'read.calendar',
  'read.contact',
]);

const DESTRUCTIVE_INTENTS = new Set([
  'pipeline.stage_change',
  'pipeline.stage_update_with_notes',
]);

const WIZARD_INTENTS = new Set([
  'opportunity.create',
]);

const STAGE_LABELS: Record<string, string> = {
  'closedlost': 'Closed Lost',
  'closedwon': 'Closed Won',
  'contractsent': 'Contract Sent',
  '227588384': 'Committed',
  'decisionmakerboughtin': 'Negotiating',
  '123162712': 'Demo Completed',
  'appointmentscheduled': 'Demo Scheduled',
  '93124525': 'Disco Booked',
  '998751160': 'Disco Complete',
  'presentationscheduled': 'Presentation Scheduled',
  'qualifiedtobuy': 'Qualified to Buy',
  '60237411': 'Nurture',
};

interface ValidatedEntity extends ResolvedEntity {
  hubspot_deal_id?: string;
  hubspot_deal_name?: string;
  hubspot_current_stage?: string;
  match_status: 'exact' | 'partial' | 'not_found' | 'ambiguous';
  candidates?: { id: string; name: string; stage: string }[];
}

export default safeHandler('command', async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { text, context, mode } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing "text" field' });
  }

  // Step 0: Strict intent classification (deterministic, no AI)
  const routerClass = classifyIntent(text);

  // Step 0.5: Log command submission
  await logAction('command_submit', { command_id: undefined, metadata: { raw_text: text, router_class: routerClass.top_level } }).catch(() => {});

  // Step 1: Interpret (AI-powered)
  const intent = await interpretCommand(text, context);

  // Cross-validate: if router says read_query but AI says workflow, trust the router
  // The router is deterministic and uses the default rule: no mutation verb = read
  if (routerClass.top_level === 'read_query' && !READ_INTENTS.has(intent.intent) && intent.intent !== 'email_context.recommendation') {
    // Override to the router's sub_intent if it has one
    if (routerClass.sub_intent.startsWith('read.')) {
      intent.intent = routerClass.sub_intent;
      intent.mode = 'analyze';
    }
  }
  // If router says create_wizard, force wizard mode
  if (routerClass.top_level === 'create_wizard' && !WIZARD_INTENTS.has(intent.intent)) {
    intent.intent = 'opportunity.create';
  }

  await appendEvent({
    event_type: 'agent.command.received',
    source: 'user',
    correlation_id: intent.command_id,
    actor: 'user',
    timestamp: new Date().toISOString(),
    payload: {
      command_id: intent.command_id,
      raw_text: text,
      intent: intent.intent,
      confidence: intent.confidence,
      entities: intent.entities.map(e => ({ type: e.entity_type, name: e.resolved_name })),
    },
    metadata: {
      version: 1,
      environment: process.env.VERCEL_ENV || 'development',
      command_id: intent.command_id,
    },
  });

  // Normalize target_stage to HubSpot stage ID immediately after interpretation
  // (must happen before any early returns so all responses have the correct ID)
  if (intent.parameters?.target_stage) {
    intent.parameters.target_stage = normalizeStageId(intent.parameters.target_stage);
  }

  // Low confidence or clarifications needed
  if (intent.confidence < 0.4 || intent.clarifications.length > 0) {
    return res.status(200).json({
      success: true,
      status: 'needs_clarification',
      command_id: intent.command_id,
      raw_text: text,
      intent,
      clarifications: intent.clarifications.length > 0
        ? intent.clarifications
        : [{ id: generateId('clar'), question: "I'm not sure I understood that. Could you rephrase?", type: 'freeform', options: [], required: true }],
    });
  }

  // Step 1.5: READ intents — fetch data directly, no plan/execute pipeline
  if (READ_INTENTS.has(intent.intent)) {
    try {
      const readResult = await executeReadIntent(intent);
      return res.status(200).json({
        success: true,
        status: 'read_result',
        command_id: intent.command_id,
        raw_text: text,
        intent: {
          raw_text: text,
          intent: intent.intent,
          confidence: intent.confidence,
          entities: intent.entities,
          mode: 'read',
          parameters: intent.parameters,
        },
        read_result: readResult,
      });
    } catch (err: any) {
      await captureFailure({
        error_type: 'api_error',
        error_message: `/api/v2/command:read: ${err.message || 'Unknown'}`,
        stack: err.stack,
        severity: 'high',
        command_id: intent.command_id,
        intent: intent.intent,
        entity_snapshot: intent.entities,
        reproducible_input: { raw_text: text, context },
      }).catch(() => {});
      return res.status(200).json({
        success: false,
        status: 'read_error',
        command_id: intent.command_id,
        raw_text: text,
        intent: {
          raw_text: text,
          intent: intent.intent,
          confidence: intent.confidence,
          entities: intent.entities,
          mode: 'read',
          parameters: intent.parameters,
        },
        error: err.message || 'Failed to fetch data',
      });
    }
  }

  // Step 1.5-R: Email context recommendation — gather multi-source context, generate AI recommendation
  if (intent.intent === 'email_context.recommendation') {
    try {
      const recommendation = await executeEmailRecommendation(intent);
      return res.status(200).json({
        success: true,
        status: 'recommendation',
        command_id: intent.command_id,
        raw_text: text,
        intent: {
          raw_text: text,
          intent: intent.intent,
          confidence: intent.confidence,
          entities: intent.entities,
          mode: 'analyze',
          parameters: intent.parameters,
        },
        recommendation,
      });
    } catch (err: any) {
      await captureFailure({
        error_type: 'api_error',
        error_message: `/api/v2/command:recommendation: ${err.message || 'Unknown'}`,
        stack: err.stack,
        severity: 'high',
        command_id: intent.command_id,
        intent: intent.intent,
        entity_snapshot: intent.entities,
        reproducible_input: { raw_text: text, context },
      }).catch(() => {});
      return res.status(200).json({
        success: false,
        status: 'recommendation_error',
        command_id: intent.command_id,
        raw_text: text,
        intent: {
          raw_text: text,
          intent: intent.intent,
          confidence: intent.confidence,
          entities: intent.entities,
          mode: 'analyze',
          parameters: intent.parameters,
        },
        error: err.message || 'Failed to generate recommendation',
      });
    }
  }

  // Step 1.5a: Wizard mode for CRM creation commands
  if (WIZARD_INTENTS.has(intent.intent)) {
    const companyName = intent.parameters?.company_name
      || intent.entities.find(e => e.entity_type === 'company')?.resolved_name
      || '';
    const targetStage = intent.parameters?.target_stage || '';
    const targetStageLabel = STAGE_LABELS[targetStage] || intent.parameters?.target_stage_label || targetStage;

    // Search for existing records to pre-populate wizard
    let existingCompanies: any[] = [];
    let existingContacts: any[] = [];
    const token = process.env.HUBSPOT_ACCESS_TOKEN;

    if (token && companyName) {
      const hsHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const [companiesR, contactsR] = await Promise.allSettled([
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies/search`, {
          method: 'POST', headers: hsHeaders,
          body: JSON.stringify({ query: companyName, properties: ['name', 'domain', 'industry', 'website'], limit: 5 }),
        }).then(r => r.json()),
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
          method: 'POST', headers: hsHeaders,
          body: JSON.stringify({ query: companyName, properties: ['email', 'firstname', 'lastname', 'jobtitle', 'phone', 'company'], limit: 5 }),
        }).then(r => r.json()),
      ]);

      if (companiesR.status === 'fulfilled') {
        existingCompanies = (companiesR.value.results || []).map((c: any) => ({
          id: c.id, name: c.properties.name, domain: c.properties.domain,
          industry: c.properties.industry, website: c.properties.website,
        }));
      }
      if (contactsR.status === 'fulfilled') {
        existingContacts = (contactsR.value.results || []).map((c: any) => ({
          id: c.id, name: `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim(),
          email: c.properties.email, title: c.properties.jobtitle, phone: c.properties.phone,
        }));
      }
    }

    return res.status(200).json({
      success: true,
      status: 'wizard',
      command_id: intent.command_id,
      raw_text: text,
      intent: {
        raw_text: text,
        intent: intent.intent,
        confidence: intent.confidence,
        entities: intent.entities,
        mode: 'wizard',
        parameters: intent.parameters,
      },
      wizard: {
        type: 'opportunity_create',
        parsed_action: 'Create Opportunity',
        company_name: companyName,
        target_stage: targetStage,
        target_stage_label: targetStageLabel,
        steps: ['contact', 'company', 'deal'],
        current_step: 0,
        existing_companies: existingCompanies,
        existing_contacts: existingContacts,
      },
    });
  }

  // Step 1.5b: Entity validation for destructive actions
  if (DESTRUCTIVE_INTENTS.has(intent.intent)) {
    // Accept both 'company' and 'deal' entity types — AI may classify deal names as either
    const companyEntities = intent.entities.filter(e => e.entity_type === 'company' || e.entity_type === 'deal');

    if (companyEntities.length === 0) {
      return res.status(200).json({
        success: true,
        status: 'needs_clarification',
        command_id: intent.command_id,
        raw_text: text,
        intent,
        clarifications: [{
          id: generateId('clar'),
          question: 'Which deals should be updated? I could not identify any company or deal names in your command.',
          type: 'freeform',
          options: [],
          required: true,
        }],
      });
    }

    const validated = await validateEntities(companyEntities);
    const unresolved = validated.filter(v => v.match_status === 'not_found');
    const ambiguous = validated.filter(v => v.match_status === 'ambiguous');
    const resolved = validated.filter(v => v.match_status === 'exact' || v.match_status === 'partial');

    // If ANY entity can't be resolved, block execution and ask for clarification
    if (unresolved.length > 0 || ambiguous.length > 0) {
      const clarifications: any[] = [];

      for (const entity of unresolved) {
        clarifications.push({
          id: generateId('clar'),
          question: `Could not find a deal matching "${entity.resolved_name}" in HubSpot. Did you mean one of these?`,
          type: 'single_select',
          options: (entity.candidates || []).map(c => ({
            label: `${c.name} (${STAGE_LABELS[c.stage] || c.stage})`,
            value: c.name,
            is_recommended: false,
          })),
          required: true,
          entity_name: entity.resolved_name,
        });
      }

      for (const entity of ambiguous) {
        clarifications.push({
          id: generateId('clar'),
          question: `Multiple deals found for "${entity.resolved_name}". Which one?`,
          type: 'single_select',
          options: (entity.candidates || []).map(c => ({
            label: `${c.name} (${STAGE_LABELS[c.stage] || c.stage})`,
            value: c.name,
            is_recommended: false,
          })),
          required: true,
          entity_name: entity.resolved_name,
        });
      }

      return res.status(200).json({
        success: true,
        status: 'needs_clarification',
        command_id: intent.command_id,
        raw_text: text,
        intent,
        validated_entities: validated,
        clarifications,
      });
    }

    // All entities resolved — attach HubSpot IDs to intent entities
    for (const v of resolved) {
      const match = intent.entities.find(
        e => e.resolved_name.toLowerCase() === v.resolved_name.toLowerCase()
      );
      if (match) {
        match.resolved_id = v.hubspot_deal_id;
        match.source = 'hubspot';
        match.confidence = v.match_status === 'exact' ? 0.95 : 0.75;
      }
    }

    // Include validation details in response for UI rendering
    intent.parameters = {
      ...intent.parameters,
      _validated_entities: validated.map(v => ({
        name: v.resolved_name,
        deal_id: v.hubspot_deal_id,
        deal_name: v.hubspot_deal_name,
        current_stage: v.hubspot_current_stage,
        current_stage_label: STAGE_LABELS[v.hubspot_current_stage || ''] || v.hubspot_current_stage,
        target_stage: intent.parameters?.target_stage,
        target_stage_label: STAGE_LABELS[intent.parameters?.target_stage || ''] || intent.parameters?.target_stage,
        match_status: v.match_status,
      })),
      _deal_count: resolved.length,
    };
  }

  // Step 1.6: For stage_update_with_notes, check Granola availability and fetch preview
  if (intent.intent === 'pipeline.stage_update_with_notes') {
    const companyName = intent.entities.find(e => e.entity_type === 'company')?.resolved_name || '';
    const granolaKey = process.env.GRANOLA_API_KEY;
    let granolaPreview: any = { found: false };

    if (granolaKey && companyName) {
      try {
        const after = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
        const listR = await fetch(
          `https://public-api.granola.ai/v1/notes?page_size=30&created_after=${after}`,
          { headers: { Authorization: `Bearer ${granolaKey}` } }
        );
        if (listR.ok) {
          const listData = await listR.json();
          const notes = listData.notes || [];
          const matches = scoreGranolaNotes(notes, companyName);
          if (matches.length > 0) {
            const best = matches[0];
            granolaPreview = {
              found: true,
              note_id: best.note.id,
              title: best.note.title,
              created_at: best.note.created_at,
              attendees: (best.note.attendees || []).map((a: any) => a.name).filter(Boolean),
              match_strategy: best.match_strategy,
              match_score: best.match_score,
              total_matches: matches.length,
            };
          }
        }
      } catch { /* non-critical */ }
    }

    intent.parameters = {
      ...intent.parameters,
      _granola_preview: granolaPreview,
      _workflow_type: 'stage_update_with_notes',
    };
  }

  // Step 2: Plan
  const plan = generatePlan(intent);

  // Preview mode: return plan without executing
  if (mode === 'preview' || intent.mode === 'analyze') {
    return res.status(200).json({
      success: true,
      status: 'plan_ready',
      command_id: intent.command_id,
      raw_text: text,
      intent,
      plan: {
        plan_id: plan.plan_id,
        steps: plan.steps.map(s => ({
          step_id: s.step_id,
          sequence: s.sequence,
          tool: s.tool,
          description: s.description,
          approval_required: s.approval_required,
        })),
        requires_approval: plan.requires_approval,
      },
    });
  }

  // Step 3: Execute
  plan.status = 'executing';
  const run = await runPlan(plan);

  return res.status(200).json({
    success: true,
    status: 'completed',
    command_id: intent.command_id,
    raw_text: text,
    intent: {
      raw_text: text,
      intent: intent.intent,
      confidence: intent.confidence,
      entities: intent.entities,
      mode: intent.mode,
      parameters: intent.parameters,
    },
    execution: {
      execution_run_id: run.execution_run_id,
      plan_id: run.plan_id,
      status: run.status,
      steps_completed: run.steps_completed,
      steps_failed: run.steps_failed,
      steps_total: run.steps_total,
      duration_ms: run.duration_ms,
      artifacts: run.artifacts,
      results: run.results,
    },
  });
});

/**
 * Validate company entities against HubSpot before allowing destructive actions.
 * Searches for each entity and categorizes the match quality.
 */
async function validateEntities(entities: ResolvedEntity[]): Promise<ValidatedEntity[]> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    return entities.map(e => ({ ...e, match_status: 'not_found' as const, candidates: [] }));
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  return Promise.all(entities.map(async (entity): Promise<ValidatedEntity> => {
    try {
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: entity.resolved_name,
          properties: ['dealname', 'dealstage', 'amount', 'closedate'],
          limit: 5,
        }),
      });

      if (!r.ok) {
        return { ...entity, match_status: 'not_found', candidates: [] };
      }

      const data = await r.json();
      const deals = (data.results || []).map((d: any) => ({
        id: d.id,
        name: d.properties.dealname || '',
        stage: d.properties.dealstage || '',
        amount: d.properties.amount,
      }));

      if (deals.length === 0) {
        return { ...entity, match_status: 'not_found', candidates: [] };
      }

      // Check for exact match (case-insensitive)
      const exactMatch = deals.find(
        (d: any) => d.name.toLowerCase() === entity.resolved_name.toLowerCase()
      );

      if (exactMatch) {
        return {
          ...entity,
          match_status: 'exact',
          hubspot_deal_id: exactMatch.id,
          hubspot_deal_name: exactMatch.name,
          hubspot_current_stage: exactMatch.stage,
          candidates: deals,
        };
      }

      // Check for partial match (entity name appears in deal name or vice versa)
      const partialMatch = deals.find(
        (d: any) =>
          d.name.toLowerCase().includes(entity.resolved_name.toLowerCase()) ||
          entity.resolved_name.toLowerCase().includes(d.name.toLowerCase())
      );

      if (partialMatch && deals.length === 1) {
        return {
          ...entity,
          match_status: 'partial',
          hubspot_deal_id: partialMatch.id,
          hubspot_deal_name: partialMatch.name,
          hubspot_current_stage: partialMatch.stage,
          candidates: deals,
        };
      }

      // Multiple matches or no strong match → ambiguous
      return {
        ...entity,
        match_status: deals.length > 1 ? 'ambiguous' : 'not_found',
        candidates: deals,
      };
    } catch {
      return { ...entity, match_status: 'not_found', candidates: [] };
    }
  }));
}

/**
 * Get a fresh Gmail access token from the refresh token.
 */
async function getGmailToken(): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Gmail auth failed');
  return data.access_token;
}

/**
 * Execute a READ intent directly — no plan/execute pipeline.
 * Returns structured data for the UI to render.
 */
async function executeReadIntent(intent: any): Promise<any> {
  switch (intent.intent) {
    case 'read.email':
      return executeReadEmail(intent);
    case 'read.deal':
      return executeReadDeal(intent);
    case 'read.pipeline':
      return executeReadPipeline(intent);
    case 'read.contact':
      return executeReadContact(intent);
    case 'read.calendar':
      return { type: 'calendar', items: [], message: 'Calendar integration coming soon.' };
    default:
      return { type: 'unknown', items: [], message: 'Unsupported read intent.' };
  }
}

async function executeReadEmail(intent: any): Promise<any> {
  const token = await getGmailToken();
  const headers = { Authorization: `Bearer ${token}` };

  // Build Gmail search query from entities and parameters
  const companyEntity = intent.entities.find((e: any) => e.entity_type === 'company');
  const personEntity = intent.entities.find((e: any) => e.entity_type === 'person');
  let query = intent.parameters?.query || '';

  if (!query) {
    if (companyEntity) query = companyEntity.resolved_name;
    else if (personEntity) query = personEntity.resolved_name;
  }

  if (intent.parameters?.date_filter) {
    query += ` ${intent.parameters.date_filter}`;
  }

  const maxResults = intent.parameters?.max_results || 5;

  const listR = await fetch(
    `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers }
  );

  if (!listR.ok) {
    throw new Error(`Gmail search failed: ${listR.status}`);
  }

  const listData = await listR.json();
  const messages = listData.messages || [];

  if (messages.length === 0) {
    return {
      type: 'email',
      query,
      items: [],
      message: `No emails found matching "${query}".`,
    };
  }

  // Fetch metadata for each message
  const details = await Promise.all(
    messages.slice(0, maxResults).map((m: any) =>
      fetch(
        `${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers }
      ).then(r => r.json()).catch(() => null)
    )
  );

  const threads = details.filter(Boolean).map((msg: any) => {
    const getHeader = (name: string) =>
      (msg.payload?.headers || []).find((h: any) => h.name === name)?.value || '';
    return {
      thread_id: msg.threadId,
      message_id: msg.id,
      subject: getHeader('Subject'),
      from: getHeader('From'),
      to: getHeader('To'),
      date: getHeader('Date'),
      snippet: msg.snippet || '',
    };
  });

  // Dedupe by thread_id, keep the most recent
  const seen = new Set<string>();
  const uniqueThreads = threads.filter((t: any) => {
    if (seen.has(t.thread_id)) return false;
    seen.add(t.thread_id);
    return true;
  });

  return {
    type: 'email',
    query,
    items: uniqueThreads,
    message: `Found ${uniqueThreads.length} thread(s) matching "${query}".`,
  };
}

async function executeReadDeal(intent: any): Promise<any> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HubSpot not configured');

  const hsHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const companyEntity = intent.entities.find((e: any) => e.entity_type === 'company');
  const query = companyEntity?.resolved_name || intent.parameters?.query || '';

  const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
    method: 'POST',
    headers: hsHeaders,
    body: JSON.stringify({
      query,
      properties: ['dealname', 'dealstage', 'amount', 'closedate', 'hs_next_step'],
      limit: 10,
    }),
  });

  if (!r.ok) throw new Error(`HubSpot search failed: ${r.status}`);
  const data = await r.json();

  const deals = (data.results || []).map((d: any) => ({
    id: d.id,
    name: d.properties.dealname || '',
    stage: STAGE_LABELS[d.properties.dealstage || ''] || d.properties.dealstage || '',
    amount: d.properties.amount || '',
    close_date: d.properties.closedate || '',
    next_step: d.properties.hs_next_step || '',
  }));

  return {
    type: 'deal',
    query,
    items: deals,
    message: deals.length ? `Found ${deals.length} deal(s) matching "${query}".` : `No deals found matching "${query}".`,
  };
}

async function executeReadPipeline(intent: any): Promise<any> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HubSpot not configured');

  const hsHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Get open deals
  const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals?limit=20&properties=dealname,dealstage,amount,closedate`, {
    headers: hsHeaders,
  });

  if (!r.ok) throw new Error(`HubSpot fetch failed: ${r.status}`);
  const data = await r.json();

  const deals = (data.results || []).map((d: any) => ({
    id: d.id,
    name: d.properties.dealname || '',
    stage: STAGE_LABELS[d.properties.dealstage || ''] || d.properties.dealstage || '',
    amount: d.properties.amount || '',
    close_date: d.properties.closedate || '',
  }));

  return {
    type: 'pipeline',
    items: deals,
    message: `${deals.length} deal(s) in pipeline.`,
  };
}

async function executeReadContact(intent: any): Promise<any> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HubSpot not configured');

  const hsHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const personEntity = intent.entities.find((e: any) => e.entity_type === 'person');
  const companyEntity = intent.entities.find((e: any) => e.entity_type === 'company');
  const query = personEntity?.resolved_name || companyEntity?.resolved_name || intent.parameters?.query || '';

  const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: hsHeaders,
    body: JSON.stringify({
      query,
      properties: ['email', 'firstname', 'lastname', 'jobtitle', 'phone', 'company'],
      limit: 10,
    }),
  });

  if (!r.ok) throw new Error(`HubSpot search failed: ${r.status}`);
  const data = await r.json();

  const contacts = (data.results || []).map((c: any) => ({
    id: c.id,
    name: `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim(),
    email: c.properties.email || '',
    title: c.properties.jobtitle || '',
    phone: c.properties.phone || '',
    company: c.properties.company || '',
  }));

  return {
    type: 'contact',
    query,
    items: contacts,
    message: contacts.length ? `Found ${contacts.length} contact(s) matching "${query}".` : `No contacts found matching "${query}".`,
  };
}

/**
 * Email Context Recommendation — Gather multi-source context and generate
 * AI-powered strategic recommendation. Non-mutating: only reads data.
 */
async function executeEmailRecommendation(intent: any): Promise<any> {
  const companyEntity = intent.entities.find((e: any) => e.entity_type === 'company');
  const companyName = companyEntity?.resolved_name || intent.parameters?.query || '';

  if (!companyName) {
    return {
      company: '',
      email_context: null,
      deal_context: null,
      meeting_context: null,
      recommendation: null,
      error: 'Could not identify a company from your message. Please mention the company name.',
    };
  }

  // ── Gather context from all sources in parallel ──
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  const granolaKey = process.env.GRANOLA_API_KEY;

  const [emailResult, dealResult, companyResult, contactResult, granolaResult] = await Promise.allSettled([
    // 1. Latest Gmail threads from this company
    (async () => {
      const gmailToken = await getGmailToken();
      const headers = { Authorization: `Bearer ${gmailToken}` };
      const listR = await fetch(
        `${GMAIL_BASE}/messages?q=${encodeURIComponent(companyName)}&maxResults=5`,
        { headers }
      );
      if (!listR.ok) return { threads: [] };
      const listData = await listR.json();
      const messages = listData.messages || [];
      const details = await Promise.all(
        messages.slice(0, 5).map((m: any) =>
          fetch(
            `${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
            { headers }
          ).then(r => r.json()).catch(() => null)
        )
      );
      const threads = details.filter(Boolean).map((msg: any) => {
        const getH = (n: string) => (msg.payload?.headers || []).find((h: any) => h.name === n)?.value || '';
        return { thread_id: msg.threadId, message_id: msg.id, subject: getH('Subject'), from: getH('From'), to: getH('To'), date: getH('Date'), snippet: msg.snippet || '' };
      });
      // Dedupe by thread_id
      const seen = new Set<string>();
      return { threads: threads.filter((t: any) => { if (seen.has(t.thread_id)) return false; seen.add(t.thread_id); return true; }) };
    })(),

    // 2. HubSpot deals
    (async () => {
      if (!token) return { deals: [] };
      const hsHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
        method: 'POST', headers: hsHeaders,
        body: JSON.stringify({ query: companyName, properties: ['dealname', 'dealstage', 'amount', 'closedate', 'hs_next_step', 'hubspot_owner_id'], limit: 5 }),
      });
      if (!r.ok) return { deals: [] };
      const data = await r.json();
      return {
        deals: (data.results || []).map((d: any) => ({
          id: d.id, name: d.properties.dealname || '', stage: d.properties.dealstage || '',
          stage_label: STAGE_LABELS[d.properties.dealstage || ''] || d.properties.dealstage || '',
          amount: d.properties.amount || '', close_date: d.properties.closedate || '',
          next_step: d.properties.hs_next_step || '', owner_id: d.properties.hubspot_owner_id || '',
        })),
      };
    })(),

    // 3. HubSpot companies
    (async () => {
      if (!token) return { companies: [] };
      const hsHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies/search`, {
        method: 'POST', headers: hsHeaders,
        body: JSON.stringify({ query: companyName, properties: ['name', 'domain', 'industry', 'website', 'description'], limit: 3 }),
      });
      if (!r.ok) return { companies: [] };
      const data = await r.json();
      return {
        companies: (data.results || []).map((c: any) => ({
          id: c.id, name: c.properties.name || '', domain: c.properties.domain || '',
          industry: c.properties.industry || '', website: c.properties.website || '',
        })),
      };
    })(),

    // 4. HubSpot contacts
    (async () => {
      if (!token) return { contacts: [] };
      const hsHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
        method: 'POST', headers: hsHeaders,
        body: JSON.stringify({ query: companyName, properties: ['email', 'firstname', 'lastname', 'jobtitle', 'phone'], limit: 5 }),
      });
      if (!r.ok) return { contacts: [] };
      const data = await r.json();
      return {
        contacts: (data.results || []).map((c: any) => ({
          id: c.id, name: `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim(),
          email: c.properties.email || '', title: c.properties.jobtitle || '',
        })),
      };
    })(),

    // 5. Granola meeting notes (last 14 days) — multi-strategy matching
    (async () => {
      if (!granolaKey) return { notes: [] };
      const after = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
      const r = await fetch(
        `https://public-api.granola.ai/v1/notes?page_size=30&created_after=${after}`,
        { headers: { Authorization: `Bearer ${granolaKey}` } }
      );
      if (!r.ok) return { notes: [] };
      const data = await r.json();
      const matches = scoreGranolaNotes(data.notes || [], companyName);
      return {
        notes: matches.map((m: any) => ({
          id: m.note.id, title: m.note.title, created_at: m.note.created_at,
          attendees: (m.note.attendees || []).map((a: any) => a.name).filter(Boolean),
          match_strategy: m.match_strategy,
          match_score: m.match_score,
        })),
      };
    })(),
  ]);

  // Unpack results (gracefully handle failures)
  const emails = emailResult.status === 'fulfilled' ? emailResult.value : { threads: [] };
  const deals = dealResult.status === 'fulfilled' ? dealResult.value : { deals: [] };
  const companies = companyResult.status === 'fulfilled' ? companyResult.value : { companies: [] };
  const contacts = contactResult.status === 'fulfilled' ? contactResult.value : { contacts: [] };
  const granolaNotes = granolaResult.status === 'fulfilled' ? granolaResult.value : { notes: [] };

  // ── Generate AI recommendation ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let aiRecommendation: any = null;

  if (apiKey) {
    try {
      const contextSummary = buildRecommendationContext(companyName, emails, deals, companies, contacts, granolaNotes);

      const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: `You are a strategic revenue operations advisor. Given context about a company from email, CRM, and meeting data, generate a concise recommendation.

Return ONLY valid JSON:
{
  "recommended_action": "string — the primary thing the user should do next (1 sentence)",
  "reasoning": "string — why this action makes sense given the context (2-3 sentences)",
  "urgency": "high" | "medium" | "low",
  "urgency_reason": "string — brief reason for urgency level",
  "suggested_next_steps": ["string — concrete action item 1", "string — concrete action item 2", "..."],
  "key_context": "string — the most important piece of context driving this recommendation (1 sentence)",
  "deal_stage_suggestion": "string | null — if a stage change seems appropriate, suggest it",
  "tone": "string — suggested tone for any reply (e.g., 'warm follow-up', 'urgent close', 'nurture')"
}

Rules:
- Ground every recommendation in ACTUAL data from the context provided. Never fabricate.
- If email threads exist, reference the most recent subject/content.
- If a deal exists in CRM, reference its stage and next steps.
- If meeting notes exist, reference any relevant takeaways.
- Be specific and actionable, not generic. "Send a follow-up" is weak. "Reply to their pricing inquiry with the Q2 discount structure and cc the AE" is strong.
- If data is sparse, say so and recommend gathering more context first.`,
          messages: [{
            role: 'user',
            content: `The user said: "${intent.raw_text}"\n\nContext for ${companyName}:\n${contextSummary}`,
          }],
        }),
      });

      const aiData = await aiResponse.json();
      const rawAi = (aiData.content?.[0]?.text || '{}')
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
      aiRecommendation = JSON.parse(rawAi);
    } catch (err: any) {
      console.warn('[recommendation] AI generation failed:', err.message);
    }
  }

  return {
    company: companyName,
    email_context: {
      threads: emails.threads.slice(0, 3),
      thread_count: emails.threads.length,
    },
    deal_context: {
      deals: deals.deals,
      primary_deal: deals.deals[0] || null,
    },
    company_context: {
      company: companies.companies[0] || null,
      contacts: contacts.contacts.slice(0, 3),
    },
    meeting_context: {
      notes: granolaNotes.notes.slice(0, 3),
      has_recent_meetings: granolaNotes.notes.length > 0,
    },
    recommendation: aiRecommendation || {
      recommended_action: `Review the latest email from ${companyName} and assess next steps based on deal context.`,
      reasoning: 'Unable to generate AI recommendation. Review the gathered context below to determine next steps.',
      urgency: 'medium',
      urgency_reason: 'Manual review needed',
      suggested_next_steps: ['Review latest email thread', 'Check deal stage in HubSpot', 'Determine if follow-up is needed'],
      key_context: `Found ${emails.threads.length} email thread(s) and ${deals.deals.length} deal(s) for ${companyName}.`,
      deal_stage_suggestion: null,
      tone: 'professional',
    },
    actions: [
      { id: 'draft_reply', label: 'Draft reply', icon: '✉', command: `Draft a follow-up email to ${companyName}` },
      { id: 'update_next_steps', label: 'Update next steps', icon: '✎', command: `Update next steps for ${companyName}` },
      { id: 'move_stage', label: 'Move stage', icon: '→', command: `Move ${companyName} to ` },
      { id: 'loop_in', label: 'Loop in Jackson', icon: '👤', command: `Loop in Jackson to schedule a follow-up with ${companyName}` },
    ],
  };
}

function buildRecommendationContext(
  companyName: string,
  emails: any,
  deals: any,
  companies: any,
  contacts: any,
  granolaNotes: any
): string {
  const parts: string[] = [];

  // Email context
  if (emails.threads.length > 0) {
    parts.push('=== RECENT EMAIL THREADS ===');
    emails.threads.slice(0, 3).forEach((t: any, i: number) => {
      parts.push(`${i + 1}. Subject: "${t.subject}" | From: ${t.from} | Date: ${t.date}`);
      if (t.snippet) parts.push(`   Preview: ${t.snippet.slice(0, 200)}`);
    });
  } else {
    parts.push('=== EMAIL: No recent threads found ===');
  }

  // Deal context
  if (deals.deals.length > 0) {
    parts.push('\n=== CRM DEALS ===');
    deals.deals.forEach((d: any, i: number) => {
      parts.push(`${i + 1}. "${d.name}" | Stage: ${d.stage_label} | Amount: ${d.amount || 'N/A'} | Close: ${d.close_date || 'N/A'}`);
      if (d.next_step) parts.push(`   Next Steps: ${d.next_step}`);
    });
  } else {
    parts.push('\n=== CRM: No deals found ===');
  }

  // Company context
  if (companies.companies.length > 0) {
    const c = companies.companies[0];
    parts.push(`\n=== COMPANY: ${c.name} ===`);
    if (c.industry) parts.push(`Industry: ${c.industry}`);
    if (c.domain) parts.push(`Domain: ${c.domain}`);
  }

  // Contacts
  if (contacts.contacts.length > 0) {
    parts.push('\n=== CONTACTS ===');
    contacts.contacts.slice(0, 3).forEach((c: any) => {
      parts.push(`- ${c.name}${c.title ? ' (' + c.title + ')' : ''}${c.email ? ' — ' + c.email : ''}`);
    });
  }

  // Meeting notes
  if (granolaNotes.notes.length > 0) {
    parts.push('\n=== RECENT MEETING NOTES ===');
    granolaNotes.notes.slice(0, 2).forEach((n: any) => {
      parts.push(`- "${n.title}" on ${n.created_at}${n.attendees.length ? ' with ' + n.attendees.join(', ') : ''}`);
    });
  }

  return parts.join('\n');
}

/**
 * Multi-strategy Granola note matching (mirrors server/tools/granola/getNotes.ts).
 * Returns scored matches sorted by score descending.
 */
function scoreGranolaNotes(notes: any[], companyName: string): { note: any; match_score: number; match_strategy: string }[] {
  const q = companyName.toLowerCase();
  const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = new RegExp(`(?:^|\\W)${qEsc}(?:$|\\W)`, 'i');
  const domainFragment = q.replace(/[^a-z0-9]/g, '');

  const scored: { note: any; match_score: number; match_strategy: string }[] = [];

  for (const n of notes) {
    const attendees = (n.attendees || []).map((a: any) => ({
      name: (a.name || '').toLowerCase(),
      email: (a.email || '').toLowerCase(),
    }));
    let bestScore = 0;
    let bestStrategy = '';

    // Strategy 1: Calendar event match
    if (n.calendar_event?.title) {
      const ct = n.calendar_event.title.toLowerCase();
      if (ct === q) { bestScore = 100; bestStrategy = 'calendar_event'; }
      else if (wordRe.test(n.calendar_event.title) && bestScore < 90) { bestScore = 90; bestStrategy = 'calendar_event'; }
      else if (ct.includes(q) && bestScore < 75) { bestScore = 75; bestStrategy = 'calendar_event'; }
    }

    // Strategy 2: Participant email
    if (domainFragment.length >= 3) {
      for (const a of attendees) {
        if (a.email && a.email.includes(domainFragment)) {
          const s = a.email.split('@')[1]?.includes(domainFragment) ? 85 : 70;
          if (s > bestScore) { bestScore = s; bestStrategy = 'participant_email'; }
          break;
        }
      }
    }

    // Strategy 3: Participant name
    for (const a of attendees) {
      if (a.name === q && bestScore < 80) { bestScore = 80; bestStrategy = 'participant_name'; break; }
      if (wordRe.test(a.name) && bestScore < 65) { bestScore = 65; bestStrategy = 'participant_name'; break; }
      if (a.name.includes(q) && bestScore < 50) { bestScore = 50; bestStrategy = 'participant_name'; break; }
    }

    // Strategy 4: Title fuzzy match
    const nt = (n.title || '').toLowerCase();
    if (nt === q && bestScore < 100) { bestScore = 100; bestStrategy = 'title_fuzzy'; }
    else if (wordRe.test(n.title || '') && bestScore < 80) { bestScore = 80; bestStrategy = 'title_fuzzy'; }
    else if (nt.includes(q) && bestScore < 40) { bestScore = 40; bestStrategy = 'title_fuzzy'; }

    if (bestScore > 0) {
      scored.push({ note: n, match_score: bestScore, match_strategy: bestStrategy });
    }
  }

  // Strategy 5: Recent window fallback
  if (scored.length === 0 && notes.length > 0) {
    const fourteenDaysAgo = Date.now() - 14 * 86400000;
    const recent = notes.filter(n => new Date(n.created_at).getTime() >= fourteenDaysAgo);
    if (recent.length > 0) {
      scored.push({ note: recent[0], match_score: 20, match_strategy: 'recent_window' });
    }
  }

  scored.sort((a, b) => b.match_score - a.match_score);
  return scored;
}

/**
 * Normalize stage names (from AI or user input) to HubSpot stage IDs.
 * Handles various formats: "discocomplete", "Disco Complete", "disco_complete", etc.
 */
function normalizeStageId(raw: string): string {
  const s = raw.toLowerCase().replace(/[\s_-]+/g, '');
  const map: Record<string, string> = {
    'closedlost': 'closedlost',
    'closedwon': 'closedwon',
    'contractsent': 'contractsent',
    'committed': '227588384',
    'negotiating': 'decisionmakerboughtin',
    'negotiatingproposal': 'decisionmakerboughtin',
    'democompleted': '123162712',
    'demoscheduled': 'appointmentscheduled',
    'discobooked': '93124525',
    'discocomplete': '998751160',
    'presentationscheduled': 'presentationscheduled',
    'qualifiedtobuy': 'qualifiedtobuy',
    'nurture': '60237411',
  };
  return map[s] || raw;
}
