const axios = require('axios');

const MIN_MS = 60 * 1000;
const EARTH_RADIUS_M = 6371000;

// Read lazily so dotenv has a chance to load first.
function config() {
  return {
    // Pedestrian routing by default (FOSSGIS OSRM foot server). The public
    // router.project-osrm.org demo only does driving, which badly underestimates walks.
    baseUrl: process.env.OSRM_BASE_URL || 'https://routing.openstreetmap.de/routed-foot',
    profile: process.env.OSRM_PROFILE || 'foot',
    timeoutMs: Number(process.env.OSRM_TIMEOUT_MS) || 8000,
    // Used only when OSRM is unreachable: walking speed and a detour factor for street grids.
    fallbackSpeedMps: Number(process.env.FALLBACK_SPEED_MPS) || 1.4,
    fallbackDetour: 1.3,
  };
}

// Accepts [lng, lat], { lng, lat }, or anything with a `coordinates: [lng, lat]` field.
function toLngLat(point, label) {
  const c = Array.isArray(point)
    ? point
    : point && Array.isArray(point.coordinates)
      ? point.coordinates
      : point && point.lng != null && point.lat != null
        ? [point.lng, point.lat]
        : null;
  if (!c || c.length < 2 || !Number.isFinite(+c[0]) || !Number.isFinite(+c[1])) {
    throw new TypeError(`${label} must be [lng, lat] or { lng, lat }`);
  }
  return [+c[0], +c[1]];
}

function parseTime(value, label) {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(t)) throw new TypeError(`${label} must be an ISO 8601 time`);
  return t;
}

const iso = (ms) => new Date(ms).toISOString();
const minutes = (ms) => Math.round(ms / MIN_MS);

function haversine([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// One OSRM request for the whole chain. The full overview geometry is split back into
// legs using the per-segment duration annotations (each leg contributes N segments).
async function fetchOsrmLegs(waypoints) {
  const { baseUrl, profile, timeoutMs } = config();
  const coords = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const url = `${baseUrl}/route/v1/${profile}/${coords}`;
  const { data } = await axios.get(url, {
    params: { overview: 'full', geometries: 'geojson', annotations: 'duration,distance' },
    timeout: timeoutMs,
  });
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(`OSRM returned ${data.code}: ${data.message || 'no route'}`);
  }

  const route = data.routes[0];
  const overview = route.geometry.coordinates;
  let cursor = 0;
  return route.legs.map((leg) => {
    const segmentDurations = leg.annotation.duration;
    const coordinates = overview.slice(cursor, cursor + segmentDurations.length + 1);
    cursor += segmentDurations.length;
    return { coordinates, segmentDurations, durationSec: leg.duration, distanceM: leg.distance };
  });
}

// Straight-line estimate so the demo keeps working without network access.
function estimateLegs(waypoints) {
  const { fallbackSpeedMps, fallbackDetour } = config();
  return waypoints.slice(1).map((to, i) => {
    const from = waypoints[i];
    const distanceM = haversine(from, to) * fallbackDetour;
    const durationSec = distanceM / fallbackSpeedMps;
    return { coordinates: [from, to], segmentDurations: [durationSec], durationSec, distanceM };
  });
}

async function getLegs(waypoints) {
  try {
    return { legs: await fetchOsrmLegs(waypoints), source: 'osrm' };
  } catch (err) {
    console.warn(`[routingEngine] OSRM unavailable (${err.message}); using straight-line estimate`);
    return { legs: estimateLegs(waypoints), source: 'estimate' };
  }
}

/**
 * Build a chronological "Time Chain": start -> selected events (ordered by startTime) -> end.
 *
 * The chain is valid only when every event is reached before it ends and
 * transit + event time + transit to the destination finishes strictly before maxEndTime.
 *
 * @param startPoint     [lng, lat] | { lng, lat }
 * @param endPoint       [lng, lat] | { lng, lat }
 * @param maxEndTime     ISO string: latest allowed arrival at endPoint
 * @param selectedEvents events from data/events.json; an optional `dwellMinutes` caps time spent at that event
 * @param options.departureTime   ISO string, defaults to now
 * @param options.maxDwellMinutes cap time spent at any event (default: stay until it ends)
 * @returns {{ feasible, violations, routingSource, summary, geojson }}
 *   geojson is a FeatureCollection: one LineString (properties.coordTimes holds an ISO
 *   timestamp for every vertex) followed by one Point per node with its ETA.
 */
async function calculateTimeChain(startPoint, endPoint, maxEndTime, selectedEvents = [], options = {}) {
  const origin = toLngLat(startPoint, 'startPoint');
  const destination = toLngLat(endPoint, 'endPoint');
  const deadline = parseTime(maxEndTime, 'maxEndTime');
  const departure = options.departureTime ? parseTime(options.departureTime, 'departureTime') : Date.now();

  const events = [...selectedEvents]
    .map((e) => ({ ...e, _start: parseTime(e.startTime, `${e.id}.startTime`), _end: parseTime(e.endTime, `${e.id}.endTime`) }))
    .sort((a, b) => a._start - b._start);

  const waypoints = [origin, ...events.map((e) => toLngLat(e.coordinates, `${e.id}.coordinates`)), destination];
  const { legs, source } = await getLegs(waypoints);

  const violations = [];
  const lineCoords = [];
  const coordTimes = [];
  const nodeFeatures = [];
  let clock = departure;
  let totalTransitMs = 0;
  let totalEventMs = 0;
  let totalWaitMs = 0;
  let totalDistanceM = 0;

  const addNode = (coordinates, properties) =>
    nodeFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { order: nodeFeatures.length, ...properties } });

  addNode(origin, { kind: 'origin', departure: iso(departure) });

  legs.forEach((leg, i) => {
    // Timestamp every vertex of this leg. The leg's first vertex is the previous node,
    // which already has an arrival time; we add it again with the departure time so the
    // line "pauses" there for the wait and the event.
    let t = clock;
    leg.coordinates.forEach((coord, j) => {
      if (j > 0) t += leg.segmentDurations[j - 1] * 1000;
      lineCoords.push(coord);
      coordTimes.push(iso(t));
    });

    const legInfo = { durationMin: minutes(leg.durationSec * 1000), distanceM: Math.round(leg.distanceM) };
    const arrival = clock + leg.durationSec * 1000;
    totalTransitMs += leg.durationSec * 1000;
    totalDistanceM += leg.distanceM;

    const event = events[i];
    if (!event) {
      addNode(destination, { kind: 'destination', eta: iso(arrival), legFromPrevious: legInfo });
      clock = arrival;
      return;
    }

    if (arrival >= event._end) {
      violations.push({
        eventId: event.id,
        type: 'MISSED_EVENT',
        message: `Arrives at "${event.title}" ${minutes(arrival - event._end)} min after it ends`,
      });
      addNode(lineCoords[lineCoords.length - 1], {
        kind: 'event', eventId: event.id, title: event.title, eta: iso(arrival), departure: iso(arrival), missed: true, legFromPrevious: legInfo,
      });
      clock = arrival;
      return;
    }

    const attendStart = Math.max(arrival, event._start);
    const dwellCap = event.dwellMinutes ?? options.maxDwellMinutes;
    const attendEnd = dwellCap != null ? Math.min(event._end, attendStart + dwellCap * MIN_MS) : event._end;

    totalWaitMs += attendStart - arrival;
    totalEventMs += attendEnd - attendStart;

    addNode(toLngLat(event.coordinates), {
      kind: 'event',
      eventId: event.id,
      title: event.title,
      price: event.price,
      eta: iso(arrival),
      attendStart: iso(attendStart),
      departure: iso(attendEnd),
      waitMin: minutes(attendStart - arrival),
      dwellMin: minutes(attendEnd - attendStart),
      legFromPrevious: legInfo,
    });
    clock = attendEnd;
  });

  const finalArrival = clock;
  if (finalArrival >= deadline) {
    violations.push({
      type: 'EXCEEDS_MAX_END_TIME',
      message: `Reaches destination at ${iso(finalArrival)}, ${minutes(finalArrival - deadline)} min past maxEndTime`,
    });
  }

  return {
    feasible: violations.length === 0,
    violations,
    routingSource: source,
    summary: {
      departure: iso(departure),
      arrival: iso(finalArrival),
      maxEndTime: iso(deadline),
      slackMin: minutes(deadline - finalArrival),
      totalDistanceM: Math.round(totalDistanceM),
      totalTransitMin: minutes(totalTransitMs),
      totalEventMin: minutes(totalEventMs),
      totalWaitMin: minutes(totalWaitMs),
    },
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: lineCoords },
          properties: { kind: 'timeChain', coordTimes },
        },
        ...nodeFeatures,
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Spatio-temporal detours: events you can catch on the way from start to end.
// ---------------------------------------------------------------------------

// Walking times don't change over the night, so cache them per start/end pair. Moving
// the time or budget sliders then needs no new OSRM calls.
const MATRIX_TTL_MS = 30 * MIN_MS;
const matrixCache = new Map(); // "start|end" -> { at, baseSec, to: Map(id->sec), from: Map(id->sec) }
let tableBackoffUntil = 0; // after a 429 from the public server, rest for a bit

/**
 * Walking seconds start->end, start->event and event->end for each event, via one
 * OSRM table call for whatever isn't cached yet. Falls back to straight-line
 * estimates (not cached) if the table service is slow, rate-limited or down.
 */
async function detourMatrix(start, end, events) {
  const { baseUrl, profile, fallbackSpeedMps, fallbackDetour } = config();
  const key = `${start.map((n) => n.toFixed(5))}|${end.map((n) => n.toFixed(5))}`;
  let entry = matrixCache.get(key);
  if (entry && Date.now() - entry.at > MATRIX_TTL_MS) entry = null;
  const missing = events.filter((e) => !entry || !entry.to.has(e.id));

  let source = 'osrm';
  if (!entry || missing.length) {
    try {
      if (Date.now() < tableBackoffUntil) throw new Error('backing off after a rate limit');
      const points = [start, end, ...missing.map((e) => toLngLat(e.coordinates, e.id))];
      const idx = missing.map((_, i) => i + 2);
      const coords = points.map(([lng, lat]) => `${lng},${lat}`).join(';');
      const { data } = await axios.get(`${baseUrl}/table/v1/${profile}/${coords}`, {
        params: { sources: [0, ...idx].join(';'), destinations: [1, ...idx].join(';'), annotations: 'duration' },
        timeout: Number(process.env.OSRM_TABLE_TIMEOUT_MS) || 5000,
      });
      if (data.code !== 'Ok') throw new Error(`OSRM table returned ${data.code}`);
      const d = data.durations; // rows: start, events; cols: end, events
      entry = entry || { at: Date.now(), baseSec: d[0][0], to: new Map(), from: new Map() };
      missing.forEach((e, i) => {
        entry.to.set(e.id, d[0][i + 1]);
        entry.from.set(e.id, d[i + 1][0]);
      });
      matrixCache.set(key, entry);
    } catch (err) {
      if (err.response?.status === 429) tableBackoffUntil = Date.now() + 30000;
      console.warn(`[routingEngine] OSRM table unavailable (${err.message}); using straight-line estimate`);
      source = 'estimate';
    }
  }

  const sec = (a, b) => (haversine(a, b) * fallbackDetour) / fallbackSpeedMps;
  const pick = (map, e, fallback) => (map?.has(e.id) ? map.get(e.id) : fallback);
  return {
    source,
    baseSec: entry ? entry.baseSec : sec(start, end),
    toEvent: events.map((e) => pick(entry?.to, e, sec(start, e.coordinates))),
    fromEvent: events.map((e) => pick(entry?.from, e, sec(e.coordinates, end))),
  };
}

/**
 * Rank events worth a detour on the walk from `start` to `end`.
 *  - affordable: price <= currentBalance * budgetPercent / 100
 *  - on time: arriving straight from start lands inside the event's window
 *  - score = price + extra walking minutes (lower is better)
 * @returns {{ base, budget, detours, routingSource }}
 */
async function findDetours({ start, end, departureTime, currentBalance, budgetPercent = 10, events, excludeIds = [], limit = 3 }) {
  const origin = toLngLat(start, 'start');
  const destination = toLngLat(end, 'end');
  const departure = departureTime ? parseTime(departureTime, 'departureTime') : Date.now();
  if (!Number.isFinite(currentBalance) || currentBalance < 0) throw new TypeError('currentBalance must be a non-negative number');
  if (!Number.isFinite(budgetPercent) || budgetPercent < 0 || budgetPercent > 100) throw new TypeError('budgetPercent must be between 0 and 100');

  const cap = Math.round(currentBalance * budgetPercent) / 100;

  // Cheap straight-line pass first, so the OSRM table only sees plausible events
  // (big tables are slow on the public server): roughly on time and roughly on the way.
  const { fallbackSpeedMps, fallbackDetour } = config();
  const estMin = (a, b) => (haversine(a, b) * fallbackDetour) / fallbackSpeedMps / 60;
  const estBase = estMin(origin, destination);
  const SLACK_MS = 20 * MIN_MS;
  const affordable = events
    .filter((e) => e.price <= cap && !excludeIds.includes(e.id))
    .map((e) => {
      const to = estMin(origin, e.coordinates);
      return { e, to, extra: to + estMin(e.coordinates, destination) - estBase };
    })
    .filter(({ e, to, extra }) => {
      const arrival = departure + to * MIN_MS;
      return extra <= 45 && arrival >= Date.parse(e.startTime) - SLACK_MS && arrival <= Date.parse(e.endTime) + SLACK_MS;
    })
    .sort((a, b) => a.extra - b.extra)
    .slice(0, 20)
    .map(({ e }) => e);
  const m = await detourMatrix(origin, destination, affordable);
  const baseMin = m.baseSec / 60;

  const detours = affordable
    .map((e, i) => {
      if (m.toEvent[i] == null || m.fromEvent[i] == null) return null; // unroutable
      const timeToEventMins = m.toEvent[i] / 60;
      const timeFromEventMins = m.fromEvent[i] / 60;
      const extraDetourMins = Math.max(0, timeToEventMins + timeFromEventMins - baseMin);
      const arrival = departure + m.toEvent[i] * 1000;
      if (arrival < Date.parse(e.startTime) || arrival > Date.parse(e.endTime)) return null;
      return {
        event: e,
        timeToEventMins: Math.round(timeToEventMins),
        timeFromEventMins: Math.round(timeFromEventMins),
        extraDetourMins: Math.round(extraDetourMins),
        estimatedArrival: iso(arrival),
        score: Math.round((e.price + extraDetourMins) * 10) / 10,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);

  return {
    base: { durationMin: Math.round(baseMin), departure: iso(departure), arrival: iso(departure + m.baseSec * 1000) },
    budget: { percent: budgetPercent, limit: cap, balance: currentBalance },
    detours,
    considered: affordable.length,
    routingSource: m.source,
  };
}

module.exports = { calculateTimeChain, findDetours, haversine };
