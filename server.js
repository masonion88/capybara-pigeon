require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { loadEvents, eventsActiveAt } = require('./services/eventStore');
const { calculateTimeChain, findDetours } = require('./services/routingEngine');
const { getUserBalance, filterAffordableEvents, payEventCover, refundTransfer, resetDemoAccount } = require('./services/nessieService');
const { curateConstellation } = require('./services/agentService');
const photon = require('./services/photonService');
const pigeon = require('./services/pigeonService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET /api/events             -> all events
// GET /api/events?time=<ISO>  -> only events happening at that instant
app.get('/api/events', (req, res) => {
  const events = loadEvents();
  if (req.query.time) {
    if (Number.isNaN(Date.parse(req.query.time))) {
      return res.status(400).json({ error: 'Invalid time; expected an ISO 8601 string' });
    }
    return res.json(eventsActiveAt(events, req.query.time));
  }
  res.json(events);
});

app.get('/api/events/:id', (req, res) => {
  const event = loadEvents().find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

// POST /api/route/timechain
// Body: { startPoint, endPoint, maxEndTime, eventIds: [], departureTime?, maxDwellMinutes? }
app.post('/api/route/timechain', async (req, res) => {
  const { startPoint, endPoint, maxEndTime, eventIds = [], departureTime, maxDwellMinutes } = req.body || {};
  const events = loadEvents();
  const selected = eventIds.map((id) => events.find((e) => e.id === id));
  const unknown = eventIds.filter((id, i) => !selected[i]);
  if (unknown.length) return res.status(400).json({ error: `Unknown event ids: ${unknown.join(', ')}` });

  try {
    const chain = await calculateTimeChain(startPoint, endPoint, maxEndTime, selected, { departureTime, maxDwellMinutes });
    res.json(chain);
  } catch (err) {
    const status = err instanceof TypeError ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/route/detours
// Body: { start: [lng, lat], end: [lng, lat], departureTime?: ISO, currentBalance?: number,
//         budgetPercent?: 0-100 (default 10), excludeIds?: string[] }
// Top 3 events you can catch on the way, ranked by price + extra walking minutes.
app.post('/api/route/detours', async (req, res) => {
  const { start, end, departureTime, currentBalance, budgetPercent = 10, excludeIds = [] } = req.body || {};
  try {
    // Default to the live Nessie balance when the client doesn't send one.
    const balance = Number.isFinite(currentBalance) ? currentBalance : (await getUserBalance()).balance;
    const result = await findDetours({
      start,
      end,
      departureTime,
      currentBalance: balance,
      budgetPercent: Number(budgetPercent),
      events: loadEvents(),
      excludeIds: Array.isArray(excludeIds) ? excludeIds : [],
    });
    res.json(result);
  } catch (err) {
    res.status(err instanceof TypeError ? 400 : 500).json({ error: err.message });
  }
});

// GET /api/radar/affordable[?time=<ISO>]
// Events the user's Nessie balance can cover (optionally only those happening at `time`).
app.get('/api/radar/affordable', async (req, res) => {
  if (req.query.time && Number.isNaN(Date.parse(req.query.time))) {
    return res.status(400).json({ error: 'Invalid time; expected an ISO 8601 string' });
  }
  const account = await getUserBalance();
  let events = loadEvents();
  if (req.query.time) events = eventsActiveAt(events, req.query.time);
  const affordable = filterAffordableEvents(events, account.balance);
  res.json({
    balance: account.balance,
    balanceSource: account.source,
    filteredOut: events.length - affordable.length,
    events: affordable,
  });
});

// POST /api/radar/pay  Body: { eventId }
// Pays the event's cover from the demo user's account to the organizer. The price
// comes from our event data, never from the client.
app.post('/api/radar/pay', async (req, res) => {
  const event = loadEvents().find((e) => e.id === req.body?.eventId);
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  if (event.price <= 0) {
    const account = await getUserBalance();
    return res.json({ ok: true, free: true, amount: 0, balance: account.balance, balanceSource: account.source });
  }

  const result = await payEventCover(
    process.env.NESSIE_CUSTOMER_ID,
    process.env.NESSIE_ORGANIZER_ACCOUNT_ID,
    event.price,
    `Cover: ${event.title} @ ${event.venue}`,
  );
  const account = await getUserBalance();
  res.status(result.ok ? 200 : 402).json({
    ...result,
    eventId: event.id,
    venue: event.venue,
    amount: event.price,
    balance: account.balance,
    balanceSource: account.source,
  });
});

// DELETE /api/radar/pay/:transferId  -> cancel a cover charge (refund)
app.delete('/api/radar/pay/:transferId', async (req, res) => {
  const result = await refundTransfer(req.params.transferId);
  const account = await getUserBalance();
  res.status(result.ok ? 200 : 502).json({ ...result, balance: account.balance, balanceSource: account.source });
});

const isLngLat = (p) => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite);

// Shared by the two pit-stop routes. Returns { error } or { ctx, clientId }.
// Body: { location: [lng, lat], destinationEta: ISO, interests: string[],
//         destination?: [lng, lat], currentTime?: ISO, excludeIds?: string[],
//         excludeCategories?: string[] (kinds of event never to text about),
//         textStyle?: string[] (how Gemini should write the text), clientId?: string }
function pitStopRequest(body) {
  const { location, destinationEta, interests = [], destination, currentTime, excludeIds = [], excludeCategories = [], textStyle = [], geminiBudgetMs, clientId } = body || {};
  if (!isLngLat(location)) return { error: 'location must be [lng, lat]' };
  if (destination != null && !isLngLat(destination)) return { error: 'destination must be [lng, lat]' };
  if (Number.isNaN(Date.parse(destinationEta))) return { error: 'destinationEta must be an ISO 8601 time' };
  if (currentTime != null && Number.isNaN(Date.parse(currentTime))) return { error: 'currentTime must be an ISO 8601 time' };
  if (!Array.isArray(interests) || !interests.every((i) => typeof i === 'string')) return { error: 'interests must be an array of strings' };
  if (!Array.isArray(excludeCategories) || !excludeCategories.every((c) => typeof c === 'string')) {
    return { error: 'excludeCategories must be an array of strings' };
  }
  if (!Array.isArray(textStyle) || !textStyle.every((s) => typeof s === 'string')) return { error: 'textStyle must be an array of strings' };
  return {
    clientId: typeof clientId === 'string' ? clientId.slice(0, 64) : undefined,
    ctx: {
      location,
      destinationEta,
      interests,
      destination,
      currentTime,
      excludeIds: Array.isArray(excludeIds) ? excludeIds : [],
      excludeCategories,
      // Free text that ends up in Gemini's prompt: one line each, kept short.
      textStyle: textStyle.map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 10),
      geminiBudgetMs: Number.isFinite(geminiBudgetMs) ? Math.max(1000, Math.min(geminiBudgetMs, 30000)) : undefined,
    },
  };
}

// POST /api/radar/pitstop -> "send me one now": always looks, and texts the best pit stop.
app.post('/api/radar/pitstop', async (req, res) => {
  const { error, ctx, clientId } = pitStopRequest(req.body);
  if (error) return res.status(400).json({ error });
  try {
    res.json(await pigeon.suggest(ctx, { clientId }));
  } catch (err) {
    console.error('[pitstop]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/photon/checkin -> the app reporting where the user is. Texts only when
// automatic alerts are on, something new is worth it, and the pigeon hasn't texted lately.
app.post('/api/photon/checkin', async (req, res) => {
  const { error, ctx, clientId } = pitStopRequest(req.body);
  if (error) return res.status(400).json({ error });
  try {
    res.json(await pigeon.suggest(ctx, { auto: true, clientId }));
  } catch (err) {
    console.error('[checkin]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/radar/constellation
// Body: { balance?: number, location?: [lng, lat], interests?: string[] }
// Gemini curates a 3-event night (6 PM – 1 AM) that fits the Nessie balance.
app.post('/api/radar/constellation', async (req, res) => {
  const { balance, location, interests = [], mustInclude = [] } = req.body || {};
  if (balance != null && !Number.isFinite(balance)) return res.status(400).json({ error: 'balance must be a number' });
  if (location != null && !isLngLat(location)) return res.status(400).json({ error: 'location must be [lng, lat]' });
  if (!Array.isArray(interests) || !interests.every((i) => typeof i === 'string')) {
    return res.status(400).json({ error: 'interests must be an array of strings' });
  }
  try {
    const result = await curateConstellation({ balance, location, interests, mustInclude: Array.isArray(mustInclude) ? mustInclude : [] });
    res.status(result.success ? 200 : 422).json(result);
  } catch (err) {
    console.error('[constellation]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/demo/reset -> cancel pending demo transfers so the balance starts fresh
app.post('/api/demo/reset', async (req, res) => {
  const result = await resetDemoAccount();
  pigeon.reset();
  const account = await getUserBalance();
  res.json({ ...result, balance: account.balance, balanceSource: account.source });
});

// ---- Pigeon alerts over Photon iMessage ----
// GET  /api/photon/status?client=<id>  -> { live, to, own, enabled } for that app's user
// POST /api/photon/number { clientId, phone } -> set that number up; returns the JOIN text
//                                               (and a link that opens it in Messages)
// POST /api/photon/forget { clientId }        -> go back to the default number
// POST /api/photon/alerts { enabled }  -> turn automatic texts on or off
// GET  /api/photon/stream?client=<id>  -> server-sent events: replies, add requests, alerts
// POST /api/photon/ack { id, ok, reason? } -> the app confirming a stop added by text reply
const clientIdOf = (value) => (typeof value === 'string' && value ? value.slice(0, 64) : undefined);

app.get('/api/photon/status', (req, res) => res.json(pigeon.status(clientIdOf(req.query.client))));

// Using your own number: you text a JOIN code to the pigeon from that phone, which both
// opts you in with Photon and proves the number is yours.
// Errors marked `expected` are things to tell the user (bad number, too many tries).
const numberStep = (step) => async (req, res) => {
  const clientId = clientIdOf(req.body?.clientId);
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  try {
    res.json(await step(clientId, req.body));
  } catch (err) {
    if (!err.expected) console.error('[photon number]', err);
    res.status(err.expected ? 400 : 500).json({ error: err.expected ? err.message : 'Something went wrong. Try again.' });
  }
};
app.post('/api/photon/number', numberStep((clientId, body) => pigeon.requestJoin(clientId, body.phone)));
app.post('/api/photon/forget', numberStep((clientId) => pigeon.forgetNumber(clientId)));

app.post('/api/photon/alerts', (req, res) => {
  const { enabled, clientId } = req.body || {};
  res.json(pigeon.setEnabled(enabled === true, clientIdOf(clientId)));
});

app.get('/api/photon/stream', (req, res) => {
  const clientId = String(req.query.client || '').slice(0, 64) || `anon-${Date.now()}`;
  req.on('close', pigeon.subscribe(clientId, res));
});

app.post('/api/photon/ack', (req, res) => {
  const { id, ok, reason } = req.body || {};
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
  pigeon.ack(id, { ok, reason });
  res.json({ ok: true });
});

// POST /api/photon/mock-reply { text } -> pretend the user texted back. Only when Photon
// isn't live (no keys), so the reply flow can be tried without a phone.
app.post('/api/photon/mock-reply', async (req, res) => {
  if (photon.isLive()) return res.status(403).json({ error: 'Photon is live: reply from your phone instead' });
  const text = String(req.body?.text || '').slice(0, 300);
  if (!text.trim()) return res.status(400).json({ error: 'text is required' });
  res.json({ reply: await pigeon.handleIncoming({ kind: 'text', text }, { clientId: clientIdOf(req.body?.clientId) }) });
});

const server = app.listen(PORT, () => {
  console.log(`Capybara Pigeon server running at http://localhost:${PORT}`);
  photon.warmUp();
  photon.startInbox((incoming, from) => pigeon.handleIncoming(incoming, { from }), pigeon.accepts);
});

// A busy port is the usual reason the server won't start: say so plainly.
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\nPort ${PORT} is already in use by another program, so Capybara Pigeon can't start there.`);
  console.error(`Close that program, or set PORT in .env to a free port (for example ${Number(PORT) + 1}) and run "npm start" again.\n`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await photon.shutdown();
    process.exit(0);
  });
}
