/* ============================================================
   World Cup 2026 — Fixtures in Bangladesh Time (React 18)
   - All kickoff times rendered in Asia/Dhaka (BST, UTC+6)
   - Fixtures auto-refresh from /api/fixtures every 60s
   - Real-time scores + status on cards via /api/live (every 20s)
   - Match Centre: timeline, lineups/formation, stats, player ratings
   - Player card: photo, goals/assists, stats and notable records
   ============================================================ */

const { useState, useEffect, useMemo, useRef, useCallback } = React;

/* ----------------------------- constants ----------------------------- */

const BD_TZ = "Asia/Dhaka";
const REFRESH_MS = 60_000;
const LIVE_WINDOW_MIN = 150; // a match is "live" for ~2.5h after kickoff

const FLAGS = {
  "Algeria": "🇩🇿", "Argentina": "🇦🇷", "Australia": "🇦🇺", "Austria": "🇦🇹",
  "Belgium": "🇧🇪", "Bosnia and Herzegovina": "🇧🇦", "Brazil": "🇧🇷",
  "Cabo Verde": "🇨🇻", "Canada": "🇨🇦", "Colombia": "🇨🇴", "Congo DR": "🇨🇩",
  "Croatia": "🇭🇷", "Curaçao": "🇨🇼", "Czechia": "🇨🇿", "Côte d'Ivoire": "🇨🇮",
  "Ecuador": "🇪🇨", "Egypt": "🇪🇬", "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "France": "🇫🇷",
  "Germany": "🇩🇪", "Ghana": "🇬🇭", "Haiti": "🇭🇹", "IR Iran": "🇮🇷",
  "Iraq": "🇮🇶", "Japan": "🇯🇵", "Jordan": "🇯🇴", "Korea Republic": "🇰🇷",
  "Mexico": "🇲🇽", "Morocco": "🇲🇦", "Netherlands": "🇳🇱", "New Zealand": "🇳🇿",
  "Norway": "🇳🇴", "Panama": "🇵🇦", "Paraguay": "🇵🇾", "Portugal": "🇵🇹",
  "Qatar": "🇶🇦", "Saudi Arabia": "🇸🇦", "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "Senegal": "🇸🇳", "South Africa": "🇿🇦", "Spain": "🇪🇸", "Sweden": "🇸🇪",
  "Switzerland": "🇨🇭", "Tunisia": "🇹🇳", "Türkiye": "🇹🇷", "USA": "🇺🇸",
  "Uruguay": "🇺🇾", "Uzbekistan": "🇺🇿",
};

const VENUE_COUNTRY = {
  "Mexico City Stadium": "MEX", "Guadalajara Stadium": "MEX", "Monterrey Stadium": "MEX",
  "Toronto Stadium": "CAN", "BC Place Vancouver": "CAN",
};

const STAGE_NAMES = {
  4: "Round of 32", 5: "Round of 16", 6: "Quarter-final",
  7: "Semi-final", 8: "Final",
};

/* ----------------------------- formatters ----------------------------- */

const fmtTime = new Intl.DateTimeFormat("en-US", {
  timeZone: BD_TZ, hour: "numeric", minute: "2-digit", hour12: true,
});
const fmtDateLong = new Intl.DateTimeFormat("en-GB", {
  timeZone: BD_TZ, weekday: "long", day: "numeric", month: "long",
});
const fmtDateChip = new Intl.DateTimeFormat("en-GB", {
  timeZone: BD_TZ, day: "numeric", month: "short",
});
const fmtWeekday = new Intl.DateTimeFormat("en-GB", { timeZone: BD_TZ, weekday: "short" });
const fmtKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: BD_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const fmtClock = new Intl.DateTimeFormat("en-US", {
  timeZone: BD_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
});

const bdKey = (d) => fmtKey.format(d);

/* ----------------------------- team helpers ----------------------------- */

function prettyTeam(name) {
  if (!name) return { label: "TBD", tbd: true };
  let m;
  if ((m = name.match(/^1([A-L])$/))) return { label: `Winner Group ${m[1]}`, tbd: true };
  if ((m = name.match(/^2([A-L])$/))) return { label: `Runner-up Group ${m[1]}`, tbd: true };
  if ((m = name.match(/^3([A-L]+)$/)))
    return { label: `3rd place ${m[1].split("").join("/")}`, tbd: true };
  if ((m = name.match(/^W(\d+)$/))) return { label: `Winner Match ${m[1]}`, tbd: true };
  if ((m = name.match(/^L(\d+)$/))) return { label: `Loser Match ${m[1]}`, tbd: true };
  if (/to be announced/i.test(name)) return { label: "To be announced", tbd: true };
  return { label: name, tbd: false };
}

const flagOf = (name, tbd) => (tbd ? "⚽" : FLAGS[name] || "🏳️");

function stageOf(m, finalMatchNo) {
  if (m.Group) return { label: `${m.Group} · MD${m.RoundNumber}`, kind: "group" };
  if (m.RoundNumber === 8) {
    return m.MatchNumber === finalMatchNo
      ? { label: "🏆 FINAL", kind: "final" }
      : { label: "Third Place", kind: "knockout" };
  }
  return { label: STAGE_NAMES[m.RoundNumber] || `Round ${m.RoundNumber}`, kind: "knockout" };
}

function venuePretty(loc) {
  return loc
    .replace(" Stadium", "")
    .replace("BC Place Vancouver", "Vancouver")
    .replace("San Francisco Bay Area", "SF Bay Area");
}

function matchStatus(m, now) {
  const ko = m.date.getTime();
  const end = ko + LIVE_WINDOW_MIN * 60_000;
  if (m.Winner || (now > end && m.HomeTeamScore != null)) return "FT";
  if (now > end) return "FT?";
  if (now >= ko) return "LIVE";
  return "UPCOMING";
}

/* ----------------------------- data hooks ----------------------------- */

function useNow(stepMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [stepMs]);
  return now;
}

function useFixtures() {
  const [state, setState] = useState({ matches: null, source: null, error: null });
  const load = useCallback(async () => {
    try {
      const res = await fetch("api/fixtures");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const matches = json.matches
        .map((m) => ({ ...m, date: new Date(m.DateUtc.replace(" ", "T")) }))
        .sort((a, b) => a.date - b.date || a.MatchNumber - b.MatchNumber);
      setState({ matches, source: json.source, error: null });
    } catch (err) {
      setState((s) => ({ ...s, error: String(err) }));
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);
  return state;
}

/* Real-time score + status for every nearby match, in one poll.
   Returns a map: matchNumber -> { score:{home,away}, status:{state,detail,clock} } */
function useLiveScores() {
  const [live, setLive] = useState({});
  useEffect(() => {
    let timer, dead = false;
    const tick = async () => {
      try {
        const res = await fetch("api/live");
        const j = await res.json();
        if (!dead) {
          const map = {};
          for (const m of j.matches || []) map[m.matchNumber] = m;
          setLive(map);
        }
      } catch { /* keep last known */ }
      if (!dead) timer = setTimeout(tick, 20_000);
    };
    tick();
    return () => { dead = true; clearTimeout(timer); };
  }, []);
  return live;
}

/* ----------------------------- small components ----------------------------- */

/* Windows has no flag-emoji font, so render flags as locally bundled
   Twemoji images (frontend/flags/), with the raw emoji as fallback. */
function Flag({ team }) {
  const p = prettyTeam(team);
  const emoji = p.tbd ? "⚽" : FLAGS[team] || "🏴";
  const [broken, setBroken] = useState(false);
  const code = [...emoji]
    .map((c) => c.codePointAt(0).toString(16))
    .filter((c) => c !== "fe0f")
    .join("-");
  return (
    <span className="flag" aria-hidden="true">
      {broken ? (
        emoji
      ) : (
        <img
          className="flag-img" src={`flags/${code}.png`}
          alt="" loading="lazy" onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}

function TeamRow({ team, score, isWinner }) {
  const p = prettyTeam(team);
  return (
    <div className={"team-row" + (isWinner ? " winner" : "")}>
      <Flag team={team} />
      <span className={"tname" + (p.tbd ? " tbd" : "")}>{p.label}</span>
      {score != null && <span className="score">{score}</span>}
    </div>
  );
}

function Countdown({ target, now }) {
  let diff = Math.max(0, target - now);
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor(diff / 3_600_000) % 24;
  const m = Math.floor(diff / 60_000) % 60;
  const s = Math.floor(diff / 1000) % 60;
  const cells = [["Days", d], ["Hrs", h], ["Min", m], ["Sec", s]];
  return (
    <div className="countdown">
      {cells.map(([unit, val]) => (
        <div className="cd-cell" key={unit}>
          <div className="cd-num">{String(val).padStart(2, "0")}</div>
          <div className="cd-unit">{unit}</div>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------- match card ----------------------------- */

function MatchCard({ m, now, finalMatchNo, live, onCentre }) {
  const stage = stageOf(m, finalMatchNo);
  const ls = live && live.status ? live.status : null;
  const timeStatus = matchStatus(m, now);

  // live feed wins; otherwise fall back to time-based heuristics + feed
  const isLive = ls ? ls.state === "in" : timeStatus === "LIVE";
  const done = (ls ? ls.state === "post" : (timeStatus === "FT" || timeStatus === "FT?"))
    || !!m.Winner;

  // only show a scoreline for matches that are live or finished — the live
  // feed reports 0-0 for not-yet-started matches, which we must ignore
  const showScore = isLive || done;
  const liveScore = live && live.score ? live.score : null;
  const hs = showScore ? (liveScore && liveScore.home != null ? liveScore.home : m.HomeTeamScore) : null;
  const as_ = showScore ? (liveScore && liveScore.away != null ? liveScore.away : m.AwayTeamScore) : null;
  const hasScore = hs != null && as_ != null;

  const homeWin = done && hasScore ? hs > as_ : m.Winner === m.HomeTeam;
  const awayWin = done && hasScore ? as_ > hs : m.Winner === m.AwayTeam;
  const minute = isLive ? ((ls && (ls.clock || ls.detail)) || "LIVE") : null;

  return (
    <article
      className={
        "match-card" + (isLive ? " is-live" : "") + (stage.kind === "final" ? " is-final-match" : "")
      }
      onClick={() => onCentre(m)}
      role="button" tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onCentre(m)}
    >
      <div className="mc-top">
        <span className={"stage-pill " + (stage.kind === "final" ? "final-pill" : stage.kind)}>
          {stage.label}
        </span>
        {isLive && <span className="status-pill live">● {minute}</span>}
        {!isLive && done && <span className="status-pill ft">FT</span>}
        <span className="mc-no">#{m.MatchNumber}</span>
      </div>

      <div className="mc-teams">
        <TeamRow team={m.HomeTeam} score={hs} isWinner={homeWin} />
        <TeamRow team={m.AwayTeam} score={as_} isWinner={awayWin} />
      </div>

      <div className="mc-bottom">
        <div className="kick-time">
          <span className="kt">{fmtTime.format(m.date)}</span>
          <span className="kd">{fmtWeekday.format(m.date)}, {fmtDateChip.format(m.date)} · BD time</span>
        </div>
        <div className="venue">
          🏟 {venuePretty(m.Location)}, {VENUE_COUNTRY[m.Location] || "USA"}
        </div>
      </div>

      <button className="centre-btn" onClick={(e) => { e.stopPropagation(); onCentre(m); }}>
        📊 Match centre
      </button>
    </article>
  );
}

/* ----------------------------- match centre ----------------------------- */

function eventIcon(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("own goal")) return "⚽🔴";
  if (t.includes("goal") || t.includes("penalty - scored")) return "⚽";
  if (t.includes("penalty") && t.includes("miss")) return "❌";
  if (t.includes("yellow")) return "🟨";
  if (t.includes("red")) return "🟥";
  if (t.includes("sub")) return "🔄";
  if (t.includes("kickoff")) return "▶️";
  if (t.includes("half") || t.includes("end")) return "⏱";
  if (t.includes("var")) return "📺";
  return "•";
}

const ratingClass = (r) =>
  r == null ? "" : r >= 8 ? "r-great" : r >= 7 ? "r-good" : r >= 6 ? "r-ok" : "r-poor";

function useMatchCentre(matchNo) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let timer, dead = false;
    const tick = async () => {
      try {
        const res = await fetch(`api/match/${matchNo}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (dead) return;
        setData(j);
        setErr(null);
        timer = setTimeout(tick, j.status && j.status.state === "in" ? 10_000 : 60_000);
      } catch (e) {
        if (dead) return;
        setErr(String(e));
        timer = setTimeout(tick, 30_000);
      }
    };
    tick();
    return () => { dead = true; clearTimeout(timer); };
  }, [matchNo]);
  return { data, err };
}

function RatingBadge({ rating }) {
  if (rating == null) return null;
  return <span className={"rating-badge " + ratingClass(rating)}>{rating.toFixed(1)}</span>;
}

/* rows for the pitch: [GK, defence, ..., attack] driven by the formation */
function formationRows(lineup) {
  const starters = lineup.starters || [];
  const gk = starters.filter((p) => p.position === "G" || (p.place | 0) === 1);
  const out = starters.filter((p) => !gk.includes(p));
  const parts = (lineup.formation || "").split("-").map(Number).filter((n) => n > 0);
  const rows = [];
  if (parts.length && parts.reduce((a, b) => a + b, 0) === out.length) {
    let i = 0;
    for (const n of parts) { rows.push(out.slice(i, i + n)); i += n; }
  } else {
    for (let j = 0; j < out.length; j += 4) rows.push(out.slice(j, j + 4));
  }
  return [gk, ...rows];
}

/* goal / assist / card markers shown next to a player */
function GAflags({ p }) {
  if (!p.goals && !p.assists && !p.yellow && !p.red) return null;
  return (
    <span className="ga-flags">
      {p.goals > 0 && <span className="ga g" title={`${p.goals} goal(s)`}>⚽{p.goals > 1 ? p.goals : ""}</span>}
      {p.assists > 0 && <span className="ga a" title={`${p.assists} assist(s)`}>👟{p.assists > 1 ? p.assists : ""}</span>}
      {p.yellow > 0 && <span className="ga yc" title="Yellow card" />}
      {p.red > 0 && <span className="ga rc" title="Red card" />}
    </span>
  );
}

function PlayerChip({ p, subMinutes, onPlayer }) {
  const lastName = (p.shortName || p.name).split(" ").slice(-1)[0] || p.name;
  return (
    <button
      className="pchip" onClick={() => onPlayer(p)}
      title={`${p.name} · ${p.position}${p.rating != null ? " · rating " + p.rating : ""} — click for details`}
    >
      <div className="pchip-circle">
        {p.jersey || "–"}
        <RatingBadge rating={p.rating} />
        <GAflags p={p} />
        {p.subbedOut && <span className="sub-arrow out">▼{subMinutes[p.name] || ""}</span>}
      </div>
      <div className="pchip-name">{lastName}</div>
    </button>
  );
}

function TeamPitch({ lineup, subMinutes, onPlayer }) {
  const rows = formationRows(lineup).slice().reverse(); // attack on top
  const rated = [...(lineup.starters || []), ...(lineup.subs || [])]
    .map((p) => p.rating).filter((r) => r != null);
  const avg = rated.length ? (rated.reduce((a, b) => a + b, 0) / rated.length) : null;
  return (
    <div className="pitch-block">
      <div className="pitch-head">
        <strong>{lineup.team}</strong>
        <span className="formation-tag">{lineup.formation || "—"}</span>
        {avg != null && <RatingBadge rating={Math.round(avg * 10) / 10} />}
      </div>
      <div className="pitch">
        {rows.map((row, i) => (
          <div className="pitch-row" key={i}>
            {row.map((p) => <PlayerChip key={p.name} p={p} subMinutes={subMinutes} onPlayer={onPlayer} />)}
          </div>
        ))}
      </div>
      <div className="bench">
        <div className="bench-title">Bench</div>
        {(lineup.subs || []).filter((p) => p.subbedIn).map((p) => (
          <button className="bench-row" key={p.name} onClick={() => onPlayer(p)}>
            <span className="sub-arrow in">▲{subMinutes[p.name] || ""}</span>
            <span className="bench-name">{p.name}</span>
            <GAflags p={p} />
            <span className="bench-pos">{p.position !== "SUB" ? p.position : ""}</span>
            <RatingBadge rating={p.rating} />
          </button>
        ))}
        {(lineup.subs || []).filter((p) => !p.subbedIn).slice(0, 8).map((p) => (
          <button className="bench-row unused" key={p.name} onClick={() => onPlayer(p)}>
            <span className="bench-name">{p.name}</span>
            <span className="bench-pos">unused</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------- player card ----------------------------- */

const PLAYER_STAT_ROWS = [
  ["G", "Goals", true], ["A", "Assists", true],
  ["SHOT", "Shots", true], ["SOG", "On target", true],
  ["FC", "Fouls", false], ["FA", "Fouls won", false],
  ["OF", "Offsides", false], ["YC", "Yellow cards", false],
  ["RC", "Red cards", false], ["SV", "Saves", false],
  ["GA", "Goals conceded", false],
];

function playerRecords(p) {
  const out = [];
  const s = p.stats || {};
  const n = (k) => Number(s[k] || 0);
  if (p.goals >= 3) out.push("⚽ Hat-trick!");
  else if (p.goals === 2) out.push("⚽ Brace");
  if (p.assists >= 2) out.push(`🅰 ${p.assists} assists`);
  if (p.position === "G" && n("APP") >= 1 && n("GA") === 0) out.push("🧤 Clean sheet");
  if (n("SV") >= 5) out.push(`🧤 ${n("SV")} saves`);
  if (p.rating != null && p.rating >= 8.5) out.push("⭐ Star performer");
  if (n("RC") >= 1) out.push("🟥 Sent off");
  return out;
}

function PlayerCard({ player, teamName, flagTeam, onClose }) {
  const [noPhoto, setNoPhoto] = useState(false);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const s = player.stats || {};
  const records = playerRecords(player);
  const rows = PLAYER_STAT_ROWS.filter(([k, , always]) =>
    always || Number(s[k] || 0) > 0);

  return (
    <div className="modal-veil player-veil" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pcard" role="dialog" aria-label={`Player: ${player.name}`}>
        <button className="close-btn pcard-close" onClick={onClose} aria-label="Close">✕</button>

        <div className="pcard-hero">
          <div className="pcard-photo">
            {player.photo && !noPhoto ? (
              <img src={player.photo} alt={player.name} onError={() => setNoPhoto(true)} />
            ) : (
              <div className="pcard-avatar">{player.jersey || "?"}</div>
            )}
            {player.rating != null && (
              <span className={"pcard-rating " + ratingClass(player.rating)}>
                {player.rating.toFixed(1)}
              </span>
            )}
          </div>
          <div className="pcard-id">
            <div className="pcard-name">{player.name}</div>
            <div className="pcard-meta">
              <Flag team={flagTeam} /> {teamName}
              <span className="dot-sep">•</span> #{player.jersey || "—"}
              <span className="dot-sep">•</span> {player.position || "—"}
              {player.subbedIn && <span className="pcard-tag in">▲ sub</span>}
              {player.subbedOut && <span className="pcard-tag out">▼ subbed off</span>}
            </div>
          </div>
        </div>

        {records.length > 0 && (
          <div className="pcard-records">
            {records.map((r) => <span className="record-chip" key={r}>{r}</span>)}
          </div>
        )}

        <div className="pcard-headline">
          <div className="ph-cell"><b>{player.goals || 0}</b><span>Goals</span></div>
          <div className="ph-cell"><b>{player.assists || 0}</b><span>Assists</span></div>
          <div className="ph-cell">
            <b>{player.rating != null ? player.rating.toFixed(1) : "–"}</b><span>Rating</span>
          </div>
        </div>

        {rows.length > 0 ? (
          <div className="pcard-stats">
            {rows.map(([k, label]) => (
              <div className="ps-row" key={k}>
                <span className="ps-label">{label}</span>
                <span className="ps-val">{Number(s[k] || 0)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="centre-empty" style={{ padding: "24px 12px" }}>
            No detailed stats recorded yet.
          </div>
        )}
        <p className="legal-note" style={{ paddingTop: 4 }}>
          Player photo from ESPN (where available) · stats &amp; rating from the Match Centre feed.
        </p>
      </div>
    </div>
  );
}

function StatBar({ s }) {
  const hv = parseFloat(String(s.home).replace("%", "")) || 0;
  const av = parseFloat(String(s.away).replace("%", "")) || 0;
  const total = hv + av;
  const hPct = total ? Math.round((hv / total) * 100) : 50;
  const homeLead = hv > av, awayLead = av > hv;
  return (
    <div className="stat-row">
      <div className="stat-vals">
        <span className={"stat-pill home" + (homeLead ? " lead" : "")}>{s.home}</span>
        <span className="stat-label">{s.label}</span>
        <span className={"stat-pill away" + (awayLead ? " lead" : "")}>{s.away}</span>
      </div>
      <div className="stat-bars">
        <div className="stat-track home">
          <div className="stat-fill home" style={{ width: hPct + "%" }} />
        </div>
        <div className="stat-track away">
          <div className="stat-fill away" style={{ width: (100 - hPct) + "%" }} />
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- prediction bar ----------------------------- */

function PredictionBar({ prediction, homeTeam, awayTeam }) {
  if (!prediction) return null;
  const { home = 0, draw = 0, away = 0 } = prediction;
  const tot = home + draw + away || 1;
  const h = (home / tot) * 100, d = (draw / tot) * 100, a = (away / tot) * 100;
  return (
    <div className="prediction">
      <div className="pred-title">
        Win prediction <span className="pred-src">· {prediction.source || "model"}</span>
      </div>
      <div className="pred-bar">
        <div className="pred-seg home" style={{ width: h + "%" }}>{Math.round(h)}%</div>
        <div className="pred-seg draw" style={{ width: d + "%" }}>{Math.round(d)}%</div>
        <div className="pred-seg away" style={{ width: a + "%" }}>{Math.round(a)}%</div>
      </div>
      <div className="pred-legend">
        <span><i className="dotc home" /> {prettyTeam(homeTeam).label}</span>
        <span><i className="dotc draw" /> Draw</span>
        <span><i className="dotc away" /> {prettyTeam(awayTeam).label}</span>
      </div>
    </div>
  );
}

/* ----------------------------- group standings ----------------------------- */

/* compute a group table from the fixtures of one group (finished matches only) */
function computeStandings(allMatches, group) {
  if (!group) return null;
  const rows = {};
  const row = (team) => (rows[team] = rows[team] ||
    { team, MP: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0, form: [] });
  for (const m of allMatches) {
    if (m.Group !== group) continue;
    if (m.HomeTeamScore == null || m.AwayTeamScore == null) continue; // not played
    const h = row(m.HomeTeam), a = row(m.AwayTeam);
    const hs = m.HomeTeamScore, as_ = m.AwayTeamScore;
    h.MP++; a.MP++; h.GF += hs; h.GA += as_; a.GF += as_; a.GA += hs;
    if (hs > as_) { h.W++; a.L++; h.Pts += 3; h.form.push("W"); a.form.push("L"); }
    else if (hs < as_) { a.W++; h.L++; a.Pts += 3; a.form.push("W"); h.form.push("L"); }
    else { h.D++; a.D++; h.Pts++; a.Pts++; h.form.push("D"); a.form.push("D"); }
  }
  const list = Object.values(rows).map((r) => ({ ...r, GD: r.GF - r.GA }));
  if (!list.length) return null;
  list.sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF
    || prettyTeam(x.team).label.localeCompare(prettyTeam(y.team).label));
  return list;
}

/* last-5 form: newest on the right, padded with empty circles to 5 */
function FormDots({ form }) {
  const last = (form || []).slice(-5);
  const cells = [];
  for (let i = 0; i < 5; i++) {
    const r = last[i];
    const cls = r === "W" ? "win" : r === "D" ? "draw" : r === "L" ? "loss" : "none";
    const mark = r === "W" ? "✓" : r === "D" ? "–" : r === "L" ? "✕" : "";
    cells.push(<i key={i} className={"form-dot " + cls}>{mark}</i>);
  }
  return <span className="form-dots">{cells}</span>;
}

function Standings({ table, group }) {
  if (!table) {
    return <div className="centre-empty">The group table appears once matches have been played.</div>;
  }
  return (
    <div className="standings">
      <div className="stand-group">{group}</div>
      <table className="stand-table">
        <thead>
          <tr>
            <th className="s-pos">#</th><th className="s-team">Team</th>
            <th>MP</th><th>W</th><th>D</th><th>L</th>
            <th className="s-hide">GF</th><th className="s-hide">GA</th>
            <th>GD</th><th className="s-pts">Pts</th>
            <th className="s-form">Last 5</th>
          </tr>
        </thead>
        <tbody>
          {table.map((r, i) => (
            <tr key={r.team} className={i < 2 ? "qualify" : ""}>
              <td className="s-pos">{i + 1}</td>
              <td className="s-team"><Flag team={r.team} /> <span>{prettyTeam(r.team).label}</span></td>
              <td>{r.MP}</td><td>{r.W}</td><td>{r.D}</td><td>{r.L}</td>
              <td className="s-hide">{r.GF}</td><td className="s-hide">{r.GA}</td>
              <td>{r.GD > 0 ? "+" + r.GD : r.GD}</td>
              <td className="s-pts">{r.Pts}</td>
              <td className="s-form"><FormDots form={r.form} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="stand-legend">
        <span><i className="form-dot win">✓</i> Win</span>
        <span><i className="form-dot draw">–</i> Draw</span>
        <span><i className="form-dot loss">✕</i> Loss</span>
        <span><i className="form-dot none" /> Not played</span>
      </div>
      <div className="stand-note"><i className="qual-dot" /> Top 2 advance to the knockout stage</div>
    </div>
  );
}

function MatchCentre({ match, allMatches, onClose }) {
  const { data, err } = useMatchCentre(match.MatchNumber);
  const [tab, setTab] = useState("overview");
  const [player, setPlayer] = useState(null); // { player, teamName, flagTeam }

  const standings = useMemo(
    () => computeStandings(allMatches || [], match.Group),
    [allMatches, match.Group]
  );

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const subMinutes = useMemo(() => {
    const map = {};
    for (const ev of (data && data.events) || []) {
      if ((ev.type || "").toLowerCase().includes("sub"))
        for (const name of ev.players || []) map[name] = ev.minute || "";
    }
    return map;
  }, [data]);

  const home = prettyTeam(match.HomeTeam);
  const away = prettyTeam(match.AwayTeam);
  const st = data && data.status;
  const live = st && st.state === "in";
  const score = data && data.score;
  const hasScore = score && score.home != null;

  return (
    <React.Fragment>
    <div className="modal-veil" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="player-card centre-card" role="dialog" aria-label={`Match centre: ${home.label} vs ${away.label}`}>
        <div className="player-head">
          <div className="title">Match Centre</div>
          <span className="sub">#{match.MatchNumber} · {venuePretty(match.Location)}</span>
          <button className="close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="centre-scoreboard">
          <div className="cs-team"><Flag team={match.HomeTeam} /><span>{home.label}</span></div>
          <div className="cs-mid">
            <div className="cs-score">{hasScore ? `${score.home} – ${score.away}` : "vs"}</div>
            {st && (
              <div className={"cs-status" + (live ? " live" : "")}>
                {live ? `● ${st.clock || st.detail || "LIVE"}` : st.detail || "Scheduled"}
              </div>
            )}
            <div className="cs-ko">{fmtTime.format(match.date)} BD · {fmtDateChip.format(match.date)}</div>
          </div>
          <div className="cs-team away"><span>{away.label}</span><Flag team={match.AwayTeam} /></div>
        </div>

        <div className="centre-tabs">
          {[["overview", "Overview"], ["lineups", "Lineups"], ["stats", "Stats"],
            ...(match.Group ? [["standings", "Standings"]] : [])].map(([id, label]) => (
            <button key={id} className={"tab-btn" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="centre-body">
          {!data && !err && <div className="centre-empty"><div className="spinner" /> Loading match data…</div>}
          {err && !data && <div className="centre-empty">Could not load match data: {err}</div>}

          {data && tab === "overview" && (
            <React.Fragment>
              <PredictionBar
                prediction={data.prediction}
                homeTeam={match.HomeTeam} awayTeam={match.AwayTeam}
              />
              {data.events.length ? (
                <div className="timeline">
                  {data.events.map((ev, i) => (
                    <div className="tl-row" key={i}>
                      <span className="tl-min">{ev.minute || "—"}</span>
                      <span className="tl-icon">{eventIcon(ev.type)}</span>
                      <span className="tl-text">
                        {ev.text || [ev.type, ev.players.join(", "), ev.team && `(${ev.team})`]
                          .filter(Boolean).join(" — ")}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="centre-empty">
                  No match events yet — the timeline appears once the match goes live.
                </div>
              )}
            </React.Fragment>
          )}

          {data && tab === "lineups" && (
            data.lineups ? (
              <div className="pitches">
                <TeamPitch
                  lineup={data.lineups.home} subMinutes={subMinutes}
                  onPlayer={(p) => setPlayer({ player: p, teamName: data.lineups.home.team, flagTeam: match.HomeTeam })}
                />
                <TeamPitch
                  lineup={data.lineups.away} subMinutes={subMinutes}
                  onPlayer={(p) => setPlayer({ player: p, teamName: data.lineups.away.team, flagTeam: match.AwayTeam })}
                />
              </div>
            ) : (
              <div className="centre-empty">Lineups are usually announced ~1 hour before kickoff.</div>
            )
          )}

          {data && tab === "stats" && (
            data.stats.length ? (
              <div className="stats-list">{data.stats.map((s) => <StatBar key={s.key} s={s} />)}</div>
            ) : (
              <div className="centre-empty">Match stats appear once the match kicks off.</div>
            )
          )}

          {tab === "standings" && (
            <Standings table={standings} group={match.Group} />
          )}
        </div>

        {data && (
          <p className="legal-note">
            Data: ESPN public API{data.source.includes("manual") ? " + manual updates" : ""} ·
            ratings are computed from match stats (goals, assists, shots, saves, cards…)
            unless overridden via <code>POST /api/match/{match.MatchNumber}/update</code> ·
            auto-refresh {live ? "10s" : "60s"}
          </p>
        )}
      </div>
    </div>
    {player && (
      <PlayerCard
        player={player.player} teamName={player.teamName}
        flagTeam={player.flagTeam} onClose={() => setPlayer(null)}
      />
    )}
    </React.Fragment>
  );
}

/* ----------------------------- main app ----------------------------- */

function App() {
  const { matches, source, error } = useFixtures();
  const live = useLiveScores();
  const now = useNow(1000);

  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [viewMode, setViewMode] = useState("current"); // current | live | history | all
  const [selectedDate, setSelectedDate] = useState("all");
  const [centre, setCentre] = useState(null);

  const todayRef = useRef(null);
  const railRef = useRef(null);
  const todayChipRef = useRef(null);
  const scrolledRef = useRef(false);

  const todayKey = bdKey(new Date(now));

  // match phase: "live" | "done" | "upcoming" — live feed wins, else heuristic
  const phaseOf = useCallback(
    (m) => {
      const l = live[m.MatchNumber];
      const st = l && l.status ? l.status.state : null;
      if (st === "in") return "live";
      if (st === "post") return "done";
      if (st === "pre") return "upcoming";
      const ts = matchStatus(m, now);
      if (ts === "LIVE") return "live";
      if (ts === "FT" || ts === "FT?" || m.Winner) return "done";
      return "upcoming";
    },
    [live, now]
  );
  const isLiveMatch = useCallback((m) => phaseOf(m) === "live", [phaseOf]);
  const finalMatchNo = useMemo(
    () => (matches ? Math.max(...matches.map((m) => m.MatchNumber)) : -1),
    [matches]
  );

  /* ---- filtering ---- */
  const filtered = useMemo(() => {
    if (!matches) return [];
    const q = search.trim().toLowerCase();
    return matches.filter((m) => {
      if (groupFilter !== "all" && m.Group !== groupFilter) return false;
      if (stageFilter === "group" && !m.Group) return false;
      if (stageFilter !== "all" && stageFilter !== "group" && String(m.RoundNumber) !== stageFilter)
        return false;
      const dayKey = bdKey(m.date);
      if (viewMode === "live" && phaseOf(m) !== "live") return false;
      // current/history split by day — but a picked date overrides it
      if (selectedDate === "all") {
        if (viewMode === "current" && dayKey < todayKey) return false;   // today + upcoming
        if (viewMode === "history" && dayKey >= todayKey) return false;  // previous days only
      }
      if (q) {
        const hay = [
          m.HomeTeam, m.AwayTeam, prettyTeam(m.HomeTeam).label, prettyTeam(m.AwayTeam).label,
          m.Location, m.Group || "",
        ].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (selectedDate !== "all" && bdKey(m.date) !== selectedDate) return false;
      return true;
    });
  }, [matches, search, stageFilter, groupFilter, viewMode, selectedDate, now, todayKey, phaseOf]);

  /* ---- group by Bangladesh date ---- */
  const byDay = useMemo(() => {
    const map = new Map();
    for (const m of filtered) {
      const k = bdKey(m.date);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    }
    return [...map.entries()];
  }, [filtered]);

  const allDays = useMemo(() => {
    if (!matches) return [];
    const map = new Map();
    for (const m of matches) {
      const k = bdKey(m.date);
      if (!map.has(k)) map.set(k, m.date);
    }
    return [...map.entries()];
  }, [matches]);

  const liveMatches = useMemo(
    () => (matches || []).filter((m) => isLiveMatch(m)),
    [matches, isLiveMatch]
  );

  // which day to auto-scroll to: today if it has matches, else the next day
  const scrollKey = useMemo(() => {
    const keys = byDay.map(([k]) => k);
    if (keys.includes(todayKey)) return todayKey;
    return keys.find((k) => k >= todayKey) || null;
  }, [byDay, todayKey]);

  // auto-scroll to today's fixtures once, after first load
  useEffect(() => {
    if (matches && !scrolledRef.current && todayRef.current) {
      scrolledRef.current = true;
      setTimeout(() => {
        todayRef.current && todayRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 350);
    }
  }, [matches, scrollKey]);

  // center the today chip in the date rail
  useEffect(() => {
    if (matches && railRef.current && todayChipRef.current) {
      const rail = railRef.current, chip = todayChipRef.current;
      rail.scrollLeft += chip.getBoundingClientRect().left - rail.getBoundingClientRect().left - 120;
    }
  }, [matches]);

  const nextMatch = useMemo(
    () => (matches || []).find((m) => m.date.getTime() > now),
    [matches, now]
  );

  if (error && !matches) {
    return (
      <div className="empty">
        <div className="big">📡</div>
        <p>Could not load fixtures: {error}</p>
        <p>Start the server with: <code>python server/server.py</code></p>
      </div>
    );
  }
  if (!matches) {
    return (
      <div className="boot-splash">
        <div className="boot-ball">⚽</div>
        <p>Loading World Cup 2026 fixtures…</p>
      </div>
    );
  }

  return (
    <React.Fragment>
      {/* ---------- top bar ---------- */}
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-badge">⚽</div>
            <div>
              <div className="brand-title">World Cup <em>2026</em></div>
              <div className="brand-sub">USA · Canada · Mexico — 48 teams · 104 matches</div>
            </div>
          </div>
          <div className="bd-clock">
            <div className="bd-clock-time">{fmtClock.format(new Date(now))}</div>
            <div className="bd-clock-label">Bangladesh (UTC+6)</div>
          </div>
        </div>
      </header>

      <main className="shell">
        {/* ---------- hero ---------- */}
        <section className="hero">
          <div className="hero-left">
            <h1>Every match, in your time.</h1>
            <p>All 104 fixtures with kickoff times converted to Bangladesh Standard Time.</p>
            <span className="tz-chip">🕕 Asia/Dhaka · UTC+6</span>
          </div>

          {liveMatches.length > 0 ? (
            <div className="live-now-banner">
              <span className="live-pill-big">
                <span className="status-pill live" style={{ padding: "2px 8px" }}>●</span>
                {liveMatches.length} match{liveMatches.length > 1 ? "es" : ""} LIVE now
              </span>
              {liveMatches.slice(0, 1).map((lm) => {
                const l = live[lm.MatchNumber];
                const sc = l && l.score && l.score.home != null
                  ? `${l.score.home}–${l.score.away}` : "vs";
                return (
                  <button key={lm.MatchNumber} className="watch-btn hot" onClick={() => setCentre(lm)}>
                    📊 {prettyTeam(lm.HomeTeam).label} {sc} {prettyTeam(lm.AwayTeam).label}
                  </button>
                );
              })}
            </div>
          ) : nextMatch ? (
            <div className="next-kickoff">
              <div className="nk-label">Next kickoff</div>
              <div className="nk-teams">
                <Flag team={nextMatch.HomeTeam} />
                <span>{prettyTeam(nextMatch.HomeTeam).label}</span>
                <span className="nk-vs">VS</span>
                <span>{prettyTeam(nextMatch.AwayTeam).label}</span>
                <Flag team={nextMatch.AwayTeam} />
              </div>
              <Countdown target={nextMatch.date.getTime()} now={now} />
            </div>
          ) : (
            <div className="next-kickoff"><div className="nk-label">Tournament complete 🏆</div></div>
          )}
        </section>

        {/* ---------- controls ---------- */}
        <div className="controls">
          <div className="search-box">
            <span className="si">🔎</span>
            <input
              placeholder="Search team, venue or group…"
              value={search} onChange={(e) => setSearch(e.target.value)}
              aria-label="Search matches"
            />
          </div>
          <select className="ctrl" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} aria-label="Stage">
            <option value="all">All stages</option>
            <option value="group">Group stage</option>
            <option value="4">Round of 32</option>
            <option value="5">Round of 16</option>
            <option value="6">Quarter-finals</option>
            <option value="7">Semi-finals</option>
            <option value="8">3rd place & Final</option>
          </select>
          <select className="ctrl" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label="Group">
            <option value="all">All groups</option>
            {"ABCDEFGHIJKL".split("").map((g) => (
              <option key={g} value={`Group ${g}`}>Group {g}</option>
            ))}
          </select>
          <div className="view-seg" role="tablist" aria-label="Filter by match phase">
            {[["current", "Today & Next"], ["live", "● Live"], ["history", "History"], ["all", "All"]]
              .map(([id, label]) => (
                <button
                  key={id} role="tab" aria-selected={viewMode === id}
                  className={"seg-btn" + (viewMode === id ? " active" : "") + (id === "live" ? " live" : "")}
                  onClick={() => setViewMode(id)}
                >
                  {label}
                </button>
              ))}
          </div>
        </div>

        {/* ---------- date rail ---------- */}
        <div className="date-rail" role="tablist" ref={railRef} aria-label="Match days (Bangladesh dates)">
          <div
            className={"date-chip" + (selectedDate === "all" ? " active" : "")}
            onClick={() => setSelectedDate("all")} role="tab"
          >
            All<br /><small>days</small>
          </div>
          {allDays.map(([key, d]) => (
            <div
              key={key}
              ref={key === todayKey ? todayChipRef : null}
              className={
                "date-chip" + (selectedDate === key ? " active" : "") +
                (key === todayKey ? " today-mark" : "")
              }
              onClick={() => setSelectedDate(selectedDate === key ? "all" : key)}
              role="tab"
            >
              {fmtDateChip.format(d)}
              <small>{key === todayKey ? "today" : fmtWeekday.format(d)}</small>
            </div>
          ))}
        </div>

        <div className="feed-note">
          <span className={"dot" + (source === "live" ? "" : " stale")} />
          {source === "live"
            ? "Live scores update in real time · times shown in Bangladesh Standard Time"
            : "Offline snapshot · connect to the internet for live scores"}
        </div>

        {/* ---------- fixtures by day ---------- */}
        {byDay.length === 0 && (
          <div className="empty">
            <div className="big">🥅</div>
            <p>No matches found for these filters.</p>
          </div>
        )}
        {byDay.map(([key, dayMatches]) => (
          <section
            className="day-section" key={key}
            ref={key === scrollKey ? todayRef : null}
          >
            <div className="day-head">
              <h2>{fmtDateLong.format(dayMatches[0].date)}</h2>
              {key === todayKey && <span className="today-tag">Today</span>}
              <span className="count">{dayMatches.length} match{dayMatches.length > 1 ? "es" : ""}</span>
            </div>
            <div className="match-grid">
              {dayMatches.map((m) => (
                <MatchCard
                  key={m.MatchNumber} m={m} now={now}
                  finalMatchNo={finalMatchNo} live={live[m.MatchNumber]}
                  onCentre={() => setCentre(m)}
                />
              ))}
            </div>
          </section>
        ))}

        <footer className="footer">
          <span>
            FIFA World Cup 2026 · 11 June – 19 July · fixtures via fixturedownload.com ·
            live data via ESPN · all times in Bangladesh Standard Time (UTC+6)
          </span>
          <span>Built with React + a Python match-centre API 🇧🇩</span>
        </footer>
      </main>

      {centre && (
        <MatchCentre match={centre} allMatches={matches} onClose={() => setCentre(null)} />
      )}
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
