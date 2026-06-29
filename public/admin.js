const socket = io({ transports: ['polling'] });
const connDot = document.getElementById('connDot');

socket.on('connect',    () => connDot.classList.add('connected'));
socket.on('disconnect', () => connDot.classList.remove('connected'));
socket.on('connect', () => socket.emit('admin:join'));

socket.on('admin:stats', (data) => render(data));

// R2 storage map: key → { size, lastModified }
let r2Objects = new Map();

async function fetchR2Objects() {
  try {
    const list = await fetch('/api/admin/r2').then(r => r.json());
    r2Objects = new Map(list.map(o => [o.key, o]));
  } catch {}
}
fetchR2Objects();
setInterval(fetchR2Objects, 60000); // refresh every minute

// ── Render ─────────────────────────────────────────────────────────────────
function render({ jobs, streams, disk, server }) {
  renderStats(jobs, streams, disk, server);
  renderStreams(streams);
  renderJobs(jobs);
  renderSysbar(server);
}

function renderStats(jobs, streams, disk, server) {
  const active  = jobs.filter(j => !['ready','error'].includes(j.status));
  const ready   = jobs.filter(j => j.status === 'ready');
  const dlJobs  = jobs.filter(j => j.status === 'downloading');
  const speed   = dlJobs.map(j => j.speed).filter(Boolean).join(' · ') || '';

  document.getElementById('statActive').textContent      = active.length;
  document.getElementById('statActiveSpeed').textContent = speed;
  document.getElementById('statReady').textContent       = ready.length;
  document.getElementById('statTotal').textContent       = `${jobs.length} total jobs`;
  document.getElementById('statStreams').textContent     = streams.length;
  document.getElementById('statStreamDetail').textContent =
    streams.length ? streams.map(s => s.title).join(', ').slice(0, 40) : 'none';

  if (disk.free !== null) {
    document.getElementById('statDisk').textContent    = `${disk.free} GB`;
    document.getElementById('statDiskSub').textContent = `${disk.used} / ${disk.total} GB used`;
  }

  document.getElementById('statMem').textContent    = `${server.memUsed} MB`;
  document.getElementById('statUptime').textContent  = `up ${fmtUptime(server.uptime)}`;
}

function renderStreams(streams) {
  const grid = document.getElementById('streamsGrid');
  if (!streams.length) {
    grid.innerHTML = '<div class="empty">No active streams</div>';
    return;
  }
  grid.innerHTML = streams.map(s => {
    const pct   = s.size ? Math.round(s.bytesSent / s.size * 100) : 0;
    const dur   = Math.floor((Date.now() - s.startedAt) / 1000);
    const mbSent = (s.bytesSent / 1e6).toFixed(0);
    const mbTotal = (s.size / 1e6).toFixed(0);
    return `
      <div class="stream-card">
        <div>
          <div class="stream-title">${esc(s.title)}</div>
          <div class="stream-meta">
            <span>IP: ${esc(s.ip)}</span>
            <span>Duration: ${fmtUptime(dur)}</span>
            <span>Sent: ${mbSent} / ${mbTotal} MB</span>
          </div>
        </div>
        <div class="stream-progress">
          <div class="stream-pct">${pct}%</div>
          <div class="stream-bytes">${mbSent} MB</div>
        </div>
      </div>`;
  }).join('');
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function renderJobs(jobs) {
  const tbody = document.getElementById('jobsTbody');
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No jobs yet</td></tr>';
    return;
  }
  tbody.innerHTML = jobs.map(j => {
    const age = Math.floor((Date.now() - j.createdAt) / 1000);
    const pct = j.progress ?? 0;
    const isDone = j.status === 'ready';
    const isErr  = j.status === 'error';

    const prog = (j.status === 'downloading' || isDone || isErr) ? `
      <div class="prog-wrap">
        <div class="prog-bar"><div class="prog-fill ${isDone ? 'done' : ''}" style="width:${pct}%"></div></div>
        <div class="prog-text">${pct}%${j.eta ? ' · ' + fmtEta(j.eta) : ''}</div>
      </div>` : '<span class="muted mono">—</span>';

    const streamBtn = isDone && j.streamUrl
      ? `<a href="${j.streamUrl}" target="_blank" class="btn btn-ghost btn-sm">▶ Play</a>`
      : '';

    const subMsg = j.status === 'error'
      ? (j.error || j.message || '').slice(0, 80)
      : (j.message || '').slice(0, 60);

    const dlTime  = j.downloadedAt ? fmtDuration(j.downloadedAt - j.createdAt)   : '—';
    const upTime  = j.readyAt && j.downloadedAt ? fmtDuration(j.readyAt - j.downloadedAt) : '—';

    // R2 storage status
    let r2Cell = '<span class="muted mono">—</span>';
    if (j.r2Key) {
      const r2obj = r2Objects.get(j.r2Key);
      if (r2obj) {
        const gb = (r2obj.size / 1e9).toFixed(2);
        r2Cell = `<span class="green mono" title="${esc(j.r2Key)}">✓ ${gb} GB</span>`;
      } else if (j.status === 'ready') {
        r2Cell = `<span style="color:#f97316" class="mono" title="${esc(j.r2Key)}">⚠ missing</span>`;
      }
    } else if (j.status === 'ready' && j.streamUrl) {
      r2Cell = `<span class="green mono">✓ ready</span>`;
    }

    return `<tr>
      <td>
        <div class="title-cell">${esc(j.title)}</div>
        <div class="title-year">${j.year || ''}${subMsg ? ' · <span style="color:' + (j.status==='error'?'var(--red)':'#888') + '">' + esc(subMsg) + '</span>' : ''}</div>
      </td>
      <td><span class="badge badge-${j.status}">${j.status}</span></td>
      <td>${prog}</td>
      <td><span class="mono">${j.quality || '—'}</span></td>
      <td><span class="mono muted">${j.size || '—'}</span></td>
      <td>${r2Cell}</td>
      <td><span class="mono muted">${j.speed || '—'}</span></td>
      <td><span class="mono muted">${fmtUptime(age)}</span></td>
      <td><span class="mono ${j.downloadedAt ? 'green' : 'muted'}">${dlTime}</span></td>
      <td><span class="mono ${j.readyAt ? 'green' : 'muted'}">${upTime}</span></td>
      <td style="display:flex;gap:6px;align-items:center">
        ${streamBtn}
        <button class="btn btn-ghost btn-sm" data-delete="${j.id}">✕</button>
      </td>
    </tr>`;
  }).join('');
}

function renderSysbar(server) {
  document.getElementById('dotR2').className      = `dot ${server.r2     ? 'dot-on' : 'dot-off'}`;
  document.getElementById('dotFfmpeg').className  = `dot ${server.ffmpeg ? 'dot-on' : 'dot-off'}`;
  document.getElementById('sysUptime').textContent = `uptime: ${fmtUptime(server.uptime)} · mem: ${server.memUsed} MB`;
}

// ── Log tail ───────────────────────────────────────────────────────────────
const logBox = document.getElementById('logBox');
const MAX_LOG_LINES = 200;
let logLines = [];

function appendLog(line) {
  const ts = new Date().toLocaleTimeString('en-AU', { hour12: false });
  const colored = line.startsWith('[ERR]')
    ? `<span style="color:#ff0099">${esc(line)}</span>`
    : line.startsWith('[WARN]')
      ? `<span style="color:#eab308">${esc(line)}</span>`
      : `<span style="color:#666">${esc(ts)}</span> ${esc(line)}`;
  logLines.push(colored);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  logBox.innerHTML = logLines.join('\n');
  logBox.scrollTop = logBox.scrollHeight;
}

function clearLog() { logLines = []; logBox.innerHTML = ''; }

function connectLogStream() {
  const es = new EventSource('/api/admin/logs');
  es.onmessage = (e) => appendLog(e.data);
  es.onerror   = () => { appendLog('[WARN] log stream disconnected — reconnecting…'); setTimeout(connectLogStream, 3000); es.close(); };
}
connectLogStream();

// ── Actions ────────────────────────────────────────────────────────────────
async function deleteJob(id) {
  await fetch(`/api/admin/job/${id}`, { method: 'DELETE' });
}

async function clearCompleted() {
  await fetch('/api/admin/jobs/completed', { method: 'DELETE' });
}

async function cleanupDisk() {
  await fetch('/api/admin/cleanup-disk', { method: 'POST' });
  appendLog('[LOG] manual disk cleanup triggered');
}

// Wire up header buttons and log clear (module scope — can't use inline onclick)
document.getElementById('btnClearDone')?.addEventListener('click', clearCompleted);
document.getElementById('btnCleanDisk')?.addEventListener('click', cleanupDisk);
document.getElementById('btnClearLog')?.addEventListener('click', clearLog);

// Event delegation for per-row delete buttons
document.getElementById('jobsTbody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delete]');
  if (btn) deleteJob(btn.dataset.delete);
});

// ── Util ───────────────────────────────────────────────────────────────────
function fmtUptime(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function fmtEta(s) {
  if (!s) return '';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s/60)}m`;
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
