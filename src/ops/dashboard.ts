/**
 * Self-contained monitoring dashboard (no external assets). Served at `/`
 * by the API. Open with the token in the query: http://host:port/?token=XXX
 * — the token is kept in memory and sent as a Bearer header on each poll.
 * Polls the read-only /api/* endpoints every 3s.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sat Rush — monitor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0b0e13; color: #d7dde5; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid #1c2230; position: sticky; top: 0;
    background: #0b0e13; }
  h1 { font-size: 15px; margin: 0; color: #9aa7b8; font-weight: 600; letter-spacing: .5px; }
  .pill { padding: 2px 9px; border-radius: 999px; font-size: 12px; border: 1px solid #2a3243; }
  .ok { color: #57d38c; border-color: #1e4d34; } .warn { color: #e0b23a; border-color: #4d3f14; }
  .bad { color: #ff6b6b; border-color: #4d1e1e; } .muted { color: #6b7688; }
  #updated { margin-left: auto; font-size: 12px; }
  main { padding: 18px 20px; max-width: 1100px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px; margin-bottom: 22px; }
  .card { background: #10151e; border: 1px solid #1c2230; border-radius: 10px; padding: 12px 14px; }
  .card .k { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #6b7688; }
  .card .v { font-size: 20px; margin-top: 4px; } .pos { color: #57d38c; } .neg { color: #ff6b6b; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: #6b7688;
    margin: 24px 0 10px; }
  .board { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; max-width: 520px; }
  .tile { background: #10151e; border: 1px solid #1c2230; border-radius: 8px; padding: 8px 4px;
    text-align: center; } .tile .i { font-size: 10px; color: #6b7688; }
  .tile .s { font-size: 13px; margin-top: 2px; } .tile.mine { border-color: #2f6b45; background: #10241a; }
  .tile.hot .s { color: #e0b23a; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; color: #6b7688; font-weight: 500; padding: 5px 8px;
    border-bottom: 1px solid #1c2230; } td { padding: 5px 8px; border-bottom: 1px solid #141a24; }
  tr:hover td { background: #10151e; } .r { text-align: right; }
  #err { color: #ff6b6b; padding: 12px 20px; } a { color: #6ea8fe; }
</style>
</head>
<body>
<header>
  <h1>SAT RUSH MONITOR</h1>
  <span id="mode" class="pill muted">…</span>
  <span id="state" class="pill muted">…</span>
  <span id="kill" class="pill" style="display:none">⛔ KILL</span>
  <span id="paused" class="pill warn" style="display:none">⏸ PAUSED</span>
  <span id="ingest" class="pill muted">ingest …</span>
  <span id="updated" class="muted">—</span>
</header>
<div id="err"></div>
<main>
  <div class="cards" id="cards"></div>
  <h2>Current board (my tiles highlighted)</h2>
  <div class="board" id="board"></div>
  <h2>Recent rounds</h2>
  <table id="rounds"><thead><tr><th>round</th><th class="r">win tile</th><th class="r">pot USD</th><th class="r">miners</th><th>strike</th></tr></thead><tbody></tbody></table>
  <h2>Recent competitor deploys</h2>
  <table id="comp"><thead><tr><th>round</th><th>authority</th><th class="r">gross</th><th class="r">stake</th><th>auto</th><th class="r">slot</th></tr></thead><tbody></tbody></table>
</main>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
const H = { headers: { authorization: "Bearer " + token } };
const usd = (n) => "$" + (Number(n)||0).toFixed(2);
const short = (s) => s ? s.slice(0,4) + "…" + s.slice(-4) : "";
const el = (id) => document.getElementById(id);

async function poll() {
  try {
    const [s, rounds, comp] = await Promise.all([
      fetch("/api/status", H).then(r => { if (!r.ok) throw new Error("auth " + r.status); return r.json(); }),
      fetch("/api/rounds?limit=12", H).then(r => r.json()),
      fetch("/api/competitors?limit=12", H).then(r => r.json()),
    ]);
    el("err").textContent = "";
    render(s, rounds, comp);
    el("updated").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    el("err").textContent = "⚠ " + e.message + (token ? "" : " — add ?token=YOUR_TOKEN to the URL");
  }
}

function pill(id, text, cls) { const e = el(id); e.textContent = text; e.className = "pill " + cls; }

function render(s, rounds, comp) {
  pill("mode", s.mode, s.mode === "mainnet" ? "bad" : s.mode === "devnet" ? "warn" : "muted");
  pill("state", "round " + (s.round.id ?? "?") + " · " + (s.round.state ?? "—") +
    " · cutoff " + (s.round.slotsToCutoff ?? "—"), "muted");
  el("kill").style.display = s.killSwitch ? "" : "none";
  el("paused").style.display = s.paused ? "" : "none";
  pill("ingest", "ingest " + (s.ingest.fresh ? "fresh" : "STALE " + s.ingest.slotAgeMs + "ms"),
    s.ingest.fresh ? "ok" : "bad");

  const net = s.pnl.todayNetUsd;
  el("cards").innerHTML = [
    ["today net", usd(net), net >= 0 ? "pos" : "neg"],
    ["deployed today", usd(s.pnl.deployedTodayUsd), ""],
    ["unclaimed USD", usd(s.unclaimed.usd), ""],
    ["unclaimed shares", s.unclaimed.shares, ""],
    ["streak", s.me.streak ?? "—", ""],
    ["my stake (round)", usd(s.me.stakeUsd), ""],
    ["board total", usd(s.board.totalUsd), ""],
    ["strike pool", usd(s.board.strikePoolUsd), ""],
    ["daily loss left", usd(s.caps.dailyLossLeftUsd), ""],
    ["max / round", usd(s.caps.maxPerRoundUsd), ""],
  ].map(([k,v,c]) => '<div class="card"><div class="k">'+k+'</div><div class="v '+c+'">'+v+'</div></div>').join("");

  const mine = new Set(s.me.tiles);
  const max = Math.max(...s.board.tileStakesUsd, 0.0001);
  el("board").innerHTML = s.board.tileStakesUsd.map((v,i) =>
    '<div class="tile'+(mine.has(i)?" mine":"")+(v>=max&&v>0?" hot":"")+'"><div class="i">'+i+'</div><div class="s">'+usd(v)+'</div></div>').join("");

  el("rounds").querySelector("tbody").innerHTML = rounds.map(r =>
    '<tr><td>'+r.id+'</td><td class="r">'+(r.winning_tile ?? "—")+'</td><td class="r">'+usd(Number(r.deployed_usd)/1e6)+
    '</td><td class="r">'+r.miners_count+'</td><td>'+(r.strike_triggered?"⚡":"")+'</td></tr>').join("");

  el("comp").querySelector("tbody").innerHTML = comp.map(c =>
    '<tr><td>'+c.round_id+'</td><td>'+short(c.authority)+'</td><td class="r">'+usd(Number(c.amount)/1e6)+
    '</td><td class="r">'+usd(Number(c.total_stake)/1e6)+'</td><td>'+(c.is_automation?"auto":"")+'</td><td class="r">'+c.slot+'</td></tr>').join("");
}
poll(); setInterval(poll, 3000);
</script>
</body>
</html>`;
