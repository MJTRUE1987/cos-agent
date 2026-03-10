const fs = require('fs');
const path = require('path');

function loadData() {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', 'seed-data.json'), 'utf-8');
  return JSON.parse(raw);
}

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const data = loadData();
  const members = data.members;
  const events = data.events;
  const nextEvent = events.sort((a, b) => new Date(a.date) - new Date(b.date))[0];

  res.json({
    organization: data.organization,
    metrics: data.metrics,
    nextEvent: nextEvent || null,
    totalMembers: members.length,
    summary: {
      activeGroups: data.groups.length,
      upcomingEvents: events.length,
      recentCheckins: data.checkins.filter(c => {
        const d = new Date(c.date);
        const week = new Date();
        week.setDate(week.getDate() - 7);
        return d >= week;
      }).length
    }
  });
};
