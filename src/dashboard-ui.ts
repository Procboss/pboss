/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Features:
 * - Fork & cluster execution modes
 * - Auto-restart & crash recovery
 * - Health checks & monitoring
 * - Log management & rotation
 * - Deployment support
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */
export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ProcBoss Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --text-dim: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --orange: #db6d28; --purple: #bc8cff;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: var(--bg); color: var(--text); }
  .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 20px; color: var(--accent); }
  .header .meta { color: var(--text-dim); font-size: 13px; }
  .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h3 { font-size: 13px; color: var(--text-dim); text-transform: uppercase; margin-bottom: 12px; letter-spacing: 0.5px; }
  .stat { font-size: 28px; font-weight: 700; }
  .stat.green { color: var(--green); }
  .stat.red { color: var(--red); }
  .stat.yellow { color: var(--yellow); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 12px; color: var(--text-dim); font-size: 12px; text-transform: uppercase; border-bottom: 2px solid var(--border); letter-spacing: 0.5px; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 14px; font-family: monospace; }
  tr:hover td { background: rgba(88, 166, 255, 0.05); }
  .status { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .status.online { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .status.stopped { background: rgba(139, 148, 158, 0.15); color: var(--text-dim); }
  .status.errored { background: rgba(248, 81, 73, 0.15); color: var(--red); }
  .status.launching, .status.waiting-restart { background: rgba(210, 153, 34, 0.15); color: var(--yellow); }
  .btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); cursor: pointer; font-size: 12px; transition: all 0.2s; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.danger:hover { border-color: var(--red); color: var(--red); }
  .btn.success:hover { border-color: var(--green); color: var(--green); }
  .actions { display: flex; gap: 6px; }
  .chart-container { height: 200px; position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  .chart-title { font-size: 13px; color: var(--text-dim); text-transform: uppercase; margin-bottom: 8px; }
  canvas { width: 100% !important; height: 160px !important; }
  .logs-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  .logs-panel h3 { font-size: 13px; color: var(--text-dim); text-transform: uppercase; margin-bottom: 12px; }
  .log-output { background: #000; border-radius: 4px; padding: 12px; font-family: monospace; font-size: 12px; max-height: 400px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; color: var(--text); }
  .log-output .err { color: var(--red); }
  .log-output .timestamp { color: var(--text-dim); }
  .tabs { display: flex; gap: 0; margin-bottom: 16px; overflow-x: auto; }
  .tab { padding: 8px 16px; background: var(--surface); border: 1px solid var(--border); cursor: pointer; font-size: 13px; color: var(--text-dim); transition: all 0.2s; white-space: nowrap; }
  .tab:first-child { border-radius: 6px 0 0 6px; }
  .tab:last-child { border-radius: 0 6px 6px 0; }
  .tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .system-info { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .sys-stat { text-align: center; }
  .sys-stat .label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; }
  .sys-stat .value { font-size: 18px; font-weight: 600; margin-top: 4px; }
  .progress-bar { height: 6px; background: var(--border); border-radius: 3px; margin-top: 6px; overflow: hidden; }
  .progress-bar .fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .live-indicator { display: inline-block; width: 8px; height: 8px; background: var(--green); border-radius: 50%; margin-right: 8px; animation: pulse 2s infinite; }
  
  /* UI Polish */
  .name-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty-state { text-align: center; color: var(--text-dim); padding: 40px; font-size: 14px; }
</style>
</head>
<body>
<div class="header">
  <h1>⚡ ProcBoss Dashboard</h1>
  <div class="meta"><span class="live-indicator"></span>Live • <span id="update-time">-</span></div>
</div>
<div class="container">
  <div class="grid" id="stats-grid"></div>
  <div class="chart-container">
    <div class="chart-title">CPU & Memory Over Time</div>
    <canvas id="chart"></canvas>
  </div>
  <div class="card" style="margin-bottom: 24px;">
    <h3>System</h3>
    <div class="system-info" id="system-info"></div>
  </div>
  <div class="card" style="margin-bottom: 24px;">
    <h3>Processes</h3>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Name</th><th>Status</th><th>PID</th>
          <th>CPU</th><th>Memory</th><th>Restarts</th><th>Uptime</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="process-table"></tbody>
    </table>
  </div>
  <div class="logs-panel">
    <h3>Logs</h3>
    <div class="tabs" id="log-tabs"></div>
    <div class="log-output" id="log-output">Select a process to view logs</div>
  </div>
</div>
<script>
const WS_URL = location.origin.replace('http','ws') + '/ws';
let ws;
let chartData = { labels: [], cpu: [], memory: [] };
let selectedLogProcess = null;
let processesData = []; // Global state to avoid double-escaping from DOM

// XSS Prevention Helper
function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') return String(unsafe ?? '');
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(1)+' '+u[i];
}

function formatUptime(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d>0) return d+'d '+h%24+'h';
  if (h>0) return h+'h '+m%60+'m';
  if (m>0) return m+'m '+s%60+'s';
  return s+'s';
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'state') render(data.data);
      if (data.type === 'logs') renderLogs(data.data);
    } catch (err) {
      console.error('ProcBoss WS parse error:', err);
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
  ws.onerror = () => ws.close();
}

function send(type, data) { if (ws?.readyState === 1) ws.send(JSON.stringify({type,data})); }

function render(state) {
  const { processes = [], metrics } = state || {};
  document.getElementById('update-time').textContent = new Date().toLocaleTimeString();

  const online = processes.filter(p => p.status === 'online').length;
  const errored = processes.filter(p => p.status === 'errored').length;
  const totalMem = processes.reduce((s, p) => s + (p.monit?.memory || 0), 0);
  const totalCpu = processes.reduce((s, p) => s + (p.monit?.cpu || 0), 0);

  document.getElementById('stats-grid').innerHTML = \`
    <div class="card"><h3>Online</h3><div class="stat green">\${online}</div></div>
    <div class="card"><h3>Errored</h3><div class="stat red">\${errored}</div></div>
    <div class="card"><h3>Total CPU</h3><div class="stat">\${totalCpu.toFixed(1)}%</div></div>
    <div class="card"><h3>Total Memory</h3><div class="stat">\${formatBytes(totalMem)}</div></div>
  \`;

  if (metrics?.system) {
    const sys = metrics.system;
    const memPct = ((sys.totalMemory - sys.freeMemory) / sys.totalMemory * 100).toFixed(1);
    document.getElementById('system-info').innerHTML = \`
      <div class="sys-stat"><div class="label">Platform</div><div class="value">\${escapeHtml(sys.platform)}</div></div>
      <div class="sys-stat"><div class="label">CPUs</div><div class="value">\${sys.cpuCount}</div></div>
      <div class="sys-stat"><div class="label">Load (1m)</div><div class="value">\${sys.loadAvg?.[0]?.toFixed(2) || '0.00'}</div></div>
      <div class="sys-stat">
        <div class="label">Memory</div><div class="value">\${memPct}%</div>
        <div class="progress-bar"><div class="fill" style="width:\${memPct}%;background:\${memPct>80?'var(--red)':memPct>60?'var(--yellow)':'var(--green)'}"></div></div>
      </div>
    \`;
  }

  const now = new Date().toLocaleTimeString();
  chartData.labels.push(now);
  chartData.cpu.push(totalCpu);
  chartData.memory.push(totalMem / 1024 / 1024);
  if (chartData.labels.length > 60) {
    chartData.labels.shift(); chartData.cpu.shift(); chartData.memory.shift();
  }
  drawChart();

  // Save processes globally so viewLogs can use them without DOM parsing
  processesData = processes; 

  if (processes.length === 0) {
    document.getElementById('process-table').innerHTML = '<tr><td colspan="9" class="empty-state">No processes running</td></tr>';
    document.getElementById('log-tabs').innerHTML = '';
    return;
  }

  document.getElementById('process-table').innerHTML = processes.map(p => {
    const env = p.pboss_env || p.bm2_env;
    return \`
    <tr>
      <td>\${p.pm_id}</td>
      <td class="name-cell" title="\${escapeHtml(p.name)}">\${escapeHtml(p.name)}</td>
      <td><span class="status \${escapeHtml(p.status)}">\${escapeHtml(p.status)}</span></td>
      <td>\${p.pid || '-'}</td>
      <td>\${(p.monit?.cpu || 0).toFixed(1)}%</td>
      <td>\${formatBytes(p.monit?.memory || 0)}</td>
      <td>\${env?.restart_time ?? 0}</td>
      <td>\${p.status === 'online' ? formatUptime(Date.now() - (env?.pm_uptime || Date.now())) : '-'}</td>
      <td class="actions">
        <button class="btn success" title="Restart" onclick="send('restart',{target:'\${p.pm_id}'})">↻</button>
        <button class="btn danger" title="Stop" onclick="send('stop',{target:'\${p.pm_id}'})">■</button>
        <button class="btn" title="View Logs" onclick="viewLogs(\${p.pm_id})">📋</button>
      </td>
    </tr>
  \`;
  }).join('');

  document.getElementById('log-tabs').innerHTML = processes.map(p => \`
    <div class="tab \${selectedLogProcess === p.pm_id ? 'active' : ''}" onclick="viewLogs(\${p.pm_id})" title="\${escapeHtml(p.name)}">\${escapeHtml(p.name)}</div>
  \`).join('');
}

function viewLogs(id) {
  selectedLogProcess = Number(id);
  document.getElementById('log-output').innerHTML = '<div class="empty-state">Loading logs...</div>';
  send('getLogs', { target: selectedLogProcess, lines: 50 });
  
  // Re-render tabs using global processesData (prevents double-escaping from DOM)
  document.getElementById('log-tabs').innerHTML = processesData.map(p => \`
    <div class="tab \${selectedLogProcess === p.pm_id ? 'active' : ''}" onclick="viewLogs(\${p.pm_id})" title="\${escapeHtml(p.name)}">\${escapeHtml(p.name)}</div>
  \`).join('');
}

function renderLogs(logs) {
  if (!logs || !logs.length) {
    document.getElementById('log-output').innerHTML = '<div class="empty-state">No logs available</div>';
    return;
  }
  const el = document.getElementById('log-output');
  let html = '';
  for (const log of logs) {
    if (log.out) html += log.out.split('\\n').map(line => {
      const safeLine = escapeHtml(line);
      const m = safeLine.match(/^\\[([^\\]]+)\\]/);
      return m ? '<span class="timestamp">['+m[1]+']</span>'+safeLine.slice(m[0].length) : safeLine;
    }).join('\\n') + '\\n';
    
    if (log.err) html += log.err.split('\\n').map(line => {
      const safeLine = escapeHtml(line);
      return '<span class="err">'+safeLine+'</span>';
    }).join('\\n') + '\\n';
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function drawChart() {
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth, h = 160;
  canvas.width = w * 2; canvas.height = h * 2;
  ctx.scale(2, 2);
  ctx.clearRect(0, 0, w, h);

  const len = chartData.labels.length;
  if (len < 2) return;

  const maxCpu = Math.max(...chartData.cpu, 1);
  const maxMem = Math.max(...chartData.memory, 1);
  const stepX = w / (len - 1);

  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.5;
  for (let i = 0; i < 4; i++) {
    const y = h * i / 4;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2;
  ctx.beginPath();
  chartData.cpu.forEach((v, i) => {
    const x = i * stepX, y = h - (v / maxCpu) * (h - 20);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 2;
  ctx.beginPath();
  chartData.memory.forEach((v, i) => {
    const x = i * stepX, y = h - (v / maxMem) * (h - 20);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.font = '11px monospace';
  ctx.fillStyle = '#58a6ff'; ctx.fillText('● CPU ' + chartData.cpu[len-1]?.toFixed(1) + '%', 10, 14);
  ctx.fillStyle = '#3fb950'; ctx.fillText('● MEM ' + chartData.memory[len-1]?.toFixed(1) + 'MB', 120, 14);
}

connect();
setInterval(() => { if (ws?.readyState === 1) send('getState', {}); }, 2000);
</script>
</body>
</html>`;
}
