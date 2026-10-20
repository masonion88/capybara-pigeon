# Capybara Pigeon

A cozy campus map for Cornell O-Week: see what's on tonight, let Gemini plan a
three-stop night, pay covers from a Capital One (Nessie) wallet, and get iMessage tips
from the pigeon over Photon.

## Run it

You need Node.js 22 or newer.

1. Install the server's packages:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in the keys (Nessie, Gemini, Photon). Set
   `PORT` to a free port, for example 3030. With no keys the app still runs: payments,
   AI picks and texts all fall back to built-in demo versions.

3. Start the server and open the address it prints:

   ```bash
   npm start
   ```

## On a phone (Expo Go)

```bash
npm --prefix mobile install
npm run mobile
```

Scan the QR code with Expo Go. The phone and computer must be on the same Wi-Fi. See
`mobile/README.md` if the app can't find the server.

## Where things are

- `public/`: the app's screens (HTML, CSS, vanilla JS, MapLibre map)
- `server.js`: the API
- `services/`: Gemini (`agentService`), Nessie payments (`nessieService`), iMessage
  (`photonService`), alert and reply logic (`pigeonService`), walking routes
  (`routingEngine`), events (`eventStore`)
- `data/events.json`: the 36 demo events
- `mobile/`: the Expo Go phone app (a full-screen shell around the web app that adds
  GPS, compass and haptics)
