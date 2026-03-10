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
  let events = data.events.sort((a, b) => new Date(a.date) - new Date(b.date));

  const { upcoming } = req.query || {};
  if (upcoming === 'true') {
    const now = new Date();
    events = events.filter(e => new Date(e.date) >= now);
  }

  res.json({ events });
};
