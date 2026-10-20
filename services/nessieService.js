const axios = require('axios');

// Read lazily so dotenv has a chance to load first.
function config() {
  return {
    baseUrl: process.env.NESSIE_BASE_URL || 'https://api.nessieisreal.com',
    apiKey: process.env.NESSIE_API_KEY,
    accountId: process.env.NESSIE_ACCOUNT_ID,
    fallbackBalance: Number(process.env.NESSIE_FALLBACK_BALANCE ?? 18),
    timeoutMs: Number(process.env.NESSIE_TIMEOUT_MS) || 6000,
  };
}

// Every request carries ?key=<NESSIE_API_KEY>.
function nessie() {
  const { baseUrl, apiKey, timeoutMs } = config();
  if (!apiKey) throw new Error('NESSIE_API_KEY is not set');
  return axios.create({ baseURL: baseUrl, params: { key: apiKey }, timeout: timeoutMs });
}

// Network failures, rate limits and 5xx are worth papering over for the demo.
// Other 4xx responses mean our request is wrong and should surface.
function isTransient(err) {
  const status = err.response?.status;
  return !status || status === 429 || status >= 500;
}

// Payments made while Nessie was unreachable, so the fallback balance still goes down.
const mockLedger = new Map(); // transferId -> amount
const mockSpent = () => [...mockLedger.values()].reduce((a, b) => a + b, 0);

function describeError(err) {
  if (!err.response) return err.message;
  const { status, data } = err.response;
  const detail = typeof data === 'string' ? data : data?.message || JSON.stringify(data);
  return `HTTP ${status}${status === 429 ? ' (rate limited)' : ''}: ${detail}`.slice(0, 300);
}

// Nessie keeps transfers "pending" without touching the balance, so subtract them
// ourselves to get what the user can actually spend.
async function pendingTransferTotal(api, accountId) {
  try {
    const { data } = await api.get(`/accounts/${accountId}/transfers`);
    return Array.isArray(data) ? data.filter((t) => t.status === 'pending').reduce((sum, t) => sum + Number(t.amount || 0), 0) : 0;
  } catch (err) {
    if (err.response?.status === 404) return 0; // "No transfers found for this account"
    throw err;
  }
}

/**
 * Fetch an account's spendable balance (posted balance minus pending transfers).
 * Never throws: if Nessie is down, rate-limits us, or isn't configured, it returns
 * the fallback balance so the demo keeps running.
 * @returns {{ accountId, balance, nickname?, source: 'nessie' | 'fallback', error? }}
 */
async function getUserBalance(accountId = config().accountId) {
  try {
    if (!accountId) throw new Error('No account id (run `npm run seed:nessie`)');
    const api = nessie();
    const [{ data }, pending] = await Promise.all([api.get(`/accounts/${accountId}`), pendingTransferTotal(api, accountId)]);
    const postedBalance = Number(data.balance);
    return { accountId, balance: postedBalance - pending, postedBalance, pending, nickname: data.nickname, source: 'nessie' };
  } catch (err) {
    const error = describeError(err);
    const balance = config().fallbackBalance - mockSpent();
    console.warn(`[nessieService] getUserBalance fell back to ${balance}: ${error}`);
    return { accountId: accountId || null, balance, source: 'fallback', error };
  }
}

// Keep only events the user can pay for (price <= balance).
function filterAffordableEvents(events, balance) {
  return events.filter((event) => event.price <= balance);
}

/**
 * Pay an event's cover charge from the customer's first account that can cover it.
 * The hackathon Nessie API has no payee field on transfers, so the organizer's
 * account id (`payeeId`) is recorded in the description.
 * Returns ok: false if funds are short or Nessie rejects the request; falls back to a
 * simulated receipt only when Nessie is unreachable, rate-limiting, or erroring (5xx).
 */
async function payEventCover(customerId, payeeId, amount, description = 'Capybara Pigeon event cover charge') {
  if (!(amount > 0)) throw new TypeError('amount must be a positive number');
  if (!payeeId) throw new TypeError('payeeId is required');

  try {
    const api = nessie();
    const { data: accounts } = await api.get(`/customers/${customerId}/accounts`);
    if (!Array.isArray(accounts) || !accounts.length) {
      return { ok: false, source: 'nessie', reason: 'NO_ACCOUNTS', message: `Customer ${customerId} has no accounts` };
    }
    let payer = null;
    for (const account of accounts) {
      const available = account.balance - (await pendingTransferTotal(api, account._id));
      if (available >= amount) { payer = account; break; }
    }
    if (!payer) {
      return { ok: false, source: 'nessie', reason: 'INSUFFICIENT_FUNDS', message: `No account for customer ${customerId} has $${amount}` };
    }

    const { data } = await api.post(`/accounts/${payer._id}/transfers`, {
      amount,
      transaction_date: new Date().toISOString().slice(0, 10),
      status: 'pending',
      description: `${description} -> payee ${payeeId}`,
    });
    return { ok: true, source: 'nessie', transfer: { ...data.objectCreated, payee_id: payeeId }, payerAccountId: payer._id };
  } catch (err) {
    const error = describeError(err);
    if (!isTransient(err)) {
      return { ok: false, source: 'nessie', reason: 'NESSIE_REJECTED', message: error };
    }
    console.warn(`[nessieService] payEventCover simulated: ${error}`);
    const fallbackAvailable = config().fallbackBalance - mockSpent();
    if (amount > fallbackAvailable) {
      return { ok: false, source: 'fallback', reason: 'INSUFFICIENT_FUNDS', message: `Balance ${fallbackAvailable} can't cover ${amount}` };
    }
    const mockId = `mock_${Date.now()}`;
    mockLedger.set(mockId, amount);
    return {
      ok: true,
      source: 'fallback',
      error,
      transfer: {
        _id: mockId,
        payee_id: payeeId,
        amount,
        status: 'pending',
        description: `${description} -> payee ${payeeId}`,
        transaction_date: new Date().toISOString().slice(0, 10),
      },
    };
  }
}

/**
 * Refund a cover charge by cancelling its pending transfer (or dropping a mock one).
 */
async function refundTransfer(transferId) {
  if (mockLedger.has(transferId)) {
    const amount = mockLedger.get(transferId);
    mockLedger.delete(transferId);
    return { ok: true, source: 'fallback', amount };
  }
  try {
    await nessie().delete(`/transfers/${transferId}`);
    return { ok: true, source: 'nessie' };
  } catch (err) {
    return { ok: false, source: 'nessie', reason: 'REFUND_FAILED', message: describeError(err) };
  }
}

/**
 * Demo reset: cancel every pending transfer on the demo account (and clear offline
 * mock payments) so the balance is back to its starting value.
 */
async function resetDemoAccount(accountId = config().accountId) {
  mockLedger.clear();
  try {
    const api = nessie();
    let transfers = [];
    try {
      ({ data: transfers } = await api.get(`/accounts/${accountId}/transfers`));
    } catch (err) {
      if (err.response?.status !== 404) throw err; // 404 = no transfers
    }
    const pending = (Array.isArray(transfers) ? transfers : []).filter((t) => t.status === 'pending');
    await Promise.all(pending.map((t) => api.delete(`/transfers/${t.id || t._id}`)));
    return { ok: true, source: 'nessie', cancelled: pending.length };
  } catch (err) {
    return { ok: false, source: 'fallback', error: describeError(err) };
  }
}

module.exports = { getUserBalance, filterAffordableEvents, payEventCover, refundTransfer, resetDemoAccount };
