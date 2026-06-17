/* EpubForge background: storage-backed store for history/queue/settings + downloads. */
importScripts('lib/common.js');  // self.BSU shared helpers (base64, escape, drag/clamp)
const get = (k) => new Promise(r => chrome.storage.local.get(k, o => r(o[k])));
const set = (k, v) => new Promise(r => chrome.storage.local.set({ [k]: v }, r));
const b64FromBuf = (buf) => BSU.b64FromBytes(new Uint8Array(buf));
// Unique session-rule id per fetchBytes call. A single shared id let a concurrent cover fetch and
// chapter-image fetch clobber each other's modifyHeaders rule (one's cleanup removed the other's).
let _ruleSeq = 0;
const nextRuleId = () => 8000 + (_ruleSeq = (_ruleSeq + 1) % 1000);
const MAX_IMG_BYTES = 25 * 1024 * 1024;  // cap on a single embedded image (cover/illustration)

chrome.runtime.onMessage.addListener((m, _s, send) => {
  (async () => {
    try {
      switch (m && m.type) {
        case 'download': {
          const id = await chrome.downloads.download({ url: m.url, filename: m.filename || undefined });
          send({ ok: true, id }); break;
        }
        case 'history.add': {
          const h = (await get('history')) || [];
          h.unshift(Object.assign({ id: 'h' + crypto.randomUUID() }, m.rec));
          await set('history', h.slice(0, 300)); send({ ok: true }); break;
        }
        case 'history.list': send({ history: (await get('history')) || [] }); break;
        case 'history.clear': await set('history', []); send({ ok: true }); break;
        case 'log.add': { const l = (await get('logs')) || []; l.push(m.line); await set('logs', l.slice(-2000)); send({ ok: true }); break; }
        case 'log.list': send({ logs: (await get('logs')) || [] }); break;
        case 'log.clear': await set('logs', []); send({ ok: true }); break;
        case 'queue.add': {
          const q = (await get('queue')) || [];
          if (!q.find(x => x.md5 && x.md5 === m.item.md5)) q.unshift(m.item);
          await set('queue', q); send({ ok: true, queue: q }); break;
        }
        case 'queue.list': send({ queue: (await get('queue')) || [] }); break;
        case 'queue.remove': { let q = (await get('queue')) || []; q = q.filter(x => x.id !== m.id); await set('queue', q); send({ ok: true, queue: q }); break; }
        case 'queue.update': { const q = (await get('queue')) || []; const it = q.find(x => x.id === m.id); if (it) Object.assign(it, m.patch); await set('queue', q); send({ ok: true, queue: q }); break; }
        case 'queue.clear': await set('queue', []); send({ ok: true, queue: [] }); break;
        case 'settings.get': send({ settings: (await get('settings')) || {} }); break;
        case 'settings.set': { const s = Object.assign((await get('settings')) || {}, m.patch); await set('settings', s); send({ ok: true, settings: s }); break; }
        case 'injectLibs': {
          const tabId = _s && _s.tab && _s.tab.id;
          if (!tabId) { send({ ok: false, error: 'no tab' }); break; }
          await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/readability.js', 'lib/epub.js', 'lib/presets.js'] });
          send({ ok: true }); break;
        }
        case 'openDashboard': await chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html') }); send({ ok: true }); break;
        case 'fetchBytes': {
          // Cross-origin image fetch for EPUB embedding. Replays the page's cookies (incl. the HttpOnly
          // cf_clearance that Chrome won't auto-attach to extension requests) + Referer via a temporary
          // header rule, so Cloudflare-/hotlink-gated images fetch. 15s timeout so one stall can't freeze.
          const RID = nextRuleId();
          const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
          try {
            const pageUrl = (_s && _s.tab && _s.tab.url) || m.url;
            let top = null; try { top = new URL(pageUrl).origin; } catch (e) {}
            let cookieStr = '';
            try {
              let all = (await chrome.cookies.getAll({ url: m.url })) || [];
              if (top) { try { all = all.concat((await chrome.cookies.getAll({ url: m.url, partitionKey: { topLevelSite: top } })) || []); } catch (e) {} }
              const seen = {}; cookieStr = all.filter(c => seen[c.name] ? false : (seen[c.name] = true)).map(c => c.name + '=' + c.value).join('; ');
            } catch (e) {}
            const reqHeaders = [{ header: 'referer', operation: 'set', value: pageUrl }];
            if (cookieStr) reqHeaders.push({ header: 'cookie', operation: 'set', value: cookieStr });
            // Match this exact URL. urlFilter treats * ^ | as special, so a URL containing them
            // (common in query strings) would fail to match and the headers wouldn't apply. Use an
            // anchored regexFilter built from the URL with all regex metacharacters escaped.
            const reEsc = m.url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
            try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RID], addRules: [{ id: RID, priority: 1, condition: { regexFilter: '^' + reEsc + '$' }, action: { type: 'modifyHeaders', requestHeaders: reqHeaders } }] }); } catch (e) {}
            const r = await fetch(m.url, { cache: 'no-store', credentials: 'include', signal: ctrl.signal });
            if (!r.ok) send({ ok: false, error: 'HTTP ' + r.status + ' (Cloudflare/hotlink — could not replay clearance)' });
            else {
              const ct0 = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
              const buf = await r.arrayBuffer();
              if (buf.byteLength > MAX_IMG_BYTES) send({ ok: false, error: 'too large (' + Math.round(buf.byteLength / 1048576) + ' MB > ' + Math.round(MAX_IMG_BYTES / 1048576) + ' MB cap)' });
              else if (/^text\/html|^application\/(json|xml)/.test(ct0)) send({ ok: false, error: 'blocked (server returned ' + ct0 + ', not an image)' });
              else { const ct = /^image\//.test(ct0) ? ct0 : 'image/jpeg'; send({ ok: true, b64: b64FromBuf(buf), ct }); }
            }
          } catch (e) { send({ ok: false, error: String(e && e.message || e) }); }
          finally { clearTimeout(to); try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RID] }); } catch (e) {} }
          break;
        }
        case 'fetchImageViaTab': {
          // Cloudflare blocks background fetches but lets a real tab navigation through. Open the image
          // in a background tab (its document IS the image's origin → same-origin canvas, not tainted),
          // read the bytes there, close the tab. Used for the cover when fetchBytes is CF-blocked.
          let tab;
          try {
            tab = await chrome.tabs.create({ url: m.url, active: false });
            await new Promise((res, rej) => {
              const t0 = Date.now();
              const tick = () => chrome.tabs.get(tab.id, (tb) => {
                if (chrome.runtime.lastError || !tb) return rej(new Error('tab closed'));
                if (tb.status === 'complete') return res();
                if (Date.now() - t0 > 20000) return rej(new Error('load timeout'));
                setTimeout(tick, 400);
              });
              setTimeout(tick, 500);
            });
            const inj = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: async () => {
                const img = document.querySelector('img') || document.images[0];
                if (!img) return null;
                if (!img.complete) await new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 6000); });
                try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png'); } catch (e) { return null; }
              },
            });
            const dataUrl = inj && inj[0] && inj[0].result;
            if (dataUrl && /^data:image\//.test(dataUrl)) {
              send({ ok: true, b64: dataUrl.slice(dataUrl.indexOf(',') + 1), ct: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png' });
            } else send({ ok: false, error: 'tab method: image not readable' });
          } catch (e) { send({ ok: false, error: 'tab method: ' + String(e && e.message || e) }); }
          finally { if (tab && tab.id) { try { await chrome.tabs.remove(tab.id); } catch (e) {} } }
          break;
        }
        default: send({ ok: false, error: 'unknown' });
      }
    } catch (e) { send({ ok: false, error: String(e && e.message || e) }); }
  })();
  return true; // async
});

// log download outcomes so they show up in the dashboard Logs panel
chrome.downloads.onChanged.addListener((delta) => {
  const st = delta.state && delta.state.current;
  if (st !== 'complete' && st !== 'interrupted') return;
  (async () => {
    const l = (await get('logs')) || [];
    let extra = '';
    if (st === 'interrupted' && delta.error) extra = ' (' + delta.error.current + ')';
    try { const [it] = await chrome.downloads.search({ id: delta.id }); if (it && it.filename) extra += ' ' + it.filename.split(/[\\/]/).pop(); } catch (e) {}
    l.push(new Date().toLocaleTimeString() + ' [dl] ' + st + extra);
    await set('logs', l.slice(-2000));
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html') });
});
