// Google Calendar Event Creation API
// Creates calendar events with video conferencing (Zoom or Google Meet)
// and sends invites to attendees

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { title, start, end, attendees, description, timezone, useZoom } = req.body || {};
  if (!title || !start) return res.status(400).json({ error: 'title and start are required' });

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
      console.error('[calendar-create] Google token refresh failed:', JSON.stringify(tokenData));
      return res.status(500).json({ error: `Failed to refresh Google token: ${tokenData.error_description || tokenData.error || 'unknown'}` });
    }

    const gcalHeaders = {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
    };

    // Calculate end time (default 30 min) if not provided
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + 30 * 60000);
    const tz = timezone || 'America/New_York';

    // Build attendees list
    const eventAttendees = (attendees || []).map(a => {
      if (typeof a === 'string') return { email: a };
      return { email: a.email, displayName: a.name || undefined };
    }).filter(a => a.email);

    // Build the event
    const event = {
      summary: title,
      description: description || '',
      start: { dateTime: startDate.toISOString(), timeZone: tz },
      end: { dateTime: endDate.toISOString(), timeZone: tz },
      attendees: eventAttendees,
      reminders: { useDefault: true },
      guestsCanModify: false,
      guestsCanInviteOthers: true,
      guestsCanSeeOtherGuests: true,
    };

    // Video conferencing setup
    let zoomLink = null;
    const zoomAccountId = process.env.ZOOM_ACCOUNT_ID;
    const zoomClientId = process.env.ZOOM_CLIENT_ID;
    const zoomClientSecret = process.env.ZOOM_CLIENT_SECRET;
    const zoomPmi = process.env.ZOOM_PMI_LINK; // Personal Meeting ID link fallback

    if (useZoom !== false && (zoomAccountId && zoomClientId && zoomClientSecret)) {
      // Create Zoom meeting via Server-to-Server OAuth
      zoomLink = await createZoomMeeting(title, startDate, 30, {
        zoomAccountId, zoomClientId, zoomClientSecret,
      });
    }

    if (zoomLink) {
      // Add Zoom link to calendar event
      event.location = zoomLink;
      event.description = (event.description ? event.description + '\n\n' : '') +
        `Join Zoom Meeting: ${zoomLink}`;
    } else if (zoomPmi) {
      // Fallback: use personal Zoom meeting link
      zoomLink = zoomPmi;
      event.location = zoomPmi;
      event.description = (event.description ? event.description + '\n\n' : '') +
        `Join Zoom Meeting: ${zoomPmi}`;
    } else {
      // No Zoom — use Google Meet
      event.conferenceData = {
        createRequest: {
          requestId: `cos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    // Create the event on Google Calendar
    const calUrl = zoomLink
      ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all'
      : 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1';

    const calRes = await fetch(calUrl, {
      method: 'POST',
      headers: gcalHeaders,
      body: JSON.stringify(event),
    });

    if (!calRes.ok) {
      const errText = await calRes.text();
      console.error('[calendar-create] Google Calendar API error:', errText);
      return res.status(calRes.status).json({
        error: `Calendar API error: ${errText}`,
        hint: calRes.status === 403
          ? 'Your Google OAuth token may need the calendar (read/write) scope. Re-authorize with scope: https://www.googleapis.com/auth/calendar'
          : undefined,
      });
    }

    const created = await calRes.json();

    // Extract meeting link
    const meetLink = zoomLink ||
      created.hangoutLink ||
      created.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri ||
      '';

    console.log(`[calendar-create] Event created: "${title}" at ${start} with ${eventAttendees.length} attendees, link=${meetLink}`);

    return res.status(200).json({
      success: true,
      eventId: created.id,
      htmlLink: created.htmlLink,
      meetLink,
      start: created.start,
      end: created.end,
      attendees: created.attendees?.map(a => ({ email: a.email, status: a.responseStatus })),
      conferenceType: zoomLink ? 'zoom' : 'google_meet',
    });
  } catch (err) {
    console.error('[calendar-create] Error:', err);
    return res.status(500).json({ error: 'Failed to create calendar event: ' + err.message });
  }
}

// Create a Zoom meeting via Server-to-Server OAuth
async function createZoomMeeting(topic, startTime, durationMinutes, creds) {
  try {
    // Get Zoom access token via Server-to-Server OAuth
    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${creds.zoomClientId}:${creds.zoomClientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'account_credentials',
        account_id: creds.zoomAccountId,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[zoom] Failed to get token:', tokenData);
      return null;
    }

    // Create meeting
    const meetingRes = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic,
        type: 2, // Scheduled meeting
        start_time: startTime.toISOString().replace('.000', ''),
        duration: durationMinutes,
        timezone: 'America/New_York',
        settings: {
          host_video: true,
          participant_video: true,
          join_before_host: true,
          waiting_room: false,
          auto_recording: 'none',
        },
      }),
    });

    if (!meetingRes.ok) {
      const errText = await meetingRes.text();
      console.error('[zoom] Meeting creation failed:', errText);
      return null;
    }

    const meeting = await meetingRes.json();
    console.log(`[zoom] Meeting created: ${meeting.join_url}`);
    return meeting.join_url;
  } catch (err) {
    console.error('[zoom] Error:', err);
    return null;
  }
}
