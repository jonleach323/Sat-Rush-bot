/**
 * Self-contained monitoring dashboard, styled to match dev.satrush.io
 * (warm near-black #080707, orange #f25e30 accent with glow, warm-tinted
 * panels, Work Sans, uppercase tracked headings). Served at `/` by the API.
 * Open with the token: http://host:port/?token=XXX — kept in memory and sent
 * as a Bearer header. Polls the read-only /api/* endpoints every 3s.
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
  .hero { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px,1fr)); gap:14px; }
  .stat { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px,1fr)); gap:12px; }
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
  .v.pos { color:var(--success); } .v.neg { color:var(--danger); }
  .v.accent { color:var(--accent-hi); text-shadow:0 0 12px var(--glow); }
  .sub { font-size:11px; color:var(--ink-3); margin-top:3px; }
  .board { display:grid; grid-template-columns:repeat(7, 1fr); gap:8px; max-width:600px; }
  .tile {
    aspect-ratio:1/.82; background:var(--sunken); border:1px solid var(--line);
    border-radius:var(--r-lg); display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:2px; transition:.15s; position:relative;
  }
  .tile .i { font-size:10px; color:var(--ink-3); letter-spacing:.05em; }
  .tile .s { font-size:13px; font-weight:600; }
  .tile.mine { border-color:var(--accent); background:linear-gradient(#f25e3014,#0000), var(--sunken);
    box-shadow:0 0 0 1px var(--accent) inset, 0 0 14px #f25e3033; }
  .tile.mine .s { color:var(--accent-hi); }
  .tile.win { border-color:var(--success); box-shadow:0 0 0 1px var(--success) inset, 0 0 14px #30f29733; }
  .tile.hot .s { color:var(--warn); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:22px; }
  @media (max-width:760px){ .grid2 { grid-template-columns:1fr; } }
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

  <div class="hero" id="hero"></div>

  <h2>Current board · <span id="boardsub" class="mono" style="color:var(--ink-2)"></span></h2>
  <div class="board" id="board"></div>

  <h2>Vitals</h2>
  <div class="stat" id="vitals"></div>

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

  <h2>Recent competitor deploys</h2>
  <table id="comp"><thead><tr><th>round</th><th>wallet</th><th class="r">gross</th><th class="r">net stake</th><th>type</th><th class="r">slot</th></tr></thead><tbody></tbody></table>

  <div class="foot">read-only · polling every 3s · Sat Rush strategy client</div>
</main>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
const H = { headers: { authorization: "Bearer " + token } };
const usd = (n) => "$" + (Number(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const base = (v) => Number(v)/1e6;
const short = (s) => s ? s.slice(0,4) + "…" + s.slice(-4) : "";
const el = (id) => document.getElementById(id);
const tilesOf = (mask) => { const t=[]; for(let i=0;i<21;i++) if(mask&(1<<i)) t.push(i); return t; };

async function jget(path){ const r = await fetch(path, H); if(!r.ok) throw new Error("HTTP "+r.status+" on "+path); return r.json(); }

async function poll() {
  try {
    const [s, rounds, deploys, comp, health] = await Promise.all([
      jget("/api/status"), jget("/api/rounds?limit=12"), jget("/api/deploys?limit=10"),
      jget("/api/competitors?limit=12"), jget("/api/health").catch(()=>null),
    ]);
    el("err").style.display="none";
    render(s, rounds, deploys, comp, health);
    el("clock").textContent = new Date().toLocaleTimeString();
  } catch (e) {
    const err = el("err"); err.style.display="block";
    err.textContent = "⚠ " + e.message + (token ? "" : " — append ?token=YOUR_API_TOKEN to the URL");
  }
}

function pill(id, text, cls){ const e=el(id); e.textContent=text; e.className="pill "+(cls||""); }

function render(s, rounds, deploys, comp, health) {
  pill("mode", s.mode, s.mode==="mainnet"?"bad":s.mode==="devnet"?"warn":"");
  pill("round", "round "+(s.round.id??"?")+" · "+(s.round.state??"—")+" · cutoff "+(s.round.slotsToCutoff??"—"), "accent");
  el("kill").style.display = s.killSwitch?"":"none";
  el("paused").style.display = s.paused?"":"none";
  const ing = el("ingest"); ing.className="pill "+(s.ingest.fresh?"ok":"bad");
  ing.innerHTML = '<span class="dot '+(s.ingest.fresh?"ok":"bad")+'"></span>'+(s.ingest.fresh?"ingest live":"STALE "+s.ingest.slotAgeMs+"ms");

  const net = s.pnl.todayNetUsd;
  el("hero").innerHTML = [
    ["Today net", usd(net), net>=0?"pos":"neg", "deployed "+usd(s.pnl.deployedTodayUsd)+" · returned "+usd(s.pnl.returnedTodayUsd)],
    ["Unclaimed", usd(s.unclaimed.usd), "accent", s.unclaimed.shares+" vault shares"],
    ["Board total", usd(s.board.totalUsd), "", (s.round.state||"")+" · "+(s.me.tiles.length?("on "+s.me.tiles.length+" tiles"):"not in round")],
    ["Strike pool", usd(s.board.strikePoolUsd), "accent", "jackpot overlay"],
  ].map(([k,v,c,sub]) => card(k,v,c,sub)).join("");

  const mine = new Set(s.me.tiles);
  const max = Math.max(...s.board.tileStakesUsd, 0.0001);
  el("boardsub").textContent = "total "+usd(s.board.totalUsd)+(s.me.tiles.length?(" · my stake "+usd(s.me.stakeUsd)):"");
  el("board").innerHTML = s.board.tileStakesUsd.map((v,i) => {
    const cls = "tile"+(mine.has(i)?" mine":"")+(v>=max&&v>0?" hot":"");
    return '<div class="'+cls+'"><span class="i">'+i+'</span><span class="s">'+(v>0?usd(v):"·")+'</span></div>';
  }).join("");

  el("vitals").innerHTML = [
    ["Streak", s.me.streak??"—", ""],
    ["My stake", usd(s.me.stakeUsd), ""],
    ["Daily loss left", usd(s.caps.dailyLossLeftUsd), ""],
    ["Max / round", usd(s.caps.maxPerRoundUsd), ""],
    ["SOL", health&&health.solBalance!=null?health.solBalance.toFixed(4):"—", ""],
    ["USDC", health&&health.usdcBalance!=null?usd(health.usdcBalance):"—", ""],
  ].map(([k,v,c]) => card(k,v,c)).join("");

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
}

function card(k,v,c,sub){ return '<div class="card"><div class="k">'+k+'</div><div class="v '+(c||"")+'">'+v+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>'; }
function emptyRow(n){ return '<tr><td colspan="'+n+'" style="color:var(--ink-3);text-align:center;padding:16px">no data yet</td></tr>'; }

poll(); setInterval(poll, 3000);
</script>
</body>
</html>`;
