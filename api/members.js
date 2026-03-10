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
  let members = data.members;

  const { role } = req.query || {};
  if (role) {
    members = members.filter(m => m.role.toLowerCase().includes(role.toLowerCase()));
  }

  res.json({ members });
};
