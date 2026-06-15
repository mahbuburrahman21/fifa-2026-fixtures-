# ⚽ World Cup 2026 — Fixtures & Live Match Centre (Bangladesh Time)

A FIFA World Cup 2026 match chart with **every kickoff converted to Bangladesh
Standard Time (Asia/Dhaka, UTC+6)**, **real-time live scores on every card**, and
a full Match Centre (timeline, lineups & formations, player ratings, match stats)
plus a per-player card with photo, goals, assists and notable records.

## Quick start

Requires only **Python 3.8+** (no Node, no pip installs — stdlib only).

```
python server\server.py
```

or double-click `start.bat`, then open **http://localhost:8000**

## What's inside

```
frontend/
  index.html     React 18 via CDN (no build step)
  app.jsx        The whole React app (fixtures chart + match centre + player card)
  styles.css     Dark glassy responsive theme
  flags/         Locally bundled Twemoji flag PNGs (Windows has no flag font)
server/
  server.py      Python server: static files + fixtures API + match centre API
  fixtures.json  Offline snapshot of all 104 fixtures (auto-updated)
  matchdata/     Manual per-match overrides (created on demand)
```

## Features

**Fixtures chart**
- All 104 matches, grouped by Bangladesh calendar date with sticky day headers
- **Auto-scrolls to today's matches** on open (the date rail centres on today too)
- **Real-time scores + live minute on each card** — polled every 20 s from
  `/api/live`; upcoming matches show no score, live matches pulse with the
  current minute, finished matches show FT with the winner highlighted
- **View filter: All · Live · Upcoming · Results** — past matches are kept as
  history (Results), today is the default landing point, future stays as-is
- Live BD clock, countdown to the next kickoff
- Filters: team/venue search, stage, group A–L, date rail
- Fully responsive — one column on phones, grid on desktop
- The whole card is clickable → opens the Match Centre

**Match Centre (per-match live data)**
- 📊 on every card opens the Match Centre with four tabs:
  - **Overview** — a **win-prediction bar** (home/draw/away % from betting
    moneylines, vig removed) plus the minute-by-minute timeline: goals,
    cards, substitutions, VAR, injuries, delays
  - **Lineups** — starting XI on a pitch in the real formation, jersey
    numbers, **goal ⚽, assist 🅰 and yellow/red card markers next to each
    player**, sub in/out arrows with minutes, bench, and colour-coded ratings
  - **Stats** — possession, shots, passes, corners, fouls, cards, saves…
    with the leading side highlighted and proportional (%) split bars
  - **Standings** — the live group table (computed from results: MP, W, D, L,
    GF, GA, GD, Pts) with the top-2 qualification places highlighted
- Live matches auto-refresh every 10 s (60 s otherwise)

**Player card**
- Click any player (on the pitch or bench) to open a card with their **photo**
  (ESPN headshot where available, jersey-number avatar otherwise), team flag,
  position, **goals, assists, cards, rating**, a full stat breakdown, and
  **notable records** (hat-trick, brace, multiple assists, clean sheet, star
  performer, red card)

Data comes from ESPN's public API, auto-matched to fixtures by team name +
kickoff time. Player ratings are computed from match stats (goals, assists,
shots on target, saves, cards, fouls…) and can be overridden via the API below.

## Match data API

```
GET  /api/fixtures            all 104 fixtures + scores (fixturedownload feed)
GET  /api/live                compact real-time score + status for every match
                              around "now" — one cached call, poll-friendly
GET  /api/match/<n>           full match centre data for match number n:
                              score, status/minute, events timeline, win
                              prediction (from odds), lineups + formation,
                              subs in/out, per-player goals/assists/cards/
                              photo/stats, ratings, team stats
                              (group standings are computed client-side)
POST /api/match/<n>/update    push your own real-time updates (JSON body);
                              stored in server/matchdata/<n>.json and
                              deep-merged over the live feed
```

Examples (PowerShell — note the UTF-8 byte body):

```powershell
# read match 1
Invoke-RestMethod http://localhost:8000/api/match/1

# push a live score + an event + a player rating override
$body = '{
  "score":  { "home": 3, "away": 0 },
  "status": { "state": "in", "detail": "78'", "clock": "78'" },
  "events": [ { "minute": "76'", "type": "Goal", "team": "Mexico",
                "players": ["R. Jimenez"], "text": "Goal! Jimenez header." } ],
  "ratings": { "Raúl Jiménez": 8.9 }
}'
Invoke-RestMethod http://localhost:8000/api/match/1/update -Method Post `
  -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
  -ContentType "application/json; charset=utf-8"

# clear all manual overrides for match 1
Invoke-RestMethod http://localhost:8000/api/match/1/update -Method Post `
  -Body '{"reset":true}' -ContentType "application/json"
```

Override rules: objects merge recursively, lists replace, and the special
`ratings` map applies per player name on top of lineups. To protect the
update endpoint, set an environment variable before starting the server —
`set WC_ADMIN_TOKEN=mysecret` — then send header `X-Admin-Token: mysecret`
with every POST.

## Options

```
python server\server.py --port 9000 --host 127.0.0.1
```

## Deploying (Render, free)

The repo includes a `Dockerfile`. On Render: **New → Web Service → Docker**,
branch `master`. The server reads the `PORT` env var via `--port $PORT` in the
start command if you prefer the non-Docker path.
