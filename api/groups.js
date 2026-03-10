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

  const groups = data.groups.map(g => ({
    ...g,
    leaderName: membersMap[g.leaderId]?.name || 'Unknown'
  }));

  res.json({ groups });
};
