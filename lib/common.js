/* EpubForge shared helpers. Pure + DOM utils used across contexts (service worker, content
   scripts, dashboard page). Exposes self.BSU. Idempotent: safe to load more than once.
   NOTE: lib/epub.js stays deliberately standalone (no BSU dependency) so the EPUB builder
   remains a self-contained "no libraries" module. */
(() => {
  const G = (typeof self !== 'undefined') ? self : this;
  const B = G.BSU || (G.BSU = {});
  const CH = 0x8000;

  // base64 ↔ bytes (chunked so big buffers don't blow the call stack)
  B.b64FromBytes = (u8) => { let bin = ''; for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(bin); };
  B.b64ToBytes = (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };

  // XML/HTML escape (& < > ")
  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  B.escapeXml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ENT[c]);

  // keep a draggable box inside the viewport (DOM contexts only — never called in the worker)
  B.clampX = (x) => Math.max(0, Math.min(G.innerWidth - 60, x));
  B.clampY = (y) => Math.max(0, Math.min(G.innerHeight - 30, y));

  // Drag `box` by `handle`. opts.posKey = storage key to persist {left,top}; opts.ignore =
  // an element inside the handle whose clicks should NOT start a drag (e.g. a minimize button).
  B.makeDrag = (box, handle, opts) => {
    opts = opts || {};
    handle.style.cursor = 'move'; handle.style.userSelect = 'none';
    handle.addEventListener('mousedown', (e) => {
      if (opts.ignore && (e.target === opts.ignore || opts.ignore.contains(e.target))) return;
      e.preventDefault();
      const r = box.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      box.style.right = 'auto'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      const move = (ev) => { box.style.left = B.clampX(ev.clientX - ox) + 'px'; box.style.top = B.clampY(ev.clientY - oy) + 'px'; };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        if (opts.posKey) { try { const b = box.getBoundingClientRect(); chrome.storage.local.set({ [opts.posKey]: { left: b.left, top: b.top } }); } catch (e) {} }
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });
  };
})();
