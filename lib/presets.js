/* Auto-detect presets → prefill the parser panel. Never blocks; everything editable.
   Exposes window.PRESETS.detect(url, document) -> config (or generic default). */
(() => {
  const ogTitle = (d) => ((d.querySelector('meta[property="og:title"]') || {}).content || (d.querySelector('h1') || {}).innerText || d.title || 'Book').trim();
  // og:description is usually truncated for SEO. Find the fullest synopsis: scan likely containers
  // AND the block right after a "Summary/Synopsis/Description" heading; keep the longest prose-like text.
  const metaDesc = (d) => {
    const clean = (s) => (s || '').trim().replace(/\s+/g, ' ');
    const cands = [];
    const add = (el) => { if (!el || !el.textContent) return; const t = clean(el.textContent); if (t.length < 40 || t.length >= 6000) return; const links = el.querySelectorAll ? el.querySelectorAll('a').length : 0; cands.push({ t, links }); };
    // the block right after a Summary/Synopsis/Description heading (most reliable on book pages)
    try {
      // the label can be a plain <div>/<span> (e.g. NovelLive's <div class="abstract">SUMMARY</div>),
      // so scan those too — but only leaf-ish elements (children ≤ 1) so we skip big containers cheaply
      // and only match the actual short label, never a whole section.
      [...d.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b,div,span,p,li')].forEach(h => {
        if (h.children.length > 1) return;
        const lt = clean(h.textContent);
        if (lt.length <= 24 && /\b(summary|synopsis|description|about)\b/i.test(lt)) { let n = h.nextElementSibling, hops = 0; while (n && hops++ < 4) { add(n); n = n.nextElementSibling; } add(h.parentElement); }
      });
    } catch (e) {}
    // explicit description containers (specific classes only — no broad [class*] that grabs sidebars)
    try { d.querySelectorAll('[itemprop="description"], .description, .desc, .summary, .synopsis, .book-intro, .book-summary, #summary').forEach(add); } catch (e) {}
    const og = clean(((d.querySelector('meta[property="og:description"]') || d.querySelector('meta[name="description"]') || {}).content));
    // score = text length minus a per-link penalty, so a clean synopsis beats both the truncated
    // og:description AND a junk wrapper that bundles nav/chapter links (e.g. NovelLive's .m-desc).
    let best = og, bestScore = og.length;
    cands.forEach(c => { const sc = c.t.length - c.links * 300; if (sc > bestScore) { bestScore = sc; best = c.t; } });
    return best.replace(/^\s*(summary|synopsis|description|about)\s*:?\s*/i, '').slice(0, 5000);  // strip a leading "Summary" label if the parent block was used
  };
  const metaAuthor = (d) => { const m = (d.querySelector('meta[name="author"]') || {}).content; const e = d.querySelector('[rel="author"], .author, .author-name, [itemprop="author"]'); return (m || (e && e.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 120); };
  const ogImage = (d) => ((d.querySelector('meta[property="og:image"]') || d.querySelector('meta[name="twitter:image"]') || {}).content || '').trim();
  const pageLang = (d) => (((d.documentElement.getAttribute('lang') || '').trim().split('-')[0]) || 'en').toLowerCase();

  // Canonical EPUB content defaults — single source (engine.js delegates here). Fresh object per call.
  const STYLE_DEFAULTS = () => ({ cover: 'auto', number: 'never', heading: true, images: true, toc: true, tocNumbers: false });

  const DEFAULTS = () => ({
    label: 'Generic',
    mode: 'links',            // 'links' | 'spa'
    title: '',
    area: '',                 // optional container selector
    linkSelector: 'a',
    linkRegex: '\\S',         // skip blank/icon links (any non-whitespace text); '.*' = keep all
    pager: '',                // optional TOC "next page" link selector
    paginate: '',             // '' | 'numeric'  (numeric = root/1, root/2, …)
    sort: 'page',             // 'page' = parse order (manual drag) | 'number' = by chapter number
    contentSelector: '',      // '' = Automatic (Readability). Active extraction selector.
    contentHint: '',          // known-good selector for this site; prefills Custom, but Automatic stays default
    nextSelector: '',         // SPA next-button
    titleSelector: '',        // SPA per-page title
    scroll: false,
    style: STYLE_DEFAULTS(),  // EPUB content options
    meta: { title: '', author: 'Unknown', series: '', seriesIndex: '', language: 'en', description: '', coverUrl: '' },  // book metadata (editable)
  });

  function detect(url, d) {
    const c = DEFAULTS();
    c.title = ogTitle(d).replace(/\s*-\s*(Novel Live|Read.*Free).*$/i, '').trim();
    c.meta = { title: c.title, author: metaAuthor(d) || 'Unknown', series: '', seriesIndex: '', language: pageLang(d), description: metaDesc(d), coverUrl: ogImage(d) };

    if (/^https?:\/\/(www\.)?novellive\.app\/book\//i.test(url)) {
      return Object.assign(c, { label: 'NovelLive', linkSelector: '.m-newest2 > .ul-list5 a', paginate: 'numeric', contentHint: '.txt' });
    }
    if (/^https?:\/\/(www\.)?royalroad\.com\/fiction\//i.test(url)) {
      return Object.assign(c, { label: 'Royal Road', linkSelector: '.chapter-row td:nth-child(1) a, table#chapters tbody tr td a[href*="/chapter/"]', contentHint: '.chapter-content, .chapter-inner' });
    }
    if (/fanfiction\.net\/s\//.test(url) || /fictionpress\.com\/s\//.test(url)) {
      // chapters are separate URLs; "Next »" navigates. Click-through survives navigation.
      return Object.assign(c, { label: 'FanFiction.net', mode: 'spa', nextSelector: 'button.btn', titleSelector: '#chap_select', contentHint: '#storytext', scroll: false });
    }
    if (/wuxiaworld\.com\/novel\//.test(url)) {
      // SPA reader: start on a chapter, click Next
      return Object.assign(c, { label: 'Wuxiaworld (SPA)', mode: 'spa', nextSelector: 'a[href*="chapter"] [aria-label="Next"], .MuiButton-root:last-child', titleSelector: 'h4, .font-set-b18', scroll: true });
    }

    // generic doc/nav heuristics (read-the-docs / mkdocs / sphinx)
    const navSel = ['.md-nav--primary>.md-nav__list>.md-nav__item--active .md-nav a', '.wy-menu a', '.toctree-l1 a', '.bd-sidenav a', '.nav-list a'];
    for (const s of navSel) { if (d.querySelector(s)) { c.label = 'Doc nav'; c.linkSelector = s; return c; } }

    return c; // pure generic
  }

  window.PRESETS = { detect, DEFAULTS, STYLE_DEFAULTS };
})();
