// Tells the phone app which port the Capybara Pigeon server uses, by reading the PORT
// line of the project's .env. That way changing the port in one place is enough.
// Only the port number is read; nothing else from .env is passed to the app.
const fs = require('fs');
const path = require('path');

function serverPort() {
  if (process.env.EXPO_PUBLIC_SERVER_PORT) return process.env.EXPO_PUBLIC_SERVER_PORT;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const match = env.match(/^\s*PORT\s*=\s*"?(\d+)"?\s*$/m);
    if (match) return match[1];
  } catch {
    // no .env: fall through to the server's own default
  }
  return '3000';
}

module.exports = ({ config }) => ({ ...config, extra: { ...config.extra, serverPort: serverPort() } });
