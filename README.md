# EpubForge

A **generic** link-parser → EPUB extension (epublifier-style) that works on **any
site**, plus an **Anna's Archive** download manager. No server, no Docker — it runs
in your real browser tab, so Cloudflare is never fought, and it **saves progress +
resumes**.

## Real talk about Cloudflare

A big chunk of why this exists is just Cloudflare. I wanted to read web novels offline
and that turned into way too many nights watching "Checking your browser before you
access..." spin, or clicking the "Verify you are human" box on the same site for the
fifth time in ten minutes after I'd already passed it. The bots are real, sure. I'm
still some guy clicking a chapter link.

Every "save to EPUB" tool I tried broke the moment it hit an actual site. They send a
background fetch, Cloudflare blocks it, and you get back a 403 or a page full of
challenge HTML. Then the tool saves that challenge page as your chapter, so you open
the book later and chapter 12 is the text "Just a moment...". Great.

What finally worked was giving up on being clever. No server fetches, no spoofed
user-agent. It runs inside the tab you already cleared the check in. It reuses the
cookies sitting right there and grabs chapters one at a time, the way you'd read them.
If Cloudflare cuts you off partway through, and it usually does, the job is saved. You
go solve the check, hit resume, and it keeps going from where it stopped instead of
making you redo the whole book.

It still isn't perfect. Cloudflare always finds a way. But a broken run won't lose your
progress anymore, and it won't pass off a challenge screen as chapter 12.

## Novels → EPUB (generic, adaptive)

Open any page, click the toolbar → a parser panel appears (top-right). Auto-detect
pre-fills the fields for known sites/nav patterns; everything is editable.

**Two modes:**

- **Chapter list:** point at a page that lists all chapters as links.
  - *Chapter links* (CSS) + *Link-text filter* (regex) → **(Re)Parse links**
    shows the matched chapters with a live count; tick which to include.
  - *Chapter-list area* (optional container) to scope the search.
  - *Next-page button* (optional) follows the list's "next page" link — loads the
    next batch of chapter links, **or** tick *list pages are numbered in the URL*
    (`/1`, `/2`, …) — multi-page lists without any preset.
  - Each chapter is fetched (sequential, throttled, Cloudflare-resilient) and its
    text extracted by *Chapter text source*: **Automatic** (Mozilla Readability,
    default) or a **Custom** element you pick.

- **Click Next (app/SPA readers like fanfiction.net, wuxiaworld):** start on the
  first chapter.
  - *Next-chapter button* (the in-page button whose click loads the next chapter —
    URL may not change), optional *Chapter title*, optional *scroll-to-bottom*.
  - Loop: capture text → click Next → wait → capture → … until no Next. (epublifier's
    "Add Page".)

**Visual pickers:** every selector field has a **⌖ pick** button — click it, then
click an element on the page; it infers the selector and fills the field (links/area
auto-reparse). Esc cancels.

**Cloudflare-resilient + resume:** in-page `credentials:'include'` fetch (real
cookie), sequential + periodic rests. If Cloudflare blocks it, the job is **saved**;
refresh + solve the check and it **resumes** (Links mode; SPA mode is a live session).

## Anna's Archive (client-side)
On a `…/md5/<hash>` page a panel offers **Download** (fast via your membership key →
direct download, else opens the slow mirror) and **+ Queue**. Manage it in the
dashboard.

## Dashboard (Dracula)
Toolbar → **Open dashboard**: **Active downloads** (live novel-job progress),
**Anna's Archive** key/queue, **History**, and a verbose **Logs** panel with a
**Download log file** button.

## Install
1. `chrome://extensions` → **Developer mode** ON.
2. **Load unpacked** → `the Epubforge folder`.
3. Dashboard opens on install. Pin the icon.

## Use
1. Open a chapter-list page (Links) or a first chapter (SPA) on any site.
2. Toolbar icon → **Open parser on this page**.
3. Adjust selectors (or accept the preset), **(Re)Parse**, then **Start**.
4. Cloudflare blocks it? Refresh, solve the check — it resumes.

## Files
```
manifest.json     MV3: engine on <all_urls> (dormant) + AA content script + background
background.js     store (history/queue/settings/logs) + downloads + lazy lib injection
novel/engine.js   generic dual-mode parser, pickers, pager, CF-resume, EPUB build
lib/presets.js    auto-detect → prefill panel (presets + nav heuristics); never gates
lib/readability.js Mozilla Readability (generic content extraction)
lib/epub.js       pure-JS EPUB builder (validated, DEFLATE)
lib/common.js     shared helpers (base64, XML escape, drag/clamp) across all contexts
aa/aa.js, aa/aa.css  Anna's Archive panel (fast/mirror + queue)
ui/*              Dracula dashboard + popup + theme
```

## Verified
- All JS + manifest: syntax/JSON clean.
- EPUB builder: CRC-valid, mimetype stored+first, parses in a real reader, TOC +
  entity escaping correct.
- Live scraping/downloads run in your browser by design (only the real session
  passes Cloudflare).

## Credits
The generic parser owes a lot to **epublifier**. The whole "point it at a chapter list,
or sit on one chapter and click Next" idea comes straight from there.

The Anna's Archive download resolver, the few different ways it digs the real file link
out of a slow-download page, is based on how **stacks** does it.

Content extraction uses Mozilla's **Readability**.

(Links to drop in here once you grab them: epublifier, stacks.)
