const msg = (m) => new Promise(r => chrome.runtime.sendMessage(m, r));
const esc = BSU.escapeXml;  // shared from lib/common.js
const when = (ts) => { try { return new Date(ts).toLocaleString(); } catch (e) { return ''; } };
// Open-for-download URL for a queue item: its own url (or the md5 page), with bsauto=1 appended
// so aa.js auto-starts the download. Handles whether the url already has a query string.
const autoUrl = (it) => { const u = it.url || ('https://annas-archive.org/md5/' + it.md5); return u + (/[?]/.test(u) ? '&' : '?') + 'bsauto=1'; };

async function loadSettings() {
  const { settings } = await msg({ type: 'settings.get' });
  document.getElementById('aakey').value = (settings && settings.aaKey) || '';
}
async function loadQueue() {
  const { queue } = await msg({ type: 'queue.list' });
  const ul = document.getElementById('queue'); ul.innerHTML = '';
  document.getElementById('qcount').textContent = (queue || []).length;
  if (!queue || !queue.length) { ul.innerHTML = '<li class="empty">Queue is empty.</li>'; return; }
  queue.forEach(it => {
    const li = document.createElement('li');
    li.innerHTML = '<div><div>' + esc(it.title || it.md5) + '</div><div class="meta">' + esc(it.md5 || '') + ' · ' + when(it.ts) + '</div></div>';
    const row = document.createElement('div'); row.className = 'row';
    const dl = document.createElement('button'); dl.className = 'sm green'; dl.textContent = 'Download';
    dl.onclick = () => chrome.tabs.create({ url: autoUrl(it) });
    const rm = document.createElement('button'); rm.className = 'sm ghost'; rm.textContent = 'Remove';
    rm.onclick = async () => { await msg({ type: 'queue.remove', id: it.id }); loadQueue(); };
    row.appendChild(dl); row.appendChild(rm); li.appendChild(row); ul.appendChild(li);
  });
}
async function loadHistory() {
  const { history } = await msg({ type: 'history.list' });
  const ul = document.getElementById('history'); ul.innerHTML = '';
  document.getElementById('hcount').textContent = (history || []).length;
  if (!history || !history.length) { ul.innerHTML = '<li class="empty">No downloads yet.</li>'; return; }
  history.forEach(h => {
    const li = document.createElement('li');
    const tag = h.kind === 'novel' ? '<span class="tag novel">novel · ' + esc(h.source || '') + '</span>'
      : '<span class="tag ' + (h.via === 'fast' ? 'fast' : 'slow') + '">AA · ' + esc(h.via || '') + '</span>';
    const extra = h.kind === 'novel' ? (esc(h.count) + ' ch · ' + esc(h.file || '')) : esc(h.md5 || '');
    li.innerHTML = '<div><div>' + esc(h.title || '') + '</div><div class="meta">' + extra + ' · ' + when(h.ts) + '</div></div>' + tag;
    ul.appendChild(li);
  });
}

document.getElementById('savekey').onclick = async () => {
  await msg({ type: 'settings.set', patch: { aaKey: document.getElementById('aakey').value.trim() } });
  document.getElementById('setmsg').textContent = 'Saved.';
  setTimeout(() => document.getElementById('setmsg').textContent = '', 1500);
};
document.getElementById('togglekey').onclick = () => {
  const i = document.getElementById('aakey'); i.type = i.type === 'password' ? 'text' : 'password';
};
document.getElementById('clearqueue').onclick = async () => { await msg({ type: 'queue.clear' }); loadQueue(); };
document.getElementById('clearhist').onclick = async () => { await msg({ type: 'history.clear' }); loadHistory(); };
document.getElementById('runqueue').onclick = async () => {
  const { queue } = await msg({ type: 'queue.list' });
  (queue || []).forEach((it, i) => setTimeout(() => chrome.tabs.create({ url: autoUrl(it), active: false }), i * 1500));
};
async function loadJobs() {
  const all = await new Promise(r => chrome.storage.local.get(null, r));
  const jobs = Object.keys(all).filter(k => k.startsWith('novelJob:')).map(k => all[k]).filter(Boolean);
  const ul = document.getElementById('jobs'); ul.innerHTML = '';
  document.getElementById('acount').textContent = jobs.filter(j => j.phase !== 'done').length;
  if (!jobs.length) { ul.innerHTML = '<li class="empty">No novel jobs. Open a book page and press Start.</li>'; return; }
  jobs.sort((a, b) => (a.phase === 'done') - (b.phase === 'done'));
  jobs.forEach(j => {
    const pct = j.total ? Math.round((j.index || 0) / j.total * 100) : 0;
    const phase = j.phase === 'paused_cf' ? '⚠ paused (Cloudflare — solve & resume on the tab)'
      : j.phase === 'fetching' ? 'downloading'
      : j.phase === 'building' ? 'building EPUB' : j.phase;
    const li = document.createElement('li');
    li.innerHTML = '<div style="flex:1"><div>' + esc(j.title || j.base) + '</div>'
      + '<div class="meta">' + esc(phase) + ' · ' + (j.index || 0) + '/' + (j.total || '?') + ' (' + pct + '%)</div>'
      + '<div style="height:5px;background:var(--line);border-radius:3px;margin-top:5px"><div style="height:5px;width:' + pct + '%;background:' + (j.phase === 'paused_cf' ? 'var(--orange)' : j.phase === 'done' ? 'var(--cyan)' : 'var(--green)') + ';border-radius:3px"></div></div></div>';
    const row = document.createElement('div'); row.className = 'row';
    const open = document.createElement('button'); open.className = 'sm ghost'; open.textContent = 'Open tab'; open.onclick = () => chrome.tabs.create({ url: j.base });
    row.appendChild(open); li.appendChild(row); ul.appendChild(li);
  });
}

async function loadLogs() {
  const { logs } = await msg({ type: 'log.list' });
  const pre = document.getElementById('logs');
  document.getElementById('lcount').textContent = (logs || []).length;
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.textContent = (logs || []).join('\n') || '(no logs yet)';
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
document.getElementById('clearlog').onclick = async () => { await msg({ type: 'log.clear' }); loadLogs(); };
document.getElementById('dllog').onclick = async () => {
  const { logs } = await msg({ type: 'log.list' });
  const blob = new Blob([(logs || []).join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;
  a.download = 'epubforge-log.txt'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
};
document.getElementById('refresh').onclick = refresh;

function refresh() { loadSettings(); loadJobs(); loadQueue(); loadHistory(); loadLogs(); }
refresh();

// Logs are the live view; refresh them every tick (cheap message round-trip). loadJobs reads the
// WHOLE storage area (get(null), incl. cover blobs + drafts), so throttle it + the queue to ~6s.
let _autotick = 0;
setInterval(() => {
  if (!document.getElementById('autolog').checked) return;
  loadLogs();
  if (++_autotick % 4 === 0) { loadJobs(); loadQueue(); }
}, 1500);
