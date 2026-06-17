/* EpubForge generic engine (epublifier-style, any site).
   Dormant until opened from the toolbar (or an active job for this page exists).
   Modes: 'links' (TOC selector + optional pager/numeric pagination → fetch URLs)
          'spa'   (click a Next button repeatedly, extract each page).
   Content: Content selector or Mozilla Readability. Cloudflare-resilient + resume (links mode). */
(() => {
  if (window.__bs_engine) return; window.__bs_engine = true;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const MAX_LIST_PAGES = 1000;                                // safety cap when paging a multi-page chapter LIST (numeric or URL pager)
  const listDelay = () => sleep(140 + Math.random() * 120);   // jittered politeness pause between list-page fetches
  // EPUB content defaults — delegate to PRESETS so there's one canonical copy (lib/presets.js).
  // The inline literal is only a load-order safety net for the rare case PRESETS isn't injected yet.
  const STYLE_DEFAULTS = () => (window.PRESETS && window.PRESETS.STYLE_DEFAULTS)
    ? window.PRESETS.STYLE_DEFAULTS()
    : { cover: 'auto', number: 'never', heading: true, images: true, toc: true, tocNumbers: false };
  const { clampX, clampY, makeDrag } = self.BSU;  // shared from lib/common.js
  const PAGEKEY = location.origin + location.pathname.replace(/\/+$/, '');
  const JOBKEY = 'novelJob:' + PAGEKEY;
  const S = {
    get: () => new Promise(r => chrome.storage.local.get(JOBKEY, o => r(o[JOBKEY] || null))),
    set: (j) => new Promise(r => chrome.storage.local.set({ [JOBKEY]: j }, r)),
    clear: () => new Promise(r => chrome.storage.local.remove(JOBKEY, r)),
  };
  // Keyed chapter store backed by IndexedDB. One impl, two instances (links job + click job).
  function makeStore(dbName) {
    const open = () => new Promise((res, rej) => { const q = indexedDB.open(dbName, 1); q.onupgradeneeded = () => q.result.createObjectStore('ch'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    return {
      put: async (i, v) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction('ch', 'readwrite'); t.objectStore('ch').put(v, i); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
      all: async () => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction('ch', 'readonly'); const out = []; const c = t.objectStore('ch').openCursor(); c.onsuccess = e => { const cur = e.target.result; if (cur) { out.push([cur.key, cur.value]); cur.continue(); } else res(out); }; c.onerror = () => rej(c.error); }); },
      clear: async () => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction('ch', 'readwrite'); t.objectStore('ch').clear(); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
    };
  }
  // Per-page DB name. Hash the FULL key — never truncate btoa, which collapses to the domain
  // prefix (first ~21 bytes) and makes every book on a site share one chapter store.
  const DBN = 'bs_' + hash(PAGEKEY);
  // Click-through survives navigation across chapter URLs, so its store/job can't key by PAGEKEY
  // (changes every page). Chapter URLs stay on one origin → key by origin: cross-site jobs stay
  // isolated, cross-navigation resume within a site still works.
  const ORIGINKEY = location.origin;
  const CLICKKEY = 'bsClickJob:' + ORIGINKEY;
  const linkStore = makeStore(DBN), clickStore = makeStore('bs_click_' + hash(ORIGINKEY));
  const dbPut = linkStore.put, dbAll = linkStore.all, dbClear = linkStore.clear;
  const cPut = clickStore.put, cAll = clickStore.all, cClear = clickStore.clear;

  // click-through job (survives navigation between chapter URLs, scoped to this origin)
  const CJ = {
    get: () => new Promise(r => chrome.storage.local.get(CLICKKEY, o => r(o[CLICKKEY] || null))),
    set: (j) => new Promise(r => chrome.storage.local.set({ [CLICKKEY]: j }, r)),
    clear: () => new Promise(r => chrome.storage.local.remove(CLICKKEY, r)),
  };

  // working-state draft (config + parsed list) per page, so Meta edits and the chapter list
  // survive a Cloudflare refresh. customCover bytes aren't persisted (re-pick after a reload).
  const DRAFTKEY = 'novelDraft:' + PAGEKEY;
  let _saveT;
  const saveDraft = () => { try { chrome.storage.local.set({ [DRAFTKEY]: { cfg: CFG, preview, ts: Date.now() } }); } catch (e) {} };
  const scheduleSave = () => { clearTimeout(_saveT); _saveT = setTimeout(saveDraft, 500); };
  // chosen cover bytes, persisted separately (not in the per-keystroke draft) so they survive a refresh
  const COVERKEY = 'novelCover:' + PAGEKEY;
  const persistCover = () => { try { if (customCover) chrome.storage.local.set({ [COVERKEY]: BSU.b64FromBytes(customCover) }); else chrome.storage.local.remove(COVERKEY); } catch (e) {} };

  let libsReady = false;
  async function ensureLibs() {
    if (libsReady && window.EPUB && window.PRESETS) return true;
    await new Promise(r => chrome.runtime.sendMessage({ type: 'injectLibs' }, r));
    libsReady = !!(window.EPUB && window.PRESETS);
    return libsReady;
  }

  // ---------- network + Cloudflare ----------
  const CF_RE = /just a moment|cf-chl|challenge-platform|cf-browser-verification|turnstile|_cf_chl|attention required|checking your browser|verifying you are human/i;
  const isCF = (st, t) => (st === 403 || st === 429 || st === 503) || CF_RE.test((t || '').slice(0, 6000));
  async function getPage(u) {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 20000);  // don't let one stalled URL freeze the run
    try { const r = await fetch(u, { credentials: 'include', cache: 'no-store', signal: ctrl.signal }); const t = await r.text(); return { status: r.status, text: t, cf: isCF(r.status, t) }; }
    catch (e) { return { status: 0, text: '', cf: false, err: e.message }; }
    finally { clearTimeout(to); }
  }

  // ---------- content extraction ----------
  // Strip non-content cruft. Use [class~="nav"] (exact whitespace-separated token) + explicit nav
  // words, NOT [class*="nav"] — the latter also nukes prose-bearing elements like "naval"/"navigate".
  function cleanEl(el) { el.querySelectorAll('script,style,ins,button,nav,iframe,.ads,.adsbygoogle,[role="navigation"],[class~="nav"],[class*="navbar"],[class*="navigation"],[class*="breadcrumb"],[class*="pagination"]').forEach(e => e.remove()); }
  function serializeEl(el) { const s = new XMLSerializer(); let h = ''; Array.from(el.childNodes).forEach(n => { h += s.serializeToString(n); }); return h; }
  // Largest plausible text container. Accept a block with ≥3 <p>, OR enough <br>-separated lines,
  // OR just a lot of text — so chapters written with <br>/<div> instead of <p> aren't missed.
  function densest(doc) {
    let best = null, bl = 0;
    doc.querySelectorAll('div,article,section,main').forEach(e => {
      const len = (e.textContent || '').length;
      const looksLikeText = e.querySelectorAll('p').length >= 3 || e.querySelectorAll('br').length >= 6 || len > 1200;
      if (looksLikeText && len > bl) { bl = len; best = e; }
    });
    return best;
  }
  function extract(doc, contentSelector) {
    if (contentSelector) { const el = doc.querySelector(contentSelector); if (el) { cleanEl(el); return { title: null, html: serializeEl(el) }; } }
    try { const R = (typeof Readability !== 'undefined') ? Readability : window.Readability; if (R) { const art = new R(doc).parse(); if (art && art.content) return { title: art.title, html: art.content }; } } catch (e) {}
    const b = densest(doc); if (b) { cleanEl(b); return { title: null, html: serializeEl(b) }; }
    return null;
  }
  const cloneDoc = () => new DOMParser().parseFromString('<!DOCTYPE html>' + document.documentElement.outerHTML, 'text/html');
  const wantImages = () => !(CFG.style && CFG.style.images === false);  // on by default
  const IMG_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };
  const hashStr = hash;  // same djb2 as the store-name hash, hoisted at top
  const b64ToU8 = BSU.b64ToBytes;  // shared from lib/common.js
  const fetchBytes = (url) => new Promise(r => { try { chrome.runtime.sendMessage({ type: 'fetchBytes', url }, x => r(x || null)); } catch (e) { r(null); } });
  let imgCache = new Map(), imgStored = new Set(), imgSeq = 0;  // per-run dedup of fetched/packaged images (imgSeq guarantees unique filenames)
  // Download each <img>, store it as a real EPUB resource (images/<hash>.<ext>) via putImg, and
  // rewrite the <img src> to that relative path — proper packaged files, not data: URLs (so every
  // reader renders them). Fetched through the background (bypasses CORS). Failures drop that image.
  async function embedImages(html, base, putImg) {
    let d; try { d = new DOMParser().parseFromString('<!DOCTYPE html><body>' + (html || '') + '</body>', 'text/html'); } catch (e) { return html; }
    const imgs = [...d.body.querySelectorAll('img')];
    if (!imgs.length) return html;
    let ok = 0, fail = 0;
    for (const img of imgs) {
      // prefer lazy-load attrs — many sites put a placeholder in src and the real image in data-*
      const raw = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '';
      if (/^data:/i.test(raw)) { ok++; continue; }  // already inline; leave as-is
      let abs; try { abs = new URL(raw, base).href; } catch (e) { img.remove(); fail++; continue; }
      if (!/^https?:/i.test(abs)) { img.remove(); fail++; continue; }
      let entry = imgCache.get(abs);
      if (entry === undefined) {
        const res = await fetchBytes(abs);
        if (res && res.ok && res.b64) {
          const ext = IMG_EXT[res.ct] || 'jpg';
          // hash for readability + a per-run sequence so two URLs that happen to hash the same never
          // collide (the cache above already gives one name per distinct URL).
          const name = 'images/' + hashStr(abs) + '-' + (imgSeq++) + '.' + ext;
          entry = { name, bytes: b64ToU8(res.b64), type: res.ct };
          if (putImg && !imgStored.has(name)) { try { await putImg('img:' + name, entry); imgStored.add(name); } catch (e) { entry = null; } }  // store failed → drop, don't leave a dangling ref
        } else entry = null;
        imgCache.set(abs, entry);
      }
      if (entry) { img.setAttribute('src', entry.name); img.removeAttribute('data-src'); img.removeAttribute('srcset'); ok++; }
      else { img.remove(); fail++; }
    }
    if (ok || fail) log('images: ' + ok + ' embedded' + (fail ? ', ' + fail + ' skipped' : ''));
    const s = new XMLSerializer(); let out = ''; d.body.childNodes.forEach(n => { try { out += s.serializeToString(n); } catch (e) {} });
    return out;
  }

  // ---------- selector inference (pickers) ----------
  function inferLinkSelector(a) {
    const cands = [];
    if (a.classList.length) cands.push('a.' + CSS.escape([...a.classList][0]));
    const cont = a.closest('ul,ol,table,tbody,div,section');
    if (cont && cont.classList.length) cands.push('.' + CSS.escape([...cont.classList][0]) + ' a');
    if (cont && cont.id) cands.push('#' + CSS.escape(cont.id) + ' a');
    const seg = (a.getAttribute('href') || '').split('/').filter(Boolean).slice(-2, -1)[0];
    if (seg) cands.push('a[href*="' + seg + '"]');
    cands.push('a');
    let best = 'a', bestN = -1;
    for (const s of cands) { try { const n = document.querySelectorAll(s).length; if (n >= 2 && n <= 100000 && (bestN < 0 || n < bestN || bestN < 2)) { best = s; bestN = n; } } catch (e) {} }
    return best;
  }
  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      let p = el.tagName.toLowerCase();
      if (el.classList.length) p += '.' + [...el.classList].slice(0, 2).map(c => CSS.escape(c)).join('.');
      const par = el.parentElement;
      if (par) { const sib = [...par.children].filter(s => s.tagName === el.tagName); if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')'; }
      parts.unshift(p); if (el.id) break; el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function containerOf(el) {
    let cur = el, best = null;
    for (let k = 0; k < 7 && cur && cur.nodeType === 1; k++) {
      const links = cur.querySelectorAll ? cur.querySelectorAll('a').length : 0;
      if (/^(ul|ol|table|tbody)$/i.test(cur.tagName) || links >= 3) { best = cur; if (links >= 3) break; }
      cur = cur.parentElement;
    }
    return best || el;
  }
  // Build a selector that UNIQUELY identifies el, qualifying with ancestors (epublifier-style
  // "parent > child") when a bare class is ambiguous — so a shared class like .ul-list5 becomes
  // .m-newest2 > .ul-list5 instead of matching every list on the page. Derived from the live DOM.
  function elSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const part = (e) => e.id ? '#' + CSS.escape(e.id) : (e.classList.length ? e.tagName.toLowerCase() + '.' + CSS.escape([...e.classList][0]) : e.tagName.toLowerCase());
    const unique = (s) => { try { const n = document.querySelectorAll(s); return n.length === 1 && n[0] === el; } catch (e) { return false; } };
    let sel = part(el);
    if (unique(sel)) return sel;
    let cur = el;
    for (let d = 0; d < 6; d++) {
      const par = cur.parentElement;
      if (!par || par.nodeType !== 1) break;
      sel = part(par) + ' > ' + sel;     // direct-child chain up the real hierarchy
      if (unique(sel)) return sel;
      if (par.id) break;                 // an id ancestor is as specific as it gets
      cur = par;
    }
    return sel;
  }

  // ---------- UI ----------
  let UI, CFG, preview = [], picking = null, ABORT = false, customCover = null, activeTab = 'parser';
  const css = (o) => Object.entries(o).map(([k, v]) => k + ':' + v).join(';');
  const B = { bg: '#282a36', bg2: '#21222c', fg: '#f8f8f2', mut: '#6272a4', line: '#44475a', pur: '#bd93f9', grn: '#50fa7b', cyan: '#8be9fd', org: '#ffb86c', field: '#1a1b23' };

  function field(label, key, withPick, help) {
    const wrap = document.createElement('div'); wrap.style.cssText = css({ margin: '6px 0' }); if (help) wrap.title = help;
    wrap.innerHTML = '<div style="color:' + B.mut + ';font-size:11px;margin-bottom:2px">' + label + (help ? ' <span style="cursor:help;color:' + B.cyan + '">ⓘ</span>' : '') + '</div>';
    const row = document.createElement('div'); row.style.cssText = css({ display: 'flex', gap: '4px' });
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = CFG[key] || '';
    inp.style.cssText = css({ flex: '1', background: B.field, border: '1px solid ' + B.line, color: B.fg, 'border-radius': '5px', padding: '5px 7px', font: '12px monospace' });
    inp.oninput = () => { CFG[key] = inp.value; };
    row.appendChild(inp);
    if (withPick) { const pk = document.createElement('button'); pk.textContent = '⌖'; pk.title = 'Click this, then click the matching element on the page — it fills in the selector for you.'; pk.style.cssText = btnCss(false); pk.onclick = () => startPick(key, inp); row.appendChild(pk); }
    wrap.appendChild(row); return wrap;
  }

  // "Where is the chapter text?" — Automatic (Readability) by default, or a Custom CSS element.
  // Stores the chosen selector in CFG.contentSelector ('' = Automatic, the engine's default path).
  function contentField() {
    const wrap = document.createElement('div'); wrap.style.cssText = css({ margin: '6px 0' });
    wrap.title = 'Where the chapter text lives on the page. "Automatic" (default) reads the page and keeps the main article text — works on most sites; if it finds nothing it falls back to the largest text block. Use "Custom" only if Automatic grabs menus/ads or misses text.';
    wrap.innerHTML = '<div style="color:' + B.mut + ';font-size:11px;margin-bottom:2px">Chapter text source <span style="cursor:help;color:' + B.cyan + '">ⓘ</span></div>';
    const sel = document.createElement('select');
    sel.style.cssText = css({ width: '100%', background: B.field, border: '1px solid ' + B.line, color: B.fg, 'border-radius': '5px', padding: '5px 7px', font: '12px system-ui,sans-serif', cursor: 'pointer' });
    sel.innerHTML = '<option value="auto">Automatic — detect &amp; clean (default)</option><option value="custom">Custom — pick the text element</option>';
    const custom = document.createElement('div'); custom.style.cssText = css({ gap: '4px', 'margin-top': '4px' });
    const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'CSS selector, e.g. .chapter-content'; inp.value = CFG.contentSelector || CFG._customSel || CFG.contentHint || '';
    inp.style.cssText = css({ flex: '1', background: B.field, border: '1px solid ' + B.line, color: B.fg, 'border-radius': '5px', padding: '5px 7px', font: '12px monospace' });
    inp.oninput = () => { CFG.contentSelector = inp.value; CFG._customSel = inp.value; };
    const pk = document.createElement('button'); pk.textContent = '⌖'; pk.title = 'Click this, then click the chapter text on the page.'; pk.style.cssText = btnCss(false); pk.onclick = () => startPick('contentSelector', inp);
    custom.appendChild(inp); custom.appendChild(pk);
    // Automatic = active extraction is '' (Readability). Custom = the input's selector. _customSel
    // remembers a typed selector so toggling Auto→Custom doesn't lose it (contentHint is the fallback).
    const apply = () => { const isC = sel.value === 'custom'; custom.style.display = isC ? 'flex' : 'none'; if (isC) { if (!inp.value) inp.value = CFG._customSel || CFG.contentHint || ''; CFG.contentSelector = inp.value; CFG._customSel = inp.value; } else CFG.contentSelector = ''; };
    sel.value = CFG.contentSelector ? 'custom' : 'auto'; sel.onchange = apply;
    wrap.appendChild(sel); wrap.appendChild(custom); apply();
    return wrap;
  }
  function btnCss(primary) { return css({ padding: '6px 9px', border: '0', 'border-radius': '5px', cursor: 'pointer', 'font-weight': '600', 'font-size': '12px', background: primary ? B.pur : B.line, color: primary ? B.bg : B.fg }); }

  // EPUB content options — what gets baked into the file (not fonts/alignment; the reader
  // handles those). Stored in CFG.style (persisted with the job), read by packageAndDownload.
  function styleSection() {
    const st = CFG.style || (CFG.style = STYLE_DEFAULTS());
    const wrap = document.createElement('div');
    const labelRow = (label, help) => '<div style="color:' + B.mut + ';font-size:11px;margin-bottom:2px">' + label + (help ? ' <span style="cursor:help;color:' + B.cyan + '">ⓘ</span>' : '') + '</div>';
    const drop = (label, opts, get, set, help) => {
      const row = document.createElement('div'); row.style.cssText = css({ margin: '6px 0' }); if (help) row.title = help;
      row.innerHTML = labelRow(label, help);
      const sel = document.createElement('select'); sel.style.cssText = css({ width: '100%', background: B.field, border: '1px solid ' + B.line, color: B.fg, 'border-radius': '5px', padding: '4px 6px', font: '12px system-ui,sans-serif', cursor: 'pointer' });
      sel.innerHTML = opts.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('');
      sel.value = get(); sel.onchange = () => set(sel.value, sel);
      row.appendChild(sel); wrap.appendChild(row);
    };
    const toggle = (label, get, set, help) => {
      const row = document.createElement('label'); row.style.cssText = css({ display: 'flex', 'align-items': 'center', gap: '6px', margin: '8px 0', color: B.fg, 'font-size': '12px', cursor: 'pointer' }); if (help) row.title = help;
      const ck = document.createElement('input'); ck.type = 'checkbox'; ck.checked = get(); ck.style.cssText = CB;
      ck.onchange = () => set(ck.checked);
      const tx = document.createElement('span'); tx.innerHTML = label + (help ? ' <span style="cursor:help;color:' + B.cyan + '">ⓘ</span>' : '');
      row.appendChild(ck); row.appendChild(tx); wrap.appendChild(row);
    };
    drop('Chapter numbers', [['never', 'Never — use titles as-is'], ['auto', 'Auto — add only if the title has no number'], ['always', 'Always add “Chapter N”']],
      () => st.number || 'never', (v) => { st.number = v; },
      'Whether to prepend “Chapter N — ” to each chapter heading + contents entry. Never (default) = scraped titles exactly. Auto = only titles that contain no number at all. Always = force it on every chapter.');
    toggle('Show chapter title heading', () => st.heading !== false, (v) => { st.heading = v; },
      'Print the chapter title as a heading at the top of each chapter page. Off = text only (the reader still shows the title in its own contents list).');
    toggle('Embed images', () => st.images !== false, (v) => { st.images = v; },
      'On by default. Downloads images in each chapter and bakes them into the EPUB at their correct spot. Turn off for text-only books (smaller, faster).');
    toggle('Include contents page', () => st.toc !== false, (v) => { st.toc = v; },
      'Add a clickable Table of Contents page inside the book. Off = rely on the reader’s own contents list.');
    toggle('Number the contents list', () => !!st.tocNumbers, (v) => { st.tocNumbers = v; },
      'Off (default): contents shows chapter titles only. On: prefixes each entry with a list number (1. 2. 3.) — note this counts list position, so it can drift from a title’s own “Chapter N”, especially with two-part chapters.');
    return wrap;
  }
  // Book metadata (editable). Stored in CFG.meta; cover choice stays in CFG.style.cover.
  function metaSection() {
    const m = CFG.meta || (CFG.meta = { title: CFG.title || document.title || 'Book', author: 'Unknown', series: '', seriesIndex: '', language: 'en', description: '', coverUrl: '' });
    const st = CFG.style || (CFG.style = STYLE_DEFAULTS());
    const wrap = document.createElement('div');
    const fld = (label, key, help, multiline) => {
      const row = document.createElement('div'); row.style.cssText = css({ margin: '6px 0' }); if (help) row.title = help;
      row.innerHTML = '<div style="color:' + B.mut + ';font-size:11px;margin-bottom:2px">' + label + (help ? ' <span style="cursor:help;color:' + B.cyan + '">ⓘ</span>' : '') + '</div>';
      const inp = document.createElement(multiline ? 'textarea' : 'input'); if (!multiline) inp.type = 'text';
      inp.value = m[key] || '';
      inp.style.cssText = css({ width: '100%', background: B.field, border: '1px solid ' + B.line, color: B.fg, 'border-radius': '5px', padding: '5px 7px', font: '12px system-ui,sans-serif' }) + (multiline ? ';min-height:96px;resize:vertical' : '');
      inp.oninput = () => { m[key] = inp.value; };
      row.appendChild(inp); wrap.appendChild(row);
    };
    fld('Title', 'title', 'Book title — used for the file name and shown in your reader.');
    fld('Author', 'author', 'Author or translator. Your reader sorts the library by this, so avoid leaving it “Unknown”.');
    fld('Series', 'series', 'Optional. Series name — readers group the books in a series together.');
    fld('Series index', 'seriesIndex', 'Optional. This book’s position in the series (1, 2, 3…).');
    fld('Language', 'language', 'Two-letter code (en, zh, ja, ko…). Helps the reader pick fonts and hyphenation.');
    fld('Description', 'description', 'Optional blurb shown in your reader’s book details.', true);
    // cover (writes CFG.style.cover so the EPUB builder picks it up)
    const cv = document.createElement('div'); cv.style.cssText = css({ margin: '6px 0' }); cv.title = 'Cover baked into the book. "From page" uses the cover image found on this page.';
    cv.innerHTML = '<div style="color:' + B.mut + ';font-size:11px;margin-bottom:2px">Cover image <span style="cursor:help;color:' + B.cyan + '">ⓘ</span></div>';
    const sel = document.createElement('select'); sel.style.cssText = css({ width: '100%', background: B.field, border: '1px solid ' + B.line, color: B.fg, 'border-radius': '5px', padding: '4px 6px', font: '12px system-ui,sans-serif', cursor: 'pointer' });
    sel.innerHTML = [['auto', 'Auto-generated'], ['page', 'From page (og:image)'], ['select', 'Select image on page…'], ['upload', 'Upload image…'], ['none', 'No cover']].map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('');
    sel.value = st.cover || 'auto';
    // Only auto/none persist immediately. select/upload/page are actions that capture an image —
    // their mode is saved only once an image is actually captured (in pickCover/grabImageUrl), and
    // the dropdown reverts to the saved mode if the action is cancelled/fails. This stops the panel
    // from re-opening stuck on "Select" with no image behind it.
    sel.onchange = () => {
      const v = sel.value;
      if (v === 'auto' || v === 'none') { st.cover = v; customCover = null; persistCover(); }
      else if (v === 'upload') pickCover(sel);
      else if (v === 'page') grabPageCover(sel);
      else if (v === 'select') { status('Click any image on the page to use as the cover (Esc to cancel).'); startPick('coverImage', sel); }
    };
    cv.appendChild(sel);
    if (customCover) { const hc = document.createElement('div'); hc.style.cssText = css({ color: B.grn, 'font-size': '11px', 'margin-top': '3px' }); hc.textContent = '✓ Cover saved (' + Math.round(customCover.length / 1024) + ' KB) — used when you build, survives refresh'; cv.appendChild(hc); }
    else if (m.coverUrl) { const h = document.createElement('div'); h.style.cssText = css({ color: B.mut, 'font-size': '11px', 'margin-top': '3px' }); h.textContent = 'Page cover detected ✓'; cv.appendChild(h); }
    wrap.appendChild(cv);
    return wrap;
  }

  // Load any image URL (file blob or data: URL) and re-encode to PNG bytes via canvas.
  function imageToPng(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = async () => { try { const cv = document.createElement('canvas'); cv.width = img.naturalWidth || 1600; cv.height = img.naturalHeight || 2400; cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); resolve(new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/png'))).arrayBuffer())); } catch (e) { resolve(null); } };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
  const coverReset = (sel) => { if (sel) sel.value = (CFG.style && CFG.style.cover) || 'auto'; };  // revert dropdown to the saved mode
  // Upload a cover from disk → PNG bytes in customCover (not persisted across reloads).
  function pickCover(sel) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) { coverReset(sel); return; }
      const url = URL.createObjectURL(f); const png = await imageToPng(url); URL.revokeObjectURL(url);
      if (png) { customCover = png; if (CFG.style) CFG.style.cover = 'upload'; persistCover(); scheduleSave(); if (UI) renderPanel(); status('Cover set (' + Math.round(png.length / 1024) + ' KB) — saved.'); log('Custom cover set.'); }
      else { coverReset(sel); status('Could not process that image — using auto cover.'); }
    };
    inp.click();
  }
  // Fetch any image URL (page cover, or a picked on-page image) → PNG bytes in customCover.
  // Routed through the background so cross-origin images don't taint the canvas. mode = which cover
  // option to lock in on success; sel = the dropdown to revert on failure.
  async function grabImageUrl(src, mode, sel) {
    const ok = (png) => { customCover = png; if (CFG.style) CFG.style.cover = mode || 'select'; persistCover(); scheduleSave(); if (UI) renderPanel(); status('Cover set (' + Math.round(png.length / 1024) + ' KB) — saved.'); log('Cover set from image.'); };
    const fail = (msg) => { coverReset(sel); status(msg); };
    if (!src) { fail('No image source found.'); return; }
    if (/^data:/i.test(src)) { const png = await imageToPng(src); if (png) ok(png); else fail('Could not process that image.'); return; }
    let abs; try { abs = new URL(src, location.href).href; } catch (e) { fail('Image URL looks invalid.'); return; }
    status('Fetching image…');
    let res = await new Promise(r => { try { chrome.runtime.sendMessage({ type: 'fetchBytes', url: abs }, x => r(x || null)); } catch (e) { r(null); } });
    if (!(res && res.ok)) {
      // background fetch blocked (Cloudflare) → load it in a background tab, which the browser lets through
      status('Cloudflare-blocked — grabbing it via a background tab…'); log('cover: direct fetch failed (' + ((res && res.error) || 'no response') + '), trying tab method');
      res = await new Promise(r => { try { chrome.runtime.sendMessage({ type: 'fetchImageViaTab', url: abs }, x => r(x || null)); } catch (e) { r(null); } });
    }
    if (!(res && res.ok)) { const why = (res && res.error) || 'no response'; log('cover fetch failed [' + why + ']: ' + abs); fail('Could not fetch image (' + why + '). Use Upload, or right-click the cover → Save → Upload.'); return; }
    const png = await imageToPng('data:' + res.ct + ';base64,' + res.b64);
    if (png) ok(png); else fail('Could not process that image.');
  }
  // Grab the page's detected cover (og:image).
  async function grabPageCover(sel) {
    const url = CFG.meta && CFG.meta.coverUrl;
    if (!url) { coverReset(sel); status('No cover image found on this page — use Select or Upload.'); return; }
    grabImageUrl(url, 'page', sel);
  }

  function buildPanel() {
    const box = document.createElement('div'); box.id = 'bs-engine';
    box.style.cssText = css({ position: 'fixed', top: '12px', right: '12px', 'z-index': '2147483647', width: '380px', 'max-height': '92vh', overflow: 'auto', background: B.bg, color: B.fg, font: '13px/1.45 system-ui,sans-serif', border: '1px solid ' + B.pur, 'border-radius': '8px', padding: '12px', 'box-shadow': '0 8px 30px rgba(0,0,0,.5)' });
    document.body.appendChild(box);
    UI = { box };
    box.addEventListener('input', scheduleSave); box.addEventListener('change', scheduleSave);  // persist edits as a draft
    chrome.storage.local.get('bsPanelPos', (o) => {
      const p = o.bsPanelPos;
      if (p) { box.style.right = 'auto'; box.style.left = clampX(p.left) + 'px'; box.style.top = clampY(p.top) + 'px'; }
    });
    renderPanel();
  }

  function renderPanel() {
    const box = UI.box; box.innerHTML = '';
    const head = document.createElement('div'); head.style.cssText = css({ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '6px' });
    head.innerHTML = '<span style="font-weight:600;color:' + B.pur + '">EpubForge · ' + (CFG.label || 'Parser') + '</span>';
    const min = document.createElement('span'); min.textContent = '–'; min.title = 'minimize'; min.style.cssText = css({ cursor: 'pointer', color: B.mut, 'font-size': '18px', padding: '0 4px' });
    const bodyWrap = document.createElement('div');
    min.onclick = () => { const h = bodyWrap.style.display === 'none'; bodyWrap.style.display = h ? '' : 'none'; min.textContent = h ? '–' : '+'; };
    head.appendChild(min); box.appendChild(head); box.appendChild(bodyWrap);
    makeDrag(box, head, { posKey: 'bsPanelPos', ignore: min });
    UI.prev = null;

    // tabs
    const tabBar = document.createElement('div'); tabBar.style.cssText = css({ display: 'flex', gap: '4px', margin: '4px 0 8px', 'border-bottom': '1px solid ' + B.line });
    [['parser', 'Parser'], ['meta', 'Meta'], ['epub', 'EPUB']].forEach(([id, lbl]) => {
      const t = document.createElement('button'); t.textContent = lbl; const on = activeTab === id;
      t.style.cssText = css({ flex: '1', padding: '6px 8px', border: '0', background: 'transparent', cursor: 'pointer', 'font-weight': '600', 'font-size': '12px', color: on ? B.pur : B.mut, 'border-bottom': '2px solid ' + (on ? B.pur : 'transparent') });
      t.onclick = () => { activeTab = id; renderPanel(); };
      tabBar.appendChild(t);
    });
    bodyWrap.appendChild(tabBar);
    if (activeTab === 'meta') bodyWrap.appendChild(metaSection());
    if (activeTab === 'epub') bodyWrap.appendChild(styleSection());

    if (activeTab === 'parser') {
    // mode toggle
    const modes = document.createElement('div'); modes.style.cssText = css({ display: 'flex', gap: '4px', margin: '4px 0 8px' });
    ['links', 'spa'].forEach(m => {
      const b = document.createElement('button');
      b.textContent = m === 'links' ? 'Chapter list' : 'Click Next';
      b.title = m === 'links'
        ? 'Use when this page lists every chapter as links (a contents/index page). The tool fetches each linked chapter.'
        : 'Use when you read one chapter per page and click a “Next” button to advance (app/SPA readers like fanfiction.net or wuxiaworld). It captures the page, clicks Next, and repeats.';
      b.style.cssText = btnCss(CFG.mode === m); b.onclick = () => { CFG.mode = m; renderPanel(); }; modes.appendChild(b);
    });
    bodyWrap.appendChild(modes);

    if (CFG.mode === 'links') {
      bodyWrap.appendChild(field('Chapter-list area (optional)', 'area', true, 'Optional. Restrict the search to one region of the page (e.g. the chapter table) so unrelated links are ignored. Click ⌖ then the box that holds the chapter list.'));
      bodyWrap.appendChild(field('Chapter links', 'linkSelector', true, 'Which links on the page are chapters. Click ⌖ then any one chapter link — it works out a selector that matches them all.'));
      bodyWrap.appendChild(field('Link-text filter (regex)', 'linkRegex', false, 'Keep only links whose visible text matches this regex. Make it match what real chapters share and junk (Next, See all, Read first…) drops out on its own — e.g. \\d if every title has a number, or ^Volume / ^Chapter. Default \\S keeps any link that has text.'));
      bodyWrap.appendChild(field('Next-page button (multi-page lists only)', 'pager', true, 'Only needed when the chapter LIST spans several pages. Selector for the list’s “next page” link — it loads the next batch of chapter links, not the next chapter.'));
      const pg = document.createElement('label'); pg.style.cssText = css({ display: 'block', color: B.mut, 'font-size': '12px', margin: '4px 0' });
      pg.title = 'Tick this when the chapter list doesn’t show every chapter at once — the rest are on page 2, 3, … and the page number sits at the end of the web address (e.g. the URL ends in /1, then /2). It loads every page and collects all the chapters. Leave off if all chapters are already on this one page.';
      pg.innerHTML = '<input type="checkbox" style="' + CB + '" id="bs-num"' + (CFG.paginate === 'numeric' ? ' checked' : '') + '/> Auto-page through the chapter list';
      pg.querySelector('#bs-num').onchange = (e) => { CFG.paginate = e.target.checked ? 'numeric' : ''; };
      bodyWrap.appendChild(pg);
      const sortRow = document.createElement('div'); sortRow.style.cssText = css({ margin: '6px 0' });
      sortRow.title = 'Order of chapters in the EPUB. “Parse order” = exactly as they appear on the page, top to bottom (safest with outtakes/side-stories/epilogues) — you can drag rows below to fine-tune. “Chapter number” reorders by the number in each title (1, 2, 3…).';
      sortRow.innerHTML = '<div style="color:' + B.mut + ';font-size:11px;margin-bottom:2px">Chapter order <span style="cursor:help;color:' + B.cyan + '">ⓘ</span></div>';
      const sortSel = document.createElement('select'); sortSel.style.cssText = css({ width: '100%', background: B.field, border: '1px solid ' + B.line, color: B.fg, 'border-radius': '5px', padding: '5px 7px', font: '12px system-ui,sans-serif', cursor: 'pointer' });
      sortSel.innerHTML = [['page', 'Parse order — as on page (drag to reorder)'], ['number', 'Chapter number (1, 2, 3…)']].map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('');
      sortSel.value = CFG.sort || 'page';
      sortSel.onchange = () => { CFG.sort = sortSel.value; };
      sortRow.appendChild(sortSel); bodyWrap.appendChild(sortRow);
      bodyWrap.appendChild(contentField());
      const rp = document.createElement('button'); rp.textContent = '(Re)Parse links'; rp.title = 'Scan the page now and list the chapters it finds below — tick which ones to include before Start.'; rp.style.cssText = btnCss(true) + ';margin:6px 6px 0 0'; rp.onclick = reparse;
      bodyWrap.appendChild(rp);
      const dchk = document.createElement('button'); dchk.textContent = 'Delete ticked'; dchk.title = 'Remove the ticked rows from the list (untick everything first, tick the junk, then delete).'; dchk.style.cssText = btnCss(false) + ';margin:6px 6px 0 0'; dchk.onclick = () => { preview = preview.filter(c => c.sel === false); renderPreview(); scheduleSave(); status(preview.length + ' chapters.'); };
      const dunc = document.createElement('button'); dunc.textContent = 'Delete unticked'; dunc.title = 'Keep only the ticked rows, remove the rest (untick the junk, then delete).'; dunc.style.cssText = btnCss(false) + ';margin:6px 0 0 0'; dunc.onclick = () => { preview = preview.filter(c => c.sel !== false); renderPreview(); scheduleSave(); status(preview.length + ' chapters.'); };
      bodyWrap.appendChild(dchk); bodyWrap.appendChild(dunc);
    } else {
      bodyWrap.appendChild(field('Next-chapter button', 'nextSelector', true, 'The button you click to load the next chapter. Click ⌖ then that button on the page.'));
      bodyWrap.appendChild(field('Chapter title (optional)', 'titleSelector', true, 'Optional. The element holding each chapter’s title (a heading, or a chapter dropdown). Blank = use the browser tab title.'));
      bodyWrap.appendChild(contentField());
      const sc = document.createElement('label'); sc.style.cssText = css({ display: 'block', color: B.mut, 'font-size': '12px', margin: '4px 0' });
      sc.title = 'Some readers only load the text after you scroll. Enable if captured chapters come out short or empty.';
      sc.innerHTML = '<input type="checkbox" style="' + CB + '" id="bs-scroll"' + (CFG.scroll ? ' checked' : '') + '/> Scroll to the bottom before each capture';
      sc.querySelector('#bs-scroll').onchange = (e) => { CFG.scroll = e.target.checked; };
      bodyWrap.appendChild(sc);
    }

    // preview list (links mode)
    const prevBox = document.createElement('div'); prevBox.id = 'bs-prev'; prevBox.style.cssText = css({ 'max-height': '26vh', overflow: 'auto', margin: '6px 0', border: '1px solid ' + B.line, 'border-radius': '5px', display: CFG.mode === 'links' && preview.length ? '' : 'none' });
    bodyWrap.appendChild(prevBox); UI.prev = prevBox; renderPreview();
    }

    // actions
    const act = document.createElement('div'); act.style.cssText = css({ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', margin: '8px 0' });
    const start = document.createElement('button'); start.textContent = 'Start'; start.title = 'Download the selected chapters and build the EPUB.'; start.style.cssText = btnCss(true); start.onclick = start_;
    const stop = document.createElement('button'); stop.textContent = 'Stop'; stop.title = 'Stop now. Progress is saved — use Resume to continue later.'; stop.style.cssText = btnCss(false) + ';background:#ff5555;color:#fff'; stop.onclick = () => { ABORT = true; RUNNING = false; status('⏹ Stopping…'); log('Stop requested by user.'); };
    const resume = document.createElement('button'); resume.textContent = 'Resume'; resume.title = 'Continue a paused or Cloudflare-interrupted job from where it left off.'; resume.style.cssText = btnCss(false); resume.onclick = async () => { ABORT = false; const cj = await CJ.get(); if (cj) runClick(); else resume_(); };
    const reset = document.createElement('button'); reset.textContent = 'Reset'; reset.title = 'Full reset (asks first): clears every saved job, this page’s captured chapters, the chosen cover, and re-detects the page.'; reset.style.cssText = btnCss(false); reset.onclick = reset_;
    const dash = document.createElement('button'); dash.textContent = 'Dashboard'; dash.title = 'Open the dashboard: jobs, Anna’s Archive queue, history and logs.'; dash.style.cssText = btnCss(false); dash.onclick = () => chrome.runtime.sendMessage({ type: 'openDashboard' });
    act.appendChild(start); act.appendChild(stop); act.appendChild(resume); act.appendChild(reset); act.appendChild(dash); bodyWrap.appendChild(act);

    // status + bar + log
    const st = document.createElement('div'); st.id = 'bs-stat'; st.style.cssText = css({ 'margin-bottom': '4px' }); st.textContent = 'Ready.'; bodyWrap.appendChild(st); UI.stat = st;
    const bar = document.createElement('div'); bar.style.cssText = css({ height: '6px', background: B.line, 'border-radius': '3px' }); bar.innerHTML = '<div id="bs-fill" style="height:6px;width:0;background:' + B.grn + ';border-radius:3px"></div>'; bodyWrap.appendChild(bar); UI.fill = bar.firstChild;
    const lg = document.createElement('div'); lg.id = 'bs-log'; lg.style.cssText = css({ 'margin-top': '6px', 'max-height': '22vh', overflow: 'auto', color: B.mut, 'font-size': '11px' }); bodyWrap.appendChild(lg); UI.log = lg;
  }

  const CB = 'width:15px;height:15px;min-width:15px;accent-color:#bd93f9;vertical-align:middle;margin:0 6px 0 0;-webkit-appearance:auto;appearance:auto;opacity:1;position:static;flex:0 0 auto';
  function renderPreview() {
    if (!UI.prev) return; const el = UI.prev; el.innerHTML = '';
    el.style.display = (CFG.mode === 'links' && preview.length) ? '' : 'none';
    if (!preview.length) return;
    const hdr = document.createElement('div'); hdr.style.cssText = css({ position: 'sticky', top: '0', background: B.bg2, padding: '5px 7px', 'border-bottom': '1px solid ' + B.line, display: 'flex', 'align-items': 'center' });
    const all = document.createElement('input'); all.type = 'checkbox'; all.checked = preview.every(c => c.sel !== false); all.style.cssText = CB;
    const lbl = document.createElement('span'); lbl.style.cssText = css({ color: B.cyan }); lbl.textContent = preview.length + ' chapters · drag ⠿ to reorder';
    hdr.appendChild(all); hdr.appendChild(lbl); el.appendChild(hdr);
    preview.forEach((c, i) => {
      const r = document.createElement('div'); r.style.cssText = css({ display: 'flex', 'align-items': 'center', padding: '2px 7px', 'font-size': '12px' });
      r.draggable = true;
      r.ondragstart = (e) => { try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch (er) {} r.style.opacity = '0.4'; };
      r.ondragend = () => { r.style.opacity = ''; };
      r.ondragover = (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; };
      r.ondrop = (e) => { e.preventDefault(); let from = NaN; try { from = parseInt(e.dataTransfer.getData('text/plain'), 10); } catch (er) {} if (isNaN(from) || from === i) return; const [moved] = preview.splice(from, 1); preview.splice(i, 0, moved); renderPreview(); scheduleSave(); status('Reordered (' + preview.length + ' chapters).'); };
      const handle = document.createElement('span'); handle.textContent = '⠿'; handle.title = 'Drag to reorder'; handle.style.cssText = css({ color: B.mut, cursor: 'grab', padding: '0 5px 0 1px', 'flex': '0 0 auto' });
      const ck = document.createElement('input'); ck.type = 'checkbox'; ck.checked = c.sel !== false; ck.style.cssText = CB;
      ck.onchange = () => { c.sel = ck.checked; };
      const tx = document.createElement('span'); tx.style.cssText = css({ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }); tx.textContent = (i + 1) + '. ' + (c.title || c.url);
      const del = document.createElement('span'); del.textContent = '✕'; del.title = 'remove'; del.style.cssText = css({ cursor: 'pointer', color: B.mut, padding: '0 4px' }); del.onclick = () => { preview.splice(i, 1); renderPreview(); scheduleSave(); status(preview.length + ' chapters.'); };
      r.appendChild(handle); r.appendChild(ck); r.appendChild(tx); r.appendChild(del); el.appendChild(r);
    });
    all.onchange = (e) => { preview.forEach(c => c.sel = e.target.checked); renderPreview(); };
  }
  const selectedPreview = () => preview.filter(c => c.sel !== false);

  const status = (m) => { if (UI.stat) UI.stat.textContent = m; };
  const prog = (p) => { if (UI.fill) UI.fill.style.width = Math.max(0, Math.min(100, p)) + '%'; };
  const log = (m) => { const line = new Date().toLocaleTimeString() + ' ' + m; if (UI.log) { const d = document.createElement('div'); d.textContent = line; UI.log.appendChild(d); UI.log.scrollTop = 1e9; } try { chrome.runtime.sendMessage({ type: 'log.add', line }); } catch (e) {} };

  // ---------- element picker ----------
  let hl;
  function startPick(key, inp) {
    if (picking) stopPick();
    picking = { key, inp };
    hl = document.createElement('div'); hl.style.cssText = css({ position: 'fixed', 'z-index': '2147483646', background: 'rgba(189,147,249,.3)', border: '2px solid ' + B.pur, 'pointer-events': 'none' }); document.body.appendChild(hl);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onPick, true);
    status('Pick mode: click an element (Esc to cancel).');
    document.addEventListener('keydown', onEsc, true);
  }
  function pickTarget(raw) {
    if (!picking) return raw;
    if (picking.key === 'area' || picking.key === 'linkSelector') return containerOf(raw.closest('a') || raw);
    if (picking.key === 'pager' || picking.key === 'nextSelector') return raw.closest('a,button') || raw;
    if (picking.key === 'coverImage') return (raw.closest && raw.closest('img')) || raw;
    return raw;
  }
  function onMove(e) {
    const raw = e.target; if (!raw || raw.closest('#bs-engine')) { hl.style.display = 'none'; return; }
    const el = pickTarget(raw); const r = el.getBoundingClientRect();
    hl.style.display = ''; hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px'; hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
  }
  function onPick(e) {
    const el = e.target; if (!el || el.closest('#bs-engine')) return;
    e.preventDefault(); e.stopPropagation();
    if (picking.key === 'coverImage') {
      const sel = picking.inp;
      const img = (el.tagName === 'IMG') ? el : ((el.closest && el.closest('img')) || (el.querySelector && el.querySelector('img')));
      stopPick();
      if (!img) { coverReset(sel); status('Not an image — click directly on a picture.'); return; }
      grabImageUrl(img.currentSrc || img.getAttribute('src') || '', 'select', sel);
      return;
    }
    const k = picking.key, inp = picking.inp;
    let sel;
    if (k === 'linkSelector') {
      const a = el.closest('a') || el; const cont = containerOf(a);
      sel = (cont !== a && cont.querySelectorAll('a').length >= 2) ? (elSelector(cont) + ' a') : inferLinkSelector(a);
    } else if (k === 'area') {
      const cont = containerOf(el.closest('a') || el); sel = elSelector(cont);
    } else if (k === 'pager' || k === 'nextSelector') {
      const a = el.closest('a,button') || el; sel = a.id ? '#' + CSS.escape(a.id) : (a.classList.length ? a.tagName.toLowerCase() + '.' + CSS.escape([...a.classList][0]) : cssPath(a));
    } else sel = cssPath(el);
    CFG[k] = sel; inp.value = sel; stopPick(); scheduleSave();
    log('picked ' + k + ' = ' + sel);
    if (k === 'linkSelector' || k === 'area') status('Picked — press “(Re)Parse links” to list chapters.'); else status('Picked: ' + sel);
  }
  function onEsc(e) { if (e.key === 'Escape') { if (picking && picking.key === 'coverImage') coverReset(picking.inp); stopPick(); } }
  function stopPick() { if (!picking) return; document.removeEventListener('mousemove', onMove, true); document.removeEventListener('click', onPick, true); document.removeEventListener('keydown', onEsc, true); if (hl) hl.remove(); picking = null; }

  // ---------- parse / collect ----------
  // Drop navigation links by URL STRUCTURE, not text — so it works on any language (下一页, 次へ, …).
  // A pager/"see all"/index link points back to a list/self page or carries a page number; a chapter
  // link points to a leaf. (Numeric mode also drops links to the list pages it paginates — see collectAll.)
  const normUrl = (u, base) => { try { const x = new URL(u, base); return x.origin + x.pathname.replace(/\/+$/, ''); } catch (e) { return (u || '').replace(/[?#].*/, '').replace(/\/+$/, ''); } };
  function linksFromDoc(doc, base) {
    const scope = CFG.area ? (doc.querySelector(CFG.area) || doc) : doc;
    const re = new RegExp(CFG.linkRegex || '.*', 'i');
    const baseN = normUrl(base, base), hereN = normUrl(location.href, base);
    const out = [];
    scope.querySelectorAll(CFG.linkSelector || 'a').forEach(a => {
      const t = (a.textContent || '').trim().replace(/\s+/g, ' ');
      let href; try { href = new URL(a.getAttribute('href'), base).href; } catch (e) { return; }
      if (!href || /^javascript:/i.test(href)) return;
      const hN = normUrl(href, base);
      if (hN === baseN || hN === hereN) return;                                  // points back to the list/index page → nav
      if (/[?&](page|pg|p)=\d+/i.test(href) || /\/page\/\d+\/?(?:[?#]|$)/i.test(href)) return;  // explicit pagination link
      if (!re.test(t)) return;                                                   // user's keep-filter (positive match)
      out.push({ title: t, url: href });
    });
    return out;
  }
  async function reparse() {
    ABORT = false;
    status('Listing chapters…'); log('reparse [' + CFG.linkSelector + '] regex /' + CFG.linkRegex + '/' + (CFG.paginate === 'numeric' ? ' +numeric pages' : CFG.pager ? ' +pager' : ''));
    const res = await collectAll();
    if (res && res.cf) { status('⚠ Cloudflare while listing — solve it, then press (Re)Parse again.'); log('CF during listing — paused.'); return; }
    const list = res.urls.map((u, i) => ({ url: u, title: res.titles[i] }));
    let note;
    if ((CFG.sort || 'page') === 'number') { const sr = sortByChapterNum(list); preview = sr.list; note = sr.sorted ? ' (by chapter number)' : ' (no numbers found — kept parse order)'; }
    else { preview = list; note = ' (parse order)'; }
    renderPreview(); scheduleSave();
    status(preview.length + ' chapters matched.');
    log('parsed → ' + preview.length + ' chapters' + note);
  }
  function dedupe(list) { const seen = new Set(); return list.filter(x => { if (seen.has(x.url)) return false; seen.add(x.url); return true; }); }
  // Append the not-yet-seen entries of `list` into urls/titles (keyed by url); return how many new.
  const mergeNew = (seen, urls, titles, list) => { let added = 0; list.forEach(x => { if (!seen.has(x.url)) { seen.add(x.url); urls.push(x.url); titles.push(x.title); added++; } }); return added; };
  // [major, minor] chapter number from a title, or null. Accepts "Chapter 12 (2)" and bare "12. …".
  function chapterNum(title) {
    const m = /chapter\s*(\d+)(?:\s*\((\d+)\))?/i.exec(title || '') || /^\s*(\d+)(?:\s*\((\d+)\))?[).:\-\s]/.exec(title || '');
    return m ? [+m[1], +(m[2] || 0)] : null;
  }
  // Sort only when confident (>=80% of titles carry a number). Returns {list, sorted}
  // so the caller reports honestly instead of always claiming "sorted by number".
  function sortByChapterNum(list) {
    if (!list.length) return { list, sorted: false };
    const nums = list.map(x => chapterNum(x.title));
    if (nums.filter(Boolean).length < list.length * 0.8) return { list, sorted: false };
    const tagged = list.map((x, i) => [x, nums[i], i]);
    tagged.sort((a, b) => {
      if (!a[1]) return 1; if (!b[1]) return -1;               // unnumbered drift to the end, stably
      return (a[1][0] - b[1][0]) || (a[1][1] - b[1][1]) || (a[2] - b[2]);
    });
    return { list: tagged.map(t => t[0]), sorted: true };
  }
  function isDisabled(el) { return !!el && (el.getAttribute && (el.getAttribute('aria-disabled') === 'true') || /(^|\s)disabled(\s|$)/.test(el.className || '') || (el.hasAttribute && el.hasAttribute('disabled'))); }
  function areaSig() { const a = (CFG.area && document.querySelector(CFG.area)) || document.body; let n = 0, s = ''; a.querySelectorAll(CFG.linkSelector || 'a').forEach(x => { if (n++ < 60) s += (x.getAttribute('href') || '') + '|'; }); return n + ':' + s; }
  function pagerNext() {
    let els; try { els = [...document.querySelectorAll(CFG.pager)]; } catch (e) { return null; }
    if (!els.length) return null;
    const t = (e) => ((e.textContent || '') + ' ' + ((e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('rel') || e.getAttribute('title') || e.getAttribute('class'))) || '')).toLowerCase();
    const isPrev = (e) => /prev|previous|‹|«|←|first|chevron-left|arrow-left|caret-left/.test(t(e));
    const isNext = (e) => /next|›|»|→|chevron-right|arrow-right|caret-right/.test(t(e));
    let n = els.find(e => isNext(e) && !isPrev(e));
    if (!n) { const cand = els.filter(e => !isPrev(e)); n = cand[cand.length - 1] || els[els.length - 1]; } // last non-prev (DataTables "Next")
    return n;
  }
  async function collectPagerClick() {
    // client-side (JS) pager: click NEXT on the live page, re-read the DOM after each render
    const urls = [], titles = [], seen = new Set(); let guard = 0; status('Paging through the list…');
    while (guard++ < 3000) {
      if (ABORT) { log('Stopped by user.'); break; }
      const before = areaSig();
      const added = mergeNew(seen, urls, titles, dedupe(linksFromDoc(document, location.href)));
      log('pager(click) step ' + guard + ' +' + added + ' (total ' + urls.length + ')');
      const nx = pagerNext();
      if (!nx || isDisabled(nx)) { log('pager end (no/disabled Next).'); break; }
      try { nx.scrollIntoView({ block: 'center' }); } catch (e) {}
      try { nx.click(); } catch (e) { nx.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      let waited = 0, changed = false;
      while (waited < 6000) { if (ABORT) break; await sleep(250); waited += 250; if (areaSig() !== before) { changed = true; break; } }
      if (!changed) { log('pager Next had no effect — stopping.'); break; }
    }
    return { urls, titles };
  }

  // ---------- run: links mode ----------
  let RUNNING = false;
  async function pauseCF(job, msg) { if (job.phase !== 'paused_cf') job.prevPhase = job.phase; job.phase = 'paused_cf'; await S.set(job); RUNNING = false; status('⚠ ' + msg); log(msg); }

  async function collectAll() {
    // returns {urls, titles, cf}
    if (CFG.paginate === 'numeric') {
      // strip a trailing page number so we always start from page 1 of the list, not the page we opened
      // (e.g. /book/slug/8 → /book/slug → fetch /1, /2, … and get every chapter, not just page 8's)
      const root = location.href.split(/[?#]/)[0].replace(/\/+$/, '').replace(/\/\d+$/, '');
      // links to a list page (root/<n>) are pagers, not chapters — in numeric mode root/<n> ARE the
      // pages we fetch, so this is unambiguous and language-independent (kills "Next"/"下一页"/… alike)
      const pageRe = new RegExp('^' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\d+$', 'i');
      const urls = [], titles = [], seen = new Set();
      for (let p = 1; p <= MAX_LIST_PAGES; p++) {
        if (ABORT) break;
        const res = await getPage(root + '/' + p);
        if (res.cf) return { urls, titles, cf: true, page: p };
        const d = new DOMParser().parseFromString(res.text, 'text/html');
        const list = linksFromDoc(d, root + '/').filter(x => !pageRe.test(x.url.split(/[?#]/)[0].replace(/\/+$/, '')));
        const added = mergeNew(seen, urls, titles, list);
        log('page ' + p + ' status ' + res.status + ' → ' + list.length + ' links, +' + added);
        if (!list.length || added === 0) break;
        await listDelay();
      }
      return { urls, titles };
    }
    if (CFG.pager) {
      const probe = document.querySelector(CFG.pager);
      const rawHref = probe ? (probe.getAttribute('href') || '') : '';
      let isUrlPager = false;
      try { isUrlPager = !!rawHref && /^(https?:|\/)/.test(rawHref) && new URL(rawHref, location.href).href.replace(/#.*/, '') !== location.href.replace(/#.*/, ''); } catch (e) {}
      if (isUrlPager) {
        const urls = [], titles = [], seen = new Set(); let doc = document, base = location.href, guard = 0;
        while (guard++ < MAX_LIST_PAGES) {
          if (ABORT) break;
          const added = mergeNew(seen, urls, titles, linksFromDoc(doc, base));
          log('pager(url) step ' + guard + ' +' + added + ' (total ' + urls.length + ')');
          const nx = doc.querySelector(CFG.pager); const nh = nx && nx.getAttribute('href');
          if (!nh || added === 0 || isDisabled(nx)) break;
          let abs; try { abs = new URL(nh, base).href; } catch (e) { break; }
          if (abs.replace(/#.*/, '') === base.replace(/#.*/, '')) break;
          const res = await getPage(abs); if (res.cf) return { urls, titles, cf: true };
          base = abs; doc = new DOMParser().parseFromString(res.text, 'text/html');
          await listDelay();
        }
        return { urls, titles };
      }
      return await collectPagerClick(); // JS pager (e.g. Royal Road DataTables)
    }
    // single page: all links on the current page (selection is applied later, at Start)
    const list = dedupe(linksFromDoc(document, location.href));
    return { urls: list.map(x => x.url), titles: list.map(x => x.title) };
  }

  async function runLinks(job) {
    RUNNING = true;
    if (job.phase === 'fetching') {
      for (let i = job.index; i < job.urls.length; i++) {
        if (!RUNNING) return;
        let res = await getPage(job.urls[i]); let tries = 0;
        while (!res.cf && res.status !== 200 && tries < 2) { await sleep(500); res = await getPage(job.urls[i]); tries++; }
        if (res.cf) { job.index = i; await pauseCF(job, 'Cloudflare hit at chapter ' + (i + 1) + '/' + job.total + '. Saved.'); return; }
        if (res.status !== 200) { // dead link / network error — skip rather than extracting the error page
          log('⚠ chapter ' + (i + 1) + '/' + job.total + ' returned status ' + res.status + (res.err ? ' (' + res.err + ')' : '') + ' — skipped.');
          job.index = i + 1; await S.set(job); continue;
        }
        const d = new DOMParser().parseFromString(res.text, 'text/html');
        const ex = extract(d, CFG.contentSelector);
        if (!ex) { job.index = i; await pauseCF(job, 'No content at chapter ' + (i + 1) + ' (set a Content selector or solve CF, then Resume).'); return; }
        const html = wantImages() ? await embedImages(ex.html, job.urls[i], dbPut) : ex.html;
        await dbPut(i, { title: job.titles[i] || ex.title || ('Chapter ' + (i + 1)), html });
        job.index = i + 1;
        if (i % 5 === 0 || job.index === job.total) { await S.set(job); prog(job.index / job.total * 100); status('Fetched ' + job.index + '/' + job.total); }
        await sleep(120 + Math.random() * 150);
        if (job.index % 75 === 0) { status('Brief rest…'); await sleep(4000); }
      }
      job.phase = 'building'; await S.set(job);
    }
    if (job.phase === 'building') await finish(job);
    RUNNING = false;
  }

  // ---------- run: click-through (navigation-surviving) ----------
  function findNext() {
    const sel = CFG.nextSelector; if (!sel) return null;
    let els; try { els = [...document.querySelectorAll(sel)]; } catch (e) { return null; }
    if (!els.length) return null;
    const txt = (e) => ((e.textContent || '') + ' ' + (e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('title')) || '')).toLowerCase();
    const nexts = els.filter(e => /next|»|›|》|→/.test(txt(e)) && !/prev|«|‹|《|←/.test(txt(e)));
    return nexts[nexts.length - 1] || els[els.length - 1]; // bottom one usually
  }
  function clickTitle() {
    if (CFG.titleSelector) {
      const el = document.querySelector(CFG.titleSelector);
      if (el) { if (el.tagName === 'SELECT') { const o = el.options[el.selectedIndex]; return ((o && o.text) || '').trim(); } return (el.textContent || '').trim().replace(/\s+/g, ' '); }
    }
    return (document.title || '').trim();
  }
  function contentSig() { const el = (CFG.contentSelector && document.querySelector(CFG.contentSelector)) || document.body; return (el.innerText || '').slice(0, 600); }
  function isCFPage() {
    if (CF_RE.test(document.title || '')) return true;
    if (document.querySelector('#challenge-running, #cf-challenge-running, .cf-browser-verification, #challenge-form, #challenge-stage, script[src*="challenge-platform"]')) return true;
    return false;
  }

  async function runClick() {
    let job = await CJ.get(); if (!job) return; CFG = job.cfg;
    if (!UI) buildPanel();
    RUNNING = true; status('Click-through running (' + (job.index || 0) + ' captured)…');
    while (RUNNING) {
      if (isCFPage()) { await CJ.set(job); RUNNING = false; status('⚠ Cloudflare — solve the check on the page. Capture resumes automatically (saved ' + (job.index || 0) + ').'); log('Cloudflare challenge — paused, progress saved (' + (job.index || 0) + ' captured). Solve it, then it resumes.'); return; }
      if (CFG.scroll) { window.scrollTo(0, document.body.scrollHeight); await sleep(450); }
      const ex = extract(cloneDoc(), CFG.contentSelector);
      const title = clickTitle() || (ex && ex.title) || ('Chapter ' + ((job.index || 0) + 1));
      if (ex && ex.html) { const html = wantImages() ? await embedImages(ex.html, location.href, cPut) : ex.html; await cPut(job.index || 0, { title, html }); job.index = (job.index || 0) + 1; job.total = job.index; await CJ.set(job); prog(Math.min(99, job.index)); status('Captured ' + job.index + ' — ' + title.slice(0, 40)); log('captured ' + job.index + ': ' + title.slice(0, 60)); }
      else { log('No content extracted — stopping.'); break; }
      const next = findNext();
      if (!next) { log('No Next button — done.'); break; }
      const beforeUrl = location.href, beforeSig = contentSig();
      try { next.click(); } catch (e) { next.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      let waited = 0, changed = false;
      while (waited < 12000) {
        await sleep(300); waited += 300;
        if (location.href !== beforeUrl) return; // navigating → engine resumes on the new page
        if (contentSig() !== beforeSig) { changed = true; break; } // in-place SPA
      }
      if (!changed) { log('Next click had no effect — wrong selector? Stopping.'); status('⚠ Next did nothing — re-pick the Next button.'); break; }
    }
    RUNNING = false;
    await finishClick();
  }

  // Resolve the EPUB metadata from the editable Meta tab (CFG.meta), with safe fallbacks.
  function metaFor() {
    const m = CFG.meta || {};
    // Stable per-book identifier from the source page key: unique across books (different paths),
    // and the SAME on a re-download so a reader updates the book instead of duplicating it.
    return { title: m.title || CFG.title || document.title || 'Book', author: m.author || 'Unknown', description: m.description || '', publisher: location.hostname, language: m.language || 'en', series: m.series || '', seriesIndex: m.seriesIndex || '', identifier: 'epubforge:' + hash(PAGEKEY), modified: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  }

  // Build the EPUB, trigger the download, record history. Returns the slug, or null if empty.
  async function packageAndDownload(chapters, meta, images) {
    if (!chapters.length) { status('Nothing captured.'); return null; }
    const st = CFG.style || {};
    const customMode = st.cover === 'upload' || st.cover === 'page' || st.cover === 'select';
    const useCustom = customMode && !!customCover;
    if (customMode && !customCover) log('⚠ cover: “' + st.cover + '” was chosen but no image was captured — using auto cover. Re-pick it in the Meta tab.');
    else if (useCustom) log('cover: using your selected image (' + Math.round(customCover.length / 1024) + ' KB).');
    const keep = st.images !== false;
    if (keep && images && images.length) log('packaging ' + images.length + ' image' + (images.length === 1 ? '' : 's') + '.');
    const opts = { cover: useCustom ? 'custom' : (st.cover === 'none' ? 'none' : 'auto'), coverImage: useCustom ? customCover : null, number: st.number || 'never', heading: st.heading !== false, images: keep, toc: st.toc !== false, tocNumbers: !!st.tocNumbers, imageFiles: images || [] };
    const blob = await window.EPUB.build(meta, chapters, opts);
    const slug = (meta.title || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'book';
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = slug + '.epub'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);  // free the blob once the download has started
    prog(100); status('✅ Done → ' + slug + '.epub (' + (blob.size / 1048576).toFixed(1) + ' MB, ' + chapters.length + ' ch)'); log('Saved to Downloads.');
    try { chrome.runtime.sendMessage({ type: 'history.add', rec: { kind: 'novel', source: CFG.label, title: meta.title, count: chapters.length, file: slug + '.epub', ts: Date.now() } }); } catch (e) {}
    return slug;
  }

  // Shared tail for both run modes: load lib, read+sort the chapter store, build & download,
  // then run mode-specific cleanup (gets the slug, or null if nothing was packaged).
  async function finishFrom({ store, meta, packLog, after }) {
    status('Building EPUB…'); if (packLog) log(packLog);
    if (!(await ensureLibs())) { status('Could not load EPUB library.'); return; }
    const rows = await store();
    const chapters = rows.filter(r => typeof r[0] === 'number').sort((a, b) => a[0] - b[0]).map(r => r[1]);
    const images = rows.filter(r => typeof r[0] === 'string' && r[0].indexOf('img:') === 0).map(r => r[1]);
    const slug = await packageAndDownload(chapters, meta, images);
    await after(slug);
  }

  async function finishClick() {
    const job = await CJ.get();
    await finishFrom({
      store: cAll,
      meta: metaFor(),
      after: async () => { await CJ.clear(); await cClear(); },
    });
  }

  async function finish(job) {
    await finishFrom({
      store: dbAll,
      meta: metaFor(),
      packLog: 'Packaging ' + (job.total || 0) + ' chapters…',
      after: async (slug) => { if (slug === null) return; job.phase = 'done'; await S.set(job); await dbClear(); },
    });
  }

  // ---------- controls ----------
  async function start_() {
    if (!(await ensureLibs())) { status('Lib load failed.'); return; }
    ABORT = false; UI.log.innerHTML = ''; imgCache = new Map(); imgStored = new Set(); imgSeq = 0;
    if (CFG.mode === 'spa') { await cClear(); await CJ.set({ cfg: CFG, index: 0, total: 0 }); log('Start click-through.'); runClick(); return; }
    if (!preview.length) await reparse();
    const sel = selectedPreview();
    if (!sel.length) { status('No chapters selected — (Re)Parse and tick some.'); return; }
    await dbClear();
    const job = { base: PAGEKEY, title: CFG.title || document.title, mode: 'links', cfg: CFG, phase: 'fetching', urls: sel.map(x => x.url), titles: sel.map(x => x.title), total: sel.length, index: 0 };
    await S.set(job); log('Start (links) — ' + sel.length + ' selected chapters.'); runLinks(job);
  }
  async function reset_() {
    if (!confirm('Reset EpubForge?\nThis clears every saved job, this page’s captured chapters, the chosen cover, and re-detects the page from scratch.')) return;
    ABORT = true; RUNNING = false;
    // wipe ALL saved jobs (this page + every other) and the click job
    try { const all = await new Promise(r => chrome.storage.local.get(null, r)); const keys = Object.keys(all).filter(k => k.indexOf('novelJob:') === 0 || k.indexOf('novelDraft:') === 0 || k.indexOf('novelCover:') === 0 || k.indexOf('bsClickJob') === 0); if (keys.length) await new Promise(r => chrome.storage.local.remove(keys, r)); } catch (e) {}
    await dbClear(); await cClear();                       // this page's chapter store + the click store
    preview = []; customCover = null; imgCache = new Map(); imgStored = new Set(); imgSeq = 0;  // in-memory state
    CFG = (window.PRESETS ? window.PRESETS.detect(location.href, document) : null) || CFG;  // fresh config (cover→auto, meta re-detected)
    ABORT = false; renderPanel(); prog(0); status('Reset — cleared all jobs, chapters and cover.');
  }
  async function resume_() {
    const job = await S.get(); if (!job) return;
    if (job.cfg) CFG = job.cfg;
    status('Checking Cloudflare…'); const test = await getPage(location.href.split(/[?#]/)[0]);
    if (test.cf) { status('⚠ Still blocked. Refresh, solve it, then Resume.'); return; }
    // S only ever holds links-mode jobs; SPA jobs persist via CJ and resume through runClick.
    job.phase = job.prevPhase || 'fetching'; await S.set(job);
    runLinks(job);
  }

  // ---------- init ----------
  async function open() {
    if (UI) { UI.box.style.display = ''; return; }
    await ensureLibs();
    const detected = (window.PRESETS ? window.PRESETS.detect(location.href, document) : null);
    CFG = detected || { label: 'Generic', mode: 'links', linkSelector: 'a', linkRegex: '\\S', sort: 'page', style: STYLE_DEFAULTS(), meta: { title: document.title || 'Book', author: 'Unknown', series: '', seriesIndex: '', language: 'en', description: '', coverUrl: '' } };
    const draft = await new Promise(r => chrome.storage.local.get(DRAFTKEY, o => r(o[DRAFTKEY] || null)));
    const cj = await CJ.get();
    const job = await S.get();
    if (cj && cj.cfg) CFG = cj.cfg;
    else if (job && job.cfg) CFG = Object.assign(CFG, job.cfg);
    if (draft && draft.cfg) {
      // restore the user's working state (Meta edits, settings, parsed list) so a Cloudflare refresh doesn't wipe it
      CFG = Object.assign(CFG, draft.cfg);
      if (Array.isArray(draft.preview) && !preview.length) preview = draft.preview;
    } else if (detected && detected.meta) {
      // no draft → refresh page-derived metadata over any stale copy from an old job (e.g. truncated description)
      CFG.meta = CFG.meta || {}; CFG.meta.description = detected.meta.description; CFG.meta.coverUrl = detected.meta.coverUrl;
    }
    // restore the chosen cover bytes (persisted separately) so a refresh keeps it
    const savedCover = await new Promise(r => chrome.storage.local.get(COVERKEY, o => r(o[COVERKEY] || null)));
    if (savedCover) { try { customCover = b64ToU8(savedCover); } catch (e) {} }
    // a select/upload/page mode with no image behind it (none saved) → fall back to auto
    if (CFG.style && /^(select|upload|page)$/.test(CFG.style.cover) && !customCover) CFG.style.cover = 'auto';
    buildPanel();
    log('Opened on ' + location.hostname + ' — preset: ' + CFG.label);
    if (cj) { status('Resuming click-through (' + (cj.index || 0) + ' captured)…'); runClick(); return; }
    const activeLinks = job && (job.phase === 'fetching' || job.phase === 'building' || job.phase === 'paused_cf');
    if (activeLinks) { status('Resuming previous job (' + (job.index || 0) + '/' + (job.total || '?') + ')…'); resume_(); }
    else if (CFG.mode === 'links') status('Ready — press “(Re)Parse links” to list chapters.');
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg && msg.cmd === 'open') { open(); send({ ok: true }); }
    else if (msg && msg.cmd === 'status') { S.get().then(j => send({ job: j })); return true; }
    return true;
  });

  // auto-open if a job is active (click job survives navigation; links job survives refresh)
  (async () => {
    const cj = await CJ.get(); if (cj) { open(); return; }
    const job = await S.get(); if (job && job.phase && job.phase !== 'done' && job.phase !== 'idle') open();
  })();
})();
