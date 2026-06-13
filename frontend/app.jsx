/* ============================================================
   World Cup 2026 — Fixtures in Bangladesh Time (React 18)
   - All kickoff times rendered in Asia/Dhaka (BST, UTC+6)
   - Live scores auto-refresh from /api/fixtures every 60s
   - HLS live player (hls.js) fed by the Python relay server
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

function useStreams() {
  const [streams, setStreams] = useState([]);
  useEffect(() => {
    fetch("api/streams")
      .then((r) => r.json())
      .then((j) => setStreams(j.streams || []))
      .catch(() => setStreams([]));
  }, []);
  return streams;
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

function MatchCard({ m, now, finalMatchNo, onWatch, onCentre }) {
  const stage = stageOf(m, finalMatchNo);
  const status = matchStatus(m, now);
  const live = status === "LIVE";
  const done = status === "FT" || status === "FT?";
  const home = prettyTeam(m.HomeTeam);
  const away = prettyTeam(m.AwayTeam);

  return (
    <article
      className={
        "match-card" + (live ? " is-live" : "") + (stage.kind === "final" ? " is-final-match" : "")
      }
    >
      <div className="mc-top">
        <span className={"stage-pill " + (stage.kind === "final" ? "final-pill" : stage.kind)}>
          {stage.label}
        </span>
        {live && <span className="status-pill live">● Live</span>}
        {done && <span className="status-pill ft">FT</span>}
        <span className="mc-no">#{m.MatchNumber}</span>
      </div>

      <div className="mc-teams">
        <TeamRow team={m.HomeTeam} score={m.HomeTeamScore} isWinner={done && m.Winner === m.HomeTeam} />
        <TeamRow team={m.AwayTeam} score={m.AwayTeamScore} isWinner={done && m.Winner === m.AwayTeam} />
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

      <div className="card-actions">
        <button
          className={"watch-btn" + (live ? " hot" : "")}
          onClick={() => onWatch(m, { home: home.label, away: away.label, live })}
        >
          {live ? "▶ Watch live" : done ? "▶ Open player" : "▶ Player / preview"}
        </button>
        <button className="watch-btn" onClick={() => onCentre(m)}>
          📊 Match centre
        </button>
      </div>
    </article>
  );
}

/* ----------------------------- video player ----------------------------- */

function VideoPlayer({ match, streams, onClose }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [sourceId, setSourceId] = useState(streams[0] ? streams[0].id : "custom");
  const [customUrl, setCustomUrl] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | loading | playing | error
  const [errMsg, setErrMsg] = useState("");
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(1);
  const [bufferAhead, setBufferAhead] = useState(0);
  const [levelInfo, setLevelInfo] = useState("");

  const srcUrl = useMemo(() => {
    if (sourceId === "custom") return customUrl.trim();
    return `hls/${sourceId}/master.m3u8`; // relayed + prefetched by the Python server
  }, [sourceId, customUrl]);

  const destroy = () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  };

  const start = useCallback(() => {
    const video = videoRef.current;
    if (!video || !srcUrl) return;
    destroy();
    setPhase("loading");
    setErrMsg("");

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        maxBufferLength: 30,
        backBufferLength: 30,
        enableWorker: true,
      });
      hlsRef.current = hls;
      hls.loadSource(srcUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setPhase("playing");
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const lvl = hls.levels[data.level];
        if (lvl) setLevelInfo(`${lvl.height ? lvl.height + "p" : ""} ${Math.round(lvl.bitrate / 1000)} kbps`);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else {
          setPhase("error");
          setErrMsg(`Stream error: ${data.details || data.type}`);
          destroy();
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = srcUrl; // Safari native HLS
      video.play().then(() => setPhase("playing")).catch(() => setPhase("error"));
    } else {
      setPhase("error");
      setErrMsg("This browser cannot play HLS streams.");
    }
  }, [srcUrl]);

  useEffect(() => {
    start();
    return destroy;
  }, [start]);

  // buffer health meter
  useEffect(() => {
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.buffered.length) return setBufferAhead(0);
      const end = v.buffered.end(v.buffered.length - 1);
      setBufferAhead(Math.max(0, end - v.currentTime));
    }, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const v = () => videoRef.current;
  const togglePlay = () => {
    if (!v()) return;
    if (v().paused) { v().play(); setPaused(false); } else { v().pause(); setPaused(true); }
  };
  const goLive = () => {
    const hls = hlsRef.current;
    if (hls && hls.liveSyncPosition != null) v().currentTime = hls.liveSyncPosition;
    else if (v() && isFinite(v().duration)) v().currentTime = v().duration - 1;
    v() && v().play();
    setPaused(false);
  };
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v()) await v().requestPictureInPicture();
    } catch { /* PiP unsupported */ }
  };
  const fullscreen = () => {
    const el = v();
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else (el.requestFullscreen || el.webkitEnterFullscreen || (() => {})).call(el);
  };
  const setVol = (val) => {
    setVolume(val);
    if (v()) { v().volume = val; v().muted = val === 0; setMuted(val === 0); }
  };

  const title = `${prettyTeam(match.HomeTeam).label} vs ${prettyTeam(match.AwayTeam).label}`;

  return (
    <div className="modal-veil" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="player-card" role="dialog" aria-label={`Video player: ${title}`}>
        <div className="player-head">
          <Flag team={match.HomeTeam} />
          <div>
            <div className="title">{title}</div>
            <div className="sub">
              {fmtDateLong.format(match.date)} · {fmtTime.format(match.date)} BD time · {venuePretty(match.Location)}
            </div>
          </div>
          <Flag team={match.AwayTeam} />
          <button className="close-btn" onClick={onClose} aria-label="Close player">✕</button>
        </div>

        <div className="video-wrap">
          <video ref={videoRef} playsInline muted={muted} />
          {phase === "loading" && (
            <div className="video-overlay-msg"><div className="spinner" /> Connecting to stream…</div>
          )}
          {phase === "error" && (
            <div className="video-overlay-msg">
              <div style={{ fontSize: 30 }}>📡</div>
              <div>{errMsg || "Could not load this stream."}</div>
              <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                Pick another source below, or add your licensed stream URL to server/streams.json.
              </div>
            </div>
          )}
          {phase === "idle" && !srcUrl && (
            <div className="video-overlay-msg">Select a stream source below to start playback.</div>
          )}
        </div>

        <div className="player-controls">
          <button className="pc-btn" onClick={togglePlay}>{paused ? "▶ Play" : "⏸ Pause"}</button>
          <button className="pc-btn golive" onClick={goLive}>● Go Live</button>
          <span className="vol">
            <button className="pc-btn" onClick={() => setVol(muted ? 1 : 0)}>{muted ? "🔇" : "🔊"}</button>
            <input
              type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume}
              onChange={(e) => setVol(parseFloat(e.target.value))} aria-label="Volume"
            />
          </span>
          <span className="pc-spacer" />
          <span className="buffer-meter">
            buffer <b>{bufferAhead.toFixed(1)}s</b>{levelInfo ? ` · ${levelInfo}` : ""}
          </span>
          <button className="pc-btn" onClick={togglePip}>⧉ PiP</button>
          <button className="pc-btn" onClick={fullscreen}>⛶ Fullscreen</button>
        </div>

        <div className="source-row">
          <select
            className="ctrl" value={sourceId}
            onChange={(e) => setSourceId(e.target.value)} aria-label="Stream source"
          >
            {streams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="custom">Custom HLS URL…</option>
          </select>
          {sourceId === "custom" && (
            <React.Fragment>
              <input
                placeholder="https://…/playlist.m3u8 (a stream you are licensed to use)"
                value={customUrl} onChange={(e) => setCustomUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && start()}
              />
              <button className="pc-btn" onClick={start}>Load</button>
            </React.Fragment>
          )}
        </div>
        <p className="legal-note">
          Streams are relayed through your local Python server with segment prefetching for
          smooth playback. Only play streams you are authorized to use (your own encoder,
          your TV provider, or a free-to-air broadcaster).
        </p>
      </div>
    </div>
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

function PlayerChip({ p, subMinutes }) {
  const lastName = (p.shortName || p.name).split(" ").slice(-1)[0] || p.name;
  return (
    <div className="pchip" title={`${p.name} · ${p.position}${p.rating != null ? " · rating " + p.rating : ""}`}>
      <div className="pchip-circle">
        {p.jersey || "–"}
        <RatingBadge rating={p.rating} />
        {p.subbedOut && <span className="sub-arrow out">▼{subMinutes[p.name] || ""}</span>}
      </div>
      <div className="pchip-name">{lastName}</div>
    </div>
  );
}

function TeamPitch({ lineup, subMinutes }) {
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
            {row.map((p) => <PlayerChip key={p.name} p={p} subMinutes={subMinutes} />)}
          </div>
        ))}
      </div>
      <div className="bench">
        <div className="bench-title">Bench</div>
        {(lineup.subs || []).filter((p) => p.subbedIn).map((p) => (
          <div className="bench-row" key={p.name}>
            <span className="sub-arrow in">▲{subMinutes[p.name] || ""}</span>
            <span className="bench-name">{p.name}</span>
            <span className="bench-pos">{p.position !== "SUB" ? p.position : ""}</span>
            <RatingBadge rating={p.rating} />
          </div>
        ))}
        {(lineup.subs || []).filter((p) => !p.subbedIn).slice(0, 8).map((p) => (
          <div className="bench-row unused" key={p.name}>
            <span className="bench-name">{p.name}</span>
            <span className="bench-pos">unused</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatBar({ s }) {
  const hv = parseFloat(String(s.home).replace("%", "")) || 0;
  const av = parseFloat(String(s.away).replace("%", "")) || 0;
  const total = hv + av;
  const hw = total ? (hv / total) * 100 : 50;
  return (
    <div className="stat-row">
      <div className="stat-vals">
        <span className={hv >= av ? "lead" : ""}>{s.home}</span>
        <span className="stat-label">{s.label}</span>
        <span className={av >= hv ? "lead" : ""}>{s.away}</span>
      </div>
      <div className="stat-bar">
        <div className="stat-bar-home" style={{ width: hw + "%" }} />
        <div className="stat-bar-away" style={{ width: (100 - hw) + "%" }} />
      </div>
    </div>
  );
}

function MatchCentre({ match, onClose }) {
  const { data, err } = useMatchCentre(match.MatchNumber);
  const [tab, setTab] = useState("overview");

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
          {[["overview", "Overview"], ["lineups", "Lineups"], ["stats", "Stats"]].map(([id, label]) => (
            <button key={id} className={"tab-btn" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="centre-body">
          {!data && !err && <div className="centre-empty"><div className="spinner" /> Loading match data…</div>}
          {err && !data && <div className="centre-empty">Could not load match data: {err}</div>}

          {data && tab === "overview" && (
            data.events.length ? (
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
            )
          )}

          {data && tab === "lineups" && (
            data.lineups ? (
              <div className="pitches">
                <TeamPitch lineup={data.lineups.home} subMinutes={subMinutes} />
                <TeamPitch lineup={data.lineups.away} subMinutes={subMinutes} />
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
  );
}

/* ----------------------------- main app ----------------------------- */

function App() {
  const { matches, source, error } = useFixtures();
  const streams = useStreams();
  const now = useNow(1000);

  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [liveOnly, setLiveOnly] = useState(false);
  const [selectedDate, setSelectedDate] = useState("all");
  const [watching, setWatching] = useState(null);
  const [centre, setCentre] = useState(null);

  const todayKey = bdKey(new Date(now));
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
      if (liveOnly && matchStatus(m, now) !== "LIVE") return false;
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
  }, [matches, search, stageFilter, groupFilter, liveOnly, selectedDate, now]);

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
    () => (matches || []).filter((m) => matchStatus(m, now) === "LIVE"),
    [matches, now]
  );
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
              <button
                className="watch-btn hot"
                onClick={() => setWatching(liveMatches[0])}
              >
                ▶ Watch {prettyTeam(liveMatches[0].HomeTeam).label} vs{" "}
                {prettyTeam(liveMatches[0].AwayTeam).label}
              </button>
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
          <span
            className={"toggle-live" + (liveOnly ? " on" : "")}
            onClick={() => setLiveOnly(!liveOnly)}
            role="switch" aria-checked={liveOnly} tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && setLiveOnly(!liveOnly)}
          >
            ● Live only
          </span>
        </div>

        {/* ---------- date rail ---------- */}
        <div className="date-rail" role="tablist" aria-label="Match days (Bangladesh dates)">
          <div
            className={"date-chip" + (selectedDate === "all" ? " active" : "")}
            onClick={() => setSelectedDate("all")} role="tab"
          >
            All<br /><small>days</small>
          </div>
          {allDays.map(([key, d]) => (
            <div
              key={key}
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
            ? "Live data · scores refresh every 60s · times shown in Bangladesh Standard Time"
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
          <section className="day-section" key={key}>
            <div className="day-head">
              <h2>{fmtDateLong.format(dayMatches[0].date)}</h2>
              {key === todayKey && <span className="today-tag">Today</span>}
              <span className="count">{dayMatches.length} match{dayMatches.length > 1 ? "es" : ""}</span>
            </div>
            <div className="match-grid">
              {dayMatches.map((m) => (
                <MatchCard
                  key={m.MatchNumber} m={m} now={now}
                  finalMatchNo={finalMatchNo} onWatch={() => setWatching(m)}
                  onCentre={() => setCentre(m)}
                />
              ))}
            </div>
          </section>
        ))}

        <footer className="footer">
          <span>
            FIFA World Cup 2026 · 11 June – 19 July · fixtures via fixturedownload.com ·
            all times in Bangladesh Standard Time (UTC+6)
          </span>
          <span>Built with React + hls.js + a Python stream relay 🇧🇩</span>
        </footer>
      </main>

      {watching && (
        <VideoPlayer match={watching} streams={streams} onClose={() => setWatching(null)} />
      )}
      {centre && (
        <MatchCentre match={centre} onClose={() => setCentre(null)} />
      )}
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
