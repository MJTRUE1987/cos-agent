import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyIntent } from '../../server/agent/intentRouter.js';

describe('Intent Router: read_query', () => {
  const readCases = [
    { input: 'pull up my latest email from Thrive Market', expected: 'read_query' },
    { input: 'show me Brian\'s deals in Demo Completed', expected: 'read_query' },
    { input: 'what meetings do I have tomorrow', expected: 'read_query' },
    { input: 'find my last email from Matt Bahr', expected: 'read_query' },
    { input: 'show me the deal for ARMRA', expected: 'read_query' },
    { input: 'what stage is Brooklinen in', expected: 'read_query' },
    { input: 'show pipeline', expected: 'read_query' },
    { input: 'show my calendar', expected: 'read_query' },
    { input: 'who is Jane at Carda Health', expected: 'read_query' },
    { input: 'pull up my latest email from Matt Bahr', expected: 'read_query' },
    { input: 'show me Brian\'s deals', expected: 'read_query' },
  ];

  for (const { input, expected } of readCases) {
    test(`"${input}" → ${expected}`, () => {
      const result = classifyIntent(input);
      assert.strictEqual(result.top_level, expected, `Expected ${expected} but got ${result.top_level} (sub: ${result.sub_intent})`);
    });
  }
});

describe('Intent Router: assist_recommend', () => {
  const assistCases = [
    { input: 'I just got an email from Thrive Market. What do you recommend we do?', expected: 'assist_recommend' },
    { input: 'what are my top pipeline actions today?', expected: 'assist_recommend' },
    { input: 'prep me for tomorrow\'s external meetings', expected: 'assist_recommend' },
    { input: 'what should we do here', expected: 'assist_recommend' },
    { input: 'what matters today', expected: 'assist_recommend' },
    { input: 'daily brief', expected: 'assist_recommend' },
    { input: 'which deals are stale', expected: 'assist_recommend' },
    { input: 'Thrive Market emailed me, what\'s the move?', expected: 'assist_recommend' },
    { input: 'I just heard from Carda Health. How should I respond?', expected: 'assist_recommend' },
  ];

  for (const { input, expected } of assistCases) {
    test(`"${input}" → ${expected}`, () => {
      const result = classifyIntent(input);
      assert.strictEqual(result.top_level, expected, `Expected ${expected} but got ${result.top_level} (sub: ${result.sub_intent})`);
    });
  }
});

describe('Intent Router: workflow_mutation', () => {
  const mutationCases = [
    { input: 'move Thrive Market to Disco Complete', expected: 'workflow_mutation' },
    { input: 'move Hotel Collection and 2K Games to Closed Lost', expected: 'workflow_mutation' },
    { input: 'add Granola summary to Uresta and update next steps', expected: 'workflow_mutation' },
    { input: 'update thrive', expected: 'workflow_mutation' },
    { input: 'move it forward', expected: 'workflow_mutation' },
    { input: 'add the notes', expected: 'workflow_mutation' },
    { input: 'draft a follow-up email to ARMRA', expected: 'workflow_mutation' },
    { input: 'Loop in Jackson to help find a time', expected: 'workflow_mutation' },
    { input: 'I just finished my call with HexClad', expected: 'workflow_mutation' },
  ];

  for (const { input, expected } of mutationCases) {
    test(`"${input}" → ${expected}`, () => {
      const result = classifyIntent(input);
      assert.strictEqual(result.top_level, expected, `Expected ${expected} but got ${result.top_level} (sub: ${result.sub_intent})`);
    });
  }
});

describe('Intent Router: create_wizard', () => {
  const wizardCases = [
    { input: 'create opportunity in HubSpot under Disco Complete for Carda Health', expected: 'create_wizard' },
    { input: 'create deal for Thrive Market', expected: 'create_wizard' },
    { input: 'create contact for Jane Smith', expected: 'create_wizard' },
    { input: 'add Carda Health to HubSpot in Demo Completed', expected: 'create_wizard' },
  ];

  for (const { input, expected } of wizardCases) {
    test(`"${input}" → ${expected}`, () => {
      const result = classifyIntent(input);
      assert.strictEqual(result.top_level, expected, `Expected ${expected} but got ${result.top_level} (sub: ${result.sub_intent})`);
    });
  }
});

describe('Intent Router: default rule', () => {
  test('no mutation verb defaults to read_query or assist_recommend', () => {
    const result = classifyIntent('Thrive Market pipeline');
    assert.ok(result.top_level === 'read_query' || result.top_level === 'assist_recommend');
  });

  test('mutation verb always triggers workflow_mutation', () => {
    const result = classifyIntent('update something');
    assert.strictEqual(result.top_level, 'workflow_mutation');
  });

  test('confidence is reasonable', () => {
    const high = classifyIntent('move Thrive Market to Disco Complete');
    assert.ok(high.confidence >= 0.7, `Expected >= 0.7 but got ${high.confidence}`);

    const ambiguous = classifyIntent('hello');
    assert.ok(ambiguous.confidence <= 0.5, `Expected <= 0.5 but got ${ambiguous.confidence}`);
  });
});

describe('Intent Router: routing rules', () => {
  test('"Pull up email from X" = read.email, NOT inbox.triage', () => {
    const result = classifyIntent('Pull up my latest email from Thrive Market');
    assert.strictEqual(result.sub_intent, 'read.email');
    assert.notStrictEqual(result.sub_intent, 'inbox.triage');
  });

  test('"show my emails" = read.email, NOT inbox.triage', () => {
    const result = classifyIntent('show my latest email from someone');
    assert.strictEqual(result.sub_intent, 'read.email');
  });

  test('"triage inbox" = inbox.triage', () => {
    const result = classifyIntent('triage my inbox');
    assert.strictEqual(result.sub_intent, 'inbox.triage');
  });

  test('"I just got an email from X, what should we do?" = email_context.recommendation', () => {
    const result = classifyIntent('I just got an email from Thrive Market. What should we do?');
    assert.strictEqual(result.sub_intent, 'email_context.recommendation');
  });
});
