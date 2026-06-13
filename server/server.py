#!/usr/bin/env python3
"""
FIFA World Cup 2026 — Fixtures + Live Stream Relay Server
=========================================================

A zero-dependency (Python stdlib only) server that:

  1. Serves the React frontend (../frontend).
  2. Proxies the live fixtures feed (fixturedownload.com) with a short
     TTL cache, and keeps an offline snapshot in fixtures.json so the
     site still works without internet.
  3. Relays HLS (.m3u8) live streams listed in streams.json through a
     local proxy that PREFETCHES upcoming media segments into an
     in-memory cache. The player then pulls segments from localhost
     at LAN speed instead of waiting on the remote origin — which is
     what eliminates most rebuffering.

IMPORTANT — legality note:
  This server does not scrape or "find" streams. It only relays HLS
  URLs that YOU put in streams.json — i.e. streams you are licensed
  or authorized to use (your own encoder/OBS output, your TV
  provider's authenticated stream, a free-to-air broadcaster, or the
  demo test streams shipped in streams.json).

Usage:
  python server.py [--port 8000] [--host 0.0.0.0]

Then open http://localhost:8000
"""

import argparse
import base64
import copy
import json
import mimetypes
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(ROOT), "frontend")
FIXTURES_SNAPSHOT = os.path.join(ROOT, "fixtures.json")
STREAMS_FILE = os.path.join(ROOT, "streams.json")
MATCHDATA_DIR = os.path.join(ROOT, "matchdata")

# Optional write-protection for the manual update API:
#   set WC_ADMIN_TOKEN=<secret>  ->  POST requests must send X-Admin-Token
ADMIN_TOKEN = os.environ.get("WC_ADMIN_TOKEN", "")

FEED_URL = "https://fixturedownload.com/feed/json/fifa-world-cup-2026"
FEED_TTL = 60          # seconds between live re-fetches (scores update live)
HTTP_TIMEOUT = 15      # upstream request timeout
SEGMENT_CACHE_MB = 96  # in-memory segment cache budget
PREFETCH_SEGMENTS = 4  # how many of the newest segments to prefetch

USER_AGENT = "Mozilla/5.0 (WC2026-Relay/1.0)"


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def http_get(url, headers=None, timeout=HTTP_TIMEOUT):
    """GET a URL, returning (bytes, final_url, content_type)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.geturl(), resp.headers.get("Content-Type", "")


def b64e(url: str) -> str:
    return base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")


def b64d(token: str) -> str:
    pad = "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(token + pad).decode("utf-8")


# --------------------------------------------------------------------------
# Fixtures: live feed with TTL cache + offline snapshot fallback
# --------------------------------------------------------------------------

class FixtureStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._data = None
        self._fetched_at = 0.0
        self._source = "none"

    def get(self):
        with self._lock:
            fresh = self._data is not None and (time.time() - self._fetched_at) < FEED_TTL
            if fresh:
                return self._data, self._source
        data = self._fetch_live()
        if data is not None:
            with self._lock:
                self._data, self._fetched_at, self._source = data, time.time(), "live"
            return data, "live"
        snap = self._load_snapshot()
        with self._lock:
            if snap is not None:
                self._data, self._fetched_at, self._source = snap, time.time(), "snapshot"
            return self._data, self._source

    def _fetch_live(self):
        try:
            body, _, _ = http_get(FEED_URL)
            data = json.loads(body.decode("utf-8-sig"))
            if isinstance(data, list) and data:
                try:  # keep the offline snapshot up to date
                    with open(FIXTURES_SNAPSHOT, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False)
                except OSError:
                    pass
                return data
        except Exception as exc:
            print(f"[fixtures] live fetch failed: {exc}", file=sys.stderr)
        return None

    def _load_snapshot(self):
        try:
            with open(FIXTURES_SNAPSHOT, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None


# --------------------------------------------------------------------------
# HLS relay with prefetching segment cache
# --------------------------------------------------------------------------

class SegmentCache:
    """Thread-safe LRU byte cache."""

    def __init__(self, budget_bytes):
        self._lock = threading.Lock()
        self._items = OrderedDict()   # url -> (bytes, content_type)
        self._size = 0
        self._budget = budget_bytes

    def get(self, url):
        with self._lock:
            item = self._items.get(url)
            if item:
                self._items.move_to_end(url)
            return item

    def put(self, url, body, ctype):
        with self._lock:
            if url in self._items:
                return
            self._items[url] = (body, ctype)
            self._size += len(body)
            while self._size > self._budget and self._items:
                _, (old, _) = self._items.popitem(last=False)
                self._size -= len(old)

    def __contains__(self, url):
        with self._lock:
            return url in self._items


class HlsRelay:
    def __init__(self):
        self.cache = SegmentCache(SEGMENT_CACHE_MB * 1024 * 1024)
        self._inflight = set()
        self._inflight_lock = threading.Lock()

    # -- streams.json ------------------------------------------------------

    def load_streams(self):
        try:
            with open(STREAMS_FILE, encoding="utf-8") as f:
                cfg = json.load(f)
            return [s for s in cfg.get("streams", []) if s.get("id") and s.get("url")]
        except Exception as exc:
            print(f"[streams] cannot read streams.json: {exc}", file=sys.stderr)
            return []

    def stream_by_id(self, sid):
        for s in self.load_streams():
            if s["id"] == sid:
                return s
        return None

    # -- playlist rewriting --------------------------------------------------

    def rewrite_playlist(self, text, base_url, sid):
        out = []
        next_is_variant = False
        for line in text.splitlines():
            s = line.strip()
            if not s:
                out.append(line)
                continue
            if s.startswith("#"):
                line = re.sub(
                    r'URI="([^"]+)"',
                    lambda m: 'URI="%s"' % self._proxy_path(m.group(1), base_url, sid, "seg"),
                    line,
                )
                out.append(line)
                if s.startswith("#EXT-X-STREAM-INF"):
                    next_is_variant = True
                continue
            is_playlist = next_is_variant or s.split("?")[0].lower().endswith(".m3u8")
            next_is_variant = False
            out.append(self._proxy_path(s, base_url, sid, "pl" if is_playlist else "seg"))
        return ("\n".join(out) + "\n").encode("utf-8")

    @staticmethod
    def _proxy_path(uri, base_url, sid, kind):
        absolute = urllib.parse.urljoin(base_url, uri)
        return f"/hls/{sid}/{kind}/{b64e(absolute)}"

    # -- prefetching ---------------------------------------------------------

    def prefetch_from_playlist(self, text, base_url, headers):
        """Warm the cache with the newest media segments of a live playlist."""
        if "#EXTINF" not in text:
            return
        segs = [
            urllib.parse.urljoin(base_url, line.strip())
            for line in text.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        for url in segs[-PREFETCH_SEGMENTS:]:
            if url in self.cache:
                continue
            with self._inflight_lock:
                if url in self._inflight:
                    continue
                self._inflight.add(url)
            threading.Thread(target=self._fetch_into_cache, args=(url, headers), daemon=True).start()

    def _fetch_into_cache(self, url, headers):
        try:
            body, _, ctype = http_get(url, headers)
            self.cache.put(url, body, ctype or "video/mp2t")
        except Exception:
            pass
        finally:
            with self._inflight_lock:
                self._inflight.discard(url)

    # -- request entrypoints ---------------------------------------------------

    def serve_master(self, sid):
        stream = self.stream_by_id(sid)
        if not stream:
            return None
        headers = stream.get("headers") or {}
        body, final_url, _ = http_get(stream["url"], headers)
        text = body.decode("utf-8", "replace")
        self.prefetch_from_playlist(text, final_url, headers)
        return self.rewrite_playlist(text, final_url, sid)

    def serve_playlist(self, sid, token):
        stream = self.stream_by_id(sid)
        if not stream:
            return None
        headers = stream.get("headers") or {}
        url = b64d(token)
        body, final_url, _ = http_get(url, headers)
        text = body.decode("utf-8", "replace")
        self.prefetch_from_playlist(text, final_url, headers)
        return self.rewrite_playlist(text, final_url, sid)

    def serve_segment(self, sid, token):
        url = b64d(token)
        cached = self.cache.get(url)
        if cached:
            return cached
        stream = self.stream_by_id(sid)
        headers = (stream.get("headers") if stream else None) or {}
        body, _, ctype = http_get(url, headers)
        ctype = ctype or "video/mp2t"
        self.cache.put(url, body, ctype)
        return body, ctype


# --------------------------------------------------------------------------
# Match Centre: live events / lineups / formations / stats / player ratings
#
# Live data comes from ESPN's public summary API, matched to our fixture
# list by team names + kickoff time. Anything can be overridden or added
# manually through POST /api/match/<n>/update (stored in server/matchdata/).
# --------------------------------------------------------------------------

ESPN_SCOREBOARD = ("https://site.api.espn.com/apis/site/v2/sports/soccer/"
                   "fifa.world/scoreboard?dates={dates}")
ESPN_SUMMARY = ("https://site.api.espn.com/apis/site/v2/sports/soccer/"
                "fifa.world/summary?event={eid}")

# ESPN name -> fixture-feed name, compared after norm_name()
TEAM_ALIASES = {
    "southkorea": "korearepublic",
    "unitedstates": "usa",
    "bosniaherzegovina": "bosniaandherzegovina",
    "czechrepublic": "czechia",
    "iran": "iriran",
    "ivorycoast": "cotedivoire",
    "drcongo": "congodr",
    "congodemocraticrepublic": "congodr",
    "capeverde": "caboverde",
    "capeverdeislands": "caboverde",
    "turkey": "turkiye",
}

TEAM_STAT_LABELS = [
    ("possessionPct", "Possession %"),
    ("totalShots", "Shots"),
    ("shotsOnTarget", "Shots on target"),
    ("wonCorners", "Corners"),
    ("totalPasses", "Passes"),
    ("accuratePasses", "Accurate passes"),
    ("foulsCommitted", "Fouls"),
    ("offsides", "Offsides"),
    ("yellowCards", "Yellow cards"),
    ("redCards", "Red cards"),
    ("saves", "Saves"),
    ("penaltyKickGoals", "Penalty goals"),
]

# rating = 6.0 + sum(stat * weight), clamped to [4, 10] — only for players
# who appeared. Transparent and overridable via the update API.
RATING_WEIGHTS = {
    "G": 1.2, "A": 0.9, "SOG": 0.25, "SHOT": 0.05, "SV": 0.2, "FA": 0.05,
    "FC": -0.1, "OF": -0.05, "YC": -0.4, "RC": -1.5, "OG": -1.5, "GA": -0.25,
}


def norm_name(name):
    s = unicodedata.normalize("NFKD", name or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9]", "", s)
    return TEAM_ALIASES.get(s, s)


def deep_merge(base, override):
    """Recursively merge override into base (dicts only; lists replace)."""
    if not isinstance(base, dict) or not isinstance(override, dict):
        return override
    out = dict(base)
    for k, v in override.items():
        out[k] = deep_merge(out.get(k), v) if isinstance(v, dict) else v
    return out


def compute_rating(stats):
    if stats.get("APP", 0) < 1:
        return None
    score = 6.0 + sum(stats.get(abbr, 0) * w for abbr, w in RATING_WEIGHTS.items())
    return round(min(10.0, max(4.0, score)), 1)


class MatchCenter:
    def __init__(self, fixture_store):
        self.fixtures = fixture_store
        self._lock = threading.Lock()
        self._eids = {}        # MatchNumber -> espn event id
        self._summaries = {}   # eid -> (fetched_at, ttl, normalized)
        self._boards = {}      # dates-str -> (fetched_at, events)
        os.makedirs(MATCHDATA_DIR, exist_ok=True)

    # ---- public ----

    def get(self, match_no):
        fixture = self._fixture(match_no)
        if fixture is None:
            return None
        data = {
            "matchNumber": match_no,
            "kickoffUtc": fixture["DateUtc"],
            "venue": fixture["Location"],
            "group": fixture.get("Group"),
            "round": fixture.get("RoundNumber"),
            "teams": {"home": fixture["HomeTeam"], "away": fixture["AwayTeam"]},
            "score": {"home": fixture.get("HomeTeamScore"),
                      "away": fixture.get("AwayTeamScore")},
            "status": {"state": "pre", "detail": "Scheduled", "clock": ""},
            "events": [], "lineups": None, "stats": [],
            "source": "fixtures",
        }
        espn = self._espn_data(fixture)
        if espn:
            # deep copy so manual overrides never mutate the shared cache
            data.update(copy.deepcopy(espn))
            data["source"] = "espn"
        override = self._load_override(match_no)
        if override:
            ratings = override.pop("ratings", None)
            data = deep_merge(data, override)
            if ratings and data.get("lineups"):
                for side in ("home", "away"):
                    for plist in ("starters", "subs"):
                        for p in data["lineups"][side][plist]:
                            if p["name"] in ratings:
                                p["rating"] = ratings[p["name"]]
            data["source"] += "+manual"
        data["fetchedAt"] = time.time()
        return data

    def save_override(self, match_no, body):
        path = os.path.join(MATCHDATA_DIR, f"{match_no}.json")
        if body.get("reset"):
            if os.path.isfile(path):
                os.remove(path)
            return {}
        current = self._load_override(match_no) or {}
        merged = deep_merge(current, body)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
        return merged

    # ---- internals ----

    def _fixture(self, match_no):
        data, _ = self.fixtures.get()
        for m in data or []:
            if m["MatchNumber"] == match_no:
                return m
        return None

    def _load_override(self, match_no):
        path = os.path.join(MATCHDATA_DIR, f"{match_no}.json")
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _espn_data(self, fixture):
        try:
            eid = self._resolve_eid(fixture)
            if not eid:
                return None
            with self._lock:
                cached = self._summaries.get(eid)
                if cached and time.time() - cached[0] < cached[1]:
                    return cached[2]
            body, _, _ = http_get(ESPN_SUMMARY.format(eid=eid))
            normalized = self._normalize(json.loads(body))
            ttl = 10 if normalized["status"]["state"] == "in" else 120
            with self._lock:
                self._summaries[eid] = (time.time(), ttl, normalized)
            return normalized
        except Exception as exc:
            print(f"[matchcenter] espn fetch failed: {exc}", file=sys.stderr)
            return None

    def _resolve_eid(self, fixture):
        no = fixture["MatchNumber"]
        with self._lock:
            if no in self._eids:
                return self._eids[no]
        ko = datetime.strptime(fixture["DateUtc"], "%Y-%m-%d %H:%M:%SZ").replace(
            tzinfo=timezone.utc)
        dates = "{}-{}".format((ko - timedelta(days=1)).strftime("%Y%m%d"),
                               (ko + timedelta(days=1)).strftime("%Y%m%d"))
        with self._lock:
            board = self._boards.get(dates)
        if not board or time.time() - board[0] > 300:
            body, _, _ = http_get(ESPN_SCOREBOARD.format(dates=dates))
            events = json.loads(body).get("events", [])
            with self._lock:
                self._boards[dates] = (time.time(), events)
        else:
            events = board[1]
        want = {norm_name(fixture["HomeTeam"]), norm_name(fixture["AwayTeam"])}
        for ev in events:
            comp = ev.get("competitions", [{}])[0]
            names = {norm_name(c.get("team", {}).get("displayName", ""))
                     for c in comp.get("competitors", [])}
            try:
                evko = datetime.strptime(ev["date"], "%Y-%m-%dT%H:%MZ").replace(
                    tzinfo=timezone.utc)
            except ValueError:
                evko = ko
            if names == want and abs((evko - ko).total_seconds()) < 6 * 3600:
                with self._lock:
                    self._eids[no] = ev["id"]
                return ev["id"]
        return None

    def _normalize(self, s):
        comp = s["header"]["competitions"][0]
        status = comp.get("status", {})
        sides = {c.get("homeAway"): c for c in comp.get("competitors", [])}

        def side_score(side):
            v = sides.get(side, {}).get("score")
            return int(v) if v not in (None, "") else None

        events = []
        for k in s.get("keyEvents", []):
            events.append({
                "minute": (k.get("clock") or {}).get("displayValue", ""),
                "type": (k.get("type") or {}).get("text", ""),
                "team": (k.get("team") or {}).get("displayName", ""),
                "players": [p.get("athlete", {}).get("displayName", "")
                            for p in k.get("participants", [])],
                "text": k.get("text", ""),
            })

        lineups = None
        rosters = s.get("rosters", [])
        if rosters and any(r.get("roster") for r in rosters):
            lineups = {}
            for r in rosters:
                side = r.get("homeAway", "home")
                starters, subs = [], []
                for entry in r.get("roster", []):
                    stats = {st.get("abbreviation"): st.get("value", 0)
                             for st in entry.get("stats", [])}
                    player = {
                        "name": entry.get("athlete", {}).get("displayName", ""),
                        "shortName": entry.get("athlete", {}).get("shortName", ""),
                        "jersey": entry.get("jersey", ""),
                        "position": (entry.get("position") or {}).get("abbreviation", ""),
                        "place": entry.get("formationPlace", 0),
                        "starter": entry.get("starter", False),
                        "subbedIn": bool(entry.get("subbedIn")),
                        "subbedOut": bool(entry.get("subbedOut")),
                        "stats": stats,
                        "rating": compute_rating(stats),
                    }
                    (starters if player["starter"] else subs).append(player)
                starters.sort(key=lambda p: int(p["place"] or 99))
                lineups[side] = {
                    "team": r.get("team", {}).get("displayName", ""),
                    "formation": r.get("formation", ""),
                    "starters": starters,
                    "subs": subs,
                }

        stats = []
        bteams = {t.get("homeAway"): t for t in s.get("boxscore", {}).get("teams", [])}
        if "home" in bteams and "away" in bteams:
            def stat_map(side):
                return {st.get("name"): st.get("displayValue", "")
                        for st in bteams[side].get("statistics", [])}
            hmap, amap = stat_map("home"), stat_map("away")
            for key, label in TEAM_STAT_LABELS:
                if key in hmap or key in amap:
                    stats.append({"key": key, "label": label,
                                  "home": hmap.get(key, "0"),
                                  "away": amap.get(key, "0")})

        return {
            "status": {
                "state": (status.get("type") or {}).get("state", "pre"),
                "detail": (status.get("type") or {}).get("detail", ""),
                "clock": status.get("displayClock", ""),
            },
            "score": {"home": side_score("home"), "away": side_score("away")},
            "events": events,
            "lineups": lineups,
            "stats": stats,
        }


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

fixtures = FixtureStore()
relay = HlsRelay()
matchcenter = MatchCenter(fixtures)

HLS_RE = re.compile(r"^/hls/([\w.-]+)/(master\.m3u8|pl/([\w-]+)|seg/([\w-]+))$")
MATCH_RE = re.compile(r"^/api/match/(\d+)$")
MATCH_UPDATE_RE = re.compile(r"^/api/match/(\d+)/update$")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "WC2026Relay/1.0"

    # ---- plumbing ----

    def _send(self, code, body, ctype, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionAbortedError, BrokenPipeError):
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _error(self, code, msg):
        self._json({"error": msg}, code)

    def log_message(self, fmt, *args):  # quieter logs: only non-segment traffic
        if "/seg/" not in str(args[0] if args else ""):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- routes ----

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/fixtures":
                data, source = fixtures.get()
                if data is None:
                    return self._error(503, "fixtures unavailable (no internet, no snapshot)")
                return self._json({"source": source, "fetchedAt": time.time(), "matches": data})

            if path == "/api/streams":
                streams = [{k: s[k] for k in ("id", "name", "note") if k in s}
                           for s in relay.load_streams()]
                return self._json({"streams": streams})

            m = MATCH_RE.match(path)
            if m:
                data = matchcenter.get(int(m.group(1)))
                if data is None:
                    return self._error(404, "unknown match number")
                return self._json(data)

            m = HLS_RE.match(path)
            if m:
                return self._serve_hls(m)

            return self._serve_static(path)
        except urllib.error.HTTPError as exc:
            self._error(exc.code, f"upstream error: {exc}")
        except Exception as exc:
            self._error(502, f"relay error: {exc}")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        m = MATCH_UPDATE_RE.match(path)
        if not m:
            return self._error(404, "unknown endpoint")
        if ADMIN_TOKEN and self.headers.get("X-Admin-Token") != ADMIN_TOKEN:
            return self._error(401, "missing or wrong X-Admin-Token header")
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 1_000_000:
                return self._error(400, "JSON body required (max 1 MB)")
            raw = self.rfile.read(length)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:  # tolerate latin-1 clients (e.g. PS 5.1)
                text = raw.decode("latin-1")
            body = json.loads(text)
            if not isinstance(body, dict):
                return self._error(400, "body must be a JSON object")
        except Exception as exc:
            return self._error(400, f"bad JSON: {exc}")
        match_no = int(m.group(1))
        if matchcenter._fixture(match_no) is None:
            return self._error(404, "unknown match number")
        override = matchcenter.save_override(match_no, body)
        return self._json({"ok": True, "matchNumber": match_no,
                           "override": override,
                           "merged": matchcenter.get(match_no)})

    def _serve_hls(self, m):
        sid, rest = m.group(1), m.group(2)
        if rest == "master.m3u8":
            body = relay.serve_master(sid)
            if body is None:
                return self._error(404, f"unknown stream id '{sid}'")
            return self._send(200, body, "application/vnd.apple.mpegurl")
        if rest.startswith("pl/"):
            body = relay.serve_playlist(sid, m.group(3))
            if body is None:
                return self._error(404, f"unknown stream id '{sid}'")
            return self._send(200, body, "application/vnd.apple.mpegurl")
        body, ctype = relay.serve_segment(sid, m.group(4))
        return self._send(200, body, ctype, cache="max-age=60")

    def _serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        # resolve safely inside the frontend dir
        fs_path = os.path.normpath(os.path.join(FRONTEND_DIR, path.lstrip("/")))
        if not fs_path.startswith(os.path.normpath(FRONTEND_DIR)):
            return self._error(403, "forbidden")
        if not os.path.isfile(fs_path):
            return self._error(404, "not found")
        ctype = mimetypes.guess_type(fs_path)[0] or "application/octet-stream"
        if fs_path.endswith(".jsx"):
            ctype = "text/jsx"
        with open(fs_path, "rb") as f:
            body = f.read()
        self._send(200, body, ctype, cache="no-cache")


def main():
    parser = argparse.ArgumentParser(description="WC2026 fixtures + HLS relay server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"  World Cup 2026 server running:")
    print(f"  ->  http://localhost:{args.port}")
    print(f"  Fixtures feed : {FEED_URL}")
    print(f"  Streams file  : {STREAMS_FILE}")
    print(f"  Segment cache : {SEGMENT_CACHE_MB} MB, prefetch {PREFETCH_SEGMENTS} segments")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
