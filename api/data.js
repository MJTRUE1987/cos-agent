import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedData = JSON.parse(readFileSync(join(__dirname, '..', 'seed-data.json'), 'utf8'));

let kv = null;
try {
  const kvModule = await import('@vercel/kv');
  kv = kvModule.kv;
} catch (e) {
  // KV not configured — will serve seed data only
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  // POST with action=reseed forces KV to reload from seed-data.json
  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'reseed' && kv) {
      await Promise.all([
        kv.set('actions', seedData.actions),
        kv.set('meetings', seedData.meetings),
        kv.set('pipeline', seedData.pipeline),
        seedData.metadata ? kv.set('metadata', seedData.metadata) : Promise.resolve(),
      ]);
      console.log('[data] KV reseeded from seed-data.json');
      return res.status(200).json({ success: true, message: 'KV reseeded', actionCount: seedData.actions?.length });
    }
    return res.status(400).json({ error: 'Unknown action' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (kv) {
      const [actions, meetings, pipeline, metadata] = await Promise.all([
        kv.get('actions'), kv.get('meetings'), kv.get('pipeline'), kv.get('metadata'),
      ]);

      // Use KV data per-key, falling back to seed data for any missing keys
      if (!actions) console.warn('[data] KV actions missing, using seed data');
      if (!meetings) console.warn('[data] KV meetings missing, using seed data');
      if (!pipeline) console.warn('[data] KV pipeline missing, using seed data');

      const result = {
        actions: actions || seedData.actions || [],
        meetings: meetings || seedData.meetings || [],
        pipeline: pipeline || seedData.pipeline || [],
        metadata: metadata || {},
      };

      return res.status(200).json(result);
    }

    // Return seed data (KV not configured)
    return res.status(200).json({
      actions: seedData.actions || [],
      meetings: seedData.meetings || [],
      pipeline: seedData.pipeline || [],
      metadata: seedData.metadata || {},
    });
  } catch (err) {
    console.error('GET /api/data error:', err);
    return res.status(200).json({
      actions: seedData.actions || [],
      meetings: seedData.meetings || [],
      pipeline: seedData.pipeline || [],
      metadata: seedData.metadata || {},
    });
  }
}
