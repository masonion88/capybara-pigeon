// Creates the demo Nessie customers/accounts and writes their ids into .env.
// Usage: npm run seed:nessie
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENV_PATH = path.join(__dirname, '..', '.env');
const USER_START_BALANCE = Number(process.env.SEED_BALANCE) || 18;

const api = axios.create({
  baseURL: process.env.NESSIE_BASE_URL || 'https://api.nessieisreal.com',
  params: { key: process.env.NESSIE_API_KEY },
  timeout: 10000,
});

async function createCustomer(first_name, last_name) {
  const { data } = await api.post('/customers', {
    first_name,
    last_name,
    address: { street_number: '144', street_name: 'East Ave', city: 'Ithaca', state: 'NY', zip: '14853' },
  });
  return data.objectCreated._id;
}

async function createAccount(customerId, nickname, balance) {
  const { data } = await api.post(`/customers/${customerId}/accounts`, {
    type: 'Checking',
    nickname,
    rewards: 0,
    balance,
  });
  return data.objectCreated._id;
}

function setEnv(values) {
  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${env.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, env);
}

(async () => {
  if (!process.env.NESSIE_API_KEY) throw new Error('Set NESSIE_API_KEY in .env first');
  if (process.env.NESSIE_ACCOUNT_ID && !process.argv.includes('--force')) {
    console.log('NESSIE_ACCOUNT_ID already set; pass --force to create new accounts.');
    return;
  }

  const customerId = await createCustomer('Capybara', 'Pigeon');
  const accountId = await createAccount(customerId, 'Capybara Pigeon Checking', USER_START_BALANCE);
  const organizerId = await createCustomer('Ithaca', 'Event Organizer');
  const organizerAccountId = await createAccount(organizerId, 'Event Organizer Payouts', 0);

  setEnv({ NESSIE_CUSTOMER_ID: customerId, NESSIE_ACCOUNT_ID: accountId, NESSIE_ORGANIZER_ACCOUNT_ID: organizerAccountId });
  console.log({ customerId, accountId, organizerId, organizerAccountId, startingBalance: USER_START_BALANCE });
})().catch((err) => {
  console.error('Seeding failed:', err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}` : err.message);
  process.exit(1);
});
