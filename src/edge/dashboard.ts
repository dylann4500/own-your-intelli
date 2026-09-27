export const EDGE_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QM Edge</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#2a313c; --text:#e6edf3; --muted:#8b949e; --human:#58a6ff; --agent:#d2a8ff; --ok:#3fb950; --off:#6e7681; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:16px 20px; border-bottom:1px solid var(--line); }
  h1 { font-size:20px; margin:0 12px 0 0; letter-spacing:.3px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; }
  input, button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
  button { cursor:pointer; }
  main { display:grid; grid-template-columns:minmax(260px,1fr) minmax(320px,2fr) minmax(280px,1.3fr); gap:16px; padding:16px 20px; }
  @media (max-width: 900px) { main { grid-template-columns:1fr; } }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; min-height:120px; }
  .peer { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--line); }
  .peer:last-child { border-bottom:0; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--off); flex:none; }
  .online .dot { background:var(--ok); box-shadow:0 0 8px var(--ok); }
  .badge { font-size:11px; padding:1px 7px; border-radius:10px; border:1px solid currentColor; }
  .human { color:var(--human); } .agent { color:var(--agent); } .system { color:var(--muted); }
  .muted { color:var(--muted); font-size:13px; }
  .event { display:grid; grid-template-columns:56px 120px 1fr; gap:8px; padding:5px 0; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; }
  .event.fresh { animation:flash 1.2s ease-out; }
  @keyframes flash { from { background:#1f6feb44; } to { background:transparent; } }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td, th { text-align:left; padding:5px 4px; border-bottom:1px solid var(--line); }
  #status { font-weight:600; }
</style>
</head>
<body>
<header>
  <h1>QM Edge</h1>
  <label>Project <input id="project" size="12"></label>
  <label>Join token <input id="token" type="password" size="12"></label>
  <button id="apply">Watch</button>
  <span id="status" class="muted">not connected</span>
</header>
<main>
  <section><h2>Presence</h2><div id="peers" class="muted">No peers yet</div></section>
  <section><h2>Event stream</h2><div id="events" class="muted">No events yet</div></section>
  <section><h2>Live resources</h2><div id="resources" class="muted">Nothing announced yet</div></section>
</main>
<script>
(function () {
  var params = new URLSearchParams(location.hash.slice(1));
  var projectInput = document.getElementById("project");
  var tokenInput = document.getElementById("token");
  var statusEl = document.getElementById("status");
  function stored(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { return; } }
  projectInput.value = params.get("project") || stored("qmEdge.project", "unity-demo");
  tokenInput.value = params.get("token") || stored("qmEdge.token", "");
  var lastTop = 0;
  function esc(v) { return String(v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function vec(v) { return Array.isArray(v) ? "(" + v.map(function (n) { return typeof n === "number" ? Math.round(n * 100) / 100 : n; }).join(", ") + ")" : ""; }
  function get(path) {
    return fetch("/edge/v1/projects/" + encodeURIComponent(projectInput.value) + path, { headers: { authorization: "Bearer " + tokenInput.value } })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 401 ? "wrong join token" : "HTTP " + r.status); return r.json(); });
  }
  function coalesce(ops) {
    var out = [];
    ops.forEach(function (op) {
      var last = out[out.length - 1];
      if (last && last.op.actorId === op.actorId && last.op.resourceId === op.resourceId && last.op.action === op.action) { last.op = op; last.count++; return; }
      out.push({ op: op, count: 1 });
    });
    return out;
  }
  function render(presence, events, resources) {
    var peers = presence.members;
    document.getElementById("peers").innerHTML = peers.length ? peers.map(function (m) {
      var where = m.adapter === "unity" ? "Unity" : (m.adapter || "");
      var working = m.workingOn && (m.workingOn.label || m.workingOn.resourceId);
      return '<div class="peer ' + m.status + '"><span class="dot"></span><div><div><strong>' + esc(m.displayName) + '</strong> <span class="badge ' + m.actorType + '">' + m.actorType + '</span> ' + esc(where) + '</div><div class="muted">' + esc(m.status) + (m.deviceName ? " · " + esc(m.deviceName) : "") + (working && m.status === "online" ? " · working on " + esc(working) : "") + '</div></div></div>';
    }).join("") : '<span class="muted">No peers yet</span>';
    var rows = coalesce(events.operations).slice(-40).reverse();
    var top = events.latestSequence;
    document.getElementById("events").innerHTML = rows.length ? rows.map(function (row, i) {
      var op = row.op;
      var fresh = i === 0 && top > lastTop && lastTop !== 0 ? " fresh" : "";
      return '<div class="event' + fresh + '"><span class="muted">#' + op.sequence + '</span><span class="' + op.actor.type + '">' + esc(op.actor.displayName) + '</span><span>' + esc(op.label || op.action + " " + op.resourceId) + (row.count > 1 ? ' <span class="muted">x' + row.count + '</span>' : "") + '</span></div>';
    }).join("") : '<span class="muted">No events yet</span>';
    lastTop = top;
    var res = resources.resources;
    document.getElementById("resources").innerHTML = res.length ? '<table><tr><th>Name</th><th>Position</th><th>Props</th></tr>' + res.map(function (r) {
      var p = r.properties;
      var extra = p["light.intensity"] !== undefined ? "intensity " + p["light.intensity"] : (p.primitive || r.resourceType);
      return "<tr><td>" + esc(p.name || r.resourceId) + "</td><td>" + esc(vec(p.position)) + "</td><td>" + esc(extra) + "</td></tr>";
    }).join("") + "</table>" : '<span class="muted">Nothing announced yet</span>';
  }
  function tick() {
    Promise.all([get("/presence"), get("/events?limit=400"), get("/resources")]).then(function (r) {
      statusEl.textContent = "live · seq " + r[1].latestSequence;
      statusEl.style.color = "var(--ok)";
      render(r[0], r[1], r[2]);
    }).catch(function (e) {
      statusEl.textContent = e.message;
      statusEl.style.color = "#f85149";
    }).then(function () { setTimeout(tick, 700); });
  }
  document.getElementById("apply").addEventListener("click", function () {
    store("qmEdge.project", projectInput.value);
    store("qmEdge.token", tokenInput.value);
    lastTop = 0;
  });
  tick();
})();
</script>
</body>
</html>
`;
