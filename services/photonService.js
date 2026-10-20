// Photon (Spectrum) iMessage delivery via the official `spectrum-ts` SDK.
//
// Live when PHOTON_PROJECT_ID (or SPECTRUM_PROJECT_ID) and PHOTON_PROJECT_SECRET (or
// SPECTRUM_PROJECT_SECRET) are set; otherwise it logs the message and reports a mock
// delivery so the demo still works.
// Texts go to MY_PHONE_NUMBER by default, or to a number the caller passes in. Callers
// (pigeonService) only pass numbers whose owner proved they hold them with a texted code,
// and only replies from those numbers are read or answered.

const axios = require('axios');

const SEND_TIMEOUT_MS = Number(process.env.PHOTON_TIMEOUT_MS) || 12000;
const CLOUD_API = process.env.PHOTON_API_URL || 'https://spectrum.photon.codes';
const INBOX_MAX_RETRIES = 5;

let clientPromise = null; // shared Spectrum app + iMessage platform
let inboxRunning = false;
let inboxRetries = 0;
let shuttingDown = false;

function config() {
  return {
    projectId: process.env.PHOTON_PROJECT_ID || process.env.SPECTRUM_PROJECT_ID,
    projectSecret: process.env.PHOTON_PROJECT_SECRET || process.env.SPECTRUM_PROJECT_SECRET,
    phone: process.env.MY_PHONE_NUMBER,
  };
}

const isLive = () => {
  const { projectId, projectSecret } = config();
  return Boolean(projectId && projectSecret);
};

/** The number texts go to when an app hasn't set its own (MY_PHONE_NUMBER), or null. */
const defaultNumber = () => (config().phone ? toE164(config().phone) : null);

// "+1 (607) 555-0123" -> "+16075550123". Bare 10-digit numbers are treated as US.
// iMessage handles can also be an Apple ID email, which is passed through as-is.
function toE164(phone) {
  if (String(phone).includes('@')) return String(phone).trim();
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

const maskPhone = (phone) =>
  String(phone).includes('@') ? String(phone).replace(/^(.).*@/, '$1•••@') : `•••${String(phone).replace(/\D/g, '').slice(-4)}`;

// Same person? Phone numbers match on their last 10 digits; Apple ID emails match exactly.
function sameHandle(a, b) {
  if (!a || !b) return false;
  const [x, y] = [String(a).trim().toLowerCase(), String(b).trim().toLowerCase()];
  if (x.includes('@') || y.includes('@')) return x === y;
  const [dx, dy] = [x.replace(/\D/g, '').slice(-10), y.replace(/\D/g, '').slice(-10)];
  return dx.length >= 7 && dx === dy;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// spectrum-ts is ESM-only, so load it with a dynamic import from this CommonJS module.
function getClient() {
  if (!clientPromise) {
    const { projectId, projectSecret } = config();
    clientPromise = (async () => {
      const { Spectrum } = await import('spectrum-ts');
      const { imessage } = await import('spectrum-ts/providers');
      const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
      return { app, im: imessage(app) };
    })().catch((err) => {
      clientPromise = null; // let the next send retry the connection
      throw err;
    });
  }
  return clientPromise;
}

/** Connect ahead of time so the first demo text isn't slowed by the handshake. */
function warmUp() {
  if (!isLive()) return;
  getClient()
    .then(() => console.log('[photonService] Spectrum iMessage client ready'))
    .catch((err) => console.warn(`[photonService] warm-up failed: ${err.message}`));
}

/**
 * Add a phone number to this Photon project's users, so the shared line is allowed to
 * text it (otherwise Photon answers "Target not allowed for this project").
 * Uses Spectrum Cloud's "Create user" call, which is safe to repeat for a number that's
 * already a user. No-op in mock mode.
 * @returns {{ ok: true, joinUrl?, optedIn? } | { ok: false, reason: string }}
 *   joinUrl opens the user's Messages app on a text to their pigeon line (Photon's
 *   redirect link); optedIn says whether they've already texted the line once.
 */
async function registerUser(phone) {
  if (!isLive()) return { ok: true, mocked: true };
  const { projectId, projectSecret } = config();
  try {
    const { data } = await axios.post(
      `${CLOUD_API}/projects/${projectId}/users/`,
      { type: 'shared', phoneNumber: toE164(phone) },
      { auth: { username: projectId, password: projectSecret }, timeout: SEND_TIMEOUT_MS },
    );
    const user = data?.data || {};
    console.log(`[photonService] ${maskPhone(phone)} is a user of the Photon project`);
    return { ok: true, joinUrl: user.id ? `${CLOUD_API}/users/${user.id}/redirect` : null, optedIn: Boolean(user.meta?.opt_in) };
  } catch (err) {
    const data = err.response?.data;
    const reason = (typeof data === 'string' ? data : data?.message || data?.error?.message || data?.error) || err.message;
    console.warn(`[photonService] couldn't add ${maskPhone(phone)} to the Photon project: HTTP ${err.response?.status || '?'} ${String(reason).slice(0, 200)}`);
    return { ok: false, reason: String(reason).slice(0, 140) };
  }
}

/**
 * Send an iMessage to `recipient`, or to MY_PHONE_NUMBER when none is given.
 * @returns {{ delivered, mocked, channel, to, sentAt, error? }}
 */
async function sendIMessage(text, recipient) {
  const sentAt = new Date().toISOString();
  if (!isLive()) {
    console.log(`[PHOTON iMESSAGE OUTBOUND (mock)]: ${text}`);
    return { delivered: true, mocked: true, channel: 'imessage', to: 'demo-user', sentAt };
  }
  if (!recipient && !config().phone) {
    return { delivered: false, mocked: false, channel: 'imessage', to: null, sentAt, error: 'No phone number to text yet' };
  }

  const to = toE164(recipient || config().phone);
  try {
    const { im } = await withTimeout(getClient(), SEND_TIMEOUT_MS, 'Spectrum connect');
    const space = await withTimeout(im.space.create(to), SEND_TIMEOUT_MS, 'Opening the DM');
    await withTimeout(space.send(text), SEND_TIMEOUT_MS, 'Sending');
    console.log(`[PHOTON iMESSAGE OUTBOUND -> ${maskPhone(to)}]: ${text}`);
    return { delivered: true, mocked: false, channel: 'imessage', to: maskPhone(to), sentAt };
  } catch (err) {
    console.warn(`[photonService] live send failed: ${err.message}`);
    return { delivered: false, mocked: false, channel: 'imessage', to: maskPhone(to), sentAt, error: err.message };
  }
}

// One reply from the owner's phone: read it, let the handler decide the answer, send it
// back in the same conversation (with a typing bubble while it thinks).
async function answerInbound(space, message, handler, accepts) {
  if (message.direction !== 'inbound') return;
  const content = message.content;
  const incoming =
    content?.type === 'text' ? { kind: 'text', text: content.text } : content?.type === 'reaction' ? { kind: 'reaction', emoji: content.emoji } : null;
  if (!incoming) return;
  // The SDK's sender id is the canonical handle (E.164 phone or Apple ID email).
  const handles = [message.sender?.id, message.sender?.address].filter(Boolean);
  const from = handles.find((handle) => accepts(handle, incoming));
  if (!from) {
    console.log(`[photonService] ignored a message from ${handles[0] ? maskPhone(handles[0]) : 'an unknown sender'} (not someone who has joined)`);
    return;
  }
  console.log(`[PHOTON iMESSAGE INBOUND <- ${maskPhone(from)}]: ${incoming.text || incoming.emoji}`);

  const respond = async () => {
    const answer = await handler(incoming, from);
    if (!answer) return;
    await withTimeout(space.send(answer), SEND_TIMEOUT_MS, 'Replying');
    console.log(`[PHOTON iMESSAGE OUTBOUND -> ${maskPhone(from)}]: ${answer}`);
  };
  if (typeof space.responding === 'function') await space.responding(respond);
  else await respond();
}

/**
 * Listen for iMessages sent back to the pigeon (live mode only).
 * `accepts(handle, incoming)` says whether the pigeon should read this message at all;
 * `handler({ kind: 'text', text } | { kind: 'reaction', emoji }, from)` resolves to the
 * reply text, or nothing to stay quiet.
 */
function startInbox(handler, accepts) {
  if (!isLive() || inboxRunning || shuttingDown) return;
  inboxRunning = true;
  (async () => {
    const { app } = await getClient();
    console.log('[photonService] listening for iMessage replies');
    for await (const [space, message] of app.messages) {
      inboxRetries = 0;
      answerInbound(space, message, handler, accepts).catch((err) => console.warn(`[photonService] couldn't answer a reply: ${err.message}`));
    }
  })()
    .catch((err) => console.warn(`[photonService] inbox stopped: ${err.message}`))
    .finally(() => {
      inboxRunning = false;
      if (shuttingDown || ++inboxRetries > INBOX_MAX_RETRIES) return;
      setTimeout(() => startInbox(handler, accepts), 5000 * inboxRetries).unref();
    });
}

async function shutdown() {
  shuttingDown = true;
  if (!clientPromise) return;
  try {
    const { app } = await clientPromise;
    await app.stop();
  } catch {
    // already closed or never connected
  }
}

module.exports = { sendIMessage, registerUser, startInbox, warmUp, shutdown, isLive, defaultNumber, toE164, maskPhone, sameHandle };
