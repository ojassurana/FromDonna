/**
 * HTML shells for the message-flow ops dashboard (standalone Worker).
 */

export function loginPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FromDonna · Message flow</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #0b0d10; color: #e8eaed; }
    form { width: min(420px, 92vw); background: #141820; border: 1px solid #2a3140;
      border-radius: 12px; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
    h1 { font-size: 1.15rem; margin: 0 0 6px; }
    p { color: #9aa3b2; font-size: .9rem; margin: 0 0 18px; line-height: 1.45; }
    label { display: block; font-size: .8rem; color: #9aa3b2; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
      border: 1px solid #2a3140; background: #0b0d10; color: #e8eaed; font: inherit; }
    button { margin-top: 14px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px;
      background: #5b8cff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    button:hover { filter: brightness(1.08); }
  </style>
</head>
<body>
  <form id="f">
    <h1>Message flow</h1>
    <p>Ops dashboard for each inbound Telegram turn and its gateway stages.
      Paste <code>OPS_ADMIN_SECRET</code> (often set equal to the gateway harness secret).</p>
    <label for="token">Admin token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required />
    <button type="submit">Open dashboard</button>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value.trim();
      if (!token) return;
      sessionStorage.setItem('fd_admin_token', token);
      location.href = '/?token=' + encodeURIComponent(token);
    });
  </script>
</body>
</html>`;
}

export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FromDonna · Message flow</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --panel: #12161d;
      --panel2: #171c25;
      --border: #273041;
      --text: #e8eaed;
      --muted: #9aa3b2;
      --accent: #5b8cff;
      --ok: #3dd68c;
      --err: #ff6b7a;
      --warn: #f5c542;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); min-height: 100vh; }
    header {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 18px; border-bottom: 1px solid var(--border); background: #0e1218;
      position: sticky; top: 0; z-index: 5;
    }
    header h1 { font-size: 1rem; margin: 0; letter-spacing: .01em; }
    header .sub { color: var(--muted); font-size: .8rem; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    button, select, input {
      background: var(--panel2); color: var(--text); border: 1px solid var(--border);
      border-radius: 8px; padding: 7px 10px; font: inherit; font-size: .85rem;
    }
    button { cursor: pointer; }
    button.primary { background: var(--accent); border-color: transparent; color: #fff; font-weight: 600; }
    button:hover { filter: brightness(1.06); }
    main { display: grid; grid-template-columns: minmax(320px, 1.1fr) minmax(360px, 1.4fr); gap: 0; min-height: calc(100vh - 58px); }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
    .pane { border-right: 1px solid var(--border); overflow: auto; max-height: calc(100vh - 58px); }
    .pane:last-child { border-right: 0; }
    .pane-h { padding: 12px 14px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: .8rem;
      display: flex; justify-content: space-between; gap: 8px; align-items: center; position: sticky; top: 0; background: var(--bg); }
    .list { display: flex; flex-direction: column; }
    .row {
      text-align: left; width: 100%; border: 0; border-bottom: 1px solid var(--border);
      background: transparent; padding: 12px 14px; cursor: pointer; border-radius: 0;
    }
    .row:hover, .row.active { background: var(--panel); }
    .row .top { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
    .row .uid { font-weight: 600; font-size: .88rem; }
    .row .preview { color: var(--muted); font-size: .82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge {
      display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
      font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em;
      border: 1px solid var(--border); color: var(--muted);
    }
    .badge.error { color: var(--err); border-color: rgba(255,107,122,.35); background: rgba(255,107,122,.08); }
    .badge.injected, .badge.complete { color: var(--ok); border-color: rgba(61,214,140,.35); background: rgba(61,214,140,.08); }
    .badge.provisioning, .badge.injecting, .badge.routing, .badge.received {
      color: var(--warn); border-color: rgba(245,197,66,.35); background: rgba(245,197,66,.08);
    }
    .detail { padding: 16px 18px 40px; }
    .empty { color: var(--muted); padding: 28px 18px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0 18px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
    .card .k { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; }
    .card .v { margin-top: 4px; font-size: .9rem; word-break: break-all; }
    .timeline { display: flex; flex-direction: column; gap: 0; }
    .ev {
      display: grid; grid-template-columns: 18px 1fr; gap: 10px; padding: 10px 0;
      border-left: 2px solid var(--border); margin-left: 7px; padding-left: 16px; position: relative;
    }
    .ev::before {
      content: ""; position: absolute; left: -6px; top: 16px; width: 10px; height: 10px;
      border-radius: 50%; background: var(--accent); border: 2px solid var(--bg);
    }
    .ev.bad::before { background: var(--err); }
    .ev .stage { font-weight: 600; font-size: .9rem; }
    .ev .ts { color: var(--muted); font-size: .75rem; margin-top: 2px; }
    .ev pre {
      margin: 8px 0 0; padding: 8px 10px; background: #0a0d12; border: 1px solid var(--border);
      border-radius: 8px; overflow: auto; font-size: .75rem; color: #c9d1dc; max-height: 180px;
    }
    .errbox {
      background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.35);
      color: #ffc0c7; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; font-size: .88rem;
    }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>FromDonna · Message flow</h1>
      <div class="sub">Per-turn gateway stages · last 7 days</div>
    </div>
    <div class="actions">
      <select id="statusFilter">
        <option value="">All statuses</option>
        <option>received</option>
        <option>routing</option>
        <option>provisioning</option>
        <option>injecting</option>
        <option>injected</option>
        <option>error</option>
        <option>complete</option>
      </select>
      <input id="userFilter" placeholder="user_id filter" style="width:180px" />
      <button class="primary" id="refresh">Refresh</button>
      <span class="sub" style="opacity:.7">auth off</span>
    </div>
  </header>
  <main>
    <section class="pane">
      <div class="pane-h"><span>Recent turns</span><span id="count"></span></div>
      <div class="list" id="list"><div class="empty">Loading…</div></div>
    </section>
    <section class="pane">
      <div class="pane-h"><span>Turn detail</span><span id="detailId"></span></div>
      <div class="detail" id="detail"><div class="empty">Select a turn to inspect its flow.</div></div>
    </section>
  </main>
  <script>
    let selected = null;
    let turns = [];

    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error('api ' + res.status);
      return res.json();
    }

    function badge(status) {
      return '<span class="badge ' + status + '">' + status + '</span>';
    }

    function fmt(ts) {
      if (!ts) return '—';
      try { return new Date(ts).toLocaleString(); } catch { return ts; }
    }

    function renderList() {
      const el = document.getElementById('list');
      document.getElementById('count').textContent = turns.length + ' shown';
      if (!turns.length) {
        el.innerHTML = '<div class="empty">No turns yet. Send the bot a message, then refresh.</div>';
        return;
      }
      el.innerHTML = turns.map(t => {
        const active = selected === t.turn_id ? ' active' : '';
        return '<button class="row' + active + '" data-id="' + t.turn_id + '">'
          + '<div class="top"><span class="uid">' + esc(t.user_id) + '</span>' + badge(t.status) + '</div>'
          + '<div class="preview">' + esc(t.inbound_preview || '(no text)') + '</div>'
          + '<div class="preview" style="margin-top:4px">' + esc(fmt(t.started_at))
          + (t.runtime_id ? ' · <code>' + esc(t.runtime_id.slice(0, 12)) + '…</code>' : '')
          + '</div></button>';
      }).join('');
      el.querySelectorAll('.row').forEach(btn => {
        btn.addEventListener('click', () => selectTurn(btn.dataset.id));
      });
    }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }

    async function loadTurns() {
      const status = document.getElementById('statusFilter').value;
      const userId = document.getElementById('userFilter').value.trim();
      const q = new URLSearchParams({ limit: '80' });
      if (status) q.set('status', status);
      if (userId) q.set('userId', userId);
      const data = await api('/api/turns?' + q.toString());
      turns = data.turns || [];
      renderList();
      if (selected && turns.some(t => t.turn_id === selected)) {
        await selectTurn(selected);
      } else if (turns[0]) {
        await selectTurn(turns[0].turn_id);
      }
    }

    async function selectTurn(id) {
      selected = id;
      renderList();
      document.getElementById('detailId').textContent = id.slice(0, 8) + '…';
      const data = await api('/api/turns/' + encodeURIComponent(id));
      const t = data.turn;
      const events = data.events || [];
      const dur = t.finished_at
        ? (new Date(t.finished_at) - new Date(t.started_at)) + ' ms end-to-end (gateway finish)'
        : 'open / agent may still be running';
      let html = '';
      if (t.error) html += '<div class="errbox"><strong>Error</strong><br/>' + esc(t.error) + '</div>';
      html += '<div class="meta">'
        + card('Status', badge(t.status))
        + card('User', esc(t.user_id))
        + card('Runtime', esc(t.runtime_id || '—'))
        + card('Inbound', esc((t.inbound_kind || '') + ' · ' + (t.inbound_preview || '')))
        + card('Started', esc(fmt(t.started_at)))
        + card('Updated', esc(fmt(t.updated_at)))
        + card('Finished', esc(fmt(t.finished_at)))
        + card('Update id', esc(String(t.telegram_update_id ?? '—')))
        + '</div>';
      html += '<div class="sub" style="margin-bottom:10px;color:var(--muted);font-size:.82rem">' + esc(dur) + '</div>';
      html += '<div class="timeline">';
      for (const ev of events) {
        html += '<div class="ev' + (ev.ok ? '' : ' bad') + '">'
          + '<div></div><div>'
          + '<div class="stage">' + esc(ev.stage) + (ev.ok ? '' : ' · failed') + '</div>'
          + '<div class="ts">' + esc(fmt(ev.ts))
          + (ev.duration_ms != null ? ' · ' + ev.duration_ms + ' ms' : '')
          + '</div>';
        if (ev.detail_json) {
          let pretty = ev.detail_json;
          try { pretty = JSON.stringify(JSON.parse(ev.detail_json), null, 2); } catch {}
          html += '<pre>' + esc(pretty) + '</pre>';
        }
        html += '</div></div>';
      }
      html += '</div>';
      document.getElementById('detail').innerHTML = html;
    }

    function card(k, v) {
      return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
    }

    document.getElementById('refresh').addEventListener('click', loadTurns);
    document.getElementById('statusFilter').addEventListener('change', loadTurns);
    document.getElementById('userFilter').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadTurns();
    });

    loadTurns();
    setInterval(loadTurns, 15000);
  </script>
</body>
</html>`;
}

// Silence unused-type imports if tree-shaken oddly
