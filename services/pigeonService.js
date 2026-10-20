// The pigeon's alert brain. It decides when a text is worth sending, remembers what it
// already suggested, understands replies ("yes" adds the stop, "no" skips it), and keeps
// every open copy of the app in the loop over a server-sent event stream.
//
// Each person is known by their phone number. An app starts out on the default number
// (MY_PHONE_NUMBER, if set) and can switch to its user's own number. Photon's shared
// line can only text someone who has texted it first, so joining works that way round:
// the app hands the user a ready-made "JOIN 1234" text to send to their pigeon line.
// Receiving it both opts them in with Photon and proves the number is theirs.
//
// Tonight's list lives in the app, not on the server, so a "yes" is handed to one open
// app, which adds (and pays for) the stop and reports back before the pigeon answers.

const crypto = require('crypto');
const { runPitStopAgent } = require('./agentService');
const photon = require('./photonService');

const AUTO_GAP_MS = Number(process.env.PIGEON_MIN_GAP_MS) || 60 * 1000; // quiet time between unprompted texts
const ACK_WAIT_MS = 7000; // how long to wait for the app to confirm an add
const TIME_ZONE = process.env.DISPLAY_TZ || 'America/New_York';
const CODE_TTL_MS = 10 * 60 * 1000;
const CODES_PER_NUMBER = 3; // per CODE_TTL_MS, per number
const CODES_PER_HOUR = 30; // across everyone
const DEMO = 'demo'; // stand-in "number" when there's no real one to text

const users = new Map(); // phone -> { phone, enabled, busy, texted, skipped, tip, lastTextAt, context, owner }
const sessions = new Map(); // clientId -> phone that app's user verified
const pending = new Map(); // clientId -> { phone, code, at } waiting for their JOIN text
const codeTimes = []; // { phone, at } for rate limits
const clients = new Map(); // clientId -> { res, since }
const waiting = new Map(); // add request id -> resolver
const backlog = []; // { phone, request } add requests made while that user had no app open

const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
const phoneFor = (clientId) => sessions.get(clientId) || photon.defaultNumber() || DEMO;

function userAt(phone) {
  if (!users.has(phone)) {
    users.set(phone, { phone, handles: new Set(), enabled: false, busy: false, texted: new Set(), skipped: new Set(), tip: null, lastTextAt: 0, context: null, owner: null });
  }
  return users.get(phone);
}
const userFor = (clientId) => userAt(phoneFor(clientId));

// Who a reply is from: someone who verified their number, or the default number.
function userByHandle(handle) {
  for (const user of users.values()) {
    if (photon.sameHandle(user.phone, handle) || [...user.handles].some((h) => photon.sameHandle(h, handle))) return user;
  }
  for (const phone of sessions.values()) if (photon.sameHandle(phone, handle)) return userAt(phone);
  const fallback = photon.defaultNumber();
  return fallback && photon.sameHandle(fallback, handle) ? userAt(fallback) : null;
}
/** Should the pigeon read this message at all? Yes if it knows the sender, or it carries a live JOIN code. */
const accepts = (handle, incoming) => Boolean(userByHandle(handle) || findJoin(incoming));

function status(clientId) {
  const user = userFor(clientId);
  return { live: photon.isLive(), to: user.phone === DEMO ? null : photon.maskPhone(user.phone), own: sessions.has(clientId), enabled: user.enabled };
}

// ---------------------------------------------------------------------------
// Live stream to the app(s)
// ---------------------------------------------------------------------------
const write = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
const clientsOf = (user) => [...clients.keys()].filter((id) => phoneFor(id) === user.phone);

function emitTo(user, type, data, onlyClientId) {
  for (const id of clientsOf(user)) {
    if (!onlyClientId || id === onlyClientId) write(clients.get(id).res, type, typeof data === 'function' ? data(id) : data);
  }
}

/** Open an event stream for one copy of the app. Returns a function that closes it. */
function subscribe(clientId, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.set(clientId, { res, since: Date.now() });
  write(res, 'hello', status(clientId));
  flushBacklog(clientId);
  const heartbeat = setInterval(() => res.write(': coo\n\n'), 25000);
  return () => {
    clearInterval(heartbeat);
    if (clients.get(clientId)?.res === res) clients.delete(clientId);
  };
}

function flushBacklog(clientId) {
  const phone = phoneFor(clientId);
  for (let i = backlog.length - 1; i >= 0; i--) {
    if (backlog[i].phone !== phone) continue;
    write(clients.get(clientId).res, 'add', backlog[i].request);
    backlog.splice(i, 1);
  }
}

// Exactly one of a person's open apps handles an "add" (two would pay twice): the one
// that last asked for alerts, or failing that the most recently opened.
function pickClient(user) {
  const mine = clientsOf(user);
  if (user.owner && mine.includes(user.owner)) return user.owner;
  return mine.sort((a, b) => clients.get(b).since - clients.get(a).since)[0] || null;
}

function requestAdd(user, event) {
  const request = { id: crypto.randomUUID(), eventId: event.id, title: event.title };
  const target = pickClient(user);
  if (!target) {
    backlog.push({ phone: user.phone, request });
    return Promise.resolve({ ok: null, queued: true });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(request.id);
      resolve({ ok: null });
    }, ACK_WAIT_MS);
    waiting.set(request.id, (result) => {
      clearTimeout(timer);
      waiting.delete(request.id);
      resolve(result);
    });
    emitTo(user, 'add', request, target);
  });
}

/** The app reports whether it managed to add (and pay for) a requested stop. */
function ack(id, { ok, reason } = {}) {
  waiting.get(id)?.({ ok: Boolean(ok), reason: reason ? String(reason).slice(0, 160) : '' });
}

// ---------------------------------------------------------------------------
// Using your own number
// ---------------------------------------------------------------------------
const fail = (message) => Object.assign(new Error(message), { expected: true });

/**
 * Someone typed in their number. Add it to the Photon project and hand back a
 * ready-made "JOIN 1234" text for them to send to their pigeon line.
 */
async function requestJoin(clientId, rawPhone) {
  const phone = photon.toE164(String(rawPhone || ''));
  if (!/^\+\d{10,15}$/.test(phone)) throw fail("That doesn't look like a mobile number. Include the area code.");

  const now = Date.now();
  while (codeTimes.length && now - codeTimes[0].at > 60 * 60 * 1000) codeTimes.shift();
  if (codeTimes.length >= CODES_PER_HOUR) throw fail('The pigeon is run off its feet right now. Try again in a little while.');
  if (codeTimes.filter((c) => c.phone === phone && now - c.at < CODE_TTL_MS).length >= CODES_PER_NUMBER) {
    throw fail('That number was just set up a few times. Give it a few minutes.');
  }
  codeTimes.push({ phone, at: now });

  // Photon's shared line only talks to users of the project, so add this number first.
  // (It's harmless if the number is already there.)
  const joined = await photon.registerUser(phone);
  if (!joined.ok) throw fail(`Couldn't set up texts for ${photon.maskPhone(phone)}: ${joined.reason}.`);

  let code;
  do code = String(crypto.randomInt(1000, 10000));
  while ([...pending.values()].some((p) => p.code === code));
  pending.set(clientId, { phone, code, at: now });
  const joinText = `Hi pigeon! JOIN ${code}`;
  return {
    to: photon.maskPhone(phone),
    joinText,
    // Opens Messages on a text to this user's pigeon line, with the JOIN text filled in.
    joinUrl: joined.joinUrl ? `${joined.joinUrl}?msg=${encodeURIComponent(joinText)}` : null,
    demo: Boolean(joined.mocked),
  };
}

// A message carrying a JOIN code someone is waiting on: { clientId, phone, code }.
function findJoin(incoming) {
  const code = incoming?.kind === 'text' ? /\bjoin\W*(\d{4})\b/i.exec(String(incoming.text || ''))?.[1] : null;
  if (!code) return null;
  for (const [clientId, wait] of pending) {
    if (wait.code === code && Date.now() - wait.at <= CODE_TTL_MS) return { clientId, ...wait };
  }
  return null;
}

// Their JOIN text arrived: that app's texts go to their number from now on.
function completeJoin({ clientId, phone }, from) {
  pending.delete(clientId);
  sessions.set(clientId, phone);
  const user = userAt(phone);
  user.owner = clientId;
  // Apple sometimes sends from a handle other than the number typed in; remember it so
  // their replies are recognised.
  if (from && !photon.sameHandle(from, phone)) user.handles.add(from);
  const app = clients.get(clientId);
  if (app) write(app.res, 'joined', status(clientId));
  console.log(`[pigeonService] ${photon.maskPhone(phone)} joined`);
  return "Coo! You're in. I'll text you here when something fun is starting near you. Reply NEARBY any time for a tip.";
}

/** Go back to the default number. */
function forgetNumber(clientId) {
  sessions.delete(clientId);
  pending.delete(clientId);
  return status(clientId);
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
function setEnabled(on, clientId, user = userFor(clientId)) {
  user.enabled = Boolean(on);
  if (clientId) user.owner = clientId;
  emitTo(user, 'alerts', (id) => status(id));
  return clientId ? status(clientId) : null;
}

/** Forget everything (demo reset): no pending tips, nothing skipped, automatic texts off. */
function reset() {
  for (const user of users.values()) {
    user.texted.clear();
    user.skipped.clear();
    user.tip = null;
    user.lastTextAt = 0;
    user.context = null;
    user.enabled = false;
    emitTo(user, 'alerts', (id) => status(id));
  }
}

/**
 * Look for a pit stop worth texting about, and text it to this app's user.
 * `auto` check-ins respect the on/off switch, never repeat an event, and keep a quiet
 * gap between texts; a manual "send me one now" always looks.
 */
async function suggest(ctx, { auto = false, clientId, fresh = false, user = userFor(clientId) } = {}) {
  user.context = ctx;
  if (clientId) user.owner = clientId;
  if (auto) {
    if (!user.enabled) return { success: true, pitStop: null, skipped: 'off' };
    if (user.busy) return { success: true, pitStop: null, skipped: 'busy' };
    if (Date.now() - user.lastTextAt < AUTO_GAP_MS) return { success: true, pitStop: null, skipped: 'cooldown' };
  }
  const repeatsToo = auto || fresh ? user.texted : [];
  const excludeIds = [...new Set([...(ctx.excludeIds || []), ...user.skipped, ...repeatsToo])];

  if (auto) user.busy = true;
  try {
    const result = await runPitStopAgent({ ...ctx, excludeIds, to: user.phone === DEMO ? undefined : user.phone });
    if (result.pitStop) {
      user.tip = { event: result.pitStop, answered: null };
      user.texted.add(result.pitStop.id);
      if (result.delivery?.delivered) user.lastTextAt = Date.now();
    }
    return result;
  } finally {
    if (auto) user.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------
const YES = /^(y|ya|ye|yes|yea|yeah|yep|yup|sure|ok|okay|k|kk|bet|add|please|lets go|let's go|im in|i'm in|do it)\b/;
const NO = /^(n|no|nah|nope|skip|pass|not now|maybe later)\b/;
const PAUSE = /^(stop|pause|quiet|mute|unsubscribe)\b/;
const RESUME = /^(start|resume|unmute|unpause|subscribe)\b/;
const NEARBY = /(nearby|near me|around|what'?s (on|up|good|happening)|anything|another|something else|more|next)/;
const YES_TAPS = ['❤', '👍', '‼'];
const NO_TAPS = ['👎'];
const HELP = "Coo! Reply YES to add my last tip to tonight, NO to skip it, NEARBY for a fresh tip, or PAUSE and I'll stay quiet.";

async function acceptTip(user) {
  const tip = user.tip;
  if (!tip || tip.answered) return "Nothing's waiting on you right now. Text NEARBY and I'll take a look around.";
  tip.answered = 'yes';
  const e = tip.event;
  const result = await requestAdd(user, e);
  if (result.ok === true) {
    const paid = e.price > 0 ? ` and the $${e.price} cover is paid` : '';
    const now = user.context?.currentTime ? Date.parse(user.context.currentTime) : Date.now();
    const seeYou = Date.parse(e.startTime) > now ? `See you at ${clock(e.startTime)}!` : 'See you there!';
    return `Done! ${e.title} is on tonight's list${paid}. ${seeYou}`;
  }
  if (result.ok === false) {
    tip.answered = null; // let them try again
    return `Hmm, I couldn't add ${e.title}${result.reason ? `: ${result.reason}` : ''}.`;
  }
  return result.queued
    ? `Got it! ${e.title} will be waiting on tonight's list when you open Capybara Pigeon.`
    : `Got it! Adding ${e.title} to tonight's list now.`;
}

function skipTip(user) {
  const tip = user.tip;
  if (!tip || tip.answered) return "No problem! Text NEARBY whenever you'd like a tip.";
  tip.answered = 'no';
  user.skipped.add(tip.event.id);
  return "No worries, I'll skip that one and keep an eye out.";
}

async function lookAround(user) {
  if (!user.context) return 'Open Capybara Pigeon first so I know where you are, then ask me again.';
  const result = await suggest(user.context, { fresh: true, user });
  if (!result.pitStop) return "Nothing new is starting near you right now. I'll keep looking!";
  emitTo(user, 'alert', result); // the tip itself was just texted; show it in the app too
  return null;
}

function decide(user, incoming) {
  if (incoming.kind === 'reaction') {
    const emoji = String(incoming.emoji || '');
    if (YES_TAPS.some((t) => emoji.includes(t))) return acceptTip(user);
    if (NO_TAPS.some((t) => emoji.includes(t))) return skipTip(user);
    return null; // a laugh or a question mark doesn't need an answer
  }
  const said = String(incoming.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!said) return null;
  if (YES.test(said)) return acceptTip(user);
  if (NO.test(said)) return skipTip(user);
  if (PAUSE.test(said)) {
    setEnabled(false, null, user);
    return "Okay, I'll stay quiet. Text RESUME when you'd like tips again.";
  }
  if (RESUME.test(said)) {
    setEnabled(true, null, user);
    return "I'm back on lookout! I'll text when something fun is starting near you.";
  }
  if (NEARBY.test(said)) return lookAround(user);
  return HELP;
}

/**
 * A reply came in. `from` is the sender's phone (live), or `clientId` names the app
 * pretending to reply (demo mode). Returns what the pigeon texts back, or nothing.
 * That person's open apps mirror both sides of the conversation.
 */
async function handleIncoming(incoming, { from, clientId } = {}) {
  const joining = findJoin(incoming);
  if (joining) return completeJoin(joining, from);
  const user = from ? userByHandle(from) : userFor(clientId);
  if (!user) return null;
  emitTo(user, 'said', { text: incoming.kind === 'reaction' ? incoming.emoji : String(incoming.text || '') });
  let answer;
  try {
    answer = await decide(user, incoming);
  } catch (err) {
    console.warn(`[pigeonService] couldn't handle a reply: ${err.message}`);
    answer = 'Coo... I got a bit lost there. Try again in a moment?';
  }
  emitTo(user, 'answer', { text: answer || null }); // always sent, so the app can stop its typing dots
  return answer || null;
}

module.exports = { subscribe, ack, status, setEnabled, reset, suggest, handleIncoming, accepts, requestJoin, forgetNumber };
