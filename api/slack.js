// Slack API — Send messages, list channels, list users
// Supports: send to any channel or DM, list available targets
// DMs use conversations.open to get proper DM channel

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'SLACK_BOT_TOKEN not configured' });

  // Check for user token (needed to send DMs as Mike, not as the bot)
  const userToken = process.env.SLACK_USER_TOKEN;

  const botHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // GET — list channels and users for the picker
  if (req.method === 'GET') {
    try {
      const [chRes, usrRes] = await Promise.all([
        fetch('https://slack.com/api/conversations.list?types=public_channel&limit=200&exclude_archived=true', { headers: botHeaders }),
        fetch('https://slack.com/api/users.list?limit=200', { headers: botHeaders }),
      ]);
      const [chData, usrData] = await Promise.all([chRes.json(), usrRes.json()]);

      const channels = (chData.channels || [])
        .filter(c => !c.is_archived)
        .map(c => ({ id: c.id, name: c.name, topic: c.topic?.value || '' }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const users = (usrData.members || [])
        .filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT')
        .map(u => ({ id: u.id, name: u.real_name || u.name, displayName: u.profile?.display_name || u.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.status(200).json({ success: true, channels, users, hasUserToken: !!userToken });
    } catch (err) {
      console.error('Slack list error:', err);
      return res.status(500).json({ error: 'Failed to list Slack targets' });
    }
  }

  // POST — send a message
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { channel, userId, text, blocks } = req.body || {};
  const target = channel || userId;
  if (!target || !text) return res.status(400).json({ error: 'channel/userId and text required' });

  try {
    let channelId = target;
    let isDm = false;

    // If target is a user ID (starts with U), open a DM conversation first
    if (target.startsWith('U')) {
      isDm = true;

      // Use user token if available (sends as Mike), otherwise bot token (sends as bot app)
      const openHeaders = userToken
        ? { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' }
        : botHeaders;

      const openRes = await fetch('https://slack.com/api/conversations.open', {
        method: 'POST',
        headers: openHeaders,
        body: JSON.stringify({ users: target }),
      });
      const openData = await openRes.json();

      if (!openData.ok) {
        console.error('[slack] conversations.open failed:', openData.error);
        return res.status(400).json({ error: `Slack DM open failed: ${openData.error}` });
      }

      channelId = openData.channel.id;
      console.log(`[slack] Opened DM channel ${channelId} for user ${target} (using ${userToken ? 'user' : 'bot'} token)`);
    }

    // Send with user token for DMs (if available), bot token otherwise
    const sendHeaders = (isDm && userToken)
      ? { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' }
      : botHeaders;

    const payload = { channel: channelId, text };
    if (blocks) payload.blocks = blocks;

    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: sendHeaders,
      body: JSON.stringify(payload),
    });
    const data = await slackRes.json();

    if (!data.ok) {
      return res.status(400).json({ error: `Slack error: ${data.error}` });
    }

    return res.status(200).json({
      success: true,
      channel: data.channel,
      ts: data.ts,
      message: data.message?.text,
      sentAs: (isDm && userToken) ? 'user' : 'bot',
    });
  } catch (err) {
    console.error('Slack send error:', err);
    return res.status(500).json({ error: 'Failed to send Slack message' });
  }
}
