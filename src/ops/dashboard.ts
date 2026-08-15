/**
 * Self-contained monitoring dashboard, styled to match dev.satrush.io
 * (warm near-black #080707, orange #f25e30 accent with glow, warm-tinted
 * panels, Work Sans, uppercase tracked headings). Served at `/` by the API.
 * Open with the token: http://host:port/?token=XXX — kept in memory and sent
 * as a Bearer header. Polls the read-only /api/* endpoints every 3s.
 *
 * Organised around one question the operator actually needs answered — is
 * there an edge right now, and is the model telling the truth about it — so
 * the verdict strip and the intel panels lead, and the raw tables follow.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#080707" />
<title>Sat Rush · monitor</title>
<style>
  @import url("https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600;700&display=swap");
  :root {
    --bg:#080707; --accent:#f25e30; --accent-hi:#f9a074; --glow:#f25e308c;
    --ink:#eee8e8; --ink-2:#958787; --ink-3:#8b7f7f; --line:#2b2121;
    --raised:#201818; --raised-hi:#372a2a; --sunken:#1b1515;
    --success:#30f297; --danger:#ff3d67; --warn:#f2be30;
    --r-md:.375rem; --r-lg:.5rem; --r-xl:.75rem; --r-2xl:1rem;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html,body { margin:0; }
  body {
    font-family:"Work Sans", ui-sans-serif, system-ui, sans-serif;
    color:var(--ink); background:var(--bg);
    background-image:
      radial-gradient(1100px 560px at 50% -12%, #241a1a 0%, #0000 60%),
      linear-gradient(#060505 0%, #0000 55%, #0b0a0a 100%);
    background-attachment:fixed; min-height:100vh;
  }
  .mono { font-variant-numeric:tabular-nums; }
  header {
    display:flex; align-items:center; gap:14px; flex-wrap:wrap;
    padding:14px 22px; border-bottom:1px solid var(--line);
    position:sticky; top:0; z-index:10; backdrop-filter:blur(8px);
    background:linear-gradient(#080707ee, #080707cc);
  }
  .brand { font-weight:700; font-size:16px; letter-spacing:.22em; text-transform:uppercase;
    color:var(--accent); text-shadow:0 0 9px var(--glow); }
  .brand small { color:var(--ink-3); letter-spacing:.18em; font-weight:500; font-size:10px;
    margin-left:8px; text-shadow:none; }
  .pill { padding:3px 11px; border-radius:999px; font-size:12px; letter-spacing:.04em;
    border:1px solid var(--line); background:var(--sunken); color:var(--ink-2);
    text-transform:uppercase; font-weight:500; white-space:nowrap; }
  .pill.ok { color:var(--success); border-color:#1e4d34; }
  .pill.warn { color:var(--warn); border-color:#4d3f14; }
  .pill.bad { color:var(--danger); border-color:#4d1e28; box-shadow:0 0 10px #ff3d6733; }
  .pill.accent { color:var(--accent-hi); border-color:#4d2a17; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:6px;
    vertical-align:middle; }
  .dot.ok { background:var(--success); box-shadow:0 0 8px var(--success); }
  .dot.bad { background:var(--danger); box-shadow:0 0 8px var(--danger); }
  #clock { margin-left:auto; color:var(--ink-3); font-size:12px; letter-spacing:.03em; }
  main { padding:20px 22px 60px; max-width:1180px; margin:0 auto; }
  #err { color:var(--danger); background:#1b1113; border:1px solid #4d1e28; border-radius:var(--r-lg);
    padding:10px 14px; margin-bottom:16px; display:none; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.18em; color:var(--ink-3);
    margin:26px 0 12px; font-weight:600; }
  h2 .note { text-transform:none; letter-spacing:.02em; color:var(--ink-3); font-weight:400; }
  .hero { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px,1fr)); gap:14px; }
  .stat { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:12px; }
  .card {
    background:linear-gradient(#ffffff05 0%, #f25e300d 100%), var(--raised);
    border:1px solid var(--line); border-radius:var(--r-xl); padding:14px 16px;
    position:relative; overflow:hidden;
  }
  .card::before { content:""; position:absolute; inset:0 0 auto 0; height:1px;
    background:linear-gradient(90deg,#0000,#ffffff22,#0000); }
  .card .k { font-size:10px; text-transform:uppercase; letter-spacing:.14em; color:var(--ink-3); }
  .card .v { font-size:22px; margin-top:6px; font-weight:600; letter-spacing:.01em; }
  .hero .card .v { font-size:30px; }
  .v.pos { color:var(--success); } .v.neg { color:var(--danger); } .v.warn { color:var(--warn); }
  .v.accent { color:var(--accent-hi); text-shadow:0 0 12px var(--glow); }
  .v.dim { color:var(--ink-3); }
  .sub { font-size:11px; color:var(--ink-3); margin-top:3px; line-height:1.35; }

  /* Verdict strip — the one-line answer to "should this bot be running". */
  .verdict { border-radius:var(--r-xl); border:1px solid var(--line); padding:14px 18px;
    background:linear-gradient(#ffffff05,#f25e300d), var(--raised); display:flex;
    align-items:center; gap:16px; flex-wrap:wrap; }
  .verdict .tag { font-size:11px; font-weight:700; letter-spacing:.16em; text-transform:uppercase;
    padding:5px 12px; border-radius:999px; white-space:nowrap; }
  .verdict .tag.ok { color:var(--success); background:#30f2971a; border:1px solid #1e4d34; }
  .verdict .tag.warn { color:var(--warn); background:#f2be301a; border:1px solid #4d3f14; }
  .verdict .tag.bad { color:var(--danger); background:#ff3d671a; border:1px solid #4d1e28; }
  .verdict .msg { font-size:13.5px; color:var(--ink-2); line-height:1.45; }
  .verdict .msg b { color:var(--ink); font-weight:600; }

  .board { display:grid; grid-template-columns:repeat(7, 1fr); gap:8px; max-width:620px; }
  .tile {
    aspect-ratio:1/.82; background:var(--sunken); border:1px solid var(--line);
    border-radius:var(--r-lg); display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:2px; transition:.15s; position:relative; overflow:hidden;
  }
  /* Fill height encodes stake relative to the fattest tile, so a uniform board
     (the usual case) reads as flat at a glance instead of needing arithmetic. */
  .tile .fill { position:absolute; left:0; right:0; bottom:0; background:#f25e3021; }
  .tile .i, .tile .s { position:relative; }
  .tile .i { font-size:10px; color:var(--ink-3); letter-spacing:.05em; }
  .tile .s { font-size:13px; font-weight:600; }
  .tile.mine { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset, 0 0 14px #f25e3033; }
  .tile.mine .s { color:var(--accent-hi); }
  .tile.win { border-color:var(--success); box-shadow:0 0 0 1px var(--success) inset, 0 0 14px #30f29733; }
  .tile.hot .s { color:var(--warn); }
  .tile.cold .s { color:var(--success); }

  /* Compact distribution bars (tile fairness, rival timing). */
  .bars { display:flex; align-items:flex-end; gap:3px; height:64px; margin-top:4px; }
  .bars .b { flex:1; background:linear-gradient(#f25e3099,#f25e3033); border-radius:2px 2px 0 0;
    min-height:2px; position:relative; }
  .bars .b.hi { background:linear-gradient(#f2be30cc,#f2be3033); }
  .barlabels { display:flex; justify-content:space-between; font-size:9.5px; color:var(--ink-3);
    margin-top:4px; letter-spacing:.04em; }

  /* Horizontal meter used for shares (automation %, uniform %, fill %). */
  .meter { height:5px; border-radius:999px; background:var(--sunken); margin-top:8px; overflow:hidden; }
  .meter > span { display:block; height:100%; background:linear-gradient(90deg,var(--accent),var(--accent-hi)); }
  .meter.good > span { background:linear-gradient(90deg,#1e9c64,var(--success)); }
  .meter.bad > span { background:linear-gradient(90deg,#a8283f,var(--danger)); }

  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:22px; }
  @media (max-width:760px){ .grid2 { grid-template-columns:1fr; } .board { grid-template-columns:repeat(5,1fr); } }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; color:var(--ink-3); font-weight:600; padding:6px 8px;
    border-bottom:1px solid var(--line); text-transform:uppercase; letter-spacing:.08em; font-size:10px; }
  td { padding:6px 8px; border-bottom:1px solid #171012; }
  tbody tr:hover td { background:var(--raised); }
  .r { text-align:right; } a { color:var(--accent-hi); }
  .win { color:var(--success); } .loss { color:var(--ink-3); } .auto { color:var(--accent-hi); }
  .foot { margin-top:30px; color:var(--ink-3); font-size:11px; text-align:center; letter-spacing:.05em; }
</style>
</head>
<body>
<header>
  <span class="brand">SAT&nbsp;RUSH<small>STRATEGY MONITOR</small></span>
  <span id="mode" class="pill">…</span>
  <span id="round" class="pill">round …</span>
  <span id="kill" class="pill bad" style="display:none">⛔ KILL</span>
  <span id="paused" class="pill warn" style="display:none">⏸ PAUSED</span>
  <span id="ingest" class="pill"><span class="dot"></span>ingest</span>
  <span id="clock" class="mono">—</span>
</header>
<main>
  <div id="err"></div>

  <div class="verdict" id="verdict"></div>

  <h2 style="margin-top:22px">Position</h2>
  <div class="hero" id="hero"></div>

  <h2>Current board · <span id="boardsub" class="mono" style="color:var(--ink-2)"></span></h2>
  <div class="board" id="board"></div>

  <h2>Vitals</h2>
  <div class="stat" id="vitals"></div>
  <div class="stat" id="prices" style="margin-top:12px"></div>

  <h2>Edge &amp; calibration · <span class="note" id="calsub"></span></h2>
  <div class="stat" id="calibration"></div>

  <h2>The field · <span class="note" id="fieldsub"></span></h2>
  <div class="stat" id="field"></div>

  <div class="grid2" style="margin-top:14px">
    <div>
      <h2>Rival fire timing <span class="note">— slots before cutoff</span></h2>
      <div class="card">
        <div class="bars" id="timingbars"></div>
        <div class="barlabels" id="timinglabels"></div>
        <div class="sub" id="timingsub"></div>
      </div>
    </div>
    <div>
      <h2>Winning-tile fairness <span class="note">— χ² vs uniform</span></h2>
      <div class="card">
        <div class="bars" id="fairbars"></div>
        <div class="barlabels"><span>tile 0</span><span>tile 20</span></div>
        <div class="sub" id="fairsub"></div>
      </div>
    </div>
  </div>

  <h2>Daily P&amp;L · <span id="pnlsub" class="mono" style="color:var(--ink-2)"></span></h2>
  <table id="pnl"><thead><tr><th>date</th><th class="r">deployed</th><th class="r">returned</th><th class="r">net</th><th class="r">fees</th></tr></thead><tbody></tbody></table>

  <div class="grid2">
    <div>
      <h2>Recent rounds</h2>
      <table id="rounds"><thead><tr><th>round</th><th class="r">win</th><th class="r">pot</th><th class="r">miners</th><th></th></tr></thead><tbody></tbody></table>
    </div>
    <div>
      <h2>My deploys</h2>
      <table id="deploys"><thead><tr><th>round</th><th>tiles</th><th class="r">amount</th><th>status</th><th class="r">land</th></tr></thead><tbody></tbody></table>
    </div>
  </div>

  <h2>Vault · <span id="vaultsub" class="mono" style="color:var(--ink-2)"></span></h2>
  <div class="stat" id="vaultpools"></div>
  <div class="stat" id="vaultstat" style="margin-top:12px"></div>
  <table id="vaulttbl"><thead><tr><th>kind</th><th class="r">iter</th><th class="r">tickets</th><th>status</th></tr></thead><tbody></tbody></table>

  <h2>Recent competitor deploys</h2>
  <table id="comp"><thead><tr><th>round</th><th>wallet</th><th class="r">gross</th><th class="r">net stake</th><th>type</th><th class="r">slot</th></tr></thead><tbody></tbody></table>

  <div class="foot">read-only · polling every 3s · Sat Rush strategy client</div>
</main>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
const H = { headers: { authorization: "Bearer " + token } };
const usd = (n) => "$" + (Number(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const usd4 = (n) => "$" + (Number(n)||0).toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4});
const base = (v) => Number(v)/1e6;
const pct = (n) => (100*(Number(n)||0)).toFixed(1) + "%";
const bps = (n) => (n==null ? "—" : (n>=0?"+":"") + Math.round(n) + " bps");
const short = (s) => s ? s.slice(0,4) + "…" + s.slice(-4) : "";
const el = (id) => document.getElementById(id);
const tilesOf = (mask) => { const t=[]; for(let i=0;i<21;i++) if(mask&(1<<i)) t.push(i); return t; };

async function jget(path){ const r = await fetch(path, H); if(!r.ok) throw new Error("HTTP "+r.status+" on "+path); return r.json(); }

async function poll() {
  try {
    const [s, rounds, deploys, comp, health, vault, pnl, intel] = await Promise.all([
      jget("/api/status"), jget("/api/rounds?limit=12"), jget("/api/deploys?limit=10"),
      jget("/api/competitors?limit=12"), jget("/api/health").catch(()=>null),
      jget("/api/vault").catch(()=>null), jget("/api/pnl?limit=30").catch(()=>[]),
      jget("/api/intel?window=500").catch(()=>null),
    ]);
    el("err").style.display="none";
    render(s, rounds, deploys, comp, health, vault, pnl, intel);
    el("clock").textContent = new Date().toLocaleTimeString();
  } catch (e) {
    const err = el("err"); err.style.display="block";
    err.textContent = "⚠ " + e.message + (token ? "" : " — append ?token=YOUR_API_TOKEN to the URL");
  }
}

function pill(id, text, cls){ const e=el(id); e.textContent=text; e.className="pill "+(cls||""); }

function render(s, rounds, deploys, comp, health, vault, pnl, intel) {
  pill("mode", s.mode, s.mode==="mainnet"?"bad":s.mode==="devnet"?"warn":"");
  pill("round", "round "+(s.round.id??"?")+" · "+(s.round.state??"—")+" · cutoff "+(s.round.slotsToCutoff??"—"), "accent");
  el("kill").style.display = s.killSwitch?"":"none";
  el("paused").style.display = s.paused?"":"none";
  // A lagging stream is NOT a stale one: it keeps arriving on time from behind
  // head, so it looks healthy while blocking fires. Show it as its own state.
  const lagging = s.ingest.lagBlocking;
  const ingOk = s.ingest.fresh && !lagging;
  const ing = el("ingest"); ing.className="pill "+(ingOk?"ok":lagging?"warn":"bad");
  ing.innerHTML = '<span class="dot '+(ingOk?"ok":"bad")+'"></span>'+(
    !s.ingest.fresh ? "STALE "+s.ingest.slotAgeMs+"ms"
    : lagging ? "LAGGING "+s.ingest.lagSlots+" slots — not firing"
    : "ingest live"+(s.ingest.lagSlots!=null?" · lag "+s.ingest.lagSlots:""));

  renderVerdict(s, intel);

  const net = s.pnl.todayNetUsd;
  el("hero").innerHTML = [
    ["Today net", usd(net), net>=0?"pos":"neg", "deployed "+usd(s.pnl.deployedTodayUsd)+" · returned "+usd(s.pnl.returnedTodayUsd)],
    ["Unclaimed", usd(s.unclaimed.usd + (s.unclaimed.sharesUsd||0)), "accent",
      usd(s.unclaimed.usd)+" USDC + "+usd(s.unclaimed.sharesUsd||0)+" in BTC shares (net of claim fee)"],
    ["Board total", usd(s.board.totalUsd), "", (s.round.state||"")+" · "+(s.me.tiles.length?("on "+s.me.tiles.length+" tiles"):"not in round")],
    ["Strike pool", usd(s.board.strikePoolUsd), "accent", "jackpot overlay"],
  ].map(([k,v,c,sub]) => card(k,v,c,sub)).join("");

  renderBoard(s);

  el("vitals").innerHTML = [
    ["Streak", s.me.streak??"—", ""],
    ["My stake", usd(s.me.stakeUsd), ""],
    ["Daily loss left", usd(s.caps.dailyLossLeftUsd), ""],
    ["Max / round", usd(s.caps.maxPerRoundUsd), ""],
    ["SOL", health&&health.solBalance!=null?health.solBalance.toFixed(4):"—", ""],
    ["USDC", health&&health.usdcBalance!=null?usd(health.usdcBalance):"—", ""],
  ].map(([k,v,c]) => card(k,v,c)).join("");

  // Oracle prices. "fallback" is a warning, not a footnote: every
  // BTC-denominated figure below and the tip sizing are scaled by these.
  const px = s.prices || {btc:{usd:0,live:false},sol:{usd:0,live:false}};
  el("prices").innerHTML = [
    ["BTC / USD", usd(px.btc.usd), px.btc.live?"":"neg", px.btc.live?"pyth live":"FALLBACK — oracle rejected"],
    ["SOL / USD", usd(px.sol.usd), px.sol.live?"":"neg", px.sol.live?"pyth live":"FALLBACK — oracle rejected"],
  ].map(([k,v,c,sub]) => card(k,v,c,sub)).join("");

  renderIntel(intel, vault);

  el("rounds").querySelector("tbody").innerHTML = rounds.map(r =>
    '<tr><td class="mono">'+r.id+'</td><td class="r mono">'+(r.winning_tile??"—")+'</td><td class="r mono">'+usd(base(r.deployed_usd))+
    '</td><td class="r mono">'+r.miners_count+'</td><td class="r">'+(r.strike_triggered?"⚡":"")+'</td></tr>').join("") || emptyRow(5);

  el("deploys").querySelector("tbody").innerHTML = deploys.map(d => {
    const land = d.landed_slot&&d.fired_slot ? "+"+(d.landed_slot-d.fired_slot) : "—";
    const cls = d.status==="landed"?"win":d.status==="missed"||d.status==="failed"?"loss":"";
    return '<tr><td class="mono">'+d.round_id+'</td><td class="mono">'+tilesOf(d.mask).join(",")+'</td><td class="r mono">'+usd(base(d.amount))+
      '</td><td class="'+cls+'">'+d.status+'</td><td class="r mono">'+land+'</td></tr>';
  }).join("") || emptyRow(5);

  el("comp").querySelector("tbody").innerHTML = comp.map(c =>
    '<tr><td class="mono">'+c.round_id+'</td><td class="mono">'+short(c.authority)+'</td><td class="r mono">'+usd(base(c.amount))+
    '</td><td class="r mono">'+usd(base(c.total_stake))+'</td><td class="'+(c.is_automation?"auto":"")+'">'+(c.is_automation?"auto":"manual")+
    '</td><td class="r mono">'+c.slot+'</td></tr>').join("") || emptyRow(6);

  renderVault(vault);
  renderPnl(pnl);
}

/**
 * The headline judgement. Two things can make running the sniper pointless:
 * boards that settle uniform (nothing to snipe) and realized edge below what
 * flat passive play earns. Both are stated plainly rather than left for the
 * operator to infer from six other numbers.
 */
function renderVerdict(s, intel) {
  const v = el("verdict");
  if (!intel) { v.innerHTML = '<span class="tag warn">no intel</span><span class="msg">Intel endpoint unavailable.</span>'; return; }
  const c = intel.calibration || {};
  const u = intel.uniformity || {};
  const notes = [];
  let tag = "ok", label = "edge present";

  if (u.uniformShare != null && u.uniformShare >= 0.8) {
    tag = "bad"; label = "no tile edge";
    notes.push("<b>"+pct(u.uniformShare)+"</b> of recent boards settled effectively uniform — the field covers every tile, so tile selection is worth roughly nothing right now.");
  } else if (u.medianCov != null) {
    notes.push("Median board spread <b>"+pct(u.medianCov)+"</b> — thin tiles do exist to aim at.");
  }

  if (c.realizedBps != null) {
    const beats = c.realizedBps > c.benchmarkBps;
    if (!beats && tag !== "bad") { tag = "warn"; label = "below benchmark"; }
    notes.push("Realized <b>"+bps(c.realizedBps)+"</b> over "+c.landed+" landed deploys vs a passive all-21 benchmark of <b>"+bps(c.benchmarkBps)+"</b>"
      + (beats ? " — the sniper is earning its keep." : " — flat passive play would have done better."));
  } else {
    if (tag === "ok") { tag = "warn"; label = "unproven"; }
    notes.push("No settled deploys yet — realized edge unmeasured.");
  }

  if (c.modeledBps != null && c.realizedBps != null) {
    const drift = c.modeledBps - c.realizedBps;
    if (Math.abs(drift) > 300) {
      notes.push("Model is <b>"+(drift>0?"optimistic":"pessimistic")+"</b> by "+Math.abs(Math.round(drift))+" bps — thresholds are mis-set at the margin.");
    }
  }
  v.innerHTML = '<span class="tag '+tag+'">'+label+'</span><span class="msg">'+notes.join(" ")+'</span>';
}

function renderBoard(s) {
  const mine = new Set(s.me.tiles);
  const stakes = s.board.tileStakesUsd;
  const max = Math.max.apply(null, stakes.concat([0.0001]));
  const min = Math.min.apply(null, stakes);
  el("boardsub").textContent = "total "+usd(s.board.totalUsd)
    + (s.me.tiles.length?(" · my stake "+usd(s.me.stakeUsd)):"")
    + " · spread "+usd(min)+"–"+usd(max);
  el("board").innerHTML = stakes.map((v,i) => {
    const cls = "tile"+(mine.has(i)?" mine":"")+(v>=max&&v>0?" hot":(v<=min&&max>0?" cold":""));
    const h = max>0 ? Math.round(100*v/max) : 0;
    return '<div class="'+cls+'"><div class="fill" style="height:'+h+'%"></div>'
      + '<span class="i">'+i+'</span><span class="s">'+(v>0?usd(v):"·")+'</span></div>';
  }).join("");
}

function renderIntel(intel, vault) {
  if (!intel) {
    el("calsub").textContent = "unavailable";
    el("fieldsub").textContent = "unavailable";
    return;
  }
  const c = intel.calibration || {};
  const hv = (vault && vault.hashrateValue) || null;
  el("calsub").textContent = c.landed + " landed deploys measured";
  el("calibration").innerHTML = [
    ["Realized edge", bps(c.realizedBps),
      c.realizedBps==null ? "dim" : c.realizedBps>c.benchmarkBps ? "pos" : "neg",
      "USD "+bps(c.realizedUsdBps)+" + BTC shares "+bps(c.realizedSharesBps)
      +" · vs "+bps(c.benchmarkBps)+" passive benchmark"],
    ["Modeled edge", bps(c.modeledBps), c.modeledBps==null?"dim":"", "what the EV model predicted"],
    ["Model drift", (c.modeledBps!=null&&c.realizedBps!=null) ? bps(c.modeledBps-c.realizedBps) : "—",
      (c.modeledBps!=null&&c.realizedBps!=null&&Math.abs(c.modeledBps-c.realizedBps)>300)?"warn":"dim",
      "positive = over-optimistic"],
    ["Hashrate value", hv ? usd4(hv.usdPerRawUnit) : "—", hv&&hv.usdPerRawUnit>0?"accent":"dim",
      hv ? ("per raw unit · "+hv.source) : "—"],
    ["Strike cadence", intel.strike.strikes+" / "+intel.strike.rounds+" rounds", "",
      intel.strike.roundsSinceLast!=null ? (intel.strike.roundsSinceLast+" rounds since last") : "none observed"],
  ].map(([k,v,cl,sub]) => card(k,v,cl,sub)).join("");

  const f = intel.field || {};
  const u = intel.uniformity || {};
  const sk = intel.skips || [];
  const skTotal = sk.reduce((a,x)=>a+x.count,0);
  el("fieldsub").textContent = "last "+intel.windowRounds+" rounds · "+f.rounds+" with data"
    + (skTotal ? " · "+skTotal+" rounds skipped: "+sk.slice(0,3).map(x=>x.reason+" ("+x.count+")").join(", ") : "");
  el("field").innerHTML = [
    ["Distinct rivals", f.distinctRivals??0, "", f.deploys+" deploys seen"],
    ["Deploys / round", (f.avgDeploysPerRound||0).toFixed(1), "", "avg stake "+usd(f.avgRivalStakeUsd||0)],
    ["Automation share", pct(f.automationShare), "", meter(f.automationShare, "")],
    ["Cover all 21 tiles", pct(f.fullBoardShare),
      (f.fullBoardShare||0)>0.5?"warn":"", meter(f.fullBoardShare, (f.fullBoardShare||0)>0.5?"bad":"")],
    ["Board spread", u.medianCov!=null ? pct(u.medianCov) : "—", u.medianCov==null?"dim":"",
      "median CoV"+(u.residualCov!=null ? " · "+pct(u.residualCov)+" excl. blanket automations" : "")],
    ["Blanket-spread share", u.blanketShare!=null ? pct(u.blanketShare) : "—",
      u.blanketShare==null ? "dim" : (u.blanketShare>0.4?"warn":""),
      "of board stake from all-21 deployers"+meter(u.blanketShare, "")],
    ["Uniform boards", u.uniformShare!=null ? pct(u.uniformShare) : "—",
      u.uniformShare==null ? "dim" : u.uniformShare>=0.8 ? "neg" : "pos",
      meter(u.uniformShare, (u.uniformShare||0)>=0.8 ? "bad" : "good")],
  ].map(([k,v,cl,sub]) => card(k,v,cl,sub)).join("");

  renderTiming(intel.rivalTiming);
  renderFairness(intel.fairness);
}

/**
 * Rival commit timing as a histogram of slots-before-cutoff. This is the view
 * no public tracker has — we record the slot each rival's deploy landed in, so
 * we can separate rivals who commit blind and early from ones who wait and
 * react to a board we have already moved.
 */
function renderTiming(t) {
  if (!t) { el("timingbars").innerHTML=""; el("timinglabels").innerHTML=""; el("timingsub").textContent="no timing data yet"; return; }
  // Fixed 10-bucket histogram over [0, p90] so the shape is comparable over time.
  const span = Math.max(1, t.p90);
  const buckets = new Array(10).fill(0);
  // We only have percentiles, not raw samples — approximate the shape from the
  // three known quantiles so the panel still communicates spread honestly.
  const marks = [[t.p10,0.1],[t.p50,0.5],[t.p90,0.9]];
  let prev = 0;
  for (const [val, q] of marks) {
    const idx = Math.min(9, Math.max(0, Math.floor((val/span)*10)));
    buckets[idx] += (q - prev);
    prev = q;
  }
  const peak = Math.max.apply(null, buckets.concat([0.0001]));
  el("timingbars").innerHTML = buckets.map(b =>
    '<div class="b'+(b>=peak?" hi":"")+'" style="height:'+Math.round(100*b/peak)+'%"></div>').join("");
  el("timinglabels").innerHTML = '<span>at cutoff</span><span>'+t.p90+' slots early</span>';
  el("timingsub").innerHTML = "p10 <b>"+t.p10+"</b> · median <b>"+t.p50+"</b> · p90 <b>"+t.p90+"</b> slots before cutoff"
    + (t.afterUsShare!=null ? (" · <b>"+pct(t.afterUsShare)+"</b> commit later than we fire") : "")
    + " · "+t.samples+" samples";
}

function renderFairness(f) {
  if (!f) { el("fairbars").innerHTML=""; el("fairsub").textContent="no resolved rounds yet"; return; }
  const peak = Math.max.apply(null, f.counts.concat([1]));
  el("fairbars").innerHTML = f.counts.map(c =>
    '<div class="b'+(c>=peak?" hi":"")+'" style="height:'+Math.round(100*c/peak)+'%"></div>').join("");
  el("fairsub").innerHTML = "χ² <b>"+f.chiSquare.toFixed(2)+"</b> vs critical <b>"+f.criticalValue05+"</b> (df "+f.degreesOfFreedom+"), "
    + f.samples + " rounds — "
    + (f.looksUniform
        ? "draws are consistent with uniform; there is no tile bias to exploit."
        : "<b style='color:var(--warn)'>bias detected</b> — worth investigating.");
}

function meter(frac, cls) {
  const w = Math.round(100*Math.min(1, Math.max(0, Number(frac)||0)));
  return '<div class="meter '+(cls||"")+'"><span style="width:'+w+'%"></span></div>';
}

function renderPnl(rows){
  rows = rows||[];
  let allTime=0; for(const r of rows) allTime += base(r.net);
  el("pnlsub").textContent = rows.length
    ? ("net "+usd(allTime)+" over last "+rows.length+" day"+(rows.length>1?"s":""))
    : "no data yet";
  el("pnl").querySelector("tbody").innerHTML = rows.map(r => {
    const net = base(r.net);
    const col = net>=0 ? "var(--success)" : "var(--danger)";
    return '<tr><td class="mono">'+r.date+'</td><td class="r mono">'+usd(base(r.deployed))+
      '</td><td class="r mono">'+usd(base(r.returned))+'</td><td class="r mono" style="color:'+col+'">'+usd(net)+
      '</td><td class="r mono">'+usd(base(r.fees_paid))+'</td></tr>';
  }).join("") || emptyRow(5);
}

function renderVault(v){
  if(!v){ el("vaultsub").textContent="unavailable"; el("vaultstat").innerHTML=""; el("vaultpools").innerHTML=""; return; }
  const ec = v.economics || {};
  const price = ec.usdPerRawUnit;
  const hv = v.hashrateValue || {usdPerRawUnit:0, source:"none"};
  el("vaultsub").textContent = (v.enabled ? "ON" : "OFF")
    + " · pricing hashrate at " + usd4(hv.usdPerRawUnit) + "/raw unit (" + hv.source + ")"
    + (price!=null ? " · realized "+usd4(price) : "");

  // Pools first — these are the numbers that decide whether to enter.
  const p = v.pools;
  el("vaultpools").innerHTML = !p ? "" : [
    p.epoch ? ["Epoch pool", usd(p.epoch.poolUsd), "accent",
      "iter "+p.epoch.iterationId+" · "+(p.epoch.open?"open":"closed")
      +" · "+p.epoch.slotsToClose+" slots left"] : null,
    p.epoch ? ["Epoch field", p.epoch.totalTickets.toLocaleString()+" tickets", "",
      "mine "+p.epoch.myTickets] : null,
    p.epoch ? ["Epoch ticket EV", usd4(p.epoch.ticketEvUsd),
      p.epoch.ticketEvUsd>0?"pos":"dim", "value of the next ticket"] : null,
    p.oneBtc ? ["1-BTC prize", usd(p.oneBtc.prizeUsd), "accent",
      "iter "+p.oneBtc.iterationId+" · "+(p.oneBtc.fillBps/100).toFixed(1)+"% to trigger"
      + meter(p.oneBtc.fillBps/10000, "")] : null,
    p.oneBtc ? ["1-BTC field", p.oneBtc.totalTickets.toLocaleString()+" tickets", ""] : null,
    p.oneBtc ? ["1-BTC ticket EV", usd4(p.oneBtc.ticketEvUsd),
      p.oneBtc.ticketEvUsd>0?"pos":"dim", "value of the next ticket"] : null,
  ].filter(Boolean).map(([k,val,c,sub]) => card(k,val,c,sub)).join("");

  el("vaultstat").innerHTML = [
    ["Hashrate", v.hashrate.toLocaleString(), ""],
    ["Unclaimed HR", v.unclaimedHashrate.toLocaleString(), ""],
    ["Epoch tickets", v.epoch.ticketsBought, ""],
    ["Epoch claims", v.epoch.iterationsClaimed+"/"+v.epoch.iterationsPlayed, ""],
    ["1-BTC tickets", v.oneBtc.ticketsBought, ""],
    ["1-BTC claims", v.oneBtc.iterationsClaimed+"/"+v.oneBtc.iterationsPlayed, ""],
    ["HR spent (raw)", (ec.hashrateSpentRaw??0).toLocaleString(), ""],
    ["Claimed value", usd((ec.usdClaimed||0)+(ec.btcClaimedUsd||0)), (ec.iterationsPaid?"pos":"dim")],
  ].map(([k,val,c,sub]) => card(k,val,c,sub)).join("");

  el("vaulttbl").querySelector("tbody").innerHTML = (v.recent||[]).map(r =>
    '<tr><td>'+r.kind+'</td><td class="r mono">'+r.iteration_id+'</td><td class="r mono">'+r.tickets+
    '</td><td class="'+(r.claimed?"win":"")+'">'+(r.claimed?"claimed":"open")+'</td></tr>').join("") || emptyRow(4);
}

function card(k,v,c,sub){ return '<div class="card"><div class="k">'+k+'</div><div class="v '+(c||"")+'">'+v+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>'; }
function emptyRow(n){ return '<tr><td colspan="'+n+'" style="color:var(--ink-3);text-align:center;padding:16px">no data yet</td></tr>'; }

poll(); setInterval(poll, 3000);
</script>
</body>
</html>`;
