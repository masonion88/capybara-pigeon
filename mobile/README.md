# Capybara Pigeon on your phone (Expo Go)

This is a small Expo app that shows Capybara Pigeon full screen on a phone. The screens
themselves come from the Capybara Pigeon server on your computer; the app adds your
phone's GPS (so "My location" and pigeon alerts are real) and haptics.

## Run it

1. Install **Expo Go** on the phone (App Store / Play Store) and make sure it's up to date.
2. On the computer, start the server from the project folder:

   ```bash
   npm start
   ```

3. In a second terminal, start the phone app:

   ```bash
   npm run mobile
   ```

4. Scan the QR code (iPhone: Camera app, Android: Expo Go). Allow location when asked.

The phone and the computer need to be on the same Wi-Fi. The app finds the server by
itself: it uses the computer that served the QR code, on the `PORT` set in the project's
`.env` (restart `npm run mobile` after changing it).

## If it says "Can't find the Capybara Pigeon server"

- **Server not running:** check the first terminal still shows `Capybara Pigeon server running`.
- **Windows Firewall:** the first time, Windows asks whether Node.js may accept
  connections. Choose *Allow* (private networks). If you missed it, allow "Node.js
  JavaScript Runtime" under *Windows Security > Firewall > Allow an app*.
- **Campus or guest Wi-Fi:** these often block phones from talking to laptops. The quick
  fix is to turn on your phone's hotspot and connect the computer to it, then run both
  commands again.
- **Different port or a tunnel:** type the server's address into the box on that screen,
  or set it before starting:

  ```bash
  EXPO_PUBLIC_SERVER_URL=https://your-tunnel.example npm run mobile
  ```

  (`EXPO_PUBLIC_SERVER_PORT=3010` changes just the port.)

## What the phone adds

- **Live location:** on campus, the blue dot is you, "My location" in Tonight is where
  you really are, and pigeon alerts look around your real position. Off campus, the app
  keeps using its stand-in spot by Willard Straight so everything still works.
- **Haptics:** a little buzz when a payment goes through or a night is booked.
