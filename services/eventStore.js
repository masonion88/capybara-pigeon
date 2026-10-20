const fs = require('fs');
const path = require('path');

const EVENTS_PATH = path.join(__dirname, '..', 'data', 'events.json');
const DAY_MS = 24 * 60 * 60 * 1000;

// The mock data is authored for one fixed evening. To keep the demo working on
// any day, shift every event so the earliest one lands on "today" (local time).
function rebaseToToday(events) {
  if (!events.length) return events;
  const earliest = new Date(Math.min(...events.map((e) => Date.parse(e.startTime))));
  const baseDay = new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = Math.round((today - baseDay) / DAY_MS) * DAY_MS;

  return events.map((e) => ({
    ...e,
    startTime: new Date(Date.parse(e.startTime) + offset).toISOString(),
    endTime: new Date(Date.parse(e.endTime) + offset).toISOString(),
  }));
}

function loadEvents() {
  const raw = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
  return process.env.REBASE_EVENTS === 'false' ? raw : rebaseToToday(raw);
}

// Events active at a given instant: startTime <= t < endTime.
function eventsActiveAt(events, time) {
  const t = new Date(time).getTime();
  return events.filter((e) => Date.parse(e.startTime) <= t && t < Date.parse(e.endTime));
}

module.exports = { loadEvents, eventsActiveAt };
