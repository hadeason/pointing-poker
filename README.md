# Pointing Poker

Live planning poker for agile estimation. Real-time updates via Server-Sent Events; no database, all state in memory.

## Run locally

```bash
node server.js
```

Open http://localhost:3000.

## Configuration

Environment variables:

- `PORT` (default `3000`)
- `HOST_KEY` (default `0723`) — the key voters enter to claim host

## Features

**Voters and roles.** Each voter picks an experience level on join (junior / mid / senior / other). The host can shift+click any voter card to cycle their role.

**Pluggable estimation scales.** Story Points (Fibonacci), T-Shirt Sizes, Days, Weeks, Headache Level, Scale of 1–10, Scale of Good Things, Blast Radius. The host can switch scales mid-session via the dropdown — switching clears the current round. All metrics are tracked per scale.

**Round timer.** Live timer in the sidebar shows time on the current round. Average round time updates as rounds complete.

**Host controls.**
- Click any voter to "call on" them — pulses an amber border.
- Reveal Votes — picks 2–3 random "defenders" with a pulsing rose border, biased to include at least one junior, one mid, and one senior when available.
- Re-pick Defenders — re-randomizes the defenders.
- Accept & Next Round — host picks the winning estimate; the round is recorded in history.
- New Round (Discard) — clears the current round without recording.

**Auto-accept on senior consensus.** When every senior has voted and they all picked the same value, the round auto-reveals and is recorded.

**Reactions.**
- Confetti on team consensus or senior auto-accept.
- Sad faces on big discrepancy (3+ distinct votes, or range spans ≥50% of the scale).

**Session summary.** When the host ends the session, everyone sees totals (time, rounds, team consensus count, senior consensus count), a per-scale breakdown (rounds, avg estimate, most common, consensus counts, avg time), and a round-by-round table.

## Architecture

- `server.js` — Node `http` server, SSE broadcast, in-memory state.
- `index.html` — markup only.
- `style.css` — extracted styles.
- `client.js` — client logic (vanilla JS).

No build step. Render's Node service runs `npm start` (which is `node server.js`).
