/* EpubForge · Anna's Archive integration.
   On an md5 book page, injects a panel: Fast download (membership key) with
   slow-mirror fallback, plus Queue. Runs in the real AA tab (past Cloudflare). */
(() => {
  if (window.__bs_aa) return; window.__bs_aa = true;
  if (!/annas-archive/i.test(location.hostname)) return; // any AA domain/mirror
  // Keep in sync with novel/engine.js CF_RE — a shorter list here silently missed several
  // Cloudflare interstitials, so AA treated challenge pages as real content.
  const CF_RE = /just a moment|cf-chl|challenge-platform|cf-browser-verification|turnstile|_cf_chl|attention required|checking your browser|verifying you are human/i;
  // A challenge/block is either a CF status code (incl. 429 rate-limit) or a CF marker in the body.
  const isCF = (status, text) => status === 403 || status === 429 || status === 503 || CF_RE.test((text || '').slice(0, 5000));
  const { clampX, clampY, makeDrag } = self.BSU;  // shared from lib/common.js
  const md5m = location.pathname.match(/\/md5\/([a-f0-9]{32})/i);
  console.log('[EpubForge AA] host', location.hostname, 'md5', md5m ? md5m[1] : 'none');
  const settings = () => new Promise(r => chrome.storage.local.get('settings', o => r(o.settings || {})));
  let STAT = null;
  function log(m) { const line = new Date().toLocaleTimeString() + ' [aa] ' + m; try { chrome.runtime.sendMessage({ type: 'log.add', line }); } catch (e) {} if (STAT) STAT.textContent = m; console.log('[EpubForge AA]', m); }

  // ---- panel ----
  function panel() {
    const box = document.createElement('div');
    box.id = 'bs-aa';
    box.innerHTML = '<div class="bs-h">EpubForge</div><div id="bs-stat" class="bs-stat">Ready.</div><div class="bs-row"><button id="bs-dl">⬇ Download</button><button id="bs-q">+ Queue</button></div><button id="bs-dash" class="bs-link">Open dashboard</button>';
    document.body.appendChild(box);
    makeDrag(box, box.querySelector('.bs-h'), { posKey: 'bsAaPos' });
    chrome.storage.local.get('bsAaPos', (o) => { const p = o.bsAaPos; if (p) { box.style.right = 'auto'; box.style.left = clampX(p.left) + 'px'; box.style.top = clampY(p.top) + 'px'; } });
    return box;
  }
  const titleOf = () => ((document.querySelector('main h1, .text-3xl, [class*="text-3xl"]') || {}).innerText || document.title || 'book').trim().slice(0, 200);

  async function fastUrl(md5) {
    const s = await settings();
    if (!s.aaKey) return null;
    const key = encodeURIComponent(s.aaKey);
    // Try a few server/mirror combinations instead of only (0,0) — index 0 is often dead.
    // Stop at the first one that returns a download_url (only failing calls make extra requests).
    for (let path = 0; path < 4; path++) {
      for (let dom = 0; dom < 2; dom++) {
        const api = location.origin + '/dyn/api/fast_download.json?md5=' + md5 + '&key=' + key + '&path_index=' + path + '&domain_index=' + dom;
        try { const r = await fetch(api, { credentials: 'include' }); const j = await r.json(); if (j && j.download_url) return j.download_url; }
        catch (e) {}
      }
    }
    return null;
  }
  // ONLY slow (free) partner-server links — never the member-only ones
  const slowLinks = () => [...new Set([...document.querySelectorAll('a[href*="/slow_download/"]')].map(a => a.href))];
  // get slow options for a book: from this page if we're on it, else fetch its md5 page
  async function getSlowOptions(md5) {
    if (new RegExp('/md5/' + md5, 'i').test(location.pathname)) return slowLinks();
    const base = location.origin + '/md5/' + md5;
    let res; try { res = await fetch(base, { credentials: 'include' }); } catch (e) { log('md5 page fetch failed: ' + e.message); return []; }
    const text = await res.text();
    if (isCF(res.status, text)) { log('Cloudflare on the book page — open it once to clear, then retry.'); return []; }
    const d = new DOMParser().parseFromString(text, 'text/html');
    return [...new Set([...d.querySelectorAll('a[href*="/slow_download/"]')].map(a => { try { return new URL(a.getAttribute('href'), base).href; } catch (e) { return ''; } }).filter(Boolean))];
  }
  const dl = (url, via, title, md5) => { chrome.runtime.sendMessage({ type: 'download', url }); chrome.runtime.sendMessage({ type: 'history.add', rec: { kind: 'aa', via, title, md5, ts: Date.now() } }); };

  const SKIP = ['jdownloader.org', 'telegram.org', 't.me', 'discord', 'reddit.com', 'twitter.com', 'facebook.com', 'instagram.com', 'patreon', 'ko-fi', 'buymeacoffee', '.onion', '/account', '/search', '/md5', '/donate', '/login', '/faq'];
  const EXTS = ['.epub', '.pdf', '.mobi', '.azw3', '.cbz', '.cbr', '.djvu', '.txt', '.fb2', '.zip', 'get.php', 'main.php', 'download.php'];
  const isBad = (h) => SKIP.some(s => h.includes(s));

  // fetch a slow_download page and extract the ACTUAL file url (stacks' 4 methods)
  async function resolveFileUrl(slowUrl, md5) {
    let res; try { res = await fetch(slowUrl, { credentials: 'include' }); } catch (e) { return { err: e.message }; }
    const text = await res.text();
    if (isCF(res.status, text)) return { cf: true };
    const d = new DOMParser().parseFromString(text, 'text/html');
    const prefix = md5.slice(0, 12).toLowerCase();
    const abs = (h) => { try { return new URL(h, slowUrl).href; } catch (e) { return ''; } };
    // M1: link whose href carries the md5 prefix (the real file), not another slow_download
    for (const a of d.querySelectorAll('a[href]')) { const h = abs(a.getAttribute('href')); if (!/^https?:/.test(h) || isBad(h.toLowerCase()) || /slow_download/i.test(h)) continue; if (h.toLowerCase().includes(prefix)) return { url: h }; }
    // M2: download/get link with a file extension
    for (const a of d.querySelectorAll('a[href]')) { const h = abs(a.getAttribute('href')); const t = (a.textContent || '').toLowerCase(); if (!/^https?:/.test(h) || isBad(h.toLowerCase())) continue; if ((t.includes('download') || t.includes('get')) && EXTS.some(e => h.toLowerCase().includes(e))) return { url: h }; }
    // M3: clipboard button onclick=...writeText('<url>') — accept single OR double quotes
    for (const b of d.querySelectorAll('button[onclick],[onclick]')) { const m = /writeText\(\s*(['"])(.*?)\1/.exec(b.getAttribute('onclick') || ''); const v = m && m[2]; if (v && v.toLowerCase().includes(prefix)) return { url: v }; }
    // M4: raw url printed in a span
    for (const s of d.querySelectorAll('span,code,p')) { const t = (s.textContent || '').trim(); if (t.startsWith('http') && t.toLowerCase().includes(prefix)) return { url: t.split(/\s/)[0] }; }
    // detect a countdown/wait page (link not yet available)
    if (/wait|countdown|seconds|too many|try again/i.test(text.slice(0, 8000))) return { wait: true };
    return { none: true };
  }

  async function doDownload(md5, titleArg) {
    const title = titleArg || titleOf();
    const s = await settings();
    if (s.aaKey) {
      log('Trying fast download (membership key)…');
      const url = await fastUrl(md5);
      if (url) { log('✅ Fast link obtained — downloading.'); dl(url, 'fast', title, md5); return; }
      log('Fast unavailable — sweeping slow options…');
    }
    log('Getting download options…');
    const opts = await getSlowOptions(md5);
    log('Found ' + opts.length + ' slow option(s).');
    let waited = false;
    for (let i = 0; i < opts.length; i++) {
      log('Slow option ' + (i + 1) + '/' + opts.length + ' …');
      const r = await resolveFileUrl(opts[i], md5);
      if (r.url) { log('✅ Resolved file URL (option ' + (i + 1) + ') — downloading.'); dl(r.url, 'slow', title, md5); return; }
      if (r.cf) { log('  option ' + (i + 1) + ': Cloudflare — skipping.'); continue; }
      if (r.wait) { waited = true; log('  option ' + (i + 1) + ': countdown/wait page (no direct link).'); continue; }
      log('  option ' + (i + 1) + ': no file link' + (r.err ? ' (' + r.err + ')' : '') + '.');
    }
    // nothing auto-resolved → open the slow page (or the book page) to finish manually
    const openUrl = opts.length ? opts[0] : (location.origin + '/md5/' + md5);
    window.open(openUrl, '_blank');
    chrome.runtime.sendMessage({ type: 'history.add', rec: { kind: 'aa', via: 'slow-manual', title, md5, ts: Date.now() } });
    log(waited ? 'All options timed — opened the page; complete its countdown.' : 'Opened the page for manual download.');
  }

  // ---- search-result inline buttons (Download / Queue per book) ----
  const md5FromHref = (h) => { const m = (h || '').match(/\/md5\/([a-f0-9]{32})/i); return m ? m[1].toLowerCase() : null; };
  function injectSearchButtons() {
    document.querySelectorAll('a[href*="/md5/"]').forEach(a => {
      if (a.dataset.bsInjected) return;
      const md5 = md5FromHref(a.getAttribute('href')); if (!md5) return;
      const title = (a.textContent || '').trim();
      if (title.length < 4) return; // skip cover/icon links (no text)
      a.dataset.bsInjected = '1';
      const wrap = document.createElement('span'); wrap.className = 'bs-inline';
      const dlb = document.createElement('button'); dlb.className = 'bs-mini'; dlb.textContent = '⬇ Download';
      const qb = document.createElement('button'); qb.className = 'bs-mini ghost'; qb.textContent = '+ Queue';
      dlb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); dlb.textContent = '…'; log('Search download: ' + title.slice(0, 50)); doDownload(md5, title).finally(() => dlb.textContent = '⬇ Download'); };
      qb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); chrome.runtime.sendMessage({ type: 'queue.add', item: { id: md5, md5, title: title.slice(0, 200), url: location.origin + '/md5/' + md5, status: 'queued', ts: Date.now() } }, () => { qb.textContent = '✓ Queued'; setTimeout(() => qb.textContent = '+ Queue', 1500); }); };
      wrap.appendChild(dlb); wrap.appendChild(qb);
      a.insertAdjacentElement('afterend', wrap);
    });
  }

  if (md5m) {
    const md5 = md5m[1].toLowerCase();
    const box = panel();
    STAT = box.querySelector('#bs-stat');
    box.querySelector('#bs-dl').onclick = () => doDownload(md5);
    box.querySelector('#bs-q').onclick = () => {
      chrome.runtime.sendMessage({ type: 'queue.add', item: { id: md5, md5, title: titleOf(), url: location.href, status: 'queued', ts: Date.now() } }, () => log('Added to queue.'));
    };
    box.querySelector('#bs-dash').onclick = () => chrome.runtime.sendMessage({ type: 'openDashboard' });
    log('Ready (' + md5.slice(0, 8) + '…).');
    if (/[?&]bsauto=1/.test(location.search)) setTimeout(() => doDownload(md5), 800);
  } else {
    injectSearchButtons();
    // Only re-scan when nodes are ADDED (ignore attribute/text mutations) so a busy page doesn't
    // trigger a full-document a[href*=/md5/] sweep on every unrelated change.
    let t; const mo = new MutationObserver((muts) => { if (muts.some(m => m.addedNodes && m.addedNodes.length)) { clearTimeout(t); t = setTimeout(injectSearchButtons, 400); } });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
  }
})();
