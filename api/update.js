import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  const apiKey = process.env.COS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${apiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const body = req.body;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Body must be JSON' });

    const { mode = 'replace', actions, meetings, pipeline, metadata } = body;
    const updates = [];

    if (mode === 'upsert') {
      if (actions && Array.isArray(actions)) {
        const existing = (await kv.get('actions')) || [];
        updates.push(kv.set('actions', upsertById(existing, actions)));
      }
      if (meetings && Array.isArray(meetings)) {
        const existing = (await kv.get('meetings')) || [];
        updates.push(kv.set('meetings', upsertByTitle(existing, meetings)));
      }
      if (pipeline && Array.isArray(pipeline)) {
        const existing = (await kv.get('pipeline')) || [];
        updates.push(kv.set('pipeline', upsertById(existing, pipeline)));
      }
    } else {
      if (actions) updates.push(kv.set('actions', actions));
      if (meetings) updates.push(kv.set('meetings', meetings));
      if (pipeline) updates.push(kv.set('pipeline', pipeline));
    }
    if (metadata) updates.push(kv.set('metadata', metadata));

    if (updates.length === 0) return res.status(400).json({ error: 'No data fields provided' });

    await Promise.all(updates);
    return res.status(200).json({ success: true, mode, updated: [actions&&'actions', meetings&&'meetings', pipeline&&'pipeline', metadata&&'metadata'].filter(Boolean) });
  } catch (err) {
    console.error('POST /api/update error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function upsertById(existing, incoming, key = 'id') {
  const map = new Map(existing.map(item => [item[key], item]));
  for (const item of incoming) {
    if (item[key] !== undefined) {
      map.set(item[key], { ...map.get(item[key]), ...item });
    } else {
      existing.push(item); // No key — append
    }
  }
  return Array.from(map.values());
}

function upsertByTitle(existing, incoming) {
  const map = new Map(existing.map(m => [m.date + '|' + m.title, m]));
  for (const m of incoming) {
    const key = m.date + '|' + m.title;
    map.set(key, { ...map.get(key), ...m });
  }
  return Array.from(map.values());
}
