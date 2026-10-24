const SERVER_BASE = 'http://127.0.0.1:3080';

async function syncOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const formatted = tabs
      .filter((t) => t.url && /^https?:\/\//i.test(t.url))
      .map((t) => ({
        id: String(t.id),
        windowId: t.windowId,
        active: Boolean(t.active),
        title: t.title || t.url,
        url: t.url,
        favIconUrl: t.favIconUrl || null,
      }));
    await fetch(`${SERVER_BASE}/api/browser/extension-tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabs: formatted }),
    });
  } catch (_) {}
}

chrome.tabs.onUpdated.addListener(() => syncOpenTabs());
chrome.tabs.onRemoved.addListener(() => syncOpenTabs());
chrome.tabs.onActivated.addListener(() => syncOpenTabs());
setInterval(syncOpenTabs, 5000);
syncOpenTabs();
