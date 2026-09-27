export const EDGE_ROOM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QM Edge Room</title>
<style>
  :root { --bg:#0d1015; --panel:#151a21; --panel2:#1b212a; --line:#29313c; --text:#e8edf3; --muted:#8d97a3; --human:#5aa9ff; --agent:#c9a2ff; --system:#8d97a3; --ok:#3fb950; --err:#f85149; --accent:#5aa9ff; }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  [hidden] { display:none !important; }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; letter-spacing:.2px; }
  header .sub { color:var(--muted); font-size:13px; }
  header .spacer { flex:1; }
  .pill { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .pill.live { color:var(--ok); border-color:#23462c; }
  .pill.down { color:var(--err); border-color:#5a2a2a; }
  button, input, textarea { font:inherit; color:var(--text); }
  .link { background:none; border:0; color:var(--accent); cursor:pointer; padding:0; font-size:13px; }
  main { display:grid; grid-template-columns:230px minmax(0,1fr) 250px; gap:14px; padding:14px 18px; height:calc(100% - 58px); }
  @media (max-width: 980px) { main { grid-template-columns:1fr; height:auto; } .side { max-height:none; } }
  section { background:var(--panel); border:1px solid var(--line); border-radius:12px; min-height:0; }
  .side { padding:12px 14px; overflow:auto; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:2px 0 10px; font-weight:600; }
  .peer { display:flex; gap:9px; align-items:flex-start; padding:7px 0; border-bottom:1px solid var(--line); }
  .peer:last-child { border-bottom:0; }
  .dot { width:9px; height:9px; border-radius:50%; background:#4b535d; margin-top:6px; flex:none; }
  .peer.online .dot { background:var(--ok); box-shadow:0 0 7px var(--ok); }
  .peer.busy .dot { background:var(--agent); box-shadow:0 0 9px var(--agent); animation:pulse 1.2s infinite; }
  @keyframes pulse { 50% { opacity:.35; } }
  .peer .meta { color:var(--muted); font-size:12px; }
  .tag { font-size:11px; border:1px solid currentColor; border-radius:9px; padding:0 6px; margin-left:4px; }
  .human { color:var(--human); } .agent { color:var(--agent); } .system { color:var(--system); }
  .center { display:flex; flex-direction:column; overflow:hidden; }
  .hint { padding:10px 16px; border-bottom:1px solid var(--line); color:var(--muted); font-size:13px; }
  #feed { flex:1; overflow:auto; padding:12px 16px; display:flex; flex-direction:column; gap:8px; }
  .msg { max-width:78%; padding:9px 12px; border-radius:12px; background:var(--panel2); border:1px solid var(--line); }
  .msg .who { font-size:12px; font-weight:600; margin-bottom:3px; }
  .msg .text { white-space:pre-wrap; word-break:break-word; }
  .msg.ask { align-self:flex-start; border-color:#23405e; }
  .msg.ask.mine { align-self:flex-end; background:#16283d; }
  .msg.reply { align-self:flex-start; border-color:#46345f; background:#1d1828; }
  .act { font-size:13px; color:var(--muted); padding:1px 2px; }
  .act b { font-weight:600; }
  .act .seq { font-variant-numeric:tabular-nums; opacity:.6; margin-right:4px; }
  .act.fresh { animation:flash 1.4s ease-out; border-radius:6px; }
  @keyframes flash { from { background:#1f6feb33; } to { background:transparent; } }
  #working { padding:0 16px; }
  .working { font-size:13px; color:var(--agent); padding:6px 0; }
  .working .dots::after { content:"..."; animation:dots 1.2s steps(4) infinite; display:inline-block; width:1.2em; overflow:hidden; vertical-align:bottom; }
  @keyframes dots { from { width:0; } to { width:1.2em; } }
  form.compose { display:flex; gap:8px; padding:12px; border-top:1px solid var(--line); align-items:flex-end; }
  textarea { flex:1; resize:none; min-height:44px; max-height:140px; background:#0b0e12; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  textarea:focus, input:focus { outline:none; border-color:var(--accent); }
  .primary { background:var(--accent); color:#06121f; border:0; border-radius:10px; padding:11px 16px; font-weight:600; cursor:pointer; white-space:nowrap; }
  .primary:disabled { opacity:.5; cursor:default; }
  .error { color:var(--err); font-size:13px; padding:0 14px 8px; }
  .obj { display:flex; justify-content:space-between; gap:8px; font-size:13px; padding:4px 0; border-bottom:1px solid var(--line); }
  .obj:last-child { border-bottom:0; }
  .obj span:last-child { color:var(--muted); font-variant-numeric:tabular-nums; }
  #join { position:fixed; inset:0; display:grid; place-items:center; background:var(--bg); padding:16px; }
  .card { width:min(420px, 100%); background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:22px; }
  .card h1 { margin:0 0 6px; font-size:22px; }
  .card p { color:var(--muted); margin:0 0 16px; }
  .card label { display:block; font-size:13px; color:var(--muted); margin:12px 0 5px; }
  .card input { width:100%; background:#0b0e12; border:1px solid var(--line); border-radius:9px; padding:10px 12px; }
  .card .primary { width:100%; margin-top:18px; }
  .empty { color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<div id="join" hidden>
  <form class="card" id="joinForm">
    <h1>QM Edge Room</h1>
    <p>Prompt your own AI agent and watch it build in the shared live scene, next to everyone else's agents.</p>
    <label for="joinName">Your name</label>
    <input id="joinName" maxlength="40" placeholder="e.g. Sam" autocomplete="off" required>
    <div id="tokenRow">
      <label for="joinToken">Join token</label>
      <input id="joinToken" placeholder="from the person running the hub" autocomplete="off">
    </div>
    <button class="primary" type="submit">Enter the room</button>
    <div class="error" id="joinError" style="padding:10px 0 0"></div>
  </form>
</div>
<div id="app" hidden>
  <header>
    <h1>QM Edge Room</h1>
    <span class="sub" id="project"></span>
    <span class="pill" id="status">connecting</span>
    <span class="spacer"></span>
    <span class="sub">You: <b id="me"></b> <button class="link" id="changeName" type="button">change</button></span>
  </header>
  <main>
    <section class="side">
      <h2>People</h2>
      <div id="humans" class="empty">Nobody yet</div>
      <h2 style="margin-top:18px">Agents</h2>
      <div id="agents" class="empty">No agents yet. Ask yours below.</div>
    </section>
    <section class="center">
      <div class="hint">Your prompts go to <b id="myAgent"></b>. Everything any agent or person changes shows up here and in every connected Unity Editor, live.</div>
      <div id="feed"></div>
      <div id="working"></div>
      <div class="error" id="composeError"></div>
      <form class="compose" id="composer">
        <textarea id="prompt" rows="1" maxlength="2000" placeholder="Ask your agent to build something. Example: Build three pillars to the left of the Player"></textarea>
        <button class="primary" id="send" type="submit">Ask my agent</button>
      </form>
    </section>
    <section class="side">
      <h2>Live objects <span id="objCount"></span></h2>
      <div id="objects" class="empty">Nothing yet</div>
    </section>
  </main>
</div>
<script>
(function () {
  var byId = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.hash.slice(1));
  function load(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, value); } catch (e) { return; } }
  var state = {
    token: params.get("token") || load("qmEdge.token", ""),
    project: params.get("project") || load("qmEdge.project", "unity-demo"),
    name: load("qmEdge.name", ""),
    lastSeq: 0,
    polling: false,
    items: [],
    newestShown: 0
  };
  if (params.get("token")) save("qmEdge.token", state.token);
  if (params.get("project")) save("qmEdge.project", state.project);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "guest"; }
  function esc(value) { return String(value).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function vec(v) { return Array.isArray(v) ? "(" + v.map(function (n) { return typeof n === "number" ? Math.round(n * 10) / 10 : n; }).join(", ") + ")" : ""; }
  function myHumanId() { return "web:" + slug(state.name); }

  function api(path, init) {
    var options = init || {};
    options.headers = { authorization: "Bearer " + state.token };
    if (options.body) options.headers["content-type"] = "application/json";
    return fetch("/edge/v1/projects/" + encodeURIComponent(state.project) + path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          var error = new Error(body.message || ("HTTP " + response.status));
          error.status = response.status;
          throw error;
        }
        return body;
      });
    });
  }

  function showJoin(message) {
    state.polling = false;
    byId("app").hidden = true;
    byId("join").hidden = false;
    byId("joinName").value = state.name;
    byId("joinToken").value = state.token;
    byId("tokenRow").hidden = Boolean(state.token) && !message;
    byId("joinError").textContent = message || "";
    byId("joinName").focus();
  }

  byId("joinForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var name = byId("joinName").value.trim().slice(0, 40);
    var token = byId("joinToken").value.trim() || state.token;
    if (!name) return;
    if (!token) { byId("tokenRow").hidden = false; byId("joinError").textContent = "Paste the join token."; return; }
    state.name = name;
    state.token = token;
    save("qmEdge.name", name);
    save("qmEdge.token", token);
    start();
  });
  byId("changeName").addEventListener("click", function () { showJoin(); });

  function setStatus(ok, text) {
    var el = byId("status");
    el.className = "pill " + (ok ? "live" : "down");
    el.textContent = text;
  }

  function kindOf(op) {
    if (op.adapter !== "edge") return "scene";
    if (op.action === "reply") return "reply";
    if (op.action === "ask") return "ask";
    return "say";
  }

  function addOps(ops) {
    ops.forEach(function (op) {
      if (op.sequence <= state.lastSeq) return;
      state.lastSeq = op.sequence;
      var kind = kindOf(op);
      var last = state.items[state.items.length - 1];
      if (kind === "scene" && last && last.kind === "scene" && last.op.actorId === op.actorId && last.op.resourceId === op.resourceId && last.op.action === op.action) {
        last.op = op;
        last.count++;
        return;
      }
      state.items.push({ kind: kind, op: op, count: 1 });
    });
    if (state.items.length > 400) state.items.splice(0, state.items.length - 400);
  }

  function itemHtml(item) {
    var op = item.op;
    var text = op.payload && typeof op.payload.text === "string" ? op.payload.text : "";
    if (item.kind === "ask") {
      var mine = op.actorId === myHumanId();
      return '<div class="msg ask' + (mine ? " mine" : "") + '"><div class="who human">' + esc(op.actor.displayName) + ' <span class="tag">to their agent</span></div><div class="text">' + esc(text) + '</div></div>';
    }
    if (item.kind === "reply" || item.kind === "say") {
      return '<div class="msg reply"><div class="who ' + esc(op.actor.type) + '">' + esc(op.actor.displayName) + '</div><div class="text">' + esc(text || op.label || "") + '</div></div>';
    }
    var fresh = op.sequence > state.newestShown ? " fresh" : "";
    return '<div class="act' + fresh + '"><span class="seq">#' + op.sequence + '</span><b class="' + esc(op.actor.type) + '">' + esc(op.actor.displayName) + '</b> ' + esc(op.label || (op.action + " " + op.resourceId)) + (item.count > 1 ? " (x" + item.count + ")" : "") + '</div>';
  }

  function renderFeed() {
    var feed = byId("feed");
    var nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    feed.innerHTML = state.items.length ? state.items.map(itemHtml).join("") : '<div class="empty">No activity yet. Ask your agent to build something.</div>';
    state.newestShown = state.lastSeq;
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  }

  function isBusy(member) {
    return member.actorType === "agent" && member.status === "online" && member.workingOn && typeof member.workingOn.label === "string" && member.workingOn.label.indexOf("working on:") === 0;
  }

  function peerHtml(member) {
    var where = member.adapter === "unity" ? "in Unity" : (member.actorType === "agent" ? "agent" : "in the room");
    var busy = isBusy(member);
    var detail = busy ? member.workingOn.label : (member.workingOn && member.status === "online" && member.workingOn.label ? "on " + member.workingOn.label : member.status);
    return '<div class="peer ' + (busy ? "busy" : esc(member.status)) + '"><span class="dot"></span><div><div><b class="' + esc(member.actorType) + '">' + esc(member.displayName) + '</b></div><div class="meta">' + esc(where) + ' · ' + esc(detail) + '</div></div></div>';
  }

  function renderPresence(members) {
    var visible = members.filter(function (m) { return m.actorType !== "system"; });
    var humans = visible.filter(function (m) { return m.actorType === "human"; });
    var agents = visible.filter(function (m) { return m.actorType === "agent"; });
    byId("humans").innerHTML = humans.length ? humans.map(peerHtml).join("") : '<span class="empty">Nobody yet</span>';
    byId("agents").innerHTML = agents.length ? agents.map(peerHtml).join("") : '<span class="empty">No agents yet. Ask yours below.</span>';
    var busy = agents.filter(isBusy);
    byId("working").innerHTML = busy.map(function (m) { return '<div class="working"><b>' + esc(m.displayName) + '</b> is ' + esc(m.workingOn.label) + '<span class="dots"></span></div>'; }).join("");
  }

  function renderObjects(resources) {
    byId("objCount").textContent = "(" + resources.length + ")";
    byId("objects").innerHTML = resources.length ? resources.map(function (r) {
      var p = r.properties || {};
      return '<div class="obj"><span>' + esc(p.name || r.resourceId) + '</span><span>' + esc(vec(p.position)) + '</span></div>';
    }).join("") : '<span class="empty">Nothing yet</span>';
  }

  function heartbeat() {
    if (!state.polling) return;
    api("/presence", { method: "POST", body: JSON.stringify({ actor: { id: myHumanId(), displayName: state.name, type: "human" } }) }).catch(function () { return null; });
  }

  function poll() {
    if (!state.polling) return;
    Promise.all([api("/events?after=" + state.lastSeq + "&limit=500"), api("/presence"), api("/resources?adapter=unity")]).then(function (results) {
      setStatus(true, "live");
      var before = state.lastSeq;
      addOps(results[0].operations);
      if (state.lastSeq !== before) renderFeed();
      renderPresence(results[1].members);
      renderObjects(results[2].resources);
    }).catch(function (error) {
      if (error.status === 401) { showJoin("That join token does not match this hub."); return; }
      setStatus(false, "reconnecting");
    }).then(function () { if (state.polling) setTimeout(poll, 700); });
  }

  function start() {
    byId("join").hidden = true;
    byId("app").hidden = false;
    byId("me").textContent = state.name;
    byId("myAgent").textContent = state.name + "'s agent";
    byId("project").textContent = "project " + state.project;
    state.lastSeq = 0;
    state.items = [];
    state.newestShown = Number.MAX_SAFE_INTEGER;
    state.polling = true;
    api("/events?limit=200").then(function (body) {
      addOps(body.operations);
      renderFeed();
      state.newestShown = state.lastSeq;
    }).catch(function (error) {
      if (error.status === 401) showJoin("That join token does not match this hub.");
    }).then(function () { heartbeat(); poll(); });
    byId("prompt").focus();
  }
  setInterval(heartbeat, 45000);

  function send() {
    var text = byId("prompt").value.trim();
    if (!text) return;
    byId("send").disabled = true;
    api("/agent", { method: "POST", body: JSON.stringify({ name: state.name, text: text }) }).then(function () {
      byId("prompt").value = "";
      byId("composeError").textContent = "";
    }).catch(function (error) {
      byId("composeError").textContent = error.message;
    }).then(function () {
      byId("send").disabled = false;
      byId("prompt").focus();
    });
  }
  byId("composer").addEventListener("submit", function (event) { event.preventDefault(); send(); });
  byId("prompt").addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  });

  if (state.name && state.token) start();
  else showJoin();
})();
</script>
</body>
</html>
`;
