# Draw It

A lightweight, dependency-free lobby for drawing and guessing. Up to 10 guest players can join from the same network—no login required. Points reward early correct guesses so fast players climb the leaderboard.

## Running locally
1. Ensure Node.js 18+ is available.
2. Start the server:
   ```bash
   npm start
   ```
3. Open the game in a browser on the same network (phone, tablet, laptop) at `http://<your-ip>:3000`.

## How it works
- Uses Server-Sent Events for real-time updates and simple `fetch` calls for actions—no extra packages to install.
- Rounds rotate the drawer automatically. The drawer sees the secret word; others guess. Correct guesses pay more the earlier they arrive and award a bonus to the drawer.
- The lobby blocks the 11th join attempt to keep games snappy on mobile.
