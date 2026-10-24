const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocket } = require('ws');

const BOOKMARKS_FILE = path.join(__dirname, 'bookmarks.json');

const DEFAULT_BOOKMARKS = [
  {
    id: 'bm-naver-mail',
    title: '네이버 메일',
    url: 'https://mail.naver.com',
    category: '자주 쓰는 곳',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'bm-github-skills',
    title: 'Matt Pocock Skills',
    url: 'https://github.com/mattpocock/skills',
    category: '개발 / AGY',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'bm-agy-docs',
    title: 'Antigravity 공식 문서',
    url: 'https://antigravity.google/docs',
    category: '개발 / AGY',
    createdAt: new Date().toISOString(),
  },
];

// Track tabs opened directly via AGY Web Console
const trackedConsoleTabs = [];

function recordOpenedTab(url, title = '') {
  if (!url || !/^https?:\/\//i.test(url)) return;
  const existingIdx = trackedConsoleTabs.findIndex((t) => t.url === url);
  if (existingIdx !== -1) {
    trackedConsoleTabs.splice(existingIdx, 1);
  }
  trackedConsoleTabs.unshift({
    id: `console-${Date.now().toString(36)}`,
    title: title || url,
    url,
    source: 'agy-web',
    openedAt: new Date().toISOString(),
  });
  if (trackedConsoleTabs.length > 30) {
    trackedConsoleTabs.length = 30;
  }
}

/**
 * Load internal bookmarks from disk (or initialize with defaults).
 */
function loadInternalBookmarks() {
  try {
    if (!fs.existsSync(BOOKMARKS_FILE)) {
      fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(DEFAULT_BOOKMARKS, null, 2), 'utf8');
      return [...DEFAULT_BOOKMARKS];
    }
    const raw = fs.readFileSync(BOOKMARKS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [...DEFAULT_BOOKMARKS];
  } catch (err) {
    console.warn('Failed to load bookmarks.json:', err.message);
    return [...DEFAULT_BOOKMARKS];
  }
}

function saveInternalBookmarks(list) {
  fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function addInternalBookmark({ title, url, category = '기본' }) {
  const list = loadInternalBookmarks();
  const normalizedUrl = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  const item = {
    id: `bm-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    title: (title || normalizedUrl).trim(),
    url: normalizedUrl,
    category: (category || '기본').trim(),
    createdAt: new Date().toISOString(),
  };
  list.push(item);
  saveInternalBookmarks(list);
  return item;
}

function updateInternalBookmark(id, { title, url, category }) {
  const list = loadInternalBookmarks();
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  if (typeof title === 'string' && title.trim()) list[idx].title = title.trim();
  if (typeof url === 'string' && url.trim()) {
    list[idx].url = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  }
  if (typeof category === 'string' && category.trim()) list[idx].category = category.trim();
  saveInternalBookmarks(list);
  return list[idx];
}

function deleteInternalBookmark(id) {
  const list = loadInternalBookmarks();
  const next = list.filter((b) => b.id !== id);
  if (next.length === list.length) return false;
  saveInternalBookmarks(next);
  return true;
}

/**
 * Scan local Chromium browsers (Chrome, Edge, Whale, Brave) for their Bookmarks JSON files.
 */
function getBrowserDefinitions() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      userDataDir: path.join(localAppData, 'Google', 'Chrome', 'User Data'),
      exePaths: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      userDataDir: path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      exePaths: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
    },
    {
      id: 'whale',
      name: 'Naver Whale',
      userDataDir: path.join(localAppData, 'Naver', 'Naver Whale', 'User Data'),
      exePaths: ['C:\\Program Files\\Naver\\Naver Whale\\Application\\whale.exe'],
    },
    {
      id: 'brave',
      name: 'Brave',
      userDataDir: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      exePaths: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    },
  ];
}

function walkChromiumBookmarkNode(node, folderPath, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'url' && node.url) {
    out.push({
      title: node.name || node.url,
      url: node.url,
      folder: folderPath || '기타 북마크',
    });
    return;
  }
  if (Array.isArray(node.children)) {
    const nextFolder = node.name
      ? folderPath
        ? `${folderPath} / ${node.name}`
        : node.name
      : folderPath;
    for (const child of node.children) {
      walkChromiumBookmarkNode(child, nextFolder, out);
    }
  }
}

function readLocalBrowserBookmarks() {
  const results = [];
  for (const b of getBrowserDefinitions()) {
    if (!fs.existsSync(b.userDataDir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(b.userDataDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    const profileDirs = entries
      .filter((e) => e.isDirectory() && (e.name === 'Default' || e.name.startsWith('Profile ')))
      .map((e) => e.name);

    for (const prof of profileDirs) {
      const bmFile = path.join(b.userDataDir, prof, 'Bookmarks');
      if (!fs.existsSync(bmFile)) continue;
      try {
        const raw = fs.readFileSync(bmFile, 'utf8');
        const json = JSON.parse(raw);
        const items = [];
        if (json.roots) {
          for (const key of Object.keys(json.roots)) {
            walkChromiumBookmarkNode(json.roots[key], '', items);
          }
        }
        if (items.length > 0) {
          results.push({
            browserId: b.id,
            browserName: b.name,
            profile: prof,
            count: items.length,
            items,
          });
        }
      } catch (_) {}
    }
  }
  return results;
}

/**
 * Extract recent URLs from Chromium binary SNSS files (Sessions/Session_* and Tabs_*).
 */
function extractUrlsFromChromiumSessions() {
  const extracted = [];
  const seenUrls = new Set();

  for (const b of getBrowserDefinitions()) {
    const sessionsDir = path.join(b.userDataDir, 'Default', 'Sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    try {
      const files = fs
        .readdirSync(sessionsDir)
        .filter((f) => f.startsWith('Session_') || f.startsWith('Tabs_'))
        .map((f) => {
          const full = path.join(sessionsDir, f);
          const stat = fs.statSync(full);
          return { full, name: f, mtimeMs: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 2);

      for (const file of files) {
        if (file.size > 15 * 1024 * 1024) continue;
        // Read binary buffer if unlocked; on Windows Chrome locks active session file only for exclusive write, shared read works or copy
        let buf;
        try {
          buf = fs.readFileSync(file.full);
        } catch (_) {
          continue;
        }
        const ascii = buf.toString('latin1');
        const regex = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]{4,300}/g;
        const matches = ascii.match(regex) || [];
        // Iterate from end of file (most recent session entries)
        for (let i = matches.length - 1; i >= 0; i--) {
          const u = matches[i].replace(/[)\]'">]+$/, '');
          if (
            !seenUrls.has(u) &&
            !u.includes('google.com/complete/search') &&
            !u.includes('Safebrowsing') &&
            !u.startsWith('https://accounts.google.com/RotateCookies')
          ) {
            seenUrls.add(u);
            extracted.push({
              browserName: b.name,
              url: u,
              source: 'session-file',
            });
            if (extracted.length >= 25) break;
          }
        }
      }
    } catch (_) {}
  }
  return extracted;
}

/**
 * Query Chrome/Edge Remote Debugging Port (CDP) if available (default 9222).
 */
async function queryCdpTabs(ports = [9222, 9223]) {
  const cdpTabs = [];
  for (const port of ports) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 350);
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.type === 'page' && item.url && !item.url.startsWith('devtools://')) {
              cdpTabs.push({
                id: item.id,
                title: item.title || item.url,
                url: item.url,
                faviconUrl: item.faviconUrl || null,
                webSocketDebuggerUrl: item.webSocketDebuggerUrl || null,
                port,
                source: 'cdp',
              });
            }
          }
        }
      }
    } catch (_) {}
  }
  return cdpTabs;
}

/**
 * Query open browser windows and UI Automation tab items on Windows.
 */
function queryWindowsBrowserWindows() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve([]);
    }
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $procs = Get-Process chrome,msedge,whale,brave,firefox -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle -ne 0 }
      $out = @()
      foreach ($p in $procs) {
        $out += [PSCustomObject]@{
          processName = $p.ProcessName
          pid = $p.Id
          windowTitle = $p.MainWindowTitle
        }
      }
      $out | ConvertTo-Json -Compress
    `;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 2500, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          return resolve([]);
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          resolve(arr);
        } catch (_) {
          resolve([]);
        }
      }
    );
  });
}

let extensionSyncedTabs = [];
let cachedNaverMailState = {
  source: null,
  pageUrl: null,
  pageTitle: null,
  fetchedAt: null,
  mails: [],
  openMail: null,
};

function updateExtensionTabs(tabs) {
  if (Array.isArray(tabs)) {
    extensionSyncedTabs = tabs;
  }
}

function updateNaverMailState(payload, source = 'sync') {
  if (!payload || typeof payload !== 'object') return cachedNaverMailState;
  cachedNaverMailState = {
    source,
    pageUrl: payload.pageUrl || 'https://mail.naver.com',
    pageTitle: payload.pageTitle || '네이버 메일',
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
    mails: Array.isArray(payload.mails) ? payload.mails : cachedNaverMailState.mails,
    openMail: payload.openMail || cachedNaverMailState.openMail,
  };
  return cachedNaverMailState;
}

/**
 * Evaluate JavaScript inside a CDP tab via its webSocketDebuggerUrl.
 */
function evaluateInCdpTab(wsUrl, expression, navigateUrl = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch (_) {}
      reject(new Error('CDP 탭 응답 시간 초과'));
    }, 6000);

    ws.on('open', () => {
      if (navigateUrl) {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Page.navigate',
            params: { url: navigateUrl },
          })
        );
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              id: 2,
              method: 'Runtime.evaluate',
              params: {
                expression,
                awaitPromise: true,
                returnByValue: true,
              },
            })
          );
        }, 1400);
      } else {
        ws.send(
          JSON.stringify({
            id: 2,
            method: 'Runtime.evaluate',
            params: {
              expression,
              awaitPromise: true,
              returnByValue: true,
            },
          })
        );
      }
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 2) {
          clearTimeout(timeout);
          try {
            ws.close();
          } catch (_) {}
          const val = msg.result?.result?.value;
          resolve(val || null);
        }
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const NAVER_MAIL_EXTRACTOR_EXPR = `
(async () => {
  const mails = [];
  const seen = new Set();

  // 1. Try Naver Mail internal JSON list endpoint using browser session cookies
  try {
    const resp = await fetch('/json/list?page=1&sortField=1&sortType=0&folderSN=0&isUnread=false', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (resp.ok) {
      const json = await resp.json();
      if (json && Array.isArray(json.mailData)) {
        for (const m of json.mailData) {
          const sn = String(m.mailSN || '');
          const subject = (m.subject || '(제목 없음)').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          const sender = m.from ? (m.from.name || m.from.email || '') : '';
          const date = m.sentTime ? new Date(m.sentTime * 1000).toLocaleString('ko-KR') : '';
          const unread = m.status ? (m.status & 1) === 0 : false;
          const key = sn + ':' + subject;
          if (!seen.has(key)) {
            seen.add(key);
            mails.push({
              mailSn: sn,
              subject,
              sender,
              date,
              unread,
              url: 'https://mail.naver.com/v2/read/0/' + sn
            });
          }
        }
      }
    }
  } catch (_) {}

  // 2. Also scrape rendered DOM list items
  const itemEls = document.querySelectorAll('li.mail_item, div.mail_item, ul.mail_list > li, [class*="mail_item"], tr[mailsn]');
  itemEls.forEach((el, idx) => {
    const titleEl = el.querySelector('.mail_title_link, .mail_title, strong.mail_title, a[href*="/read/"], .subject') || el.querySelector('a');
    const senderEl = el.querySelector('.mail_sender, .button_sender, [class*="sender"], .name, .from');
    const dateEl = el.querySelector('.mail_date, [class*="date"], .time, .i_date');
    const linkEl = el.querySelector('a[href*="/read/"], a.mail_title_link');

    let subject = (titleEl ? titleEl.innerText : '').replace(/\\s+/g, ' ').replace(/^메일 제목\\s*/, '').trim();
    if (!subject) return;
    let sender = (senderEl ? senderEl.innerText : '').replace(/\\s+/g, ' ').replace(/^보낸 사람\\s*/, '').trim();
    let date = (dateEl ? dateEl.innerText : '').replace(/\\s+/g, ' ').trim();
    const href = linkEl ? linkEl.href : '';
    const snMatch = href && href.match(/\\/read\\/(?:\\d+\\/)?(\\d+)/);
    const mailSn = snMatch ? snMatch[1] : ('dom-' + idx);
    const isUnread = el.classList.contains('unreads') || el.classList.contains('unread') || Boolean(el.querySelector('.unread, [class*="unread"]'));

    const key = mailSn + ':' + subject;
    if (!seen.has(key)) {
      seen.add(key);
      mails.push({
        mailSn,
        subject,
        sender: sender || '알 수 없음',
        date,
        unread: isUnread,
        url: href || (snMatch ? 'https://mail.naver.com/v2/read/0/' + mailSn : window.location.href)
      });
    }
  });

  // 3. Extract currently open email body if viewing an email
  let openMail = null;
  const viewBodyEl = document.querySelector('.mail_view_contents, .mail_view_body, #readFrame, [class*="mail_view_contents"]');
  if (viewBodyEl) {
    const viewTitleEl = document.querySelector('.mail_view_title, h4.view_title, [class*="mail_view_title"]');
    const viewSenderEl = document.querySelector('.mail_view_header .button_user, .mail_view_header [class*="sender"]');
    const viewDateEl = document.querySelector('.mail_view_header .mail_view_date, [class*="mail_view_date"]');
    openMail = {
      subject: viewTitleEl ? viewTitleEl.innerText.replace(/\\s+/g, ' ').trim() : document.title,
      sender: viewSenderEl ? viewSenderEl.innerText.replace(/\\s+/g, ' ').trim() : '',
      date: viewDateEl ? viewDateEl.innerText.replace(/\\s+/g, ' ').trim() : '',
      body: viewBodyEl.innerText.trim().slice(0, 15000),
      url: window.location.href
    };
  }

  return {
    pageUrl: window.location.href,
    pageTitle: document.title,
    fetchedAt: new Date().toISOString(),
    mails,
    openMail
  };
})()
`;

async function fetchNaverMailFromBrowser({ readUrl = null } = {}) {
  const cdpTabs = await queryCdpTabs([9222, 9223]);
  const naverTab = cdpTabs.find(
    (t) => t.url && t.url.includes('mail.naver.com') && t.webSocketDebuggerUrl
  );

  if (naverTab) {
    try {
      const evaluated = await evaluateInCdpTab(
        naverTab.webSocketDebuggerUrl,
        NAVER_MAIL_EXTRACTOR_EXPR,
        readUrl
      );
      if (evaluated) {
        return updateNaverMailState(evaluated, 'cdp-live');
      }
    } catch (err) {
      console.warn('CDP Naver Mail evaluation error:', err.message);
    }
  }

  return cachedNaverMailState;
}

async function inspectOpenBrowserTabs() {
  const [cdpTabs, winWindows] = await Promise.all([
    queryCdpTabs([9222, 9223]),
    queryWindowsBrowserWindows(),
  ]);
  const sessionUrls = extractUrlsFromChromiumSessions();
  const mergedLiveTabs = cdpTabs.length > 0 ? cdpTabs : extensionSyncedTabs;

  return {
    cdpActive: mergedLiveTabs.length > 0,
    cdpTabs: mergedLiveTabs,
    windows: winWindows,
    consoleOpenedTabs: trackedConsoleTabs,
    recentSessionUrls: sessionUrls,
  };
}

/**
 * Launch Chrome or Edge with --remote-debugging-port=9222 and our local extension loaded
 * so all open tabs & Naver Mail can be read in real time.
 */
function launchCdpBrowser(preferred = 'chrome') {
  const defs = getBrowserDefinitions();
  const target = defs.find((d) => d.id === preferred) || defs[0];
  let exe = null;
  for (const d of [target, ...defs]) {
    for (const p of d.exePaths) {
      if (fs.existsSync(p)) {
        exe = p;
        break;
      }
    }
    if (exe) break;
  }
  if (!exe) {
    throw new Error('실행 가능한 Chrome 또는 Edge 브라우저를 찾을 수 없습니다.');
  }

  const debugProfileDir = path.join(__dirname, '.cdp-profile');
  const extDir = path.join(__dirname, 'extension');
  execFile(
    exe,
    [
      '--remote-debugging-port=9222',
      `--user-data-dir=${debugProfileDir}`,
      `--load-extension=${extDir}`,
      'https://mail.naver.com',
      'http://127.0.0.1:3080',
    ],
    { windowsHide: false },
    () => {}
  );
  return { exe, port: 9222 };
}

/**
 * If a matching tab is already open in CDP, activate/focus it instead of opening a duplicate tab.
 */
async function focusExistingCdpTab(rawUrl) {
  try {
    const target = new URL(rawUrl);
    const targetKey = (target.origin + target.pathname.replace(/\/+$/, '')).toLowerCase();
    const cdpTabs = await queryCdpTabs([9222, 9223]);
    for (const tab of cdpTabs) {
      try {
        const u = new URL(tab.url);
        const key = (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase();
        if (key === targetKey || u.origin.toLowerCase() === target.origin.toLowerCase()) {
          await fetch(`http://127.0.0.1:${tab.port}/json/activate/${tab.id}`);
          return true;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return false;
}

module.exports = {
  recordOpenedTab,
  loadInternalBookmarks,
  addInternalBookmark,
  updateInternalBookmark,
  deleteInternalBookmark,
  readLocalBrowserBookmarks,
  inspectOpenBrowserTabs,
  launchCdpBrowser,
  focusExistingCdpTab,
  updateExtensionTabs,
  updateNaverMailState,
  fetchNaverMailFromBrowser,
};
