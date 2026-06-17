const msgEl = document.getElementById('msg');

async function tab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }

document.getElementById('open').onclick = async () => {
  const t = await tab();
  if (!t || !/^https?:/.test(t.url || '')) { msgEl.textContent = 'Open a normal web page first.'; return; }
  try {
    await chrome.tabs.sendMessage(t.id, { cmd: 'open' });
  } catch (e) {
    // content script not present yet (page opened before install/reload) → inject then open
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['lib/common.js', 'novel/engine.js'] });
      await chrome.tabs.sendMessage(t.id, { cmd: 'open' });
    } catch (e2) { msgEl.textContent = 'Could not open here: ' + (e2.message || e2); return; }
  }
  msgEl.textContent = 'Parser panel opened (top-right of the page).';
  window.close();
};

document.getElementById('dash').onclick = () => chrome.runtime.sendMessage({ type: 'openDashboard' });
