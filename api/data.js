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
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (kv) {
      const [actions, meetings, pipeline, metadata] = await Promise.all([
        kv.get('actions'), kv.get('meetings'), kv.get('pipeline'), kv.get('metadata'),
      ]);

      if (actions && meetings && pipeline) {
        return res.status(200).json({ actions, meetings, pipeline, metadata: metadata || {} });
      }

      // Auto-seed KV from seed data on first request
      if (seedData.actions) {
        Promise.all([
          kv.set('actions', seedData.actions),
          kv.set('meetings', seedData.meetings),
          kv.set('pipeline', seedData.pipeline),
          seedData.metadata ? kv.set('metadata', seedData.metadata) : Promise.resolve(),
        ]).catch(err => console.error('KV seed error:', err));
      }
    }

    // Return seed data (with or without KV)
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
