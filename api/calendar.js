// Google Calendar API — Fetch upcoming meetings
// Detects external (brand) meetings vs internal

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Google OAuth credentials not configured' });
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

    // Fetch events for today + next 7 days
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 7 * 86400000).toISOString();

    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
      `&singleEvents=true&orderBy=startTime&maxResults=50`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    if (!calRes.ok) {
      const err = await calRes.text();
      return res.status(calRes.status).json({ error: `Calendar API error: ${err}` });
    }

    const calData = await calRes.json();
    const internalDomains = ['prescientai.com', 'prescient.ai'];

    const meetings = (calData.items || []).map(event => {
      const attendees = (event.attendees || []).filter(a => !a.self);
      const externalAttendees = attendees.filter(a =>
        a.email && !internalDomains.some(d => a.email.endsWith('@' + d))
      );
      const isExternal = externalAttendees.length > 0;

      return {
        id: event.id,
        title: event.summary || '(No title)',
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        attendees: attendees.map(a => ({
          name: a.displayName || a.email.split('@')[0],
          email: a.email,
          status: a.responseStatus,
        })),
        externalAttendees: externalAttendees.map(a => ({
          name: a.displayName || a.email.split('@')[0],
          email: a.email,
          company: a.email.split('@')[1]?.split('.')[0],
        })),
        external: isExternal,
        location: event.location || '',
        meetLink: event.hangoutLink || '',
        description: event.description || '',
        htmlLink: event.htmlLink,
      };
    });

    return res.status(200).json({
      success: true,
      meetings,
      externalCount: meetings.filter(m => m.external).length,
      totalCount: meetings.length,
    });
  } catch (err) {
    console.error('Calendar error:', err);
    return res.status(500).json({ error: 'Calendar fetch failed' });
  }
}
