// Cancels every pending transfer on the demo account so the balance is back to its
// starting value between demo run-throughs. Usage: npm run reset:nessie
require('dotenv').config();
const axios = require('axios');

const api = axios.create({
  baseURL: process.env.NESSIE_BASE_URL || 'https://api.nessieisreal.com',
  params: { key: process.env.NESSIE_API_KEY },
  timeout: 10000,
});

(async () => {
  const accountId = process.env.NESSIE_ACCOUNT_ID;
  if (!accountId) throw new Error('NESSIE_ACCOUNT_ID is not set (run `npm run seed:nessie`)');

  let transfers = [];
  try {
    ({ data: transfers } = await api.get(`/accounts/${accountId}/transfers`));
  } catch (err) {
    if (err.response?.status !== 404) throw err; // 404 = no transfers
  }
  const pending = (Array.isArray(transfers) ? transfers : []).filter((t) => t.status === 'pending');
  for (const t of pending) await api.delete(`/transfers/${t.id || t._id}`);

  const { data: account } = await api.get(`/accounts/${accountId}`);
  console.log(`Cancelled ${pending.length} pending transfer(s). Balance: $${account.balance}`);
})().catch((err) => {
  console.error('Reset failed:', err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}` : err.message);
  process.exit(1);
});
