import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  resolveEntities,
  resolveFollowUp,
  createEntitySession,
  hasTopicChanged,
} from '../../server/agent/entityResolver.js';

describe('Entity Resolver: brand vs agency preference', () => {
  test('prefers brand deal over agency deal in sales context', () => {
    const session = createEntitySession();
    const entities = [{ raw_text: 'Thrive Market', entity_type: 'company' as const, resolved_name: 'Thrive Market', confidence: 0.7 }];
    const deals = [
      { id: '1', name: 'Thrive Market', dealname: 'Thrive Market', stage: 'Disco Complete' },
      { id: '2', name: 'Thrive Market via Darkroom', dealname: 'Thrive Market via Darkroom', stage: 'Demo Scheduled' },
    ];

    const result = resolveEntities(entities, session, { deals, intent: 'pipeline.stage_change' });

    assert.strictEqual(result.entities[0].resolved_id, '1');
    assert.ok(!result.needs_clarification);
  });

  test('does not substitute missing entity with nearby match', () => {
    const session = createEntitySession();
    const entities = [{ raw_text: 'Zzzzz Fake', entity_type: 'company' as const, resolved_name: 'Zzzzz Fake', confidence: 0.7 }];
    const deals = [
      { id: '1', name: 'ARMRA', stage: 'Disco Complete' },
    ];

    const result = resolveEntities(entities, session, { deals });
    // Should pass through unresolved, NOT substitute with ARMRA
    assert.strictEqual(result.entities[0].resolved_name, 'Zzzzz Fake');
    assert.strictEqual(result.entities[0].resolved_id, undefined);
  });
});

describe('Entity Resolver: duplicate entities', () => {
  test('resolves duplicate mentions consistently', () => {
    const session = createEntitySession();
    const entities = [
      { raw_text: 'ARMRA', entity_type: 'company' as const, resolved_name: 'ARMRA', confidence: 0.7 },
      { raw_text: 'ARMRA', entity_type: 'company' as const, resolved_name: 'ARMRA', confidence: 0.7 },
    ];
    const deals = [
      { id: '10', name: 'ARMRA', stage: 'Demo Completed' },
    ];

    const result = resolveEntities(entities, session, { deals });
    assert.strictEqual(result.entities.length, 2);
    assert.strictEqual(result.entities[0].resolved_id, '10');
    assert.strictEqual(result.entities[1].resolved_id, '10');
  });
});

describe('Entity Resolver: follow-up pronouns', () => {
  test('"it" resolves to last entity', () => {
    const session = createEntitySession();
    session.resolved_entities['thrive market'] = {
      raw_text: 'Thrive Market',
      entity_type: 'company',
      resolved_name: 'Thrive Market',
      resolved_id: '123',
      source: 'hubspot',
      confidence: 0.9,
      resolved_at: new Date().toISOString(),
    };

    const result = resolveFollowUp('move it to Closed Lost', session);
    assert.ok(result.resolved);
    assert.strictEqual(result.entity?.resolved_name, 'Thrive Market');
    assert.strictEqual(result.entity?.resolved_id, '123');
  });

  test('"that deal" resolves to last company entity', () => {
    const session = createEntitySession();
    session.resolved_entities['armra'] = {
      raw_text: 'ARMRA',
      entity_type: 'company',
      resolved_name: 'ARMRA',
      resolved_id: '456',
      source: 'hubspot',
      confidence: 0.9,
      resolved_at: new Date().toISOString(),
    };

    const result = resolveFollowUp('what about that deal', session);
    assert.ok(result.resolved);
    assert.strictEqual(result.entity?.resolved_name, 'ARMRA');
  });

  test('no pronoun returns not resolved', () => {
    const session = createEntitySession();
    session.resolved_entities['armra'] = {
      raw_text: 'ARMRA',
      entity_type: 'company',
      resolved_name: 'ARMRA',
      resolved_id: '456',
      source: 'hubspot',
      confidence: 0.9,
      resolved_at: new Date().toISOString(),
    };

    const result = resolveFollowUp('move Brooklinen to Closed Lost', session);
    assert.ok(!result.resolved);
  });

  test('empty session returns not resolved', () => {
    const session = createEntitySession();
    const result = resolveFollowUp('move it to Closed Lost', session);
    assert.ok(!result.resolved);
  });
});

describe('Entity Resolver: session persistence', () => {
  test('resolved entity persists in session for follow-up', () => {
    const session = createEntitySession();
    const entities = [{ raw_text: 'ARMRA', entity_type: 'company' as const, resolved_name: 'ARMRA', confidence: 0.7 }];
    const deals = [{ id: '10', name: 'ARMRA', stage: 'Demo Completed' }];

    const result1 = resolveEntities(entities, session, { deals });
    assert.strictEqual(result1.entities[0].resolved_id, '10');

    // Second call with same entity should reuse cached resolution
    const result2 = resolveEntities(entities, result1.session, { deals: [] });
    assert.strictEqual(result2.entities[0].resolved_id, '10');
  });

  test('clarification not re-asked for same entity', () => {
    const session = createEntitySession();
    const entities = [{ raw_text: 'ARMRA', entity_type: 'company' as const, resolved_name: 'ARMRA', confidence: 0.7 }];
    const deals = [
      { id: '10', name: 'ARMRA New', stage: 'Demo Completed' },
      { id: '11', name: 'ARMRA Expansion', stage: 'Negotiating' },
    ];

    // First call: should ask for clarification
    const result1 = resolveEntities(entities, session, { deals });
    assert.ok(result1.needs_clarification);
    assert.ok(result1.clarifications.length > 0);

    // Second call with same session: should NOT re-ask
    const result2 = resolveEntities(entities, result1.session, { deals });
    assert.ok(!result2.needs_clarification);
  });
});

describe('Entity Resolver: topic change detection', () => {
  test('detects topic change when different entities mentioned', () => {
    const session = createEntitySession();
    session.last_topic = 'Move ARMRA to Closed Lost';
    const changed = hasTopicChanged('Show me Brooklinen deals', session);
    assert.ok(changed);
  });

  test('does not detect change when same entity mentioned', () => {
    const session = createEntitySession();
    session.last_topic = 'Move ARMRA to Closed Lost';
    const changed = hasTopicChanged('Show me ARMRA deals', session);
    assert.ok(!changed);
  });
});
