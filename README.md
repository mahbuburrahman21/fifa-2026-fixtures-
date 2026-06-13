# ⚽ World Cup 2026 — Fixtures & Live Stream (Bangladesh Time)

A FIFA World Cup 2026 match chart with **every kickoff converted to Bangladesh
Standard Time (Asia/Dhaka, UTC+6)**, live scores, and a built-in HLS live
video player backed by a Python stream-relay server.

## Quick start

Requires only **Python 3.8+** (no Node, no pip installs — stdlib only).

```
python server\server.py
```

or double-click `start.bat`, then open **http://localhost:8000**

## What's inside

```
frontend/
  index.html     React 18 + hls.js via CDN (no build step)
  app.jsx        The whole React app (fixtures chart + video player)
  styles.css     Dark glassy responsive theme
server/
  server.py      Python server: static files + fixtures API + HLS relay
  streams.json   Your stream sources (HLS .m3u8 URLs)
  fixtures.json  Offline snapshot of all 104 fixtures (auto-updated)
```

## Features

**Fixtures chart**
- All 104 matches, grouped by Bangladesh calendar date with sticky day headers
- Live BD clock, countdown to the next kickoff, LIVE badges + live scores
  (auto-refreshes every 60 s from fixturedownload.com, falls back to the
  offline snapshot when there's no internet)
- Filters: team/venue search, stage, group A–L, live-only toggle, date rail
- Fully responsive — one column on phones, grid on desktop

**Video player**
- HLS playback via hls.js (low-latency mode), Safari native fallback
- Play/pause, volume, Go-Live, Picture-in-Picture, fullscreen,
  buffer-health + quality readout
- Source picker fed by `server/streams.json`, plus a custom-URL input

**Match Centre (per-match live data)**
- 📊 button on every match card opens the Match Centre with three tabs:
  - **Overview** — minute-by-minute timeline: goals, cards, substitutions,
    VAR, injuries, delays
  - **Lineups** — starting XI drawn on a pitch in the real formation,
    jersey numbers, sub in/out arrows with minutes, bench, and
    color-coded player ratings
  - **Stats** — possession, shots, passes, corners, fouls, cards, saves…
    as comparison bars
- Live matches auto-refresh every 10 s (60 s otherwise)
- Data comes from ESPN's public API, auto-matched to fixtures by team
  names + kickoff time; player ratings are computed from match stats
  (goals, assists, shots on target, saves, cards, fouls…) and can be
  overridden via the update API below

**Python stream relay (`server.py`)**
- Proxies the `.m3u8` playlists in `streams.json` and **prefetches upcoming
  segments into an in-memory cache (96 MB LRU)** — the player downloads
  from localhost instead of the remote origin, which removes most
  rebuffering stalls
- `/api/fixtures` — cached live feed + snapshot fallback
- `/api/streams` — stream list for the player
- `/hls/<id>/master.m3u8` — relayed, rewritten playlist

## Match data API

```
GET  /api/fixtures            all 104 fixtures + live scores
GET  /api/match/<n>           full match centre data for match number n:
                              score, status/minute, events timeline,
                              lineups + formation, subs in/out,
                              player ratings, team stats
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

## Adding your stream

Edit `server/streams.json`:

```json
{
  "streams": [
    {
      "id": "my-feed",
      "name": "My broadcaster feed",
      "url": "https://example.com/live/master.m3u8",
      "headers": { "Referer": "https://example.com/" }
    }
  ]
}
```

> **Note on legality:** this project does not find or scrape streams. Add only
> streams you are authorized to use — your own OBS/ffmpeg encoder output, your
> TV provider's authenticated stream, or a free-to-air broadcaster. The two
> bundled entries are public *test* streams for verifying the player.

### Streaming your own encoder (OBS / ffmpeg)

Point ffmpeg at a folder and serve it as HLS, e.g.:

```
ffmpeg -i <input> -c:v h264 -c:a aac -f hls -hls_time 2 \
       -hls_list_size 6 -hls_flags delete_segments live/master.m3u8
```

then set `"url": "http://<encoder-ip>/live/master.m3u8"` in streams.json.

## Options

```
python server\server.py --port 9000 --host 127.0.0.1
```
