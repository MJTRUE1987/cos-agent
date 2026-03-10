// Gmail Draft Email API
// Creates actual Gmail drafts using Google OAuth2

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, cc, subject, body, threadId } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: 'to and body required' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.' });
  }

  try {
    // Get fresh access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(500).json({ error: 'Failed to refresh Google token' });
    }

    // Build RFC 2822 email
    const headers = [
      `To: ${to}`,
      cc ? `Cc: ${cc}` : null,
      `Subject: ${subject || '(no subject)'}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
    ].filter(Boolean).join('\r\n');

    const rawMessage = `${headers}\r\n\r\n${body}`;
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Create draft
    const draftBody = { message: { raw: encodedMessage } };
    if (threadId) draftBody.message.threadId = threadId;

    const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(draftBody),
    });

    if (!draftRes.ok) {
      const err = await draftRes.text();
      return res.status(draftRes.status).json({ error: `Gmail API error: ${err}` });
    }

    const draft = await draftRes.json();
    return res.status(200).json({
      success: true,
      draftId: draft.id,
      messageId: draft.message?.id,
      url: `https://mail.google.com/mail/u/0/#drafts/${draft.message?.id}`,
    });
  } catch (err) {
    console.error('Draft email error:', err);
    return res.status(500).json({ error: 'Failed to create draft' });
  }
}
