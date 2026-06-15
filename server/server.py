#!/usr/bin/env python3
"""
FIFA World Cup 2026 — Fixtures + Live Match Centre Server
=========================================================

A zero-dependency (Python stdlib only) server that:

  1. Serves the React frontend (../frontend).
  2. Proxies the live fixtures feed (fixturedownload.com) with a short
     TTL cache, and keeps an offline snapshot in fixtures.json so the
     site still works without internet.
  3. Exposes a Match Centre API backed by ESPN's public soccer API:
     real-time scores, match status/minute, event timeline, lineups +
     formations, substitutions, per-player goals/assists/stats and
     computed player ratings. All of it can be overridden manually
     through POST /api/match/<n>/update (stored in server/matchdata/).
  4. Exposes /api/live — one cached call returning live score + status
     for every in-progress match, so the fixture cards update in real
     time without hammering the upstream API.

Usage:
  python server.py [--port 8000] [--host 0.0.0.0]

Then open http://localhost:8000
"""

import argparse
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
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(ROOT), "frontend")
FIXTURES_SNAPSHOT = os.path.join(ROOT, "fixtures.json")
MATCHDATA_DIR = os.path.join(ROOT, "matchdata")

# Optional write-protection for the manual update API:
#   set WC_ADMIN_TOKEN=<secret>  ->  POST requests must send X-Admin-Token
ADMIN_TOKEN = os.environ.get("WC_ADMIN_TOKEN", "")

FEED_URL = "https://fixturedownload.com/feed/json/fifa-world-cup-2026"
FEED_TTL = 60          # seconds between live re-fetches (scores update live)
HTTP_TIMEOUT = 15      # upstream request timeout

USER_AGENT = "Mozilla/5.0 (WC2026-MatchCentre/2.0)"


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def http_get(url, headers=None, timeout=HTTP_TIMEOUT):
    """GET a URL, returning (bytes, final_url, content_type)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.geturl(), resp.headers.get("Content-Type", "")


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


def _ml_to_prob(ml):
    """American moneyline -> implied probability (0..1)."""
    try:
        ml = float(ml)
    except (TypeError, ValueError):
        return None
    return (-ml / (-ml + 100.0)) if ml < 0 else (100.0 / (ml + 100.0))


def prediction_from_odds(odds_list):
    """Build a home/draw/away win-probability split from betting moneylines,
    with the bookmaker margin (vig) removed by normalising to 100%."""
    if not odds_list:
        return None
    o = odds_list[0]
    h = _ml_to_prob((o.get("homeTeamOdds") or {}).get("moneyLine"))
    d = _ml_to_prob((o.get("drawOdds") or {}).get("moneyLine"))
    a = _ml_to_prob((o.get("awayTeamOdds") or {}).get("moneyLine"))
    if None in (h, d, a) or (h + d + a) <= 0:
        return None
    tot = h + d + a
    return {
        "home": round(h / tot * 100),
        "draw": round(d / tot * 100),
        "away": round(a / tot * 100),
        "source": (o.get("provider") or {}).get("name", "betting odds"),
    }


class MatchCenter:
    def __init__(self, fixture_store):
        self.fixtures = fixture_store
        self._lock = threading.Lock()
        self._eids = {}        # MatchNumber -> espn event id
        self._summaries = {}   # eid -> (fetched_at, ttl, normalized)
        self._boards = {}      # dates-str -> (fetched_at, events)
        self._live_board = None  # (dates-str, fetched_at, events) for /api/live
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
            "events": [], "lineups": None, "stats": [], "prediction": None,
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

    def live_scores(self):
        """Compact live score + status for every match around 'now'.

        One short-TTL-cached upstream scoreboard call, matched to fixtures
        by team name. Safe to poll frequently from the fixture cards.
        """
        fixtures, _ = self.fixtures.get()
        if not fixtures:
            return []
        now = datetime.now(timezone.utc)
        dates = "{}-{}".format((now - timedelta(days=1)).strftime("%Y%m%d"),
                               (now + timedelta(days=1)).strftime("%Y%m%d"))
        with self._lock:
            cached = self._live_board
        if not cached or cached[0] != dates or time.time() - cached[1] > 20:
            try:
                body, _, _ = http_get(ESPN_SCOREBOARD.format(dates=dates))
                events = json.loads(body).get("events", [])
            except Exception as exc:
                print(f"[live] scoreboard fetch failed: {exc}", file=sys.stderr)
                events = cached[2] if cached else []
            with self._lock:
                self._live_board = (dates, time.time(), events)
        else:
            events = cached[2]

        # index ESPN events by frozenset of normalized team names, with
        # scores keyed by team name (robust to home/away flips between feeds)
        by_teams = {}
        for ev in events:
            comp = ev.get("competitions", [{}])[0]
            status = comp.get("status", {})
            comps = comp.get("competitors", [])
            names = frozenset(norm_name(c.get("team", {}).get("displayName", ""))
                              for c in comps)
            score_by_name = {}
            for c in comps:
                v = c.get("score")
                score_by_name[norm_name(c.get("team", {}).get("displayName", ""))] = (
                    int(v) if v not in (None, "") else None)
            by_teams[names] = {
                "scoreByName": score_by_name,
                "status": {
                    "state": (status.get("type") or {}).get("state", "pre"),
                    "detail": (status.get("type") or {}).get("detail", ""),
                    "clock": status.get("displayClock", ""),
                },
            }

        lo, hi = now - timedelta(days=1), now + timedelta(days=1)
        out = []
        for m in fixtures:
            try:
                ko = datetime.strptime(m["DateUtc"], "%Y-%m-%d %H:%M:%SZ").replace(
                    tzinfo=timezone.utc)
            except Exception:
                continue
            if not (lo <= ko <= hi):
                continue
            hit = by_teams.get(frozenset({norm_name(m["HomeTeam"]),
                                          norm_name(m["AwayTeam"])}))
            if hit:
                out.append({
                    "matchNumber": m["MatchNumber"],
                    "score": {"home": hit["scoreByName"].get(norm_name(m["HomeTeam"])),
                              "away": hit["scoreByName"].get(norm_name(m["AwayTeam"]))},
                    "status": hit["status"],
                })
        return out

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
                    athlete = entry.get("athlete", {})
                    aid = str(athlete.get("id", "") or "")
                    player = {
                        "id": aid,
                        "name": athlete.get("displayName", ""),
                        "shortName": athlete.get("shortName", ""),
                        # ESPN headshot CDN; many WC players lack one, so the
                        # frontend falls back to a jersey avatar on 404.
                        "photo": (f"https://a.espncdn.com/i/headshots/soccer/"
                                  f"players/full/{aid}.png" if aid else ""),
                        "jersey": entry.get("jersey", ""),
                        "position": (entry.get("position") or {}).get("abbreviation", ""),
                        "place": entry.get("formationPlace", 0),
                        "starter": entry.get("starter", False),
                        "subbedIn": bool(entry.get("subbedIn")),
                        "subbedOut": bool(entry.get("subbedOut")),
                        "goals": int(float(stats.get("G", 0) or 0)),
                        "assists": int(float(stats.get("A", 0) or 0)),
                        "yellow": int(float(stats.get("YC", 0) or 0)),
                        "red": int(float(stats.get("RC", 0) or 0)),
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
            "prediction": prediction_from_odds(s.get("odds")),
        }


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

fixtures = FixtureStore()
matchcenter = MatchCenter(fixtures)

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

            if path == "/api/live":
                return self._json({"fetchedAt": time.time(),
                                   "matches": matchcenter.live_scores()})

            m = MATCH_RE.match(path)
            if m:
                data = matchcenter.get(int(m.group(1)))
                if data is None:
                    return self._error(404, "unknown match number")
                return self._json(data)

            return self._serve_static(path)
        except urllib.error.HTTPError as exc:
            self._error(exc.code, f"upstream error: {exc}")
        except Exception as exc:
            self._error(502, f"server error: {exc}")

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
    parser = argparse.ArgumentParser(description="WC2026 fixtures + match centre server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"  World Cup 2026 server running:")
    print(f"  ->  http://localhost:{args.port}")
    print(f"  Fixtures feed : {FEED_URL}")
    print(f"  Match centre  : ESPN public API (live scores, lineups, stats)")
    print(f"  Admin token   : {'set' if ADMIN_TOKEN else 'not set (updates open)'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
