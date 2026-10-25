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

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJoinedCafesInBackground() {
  const joinedCafes = [];
  const seen = new Set();
  const urls = [
    'https://apis.naver.com/cafe-home-web/cafe-home/v1/cafes/join?page=1&perPage=100',
    'https://apis.naver.com/cafe-home-web/cafe-home/v1/cafes/favorite',
  ];
  for (const u of urls) {
    try {
      const resp = await fetch(u, { credentials: 'include' });
      if (!resp.ok) continue;
      const json = await resp.json();
      const list =
        json?.message?.result?.cafes ||
        json?.message?.result?.favoriteCafes ||
        json?.result?.cafes ||
        json?.cafes ||
        [];
      if (Array.isArray(list)) {
        for (const c of list) {
          const cafeId = String(c.cafeId || c.clubid || c.id || '');
          const cafeUrl = String(c.cafeUrl || c.cluburl || '').replace(/^\/+|\/+$/g, '');
          const cafeName = stripHtml(c.cafeName || c.clubname || cafeUrl);
          const key = cafeId || cafeUrl;
          if (key && !seen.has(key)) {
            seen.add(key);
            joinedCafes.push({
              cafeId,
              cafeUrl,
              cafeName: cafeName || cafeUrl || cafeId,
              memberLevelName: c.memberLevelName || '',
              url: cafeUrl
                ? `https://cafe.naver.com/${cafeUrl}`
                : `https://cafe.naver.com/MyCafeIntro.nhn?clubid=${cafeId}`,
            });
          }
        }
      }
    } catch (_) {}
  }
  return joinedCafes;
}

async function searchSingleCafeApi(cafe, query, page = 1, perPage = 15) {
  const results = [];
  if (!cafe || (!cafe.cafeId && !cafe.cafeUrl)) return results;

  let cafeId = cafe.cafeId;
  // Resolve cafeId from cafeUrl if needed
  if (!cafeId && cafe.cafeUrl) {
    try {
      const infoResp = await fetch(
        `https://apis.naver.com/cafe-web/cafe2/CafeGateInfo.json?cluburl=${encodeURIComponent(cafe.cafeUrl)}`,
        { credentials: 'include' }
      );
      if (infoResp.ok) {
        const infoJson = await infoResp.json();
        cafeId = String(infoJson?.message?.result?.cafeInfoView?.cafeId || '');
      }
    } catch (_) {}
  }

  if (!cafeId) return results;

  const endpoints = [
    `https://apis.naver.com/cafe-web/cafe-search-api/v1.0/cafes/${cafeId}/search/articles?query=${encodeURIComponent(query)}&page=${page}&perPage=${perPage}&sortBy=TIME`,
    `https://apis.naver.com/cafe-web/cafe-mobile/CafeMobileWebArticleSearchListV3?cafeId=${cafeId}&query=${encodeURIComponent(query)}&searchBy=0&sortBy=date&page=${page}&perPage=${perPage}`,
  ];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep, { credentials: 'include' });
      if (!resp.ok) continue;
      const json = await resp.json();
      const list =
        json?.result?.articleList ||
        json?.message?.result?.articleList ||
        json?.articleList ||
        [];
      if (Array.isArray(list) && list.length > 0) {
        for (const item of list) {
          const entry = item.item || item;
          const articleId = String(entry.articleId || entry.id || '');
          if (!articleId) continue;
          const subject = stripHtml(entry.subject || entry.title || '(제목 없음)');
          const snippet = stripHtml(entry.contentSummary || entry.summary || entry.content || '');
          const author = stripHtml(
            entry.writerNickname || entry.writerInfo?.nickName || entry.memberNickName || ''
          );
          const date =
            entry.writeDateTimestamp
              ? new Date(entry.writeDateTimestamp).toLocaleString('ko-KR')
              : entry.addDate || entry.writeDate || '';
          const slug = cafe.cafeUrl || cafeId;
          results.push({
            articleId,
            cafeId,
            cafeUrl: cafe.cafeUrl || '',
            cafeName: cafe.cafeName || slug,
            title: subject,
            snippet,
            author,
            date,
            url: cafe.cafeUrl
              ? `https://cafe.naver.com/${cafe.cafeUrl}/${articleId}`
              : `https://cafe.naver.com/ArticleRead.nhn?clubid=${cafeId}&articleid=${articleId}`,
          });
        }
        break;
      }
    } catch (_) {}
  }
  return results;
}

async function pollExtensionTasks() {
  try {
    const res = await fetch(`${SERVER_BASE}/api/naver-cafe/pending-task`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.task) return;

    const { id, type, query, cafeId, cafeUrl, targetCafes } = data.task;

    if (type === 'sync-cafes') {
      const joinedCafes = await fetchJoinedCafesInBackground();
      await fetch(`${SERVER_BASE}/api/naver-cafe/task-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: id, joinedCafes }),
      });
    } else if (type === 'search-articles') {
      let joinedCafes = await fetchJoinedCafesInBackground();
      if (Array.isArray(targetCafes) && targetCafes.length > 0 && joinedCafes.length === 0) {
        joinedCafes = targetCafes;
      }

      let cafesToSearch = joinedCafes;
      if (cafeId || cafeUrl) {
        cafesToSearch = joinedCafes.filter(
          (c) => (cafeId && c.cafeId === String(cafeId)) || (cafeUrl && c.cafeUrl === cafeUrl)
        );
        if (cafesToSearch.length === 0) {
          cafesToSearch = [{ cafeId: cafeId || '', cafeUrl: cafeUrl || '', cafeName: cafeUrl || cafeId }];
        }
      } else {
        cafesToSearch = joinedCafes.slice(0, 15);
      }

      const batches = await Promise.all(
        cafesToSearch.map((c) => searchSingleCafeApi(c, query, 1, 12))
      );
      const articles = batches.flat();

      await fetch(`${SERVER_BASE}/api/naver-cafe/task-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: id,
          query,
          joinedCafes,
          articles,
        }),
      });
    }
  } catch (_) {}
}

chrome.tabs.onUpdated.addListener(() => syncOpenTabs());
chrome.tabs.onRemoved.addListener(() => syncOpenTabs());
chrome.tabs.onActivated.addListener(() => syncOpenTabs());
setInterval(syncOpenTabs, 5000);
setInterval(pollExtensionTasks, 1500);
syncOpenTabs();
