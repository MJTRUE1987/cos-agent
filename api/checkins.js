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
  const membersMap = Object.fromEntries(data.members.map(m => [m.id, m]));

  let checkins = data.checkins
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(c => ({
      ...c,
      memberName: membersMap[c.memberId]?.name || 'Unknown'
    }));

  const { limit } = req.query || {};
  if (limit) {
    checkins = checkins.slice(0, parseInt(limit, 10));
  }

  res.json({ checkins });
};
