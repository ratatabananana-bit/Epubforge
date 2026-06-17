/* Shared pure-JS EPUB builder (no libraries). Exposes window.EPUB. Validated. */
(() => {
  const CRCt = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRCt[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder();

  // Raw DEFLATE (zip method 8 = no zlib wrapper). Falls back to null if unsupported.
  async function deflateRaw(u8) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const buf = await new Response(new Response(u8).body.pipeThrough(cs)).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) { return null; }
  }
  // mimetype must stay STORED (EPUB spec) and already-compressed images gain nothing from deflate.
  const storeRaw = (name) => name === 'mimetype' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);

  async function zip(files) {
    const chunks = [], central = []; let offset = 0;
    const u16 = n => [n & 255, (n >> 8) & 255];
    const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      // CRC is over the UNCOMPRESSED data; store both sizes. method 8 = deflate, 0 = store.
      let body = data, method = 0;
      if (!storeRaw(f.name) && data.length > 64) {
        const def = await deflateRaw(data);
        if (def && def.length < data.length) { body = def; method = 8; }
      }
      const lhb = new Uint8Array([].concat(u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0)));
      chunks.push(lhb, name, body);
      central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += lhb.length + name.length + body.length;
    }
    let cdSize = 0; central.forEach(c => cdSize += c.length);
    const end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)));
    const all = [...chunks, ...central, end];
    let total = 0; all.forEach(a => total += a.length);
    const out = new Uint8Array(total); let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }
  const F = (name, str) => ({ name, data: enc.encode(str) });
  const ce = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Normalize arbitrary chapter HTML (e.g. Readability's raw output) into well-formed
  // XHTML: void tags get closed, named entities (&nbsp;) become chars, attrs get quoted.
  // Also drops resources we never package (img/svg/etc.) so the EPUB has no dangling refs.
  function chapterXHTML(html, keepImages) {
    let d;
    try { d = new DOMParser().parseFromString('<!DOCTYPE html><body>' + String(html == null ? '' : html) + '</body>', 'text/html'); }
    catch (e) { return '<p></p>'; }
    // keepImages: leave <img> (src already rewritten to a packaged images/… file); still drop <source> (external srcset)
    const strip = keepImages ? 'source,svg,script,style,iframe,object,embed,link,meta,noscript' : 'img,picture,source,svg,script,style,iframe,object,embed,link,meta,noscript';
    d.body.querySelectorAll(strip).forEach(e => e.remove());
    const s = new XMLSerializer(); let out = '';
    d.body.childNodes.forEach(n => { try { out += s.serializeToString(n); } catch (e) {} });
    out = out.trim();
    // Guarantee the result is well-formed XHTML. If HTML coercion still produced
    // something XML can't parse, fall back to the escaped plain text so the EPUB never breaks.
    if (out) {
      const chk = new DOMParser().parseFromString('<x xmlns="http://www.w3.org/1999/xhtml">' + out + '</x>', 'application/xml');
      if (chk.getElementsByTagName('parsererror').length) out = '';
    }
    if (!out) { const text = (d.body.textContent || '').trim(); return text ? '<p>' + ce(text) + '</p>' : '<p></p>'; }
    return out;
  }

  async function makeCover(title, author) {
    const cv = document.createElement('canvas'); cv.width = 1600; cv.height = 2400; const x = cv.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 2400); g.addColorStop(0, '#121a2e'); g.addColorStop(1, '#070a12'); x.fillStyle = g; x.fillRect(0, 0, 1600, 2400);
    x.strokeStyle = '#e0c47a'; x.lineWidth = 4; x.strokeRect(60, 60, 1480, 2280); x.lineWidth = 2; x.strokeStyle = '#967a3c'; x.strokeRect(84, 84, 1432, 2232);
    x.textAlign = 'center'; x.font = 'bold 120px Georgia, serif'; x.fillStyle = '#e0c47a';
    let lines = [], cur = ''; (title || 'Novel').toUpperCase().split(' ').forEach(w => { const t = (cur + ' ' + w).trim(); if (x.measureText(t).width > 1240 && cur) { lines.push(cur); cur = w; } else cur = t; }); if (cur) lines.push(cur); lines = lines.slice(0, 4);
    let yy = 1180 - (lines.length - 1) * 70; lines.forEach(l => { x.fillText(l, 800, yy); yy += 140; });
    x.fillStyle = '#967a3c'; x.fillRect(600, yy + 10, 400, 3);
    if (author && author !== 'Unknown') { x.fillStyle = '#e8ecf5'; x.font = '56px Georgia, serif'; x.fillText(author, 800, yy + 120); }
    return new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/png'))).arrayBuffer());
  }

  // meta: {title, author, description}; chapters: [{title, html}]
  // opts (all optional): { cover:'auto'|'custom'|'none', coverImage:Uint8Array,
  //   number:'auto'|'always'|'never', heading:bool (show <h2>), images:bool (keep <img>), toc:bool,
  //   imageFiles:[{name:'images/x.jpg', bytes:Uint8Array, type:'image/jpeg'}] (packaged image resources) }
  async function build(meta, chapters, opts) {
    opts = opts || {};
    const number = opts.number || 'never';
    const showHeading = opts.heading !== false;
    const keepImages = !!opts.images;
    const incToc = opts.toc !== false;
    const tocNumbers = !!opts.tocNumbers;  // false = markerless contents (default)

    // Unique book identifier. MUST NOT be derived from the title — two different books with the
    // same title would then share a UID and readers (Calibre, Apple Books…) treat them as one,
    // overwriting/merging. Prefer a caller-supplied id, else a random urn:uuid. Reused for the
    // OPF dc:identifier AND the NCX dtb:uid (the spec wants them equal).
    const uuid = () => { try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); };
    const bookId = meta.identifier ? String(meta.identifier) : ('urn:uuid:' + uuid());

    // cover: custom image if supplied, else auto-generated, unless 'none'
    let cover = null;
    if (opts.cover === 'custom' && opts.coverImage) cover = opts.coverImage;
    else if (opts.cover !== 'none') cover = await makeCover(meta.title, meta.author);
    const hasCover = !!cover;

    // per-chapter display label (heading + TOC). 'auto' adds "Chapter N" only when the
    // title has no number of its own, so already-numbered TOCs don't get doubled.
    const labelOf = (c, i) => {
      const t = String(c.title == null ? '' : c.title).trim() || ('Chapter ' + (i + 1));
      const n = i + 1;
      if (number === 'never') return t;
      const numbered = 'Chapter ' + n + ' — ' + t;
      if (number === 'always') return numbered;
      const hasNum = /\d/.test(t);   // any number anywhere → already conveys order, don't prepend another
      return hasNum ? t : numbered;
    };

    const ids = []; const files = [];
    files.push({ name: 'mimetype', data: enc.encode('application/epub+zip') });
    files.push(F('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'));
    files.push(F('OEBPS/style.css', 'body{font-family:Georgia,serif;line-height:1.6;margin:5%;text-align:justify}h2{text-align:center;border-bottom:1px solid #c9a227;padding-bottom:.4em;margin:1em 0 1.2em}p{margin:0 0 .9em;text-indent:1.4em}img{max-width:100%;height:auto}'));
    if (hasCover) {
      files.push({ name: 'OEBPS/cover.png', data: cover });
      files.push(F('OEBPS/cover.xhtml', '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body style="margin:0;text-align:center"><img src="cover.png" alt="cover" style="height:100%;max-width:100%"/></body></html>'));
    }
    chapters.forEach((c, i) => {
      const id = 'chap' + String(i + 1).padStart(4, '0'); const label = labelOf(c, i); ids.push({ id, title: label });
      const h2 = showHeading ? '<h2>' + ce(label) + '</h2>\n' : '';
      files.push(F('OEBPS/' + id + '.xhtml', '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + ce(label) + '</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>' + h2 + chapterXHTML(c.html, keepImages) + '\n</body></html>'));
    });
    // packaged image resources (referenced by chapters via relative href "images/…")
    let imageManifest = '';
    if (keepImages && Array.isArray(opts.imageFiles)) {
      opts.imageFiles.forEach((f, k) => {
        if (!f || !f.name || !f.bytes) return;
        files.push({ name: 'OEBPS/' + f.name, data: f.bytes });
        imageManifest += '<item id="img' + k + '" href="' + f.name + '" media-type="' + (f.type || 'image/jpeg') + '"/>';
      });
    }
    // EPUB3 requires the toc nav to use <ol>. By default suppress the reader's auto "1. 2. 3."
    // markers (they count list position, drift on two-parters, and double titles already saying
    // "Chapter N"). tocNumbers=true restores them.
    const navStyle = tocNumbers ? '' : '<style>nav#toc ol{list-style:none;padding:0;margin:0}nav#toc li{margin:.3em 0}</style>';
    const olAttr = tocNumbers ? '' : ' style="list-style:none;padding:0"';
    files.push(F('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title>' + navStyle + '</head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol' + olAttr + '>\n' + ids.map(o => '<li><a href="' + o.id + '.xhtml">' + ce(o.title) + '</a></li>').join('\n') + '\n</ol></nav></body></html>'));
    files.push(F('OEBPS/toc.ncx', '<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="' + ce(bookId) + '"/></head><docTitle><text>' + ce(meta.title) + '</text></docTitle><navMap>\n' + ids.map((o, i) => '<navPoint id="np' + (i + 1) + '" playOrder="' + (i + 1) + '"><navLabel><text>' + ce(o.title) + '</text></navLabel><content src="' + o.id + '.xhtml"/></navPoint>').join('\n') + '\n</navMap></ncx>'));
    const seriesMeta = meta.series ? ('<meta name="calibre:series" content="' + ce(meta.series) + '"/>' + (meta.seriesIndex ? '<meta name="calibre:series_index" content="' + ce(String(meta.seriesIndex)) + '"/>' : '') + '<meta property="belongs-to-collection" id="series-c">' + ce(meta.series) + '</meta><meta refines="#series-c" property="collection-type">series</meta>' + (meta.seriesIndex ? '<meta refines="#series-c" property="group-position">' + ce(String(meta.seriesIndex)) + '</meta>' : '')) : '';
    const coverMeta = hasCover ? '<meta name="cover" content="cover-img"/>' : '';
    const coverManifest = hasCover ? '<item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/><item id="coverpage" href="cover.xhtml" media-type="application/xhtml+xml"/>' : '';
    const coverSpine = hasCover ? '<itemref idref="coverpage"/>' : '';
    const navSpine = incToc ? '<itemref idref="nav"/>' : '';
    files.push(F('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">' + ce(bookId) + '</dc:identifier><dc:title>' + ce(meta.title) + '</dc:title><dc:creator>' + ce(meta.author || 'Unknown') + '</dc:creator><dc:language>' + ce(meta.language || 'en') + '</dc:language><dc:publisher>' + ce(meta.publisher || 'EpubForge') + '</dc:publisher><dc:description>' + ce(meta.description || '') + '</dc:description>' + seriesMeta + coverMeta + '<meta property="dcterms:modified">' + ce(meta.modified || '2024-01-01T00:00:00Z') + '</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>' + coverManifest + imageManifest + ids.map(o => '<item id="' + o.id + '" href="' + o.id + '.xhtml" media-type="application/xhtml+xml"/>').join('') + '</manifest><spine toc="ncx">' + coverSpine + navSpine + ids.map(o => '<itemref idref="' + o.id + '"/>').join('') + '</spine></package>'));
    const u8 = await zip(files);
    return new Blob([u8], { type: 'application/epub+zip' });
  }

  window.EPUB = { build };
})();
