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
setInterval(fetchR2Objects, 60000);

// ── Tabs ────────────────────────────────────────────────────────────────────
const tabBtns  = document.querySelectorAll('.tab-btn');
const tabPanes = {
  overview: document.getElementById('tab-overview'),
  users:    document.getElementById('tab-users'),
  jobs:     document.getElementById('tab-jobs'),
  codes:    document.getElementById('tab-codes'),
  log:      document.getElementById('tab-log'),
};

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.toggle('active', b === btn));
    Object.entries(tabPanes).forEach(([key, pane]) => {
      pane.hidden = key !== btn.dataset.tab;
    });
    if (btn.dataset.tab === 'codes') fetchCodes();
  });
});

// ── Render ──────────────────────────────────────────────────────────────────
function render({ jobs, streams, disk, server, seedbox }) {
  renderStats(jobs, streams, disk, server);
  renderHealth(seedbox || {});
  renderStreams(streams);
  renderUsers(jobs, streams);
  renderJobs(jobs);
  renderSysbar(server);
}

function renderStats(jobs, streams, disk, server) {
  const active  = jobs.filter(j => !['ready','error'].includes(j.status));
  const ready   = jobs.filter(j => j.status === 'ready');
  const dlJobs  = jobs.filter(j => j.status === 'downloading');
  const speed   = dlJobs.map(j => j.speed).filter(Boolean).join(' · ') || '';

  // Update users badge
  const humanUsers = new Set(jobs.filter(j => j.user && j.user !== 'system').map(j => j.user));
  const badge = document.getElementById('usersBadge');
  if (humanUsers.size > 0) {
    badge.textContent = humanUsers.size;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

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

  // R2 storage — computed from the polled r2Objects map
  const r2Bytes = [...r2Objects.values()].reduce((acc, o) => acc + (o.size || 0), 0);
  const r2Gb    = r2Bytes / 1e9;
  const r2Cost  = Math.max(0, r2Gb - 10) * 0.015; // $0.015/GB, first 10 GB free
  const r2Label = r2Gb >= 1000
    ? `${(r2Gb / 1000).toFixed(2)} TB`
    : `${r2Gb.toFixed(1)} GB`;
  document.getElementById('statR2Size').textContent = r2Label;
  document.getElementById('statR2Sub').textContent  =
    `${r2Objects.size} files · ~$${r2Cost.toFixed(2)}/mo · egress free`;
}

function renderStreams(streams) {
  const grid = document.getElementById('streamsGrid');
  if (!streams.length) {
    grid.innerHTML = '<div class="empty">No active streams</div>';
    return;
  }
  grid.innerHTML = streams.map(s => {
    const pct     = s.size ? Math.round(s.bytesSent / s.size * 100) : 0;
    const dur     = Math.floor((Date.now() - s.startedAt) / 1000);
    const mbSent  = (s.bytesSent / 1e6).toFixed(0);
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

// ── Users ────────────────────────────────────────────────────────────────────
function renderUsers(jobs, streams) {
  const tbody = document.getElementById('usersTbody');

  // Build per-user aggregates (exclude system catalog jobs)
  const userMap = new Map();

  for (const j of jobs) {
    const u = j.user || 'anonymous';
    if (u === 'system') continue; // catalog jobs in separate section below
    if (!userMap.has(u)) userMap.set(u, {
      username: u,
      ips: new Set(),
      allJobs: [],
      activeJobs: [],
      readyJobs: [],
      lastActive: 0,
      streams: [],
    });
    const ud = userMap.get(u);
    ud.allJobs.push(j);
    if (j.ip) ud.ips.add(j.ip);
    if (['searching','downloading','uploading','processing'].includes(j.status)) ud.activeJobs.push(j);
    if (j.status === 'ready') ud.readyJobs.push(j);
    if ((j.createdAt || 0) > ud.lastActive) ud.lastActive = j.createdAt || 0;
  }

  // Attach streams to users via jobId → job.user
  for (const s of streams) {
    const job = jobs.find(j => j.id === s.jobId);
    const u   = job?.user || 'anonymous';
    if (u === 'system') continue;
    if (!userMap.has(u)) userMap.set(u, {
      username: u, ips: new Set(), allJobs: [], activeJobs: [], readyJobs: [], lastActive: 0, streams: [],
    });
    userMap.get(u).streams.push({ ...s, streamIp: s.ip });
  }

  if (!userMap.size) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No users yet</td></tr>';
    return;
  }

  const users = [...userMap.values()].sort((a, b) => b.lastActive - a.lastActive);

  tbody.innerHTML = users.map(u => {
    const ipsHtml = [...u.ips].map(ip => `<span class="user-ip-pill">${esc(ip)}</span>`).join('') || '<span class="muted">—</span>';

    const nowHtml = u.streams.length
      ? u.streams.map(s => `
          <div class="user-now">
            <span class="now-dot"></span>
            <span>${esc(s.title)}</span>
            <span class="now-ip">${esc(s.streamIp)}</span>
          </div>`).join('')
      : '<span class="muted">—</span>';

    const activeHtml = u.activeJobs.length
      ? u.activeJobs.map(j => {
          const statusColor = j.status === 'downloading' ? 'var(--yellow)' : j.status === 'uploading' ? 'var(--blue)' : '#888';
          const pct = j.progress ? ` ${j.progress}%` : '';
          return `<span class="user-requests req-item"><span class="req-title">${esc(shortTitle(j))}</span> <span class="req-status" style="color:${statusColor}">${j.status}${pct}</span></span>`;
        }).join('')
      : '<span class="muted">—</span>';

    // Show 3 most recent requests
    const recent = [...u.allJobs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 3);
    const recentHtml = recent.map(j => {
      const statusColor = j.status === 'ready' ? 'var(--green)' : j.status === 'error' ? 'var(--red)' : '#888';
      return `<span class="user-requests req-item"><span class="req-title">${esc(shortTitle(j))}</span> <span class="req-status" style="color:${statusColor}">${j.status}</span></span>`;
    }).join('');

    const rowClass = u.streams.length ? 'user-row-streaming' : '';

    return `<tr class="${rowClass}">
      <td><strong>${esc(u.username)}</strong></td>
      <td>${ipsHtml}</td>
      <td>${nowHtml}</td>
      <td>${activeHtml}</td>
      <td class="mono">${u.readyJobs.length} / ${u.allJobs.length}</td>
      <td>${recentHtml}</td>
      <td class="mono muted">${u.lastActive ? timeAgo(u.lastActive) : '—'}</td>
    </tr>`;
  }).join('');
}

function shortTitle(j) {
  const t = j.showTitle || j.title || '';
  const ep = j.season && j.episode
    ? ` S${String(j.season).padStart(2,'0')}E${String(j.episode).padStart(2,'0')}`
    : '';
  return (t + ep).slice(0, 40);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────
function renderJobs(jobs) {
  const tbody = document.getElementById('jobsTbody');
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">No jobs yet</td></tr>';
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
    const retryBtn = isErr
      ? `<button class="btn btn-ghost btn-sm" style="color:var(--yellow)" data-retry="${j.id}">↺ Retry</button>`
      : '';

    const subMsg = j.status === 'error'
      ? (j.error || j.message || '').slice(0, 80)
      : (j.message || '').slice(0, 60);

    const dlTime = j.downloadedAt ? fmtDuration(j.downloadedAt - j.createdAt)   : '—';
    const upTime = j.readyAt && j.downloadedAt ? fmtDuration(j.readyAt - j.downloadedAt) : '—';

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

    const userLabel = j.user === 'system'
      ? '<span class="muted" style="font-size:10px">catalog</span>'
      : `<span style="color:#aaa">${esc(j.user || '—')}</span>`;

    return `<tr data-job-id="${j.id}">
      <td><input type="checkbox" class="job-chk" data-id="${j.id}"></td>
      <td>
        <div class="title-cell">${esc(j.title)}</div>
        <div class="title-year">${j.year || ''}${subMsg ? ' · <span style="color:' + (j.status==='error'?'var(--red)':'#888') + '">' + esc(subMsg) + '</span>' : ''}</div>
      </td>
      <td>${userLabel}</td>
      <td><span class="badge badge-${j.status}">${j.status}</span></td>
      <td>${prog}</td>
      <td><span class="mono">${j.quality || '—'}</span></td>
      <td><span class="mono muted">${fmtSize(j.size)}</span></td>
      <td>${r2Cell}</td>
      <td><span class="mono muted">${j.speed || '—'}</span></td>
      <td><span class="mono muted">${fmtUptime(age)}</span></td>
      <td><span class="mono ${j.downloadedAt ? 'green' : 'muted'}">${dlTime}</span></td>
      <td><span class="mono ${j.readyAt ? 'green' : 'muted'}">${upTime}</span></td>
      <td style="display:flex;gap:6px;align-items:center">
        ${streamBtn}
        ${retryBtn}
        <button class="btn btn-ghost btn-sm" data-delete="${j.id}">✕</button>
      </td>
    </tr>`;
  }).join('');
}

function renderHealth({ activeSeedboxOps = 0, cooldownSecsLeft = 0, diskFreeGb = null, monthlyUploadGb = 0, monthlyLimitGb = 20000, diskTotalGb = 4000 } = {}) {
  function setCard(cardId, valueId, barId, subId, value, pct, level, valueTxt, subTxt) {
    const card = document.getElementById(cardId);
    const val  = document.getElementById(valueId);
    const bar  = document.getElementById(barId);
    const sub  = document.getElementById(subId);
    card.className = `health-card${level === 'warn' ? ' warn' : level === 'crit' ? ' crit' : ''}`;
    val.className  = `health-value ${level}`;
    val.textContent = valueTxt;
    if (bar) { bar.style.width = Math.min(100, pct) + '%'; bar.className = `health-bar-fill ${level}`; }
    if (sub) sub.textContent = subTxt;
  }

  // Concurrent ops (warn ≥3, crit ≥6 out of 25 max jobs)
  const opsLevel = activeSeedboxOps >= 6 ? 'crit' : activeSeedboxOps >= 3 ? 'warn' : 'ok';
  setCard('hcOps','hOps','hOpsBar','hOpsSub',
    activeSeedboxOps, activeSeedboxOps / 10 * 100, opsLevel,
    String(activeSeedboxOps),
    activeSeedboxOps === 1 ? '1 active ffmpeg session' : `${activeSeedboxOps} active ffmpeg sessions`);

  // Monthly bandwidth (warn ≥75%, crit ≥90%)
  const bwPct   = monthlyLimitGb > 0 ? monthlyUploadGb / monthlyLimitGb * 100 : 0;
  const bwLevel = bwPct >= 90 ? 'crit' : bwPct >= 75 ? 'warn' : 'ok';
  const bwTxt   = monthlyUploadGb >= 1000 ? `${(monthlyUploadGb/1000).toFixed(1)} TB` : `${monthlyUploadGb} GB`;
  setCard('hcBw','hBw','hBwBar','hBwSub',
    bwPct, bwPct, bwLevel,
    bwTxt,
    `${bwPct.toFixed(1)}% of 20 TB limit this month`);

  // Seedbox disk free (warn <1 TB, crit <500 GB)
  if (diskFreeGb !== null) {
    const diskUsedGb = diskTotalGb - diskFreeGb;
    const diskPct    = diskTotalGb > 0 ? diskUsedGb / diskTotalGb * 100 : 0;
    const diskLevel  = diskFreeGb < 500 ? 'crit' : diskFreeGb < 1000 ? 'warn' : 'ok';
    const diskTxt    = diskFreeGb >= 1000 ? `${(diskFreeGb/1000).toFixed(1)} TB` : `${diskFreeGb} GB`;
    setCard('hcDisk','hDisk','hDiskBar','hDiskSub',
      diskPct, diskPct, diskLevel, diskTxt,
      `free — ${diskPct.toFixed(0)}% used of ${(diskTotalGb/1000).toFixed(0)} TB`);
  } else {
    document.getElementById('hDisk').textContent = '—';
    document.getElementById('hDiskSub').textContent = 'unavailable';
  }

  // qBit status
  const qbtCard = document.getElementById('hcQbt');
  const qbtVal  = document.getElementById('hQbt');
  const qbtSub  = document.getElementById('hQbtSub');
  if (cooldownSecsLeft > 0) {
    qbtCard.className = 'health-card crit';
    qbtVal.className  = 'health-value crit';
    qbtVal.textContent = 'COOLDOWN';
    const mins = Math.ceil(cooldownSecsLeft / 60);
    qbtSub.innerHTML = `${mins}m remaining — <button id="clearCooldownBtn" style="background:var(--red);border:none;color:#fff;font-family:inherit;font-size:11px;font-weight:700;padding:2px 10px;border-radius:3px;cursor:pointer;letter-spacing:.3px">Clear Now</button>`;
    document.getElementById('clearCooldownBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('clearCooldownBtn');
      btn.textContent = '…'; btn.disabled = true;
      await fetch('/api/admin/clear-cooldown', { method: 'POST' });
      appendLog('[LOG] qBittorrent cooldown cleared');
    });
  } else {
    qbtCard.className = 'health-card';
    qbtVal.className  = 'health-value ok';
    qbtVal.textContent = 'OK';
    qbtSub.textContent = 'session active';
  }
}

function renderSysbar(server) {
  document.getElementById('dotR2').className      = `dot ${server.r2     ? 'dot-on' : 'dot-off'}`;
  document.getElementById('dotFfmpeg').className  = `dot ${server.ffmpeg ? 'dot-on' : 'dot-off'}`;
  document.getElementById('sysUptime').textContent = `uptime: ${fmtUptime(server.uptime)} · mem: ${server.memUsed} MB`;
}

// ── Accounts ─────────────────────────────────────────────────────────────────
async function fetchAccounts() {
  try {
    const users = await fetch('/api/admin/users').then(r => r.json());
    const tbody = document.getElementById('accountsTbody');
    if (!users.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">No accounts</td></tr>'; return; }
    tbody.innerHTML = users.map(u => `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td><span class="mono" style="color:#aaa">${esc(u.password)}</span></td>
      <td class="mono muted">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
      <td><button class="btn btn-ghost btn-sm" style="color:var(--red)" data-del-user="${esc(u.username)}">✕</button></td>
    </tr>`).join('');
  } catch {}
}
fetchAccounts();

document.getElementById('accountsTbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-user]');
  if (!btn) return;
  const username = btn.dataset.delUser;
  await fetch(`/api/admin/user/${encodeURIComponent(username)}`, { method: 'DELETE' });
  fetchAccounts();
});

document.getElementById('btnAddUser')?.addEventListener('click', () => {
  const form = document.getElementById('addUserForm');
  form.hidden = !form.hidden;
  form.style.display = form.hidden ? '' : 'flex';
});

document.getElementById('btnCreateUser')?.addEventListener('click', async () => {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value.trim();
  if (!username || !password) return;
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.ok) {
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('addUserForm').hidden = true;
    fetchAccounts();
  } else {
    const d = await res.json();
    appendLog(`[ERR] Create user failed: ${d.error}`);
  }
});

// ── Invite Codes ─────────────────────────────────────────────────────────────
async function fetchCodes() {
  try {
    const codes = await fetch('/api/admin/invite-codes').then(r => r.json());
    const tbody = document.getElementById('codesTbody');
    if (!codes.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No codes yet — click Generate Code to create one</td></tr>'; return; }
    tbody.innerHTML = codes.map(c => {
      const used    = !!c.usedBy;
      const status  = used
        ? `<span style="color:#22c55e;font-weight:700">✓ Used</span>`
        : `<span style="color:#f59e0b;font-weight:700">Unused</span>`;
      const usedBy  = used ? `<span class="mono">${esc(c.usedBy)}</span>` : '—';
      const created = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—';
      const copyBtn = `<button class="btn btn-ghost btn-sm" data-copy-code="${esc(c.code)}" title="Copy">⎘</button>`;
      const delBtn  = !used
        ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" data-del-code="${esc(c.code)}" title="Delete">✕</button>`
        : '';
      return `<tr>
        <td><strong class="mono" style="letter-spacing:1px;color:#ff0099">${esc(c.code)}</strong></td>
        <td class="muted" style="font-size:11px">${esc(c.notes || '—')}</td>
        <td>${status}</td>
        <td>${usedBy}</td>
        <td class="muted mono" style="font-size:11px">${created}</td>
        <td style="display:flex;gap:4px">${copyBtn}${delBtn}</td>
      </tr>`;
    }).join('');
  } catch (e) { appendLog(`[ERR] fetchCodes: ${e.message}`); }
}

document.getElementById('btnGenCode')?.addEventListener('click', () => {
  const form = document.getElementById('codeCreateForm');
  form.hidden = !form.hidden;
});

document.getElementById('btnCreateCode')?.addEventListener('click', async () => {
  const code  = document.getElementById('codeInput').value.trim().toUpperCase();
  const notes = document.getElementById('codeNotes').value.trim();
  const res = await fetch('/api/admin/invite-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code || undefined, notes }),
  });
  const data = await res.json();
  if (res.ok) {
    appendLog(`[LOG] Invite code created: ${data.code}`);
    document.getElementById('codeInput').value  = '';
    document.getElementById('codeNotes').value  = '';
    document.getElementById('codeCreateForm').hidden = true;
    fetchCodes();
  } else {
    appendLog(`[ERR] Create code failed: ${data.error}`);
  }
});

document.getElementById('codesTbody')?.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy-code]');
  if (copy) {
    await navigator.clipboard.writeText(copy.dataset.copyCode).catch(() => {});
    const orig = copy.textContent;
    copy.textContent = '✓'; setTimeout(() => { copy.textContent = orig; }, 1200);
    return;
  }
  const del = e.target.closest('[data-del-code]');
  if (del) {
    await fetch(`/api/admin/invite-codes/${encodeURIComponent(del.dataset.delCode)}`, { method: 'DELETE' });
    fetchCodes();
  }
});

// ── Log tail ────────────────────────────────────────────────────────────────
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
  es.onerror   = () => {
    appendLog('[WARN] log stream disconnected — reconnecting…');
    setTimeout(connectLogStream, 3000);
    es.close();
  };
}
connectLogStream();

// ── Actions ──────────────────────────────────────────────────────────────────
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

document.getElementById('btnClearDone')?.addEventListener('click', clearCompleted);
document.getElementById('btnCleanDisk')?.addEventListener('click', cleanupDisk);
document.getElementById('btnClearLog')?.addEventListener('click', clearLog);
document.getElementById('btnCatalogSync')?.addEventListener('click', async () => {
  await fetch('/api/admin/catalog/sync', { method: 'POST' });
  appendLog('[LOG] Catalog sync triggered');
});
document.getElementById('btnCatalogRetry')?.addEventListener('click', async () => {
  await fetch('/api/admin/catalog/retry', { method: 'POST' });
  appendLog('[LOG] Catalog retry (cooldown cleared) triggered');
});

// ── Bulk selection ────────────────────────────────────────────────────────────
function getCheckedIds() {
  return [...document.querySelectorAll('.job-chk:checked')].map(c => c.dataset.id);
}

function updateSelectionUI() {
  const ids   = getCheckedIds();
  const total = document.querySelectorAll('.job-chk').length;
  const selCount = document.getElementById('selCount');
  const btnSel   = document.getElementById('btnSelectAll');
  const btnNone  = document.getElementById('btnSelectNone');
  const btnDel   = document.getElementById('btnDeleteSelected');
  const chkAll   = document.getElementById('chkAll');
  if (ids.length === 0) {
    selCount.textContent = '';
    btnSel.hidden  = false; btnNone.hidden = true; btnDel.hidden = true;
    if (chkAll) { chkAll.checked = false; chkAll.indeterminate = false; }
  } else {
    selCount.textContent = `(${ids.length} selected)`;
    btnSel.hidden  = ids.length === total;
    btnNone.hidden = false; btnDel.hidden = false;
    if (chkAll) { chkAll.checked = ids.length === total; chkAll.indeterminate = ids.length < total; }
  }
}

document.getElementById('chkAll')?.addEventListener('change', (e) => {
  document.querySelectorAll('.job-chk').forEach(c => { c.checked = e.target.checked; });
  updateSelectionUI();
});
document.getElementById('btnSelectAll')?.addEventListener('click', () => {
  document.querySelectorAll('.job-chk').forEach(c => { c.checked = true; });
  updateSelectionUI();
});
document.getElementById('btnSelectNone')?.addEventListener('click', () => {
  document.querySelectorAll('.job-chk').forEach(c => { c.checked = false; });
  updateSelectionUI();
});
document.getElementById('btnDeleteSelected')?.addEventListener('click', async () => {
  const ids = getCheckedIds();
  if (!ids.length) return;
  const btn = document.getElementById('btnDeleteSelected');
  btn.textContent = `Deleting ${ids.length}…`;
  btn.disabled = true;
  await Promise.all(ids.map(id => fetch(`/api/admin/job/${id}`, { method: 'DELETE' })));
  btn.textContent = '🗑 Delete Selected';
  btn.disabled = false;
  appendLog(`[LOG] Deleted ${ids.length} jobs`);
});

// Per-row delete + retry + checkbox change
document.getElementById('jobsTbody').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delete]');
  if (del) { deleteJob(del.dataset.delete); return; }

  const retry = e.target.closest('[data-retry]');
  if (retry) {
    retry.textContent = '…';
    retry.disabled = true;
    await fetch(`/api/admin/job/${retry.dataset.retry}/retry`, { method: 'POST' });
    appendLog(`[LOG] Retrying job ${retry.dataset.retry}`);
  }
});
document.getElementById('jobsTbody').addEventListener('change', (e) => {
  if (e.target.classList.contains('job-chk')) updateSelectionUI();
});

// ── Util ─────────────────────────────────────────────────────────────────────
function fmtUptime(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
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

function fmtSize(s) {
  if (!s || s === '?') return '—';
  const n = typeof s === 'number' ? s : (typeof s === 'string' && /^\d+$/.test(s.trim()) ? parseInt(s) : null);
  if (n !== null) {
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
    if (n >= 1e9)  return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6)  return `${(n / 1e6).toFixed(0)} MB`;
    return `${n} B`;
  }
  return String(s);
}
