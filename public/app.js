document.addEventListener('DOMContentLoaded', () => {
  Promise.all([
    fetch('/api/dashboard').then(r => r.json()),
    fetch('/api/events?upcoming=true').then(r => r.json()),
    fetch('/api/checkins?limit=5').then(r => r.json()),
    fetch('/api/groups').then(r => r.json())
  ]).then(([dashboard, events, checkins, groups]) => {
    renderHeader(dashboard);
    renderMetrics(dashboard);
    renderChart(dashboard.metrics);
    renderEvents(events.events);
    renderCheckins(checkins.checkins);
    renderGroups(groups.groups);
  }).catch(err => {
    console.error('Failed to load dashboard:', err);
  });
});

function renderHeader(data) {
  document.getElementById('org-name').textContent = data.organization.name;
  document.getElementById('org-motto').textContent = data.organization.motto;
}

function renderMetrics(data) {
  const m = data.metrics;
  const cards = [
    { value: m.weeklyAttendance[m.weeklyAttendance.length - 1], label: 'Last Sunday' },
    { value: data.totalMembers, label: 'Total Members' },
    { value: m.newMembersThisMonth, label: 'New This Month' },
    { value: m.activeGroups, label: 'Active Groups' },
    { value: Math.round(m.engagementRate * 100) + '%', label: 'Engagement' },
    { value: m.prayerRequests, label: 'Prayer Requests' },
    { value: m.volunteerHours, label: 'Volunteer Hours' }
  ];

  document.getElementById('metrics').innerHTML = cards.map(c =>
    '<div class="metric-card"><div class="value">' + c.value + '</div><div class="label">' + c.label + '</div></div>'
  ).join('');
}

function renderChart(metrics) {
  const data = metrics.weeklyAttendance;
  const labels = metrics.weekLabels;
  const max = Math.max(...data);
  const barWidth = 100 / data.length;
  const padding = barWidth * 0.2;

  let bars = '';
  data.forEach((val, i) => {
    const h = (val / max) * 140;
    const x = i * barWidth + padding;
    const w = barWidth - padding * 2;
    const y = 155 - h;
    bars += '<rect x="' + x + '%" y="' + y + '" width="' + w + '%" height="' + h + '" rx="4" fill="#1e3a5f" opacity="' + (i === data.length - 1 ? '1' : '0.6') + '"/>';
    bars += '<text x="' + (x + w / 2) + '%" y="175" text-anchor="middle" font-size="10" fill="#666">' + labels[i] + '</text>';
    bars += '<text x="' + (x + w / 2) + '%" y="' + (y - 5) + '" text-anchor="middle" font-size="11" font-weight="600" fill="#1e3a5f">' + val + '</text>';
  });

  document.getElementById('chart').innerHTML =
    '<svg viewBox="0 0 100 185" preserveAspectRatio="none" style="width:100%;height:100%">' +
    '<svg viewBox="0 0 100 185" width="100%" height="100%">' + bars + '</svg></svg>';
}

function renderEvents(events) {
  if (!events.length) {
    document.getElementById('events').innerHTML = '<p class="loading">No upcoming events</p>';
    return;
  }

  const rows = events.map(e => {
    const date = new Date(e.date + 'T00:00:00');
    const formatted = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return '<tr>' +
      '<td><strong>' + e.title + '</strong></td>' +
      '<td>' + formatted + '</td>' +
      '<td>' + e.time + '</td>' +
      '<td>' + e.location + '</td>' +
      '<td><span class="event-type type-' + e.type + '">' + e.type + '</span></td>' +
      '<td>' + e.expectedAttendance + '</td>' +
      '</tr>';
  }).join('');

  document.getElementById('events').innerHTML =
    '<table class="events-table"><thead><tr>' +
    '<th>Event</th><th>Date</th><th>Time</th><th>Location</th><th>Type</th><th>Expected</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderCheckins(checkins) {
  if (!checkins.length) {
    document.getElementById('checkins').innerHTML = '<p class="loading">No recent check-ins</p>';
    return;
  }

  const typeLabels = { attendance: 'Attended', prayer: 'Prayer', volunteer: 'Volunteered' };

  document.getElementById('checkins').innerHTML = checkins.map(c => {
    const initials = c.memberName.split(' ').map(n => n[0]).join('');
    const label = typeLabels[c.type] || c.type;
    const note = c.note ? ' — ' + c.note : '';
    return '<div class="checkin-item">' +
      '<div class="checkin-avatar">' + initials + '</div>' +
      '<div class="checkin-info">' +
      '<div class="name">' + c.memberName + '</div>' +
      '<div class="detail">' + label + note + ' &middot; ' + c.date + '</div>' +
      '</div></div>';
  }).join('');
}

function renderGroups(groups) {
  document.getElementById('groups').innerHTML = groups.map(g =>
    '<div class="group-card">' +
    '<h3>' + g.name + '</h3>' +
    '<div class="meta">' +
    '<strong>' + g.memberCount + '</strong> members<br>' +
    'Led by <strong>' + g.leaderName + '</strong><br>' +
    g.meetingDay + 's at ' + g.meetingTime +
    '</div></div>'
  ).join('');
}
