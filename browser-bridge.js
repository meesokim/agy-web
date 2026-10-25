const fs = require('fs');
const path = require('path');
const os = require('os');
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
 * Scan local Chromium browsers (Chrome, Chromium, Edge, Whale, Brave) for their Bookmarks JSON files.
 */
function getBrowserDefinitions() {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
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

  const home = os.homedir();
  const configDir = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      userDataDir: path.join(configDir, 'google-chrome'),
      exePaths: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/google-chrome',
      ],
    },
    {
      id: 'chromium',
      name: 'Chromium',
      userDataDir: path.join(configDir, 'chromium'),
      exePaths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      userDataDir: path.join(configDir, 'microsoft-edge'),
      exePaths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    },
    {
      id: 'whale',
      name: 'Naver Whale',
      userDataDir: path.join(configDir, 'naver-whale'),
      exePaths: ['/usr/bin/naver-whale', '/usr/bin/naver-whale-stable', '/opt/naver/whale/naver-whale'],
    },
    {
      id: 'brave',
      name: 'Brave',
      userDataDir: path.join(configDir, 'BraveSoftware', 'Brave-Browser'),
      exePaths: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'],
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
 * Discover active CDP ports from [9222, 9223] plus any DevToolsActivePort files in browser profiles.
 */
function getCandidateCdpPorts() {
  const portSet = new Set([9222, 9223]);
  const dirs = [
    ...getBrowserDefinitions().map((b) => b.userDataDir),
    path.join(__dirname, '.cdp-profile'),
  ];
  for (const dir of dirs) {
    try {
      const portFile = path.join(dir, 'DevToolsActivePort');
      if (fs.existsSync(portFile)) {
        const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        const p = parseInt(lines[0], 10);
        if (p > 0 && p < 65536) {
          portSet.add(p);
        }
      }
    } catch (_) {}
  }
  return Array.from(portSet);
}

/**
 * Query Chrome/Edge Remote Debugging Port (CDP) if available (default 9222 + DevToolsActivePort).
 */
async function queryCdpTabs(ports = getCandidateCdpPorts()) {
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
 * Query open browser windows on Windows or Linux.
 */
function queryWindowsBrowserWindows() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
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
      return;
    }

    // Linux: try wmctrl -lp first, fallback to ps for running browser main processes
    execFile('wmctrl', ['-lp'], { timeout: 1500 }, (err, stdout) => {
      if (!err && stdout && stdout.trim()) {
        const out = [];
        for (const line of stdout.trim().split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const pid = Number(parts[2]) || 0;
            const title = parts.slice(4).join(' ');
            if (/(Chrome|Chromium|Edge|Whale|Brave|Firefox)/i.test(title)) {
              out.push({ processName: 'browser', pid, windowTitle: title });
            }
          }
        }
        if (out.length > 0) return resolve(out);
      }

      execFile('ps', ['-eo', 'pid=,comm=,args='], { timeout: 1500 }, (psErr, psOut) => {
        if (psErr || !psOut) return resolve([]);
        const out = [];
        for (const line of psOut.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
          if (!m) continue;
          const [, pid, comm, args] = m;
          if (
            /^(chrome|google-chrome|chromium|msedge|whale|brave|firefox)$/i.test(comm) &&
            !args.includes('--type=')
          ) {
            out.push({
              processName: comm,
              pid: Number(pid),
              windowTitle: `${comm} (PID ${pid})`,
            });
          }
        }
        resolve(out);
      });
    });
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

let cachedGmailState = {
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

function updateGmailState(payload, source = 'sync') {
  if (!payload || typeof payload !== 'object') return cachedGmailState;
  cachedGmailState = {
    source,
    pageUrl: payload.pageUrl || 'https://mail.google.com',
    pageTitle: payload.pageTitle || 'Gmail',
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
    mails: Array.isArray(payload.mails) ? payload.mails : cachedGmailState.mails,
    openMail: payload.openMail || cachedGmailState.openMail,
  };
  return cachedGmailState;
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
  const cdpTabs = await queryCdpTabs();
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

const GMAIL_MAIL_EXTRACTOR_EXPR = `
(async () => {
  const mails = [];
  const seen = new Set();

  try {
    const resp = await fetch('https://mail.google.com/mail/feed/atom', { credentials: 'include' });
    if (resp.ok) {
      const text = await resp.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'text/xml');
      const entries = xmlDoc.querySelectorAll('entry');
      entries.forEach((entry, idx) => {
        const title = entry.querySelector('title')?.textContent?.trim() || '(제목 없음)';
        const summary = entry.querySelector('summary')?.textContent?.trim() || '';
        const authorName = entry.querySelector('author name')?.textContent?.trim() || '';
        const authorEmail = entry.querySelector('author email')?.textContent?.trim() || '';
        const sender = authorName ? (authorName + ' <' + authorEmail + '>') : (authorEmail || '알 수 없음');
        const issued = entry.querySelector('issued, modified')?.textContent?.trim() || '';
        const link = entry.querySelector('link')?.getAttribute('href') || 'https://mail.google.com';
        const id = entry.querySelector('id')?.textContent?.trim() || ('atom-' + idx);
        const key = id || (title + ':' + sender);
        if (!seen.has(key)) {
          seen.add(key);
          mails.push({
            mailId: id,
            subject: title,
            sender,
            date: issued ? new Date(issued).toLocaleString('ko-KR') : '',
            snippet: summary,
            unread: true,
            url: link
          });
        }
      });
    }
  } catch (_) {}

  const rows = document.querySelectorAll('tr.zA, div[role="row"].zA, tr[role="row"]');
  rows.forEach((row, idx) => {
    const subjectEl = row.querySelector('.bog, .y6 span, [data-thread-id], span[role="gridcell"]');
    const snippetEl = row.querySelector('.y2');
    const senderEl = row.querySelector('.yW span[email], .bA4 span, .yP, .zF, [email]') || row.querySelector('.yX');
    const dateEl = row.querySelector('.xW span, .xY span, td.xW, [title*="202"], [title*="오전"], [title*="오후"]');
    const linkEl = row.querySelector('a[href*="#inbox/"], a[href*="#all/"], a[href*="#search/"]') || row.querySelector('a');

    let subject = subjectEl ? subjectEl.innerText.replace(/\\s+/g, ' ').trim() : '';
    if (!subject && linkEl) {
      subject = linkEl.innerText.replace(/\\s+/g, ' ').trim();
    }
    if (!subject) return;

    let snippet = snippetEl ? snippetEl.innerText.replace(/\\s+/g, ' ').trim() : '';
    let sender = senderEl ? (senderEl.getAttribute('email') || senderEl.innerText.replace(/\\s+/g, ' ').trim()) : '알 수 없음';
    let date = dateEl ? (dateEl.getAttribute('title') || dateEl.innerText.replace(/\\s+/g, ' ').trim()) : '';

    const isUnread = row.classList.contains('zE') || Boolean(row.querySelector('.zE, font[weight="bold"], strong'));
    const href = linkEl ? linkEl.href : window.location.href;
    const id = row.getAttribute('id') || row.getAttribute('data-legacy-thread-id') || ('row-' + idx);

    const key = id + ':' + subject;
    if (!seen.has(key)) {
      seen.add(key);
      mails.push({
        mailId: id,
        subject,
        sender,
        date,
        snippet,
        unread: isUnread,
        url: href
      });
    }
  });

  let openMail = null;
  const mailBodyEl = document.querySelector('.a3s.aiL, div[role="listitem"] .a3s, .ii.gt');
  if (mailBodyEl) {
    const titleEl = document.querySelector('h2.hP, [data-thread-perm-id] h2, h2[data-legacy-thread-id]') || document.querySelector('h2');
    const senderEl = document.querySelector('span.gD, .gE .gD, [email]');
    const dateEl = document.querySelector('span.g3, .gH .g3, span[role="gridcell"]');

    const subject = titleEl ? titleEl.innerText.replace(/\\s+/g, ' ').trim() : document.title;
    const sender = senderEl ? (senderEl.getAttribute('email') ? (senderEl.innerText.trim() + ' <' + senderEl.getAttribute('email') + '>') : senderEl.innerText.trim()) : '';
    const date = dateEl ? (dateEl.getAttribute('title') || dateEl.innerText.trim()) : '';
    const body = mailBodyEl.innerText.trim().slice(0, 15000);

    openMail = {
      subject,
      sender,
      date,
      body,
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

async function fetchGmailFromBrowser({ readUrl = null } = {}) {
  const cdpTabs = await queryCdpTabs();
  const gmailTab = cdpTabs.find(
    (t) => t.url && (t.url.includes('mail.google.com') || t.url.includes('google.com/mail')) && t.webSocketDebuggerUrl
  );

  if (gmailTab) {
    try {
      const evaluated = await evaluateInCdpTab(
        gmailTab.webSocketDebuggerUrl,
        GMAIL_MAIL_EXTRACTOR_EXPR,
        readUrl
      );
      if (evaluated) {
        return updateGmailState(evaluated, 'cdp-live');
      }
    } catch (err) {
      console.warn('CDP Gmail evaluation error:', err.message);
    }
  }

  return cachedGmailState;
}

async function inspectOpenBrowserTabs() {
  const [cdpTabs, winWindows] = await Promise.all([
    queryCdpTabs(),
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
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${debugProfileDir}`,
      `--load-extension=${extDir}`,
      'https://mail.naver.com',
      'http://127.0.0.1:3080',
    ],
    { windowsHide: false },
    () => {}
  );

  // Sync DevToolsActivePort to default Chrome config dir if missing so /browser MCP can also autoConnect
  setTimeout(() => {
    try {
      const cdpPortFile = path.join(debugProfileDir, 'DevToolsActivePort');
      const chromeDir = defs[0] && defs[0].userDataDir;
      if (fs.existsSync(cdpPortFile) && chromeDir && fs.existsSync(chromeDir)) {
        const destFile = path.join(chromeDir, 'DevToolsActivePort');
        if (!fs.existsSync(destFile)) {
          fs.copyFileSync(cdpPortFile, destFile);
        }
      }
    } catch (_) {}
  }, 1500);

  return { exe, port: 9222 };
}

/**
 * If a matching tab is already open in CDP, activate/focus it instead of opening a duplicate tab.
 */
async function focusExistingCdpTab(rawUrl) {
  try {
    const target = new URL(rawUrl);
    const targetKey = (target.origin + target.pathname.replace(/\/+$/, '')).toLowerCase();
    const cdpTabs = await queryCdpTabs();
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

// ============================================================================
// Joined Naver Cafe Management & Article Search
// ============================================================================
const JOINED_CAFES_FILE = path.join(__dirname, 'joined-cafes.json');

let cachedNaverCafeState = {
  source: null,
  pageUrl: 'https://section.cafe.naver.com',
  pageTitle: '네이버 카페',
  fetchedAt: null,
  joinedCafes: [],
  articles: [],
  openArticle: null,
  lastQuery: '',
};

let pendingCafeTask = null;
const pendingCafeResolvers = new Map();

function stripHtmlTags(str) {
  return String(str || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCafeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let cafeUrl = String(raw.cafeUrl || raw.cluburl || '').trim();
  let cafeId = String(raw.cafeId || raw.clubid || '').trim();
  let rawUrl = String(raw.url || '').trim();

  if (!cafeUrl && rawUrl) {
    const m = rawUrl.match(/cafe\.naver\.com\/([A-Za-z0-9_-]{2,40})/);
    if (
      m &&
      ![
        'ca-fe',
        'ArticleRead.nhn',
        'ArticleList.nhn',
        'ArticleSearchList.nhn',
        'MyCafeIntro.nhn',
        'f-e',
      ].includes(m[1])
    ) {
      cafeUrl = m[1];
    }
    const idMatch = rawUrl.match(/[?&](?:clubid|search\.clubid)=(\d+)/i);
    if (idMatch && !cafeId) {
      cafeId = idMatch[1];
    }
  }
  cafeUrl = cafeUrl.replace(/^https?:\/\/cafe\.naver\.com\//i, '').replace(/^\/+|\/+$/g, '');
  if (!cafeUrl && !cafeId) return null;

  const cafeName = stripHtmlTags(raw.cafeName || raw.title || cafeUrl || `카페 ${cafeId}`);
  const url = cafeUrl
    ? `https://cafe.naver.com/${cafeUrl}`
    : `https://cafe.naver.com/MyCafeIntro.nhn?clubid=${cafeId}`;

  return {
    cafeId,
    cafeUrl,
    cafeName: cafeName || cafeUrl || cafeId,
    memberLevelName: raw.memberLevelName || '',
    url,
  };
}

function loadSavedJoinedCafes() {
  const map = new Map();
  try {
    if (fs.existsSync(JOINED_CAFES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(JOINED_CAFES_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const norm = normalizeCafeEntry(item);
          if (norm) {
            const key = (norm.cafeUrl || norm.cafeId).toLowerCase();
            map.set(key, norm);
          }
        }
      }
    }
  } catch (_) {}

  // Also discover any Naver Cafes from local browser bookmarks & recent session URLs
  try {
    const bmGroups = readLocalBrowserBookmarks();
    for (const g of bmGroups) {
      for (const it of g.items || []) {
        if (it.url && it.url.includes('cafe.naver.com/')) {
          const norm = normalizeCafeEntry({
            url: it.url,
            cafeName: it.title ? it.title.replace(/\s*:\s*네이버 카페.*$/, '') : '',
          });
          if (norm) {
            const key = (norm.cafeUrl || norm.cafeId).toLowerCase();
            if (!map.has(key)) map.set(key, norm);
          }
        }
      }
    }
    const sessUrls = extractUrlsFromChromiumSessions();
    for (const s of sessUrls) {
      if (s.url && s.url.includes('cafe.naver.com/')) {
        const norm = normalizeCafeEntry({ url: s.url });
        if (norm) {
          const key = (norm.cafeUrl || norm.cafeId).toLowerCase();
          if (!map.has(key)) map.set(key, norm);
        }
      }
    }
  } catch (_) {}

  return Array.from(map.values());
}

function saveJoinedCafes(list) {
  try {
    const map = new Map();
    for (const raw of list) {
      const norm = normalizeCafeEntry(raw);
      if (!norm) continue;
      const key = (norm.cafeUrl || norm.cafeId).toLowerCase();
      const prev = map.get(key);
      map.set(key, {
        ...prev,
        ...norm,
        cafeId: norm.cafeId || prev?.cafeId || '',
        cafeUrl: norm.cafeUrl || prev?.cafeUrl || '',
        cafeName:
          norm.cafeName && norm.cafeName !== norm.cafeUrl
            ? norm.cafeName
            : prev?.cafeName || norm.cafeName,
      });
    }
    const merged = Array.from(map.values());
    fs.writeFileSync(JOINED_CAFES_FILE, JSON.stringify(merged, null, 2), 'utf8');
    cachedNaverCafeState.joinedCafes = merged;
    return merged;
  } catch (_) {
    return list;
  }
}

function addJoinedCafe({ cafeUrl, cafeName, cafeId }) {
  const existing = loadSavedJoinedCafes();
  const norm = normalizeCafeEntry({
    cafeUrl,
    cafeName,
    cafeId,
    url: cafeUrl,
  });
  if (!norm) return null;
  const merged = saveJoinedCafes([norm, ...existing]);
  return merged.find(
    (c) =>
      (norm.cafeUrl && c.cafeUrl.toLowerCase() === norm.cafeUrl.toLowerCase()) ||
      (norm.cafeId && c.cafeId === norm.cafeId)
  );
}

function deleteJoinedCafe(targetKey) {
  if (!targetKey) return false;
  const keyLower = String(targetKey).toLowerCase();
  const existing = loadSavedJoinedCafes();
  const filtered = existing.filter(
    (c) =>
      c.cafeUrl.toLowerCase() !== keyLower &&
      c.cafeId.toLowerCase() !== keyLower
  );
  fs.writeFileSync(JOINED_CAFES_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  cachedNaverCafeState.joinedCafes = filtered;
  return filtered.length !== existing.length;
}

function updateNaverCafeState(payload, source = 'sync') {
  if (!payload || typeof payload !== 'object') return cachedNaverCafeState;
  const currentCafes = loadSavedJoinedCafes();
  const incomingCafes = Array.isArray(payload.joinedCafes) ? payload.joinedCafes : [];
  const mergedCafes =
    incomingCafes.length > 0 ? saveJoinedCafes([...incomingCafes, ...currentCafes]) : currentCafes;

  cachedNaverCafeState = {
    source,
    pageUrl: payload.pageUrl || cachedNaverCafeState.pageUrl,
    pageTitle: payload.pageTitle || cachedNaverCafeState.pageTitle,
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
    joinedCafes: mergedCafes,
    articles: Array.isArray(payload.articles)
      ? payload.articles
      : cachedNaverCafeState.articles,
    openArticle: payload.openArticle || cachedNaverCafeState.openArticle,
    lastQuery:
      typeof payload.query === 'string' ? payload.query : cachedNaverCafeState.lastQuery,
  };
  return cachedNaverCafeState;
}

function getPendingCafeTask() {
  const task = pendingCafeTask;
  pendingCafeTask = null;
  return task;
}

function resolveCafeTaskResult(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload.joinedCafes) && payload.joinedCafes.length > 0) {
    saveJoinedCafes([...payload.joinedCafes, ...loadSavedJoinedCafes()]);
  }
  if (Array.isArray(payload.articles)) {
    cachedNaverCafeState.articles = payload.articles;
    cachedNaverCafeState.fetchedAt = new Date().toISOString();
    cachedNaverCafeState.source = 'extension-live';
    if (payload.query) cachedNaverCafeState.lastQuery = payload.query;
  }
  const resolver = payload.taskId && pendingCafeResolvers.get(payload.taskId);
  if (resolver) {
    pendingCafeResolvers.delete(payload.taskId);
    resolver(payload);
  }
}

function dispatchExtensionCafeTask(taskPayload, timeoutMs = 2800) {
  return new Promise((resolve) => {
    const id = `cafe-task-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    pendingCafeTask = { id, ...taskPayload };
    const timer = setTimeout(() => {
      pendingCafeResolvers.delete(id);
      if (pendingCafeTask && pendingCafeTask.id === id) {
        pendingCafeTask = null;
      }
      resolve(null);
    }, timeoutMs);
    pendingCafeResolvers.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/**
 * Resolve numeric cafeId from cafeUrl slug using Naver Cafe public gate API.
 */
async function resolveCafeInfoBySlug(cafeUrl) {
  if (!cafeUrl) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(
      `https://apis.naver.com/cafe-web/cafe2/CafeGateInfo.json?cluburl=${encodeURIComponent(cafeUrl)}`,
      {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: `https://cafe.naver.com/${cafeUrl}`,
        },
      }
    );
    clearTimeout(timer);
    if (resp.ok) {
      const json = await resp.json();
      const view = json?.message?.result?.cafeInfoView;
      if (view && view.cafeId) {
        return {
          cafeId: String(view.cafeId),
          cafeUrl: view.cafeUrl || cafeUrl,
          cafeName: stripHtmlTags(view.cafeName || cafeUrl),
        };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Server-side search for articles inside a specific cafe (or across joined cafes) via Naver Cafe APIs + Naver Search fallback.
 */
async function searchCafeArticlesFromServer(cafe, query, perPage = 15) {
  const results = [];
  const seen = new Set();

  let cafeId = cafe?.cafeId || '';
  let cafeUrl = cafe?.cafeUrl || '';
  let cafeName = cafe?.cafeName || cafeUrl || cafeId || '네이버 카페';

  if (!cafeId && cafeUrl) {
    const resolved = await resolveCafeInfoBySlug(cafeUrl);
    if (resolved) {
      cafeId = resolved.cafeId;
      cafeName = resolved.cafeName || cafeName;
    }
  }

  // 1. Try Naver Cafe Search APIs if cafeId is known
  if (cafeId) {
    const apiEndpoints = [
      `https://apis.naver.com/cafe-web/cafe-search-api/v1.0/cafes/${cafeId}/search/articles?query=${encodeURIComponent(query)}&page=1&perPage=${perPage}&sortBy=TIME`,
      `https://apis.naver.com/cafe-web/cafe-mobile/CafeMobileWebArticleSearchListV3?cafeId=${cafeId}&query=${encodeURIComponent(query)}&searchBy=0&sortBy=date&page=1&perPage=${perPage}`,
    ];
    for (const ep of apiEndpoints) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        const resp = await fetch(ep, {
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Referer: cafeUrl ? `https://cafe.naver.com/${cafeUrl}` : 'https://section.cafe.naver.com/',
          },
        });
        clearTimeout(timer);
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
            const title = stripHtmlTags(entry.subject || entry.title || '(제목 없음)');
            const snippet = stripHtmlTags(
              entry.contentSummary || entry.summary || entry.content || ''
            );
            const author = stripHtmlTags(
              entry.writerNickname || entry.writerInfo?.nickName || entry.memberNickName || ''
            );
            const date = entry.writeDateTimestamp
              ? new Date(entry.writeDateTimestamp).toLocaleString('ko-KR')
              : entry.addDate || entry.writeDate || '';
            const url = cafeUrl
              ? `https://cafe.naver.com/${cafeUrl}/${articleId}`
              : `https://cafe.naver.com/ArticleRead.nhn?clubid=${cafeId}&articleid=${articleId}`;
            if (!seen.has(url)) {
              seen.add(url);
              results.push({
                articleId,
                cafeId,
                cafeUrl,
                cafeName,
                title,
                snippet,
                author,
                date,
                url,
              });
            }
          }
          if (results.length > 0) return results;
        }
      } catch (_) {}
    }
  }

  // 2. Fallback: Query Naver Cafe Search (search.naver.com?ssc=tab.cafe.all) scoped to the cafe or joined cafes
  try {
    const prefix =
      cafeName && cafeName !== '네이버 카페' && cafeName !== cafeUrl
        ? cafeName
        : cafeUrl || '';
    const effectiveQuery = prefix ? `${prefix} ${query}` : query;
    const searchUrl = `https://search.naver.com/search.naver?ssc=tab.cafe.all&ie=utf8&query=${encodeURIComponent(effectiveQuery)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const resp = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timer);
    if (resp.ok) {
      const html = await resp.text();
      const blocks = html.split('<li class="bx _bx">').slice(1);
      const matchedItems = [];
      const fallbackItems = [];

      for (const b of blocks) {
        const cafeM = b.match(
          /<a href="https:\/\/cafe\.naver\.com\/([A-Za-z0-9_-]+)" class="name"[^>]*>([\s\S]*?)<\/a>/i
        );
        const dateM = b.match(/<span class="sub">([\s\S]*?)<\/span>/i);
        const titleM = b.match(
          /<a href="(https:\/\/cafe\.naver\.com\/([A-Za-z0-9_-]+)\/(\d+)[^"]*)"[^>]*class="title_link"[^>]*>([\s\S]*?)<\/a>/i
        );
        const dscM = b.match(/class="dsc_link"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleM) continue;

        const slug = titleM[2] || cafeM?.[1] || '';
        const artId = titleM[3] || '';
        const cleanUrl = `https://cafe.naver.com/${slug}/${artId}`;
        if (seen.has(cleanUrl)) continue;

        const title = stripHtmlTags(titleM[4]);
        if (!title) continue;

        const itemObj = {
          articleId: artId,
          cafeId: cafeId || '',
          cafeUrl: slug,
          cafeName: stripHtmlTags(cafeM?.[2]) || cafeName || slug,
          title,
          snippet: stripHtmlTags(dscM?.[1] || '').slice(0, 220),
          author: '',
          date: stripHtmlTags(dateM?.[1] || ''),
          url: cleanUrl,
        };

        if (cafeUrl && slug.toLowerCase() === cafeUrl.toLowerCase()) {
          seen.add(cleanUrl);
          matchedItems.push(itemObj);
        } else if (!cafeUrl) {
          seen.add(cleanUrl);
          matchedItems.push(itemObj);
        } else {
          fallbackItems.push(itemObj);
        }
      }

      const finalItems = matchedItems.length > 0 ? matchedItems : fallbackItems;
      for (const it of finalItems.slice(0, perPage)) {
        results.push(it);
      }
    }
  } catch (_) {}

  return results;
}

/**
 * Fetch joined cafes & current state via CDP, Extension, or saved state.
 */
async function fetchNaverCafeFromBrowser() {
  const savedCafes = loadSavedJoinedCafes();
  cachedNaverCafeState.joinedCafes = savedCafes;

  // 1. Check if a CDP tab on *.naver.com is open
  const cdpTabs = await queryCdpTabs();
  const naverTab = cdpTabs.find(
    (t) =>
      t.url &&
      (t.url.includes('cafe.naver.com') || t.url.includes('naver.com')) &&
      t.webSocketDebuggerUrl
  );

  if (naverTab) {
    try {
      const expr = `
        (async () => {
          const cafes = [];
          const seen = new Set();
          try {
            const r = await fetch('https://apis.naver.com/cafe-home-web/cafe-home/v1/cafes/join?page=1&perPage=100', { credentials: 'include' });
            if (r.ok) {
              const j = await r.json();
              const list = j?.message?.result?.cafes || j?.result?.cafes || [];
              for (const c of list) {
                const key = String(c.cafeId || c.cafeUrl || '');
                if (key && !seen.has(key)) {
                  seen.add(key);
                  cafes.push({
                    cafeId: String(c.cafeId || ''),
                    cafeUrl: String(c.cafeUrl || ''),
                    cafeName: c.cafeName || c.cafeUrl,
                    memberLevelName: c.memberLevelName || '',
                    url: c.cafeUrl ? ('https://cafe.naver.com/' + c.cafeUrl) : ''
                  });
                }
              }
            }
          } catch (_) {}
          return { joinedCafes: cafes, pageUrl: location.href, pageTitle: document.title };
        })()
      `;
      const evaluated = await evaluateInCdpTab(naverTab.webSocketDebuggerUrl, expr);
      if (evaluated && Array.isArray(evaluated.joinedCafes) && evaluated.joinedCafes.length > 0) {
        return updateNaverCafeState(evaluated, 'cdp-live');
      }
    } catch (_) {}
  }

  // 2. If extension tabs are active, ask extension to sync joined cafes
  if (extensionSyncedTabs.length > 0) {
    const extRes = await dispatchExtensionCafeTask({ type: 'sync-cafes' }, 2000);
    if (extRes && Array.isArray(extRes.joinedCafes) && extRes.joinedCafes.length > 0) {
      return updateNaverCafeState(extRes, 'extension-live');
    }
  }

  return cachedNaverCafeState;
}

/**
 * Search articles across the user's joined Naver Cafes (or a specific joined cafe).
 */
async function searchJoinedNaverCafes({ query, cafeId = '', cafeUrl = '' } = {}) {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) {
    return cachedNaverCafeState;
  }

  // Ensure cafeUrl is normalized if user passed full URL
  let cleanCafeUrl = String(cafeUrl || '')
    .trim()
    .replace(/^https?:\/\/cafe\.naver\.com\//i, '')
    .replace(/^\/+|\/+$/g, '');

  const joinedCafes = loadSavedJoinedCafes();

  // 1. Try CDP evaluation with cookies if a *.naver.com CDP tab is open
  const cdpTabs = await queryCdpTabs();
  const naverTab = cdpTabs.find(
    (t) =>
      t.url &&
      (t.url.includes('cafe.naver.com') || t.url.includes('naver.com')) &&
      t.webSocketDebuggerUrl
  );

  if (naverTab) {
    try {
      const cdpSearchExpr = `
        (async () => {
          const query = ${JSON.stringify(trimmedQuery)};
          const filterCafeId = ${JSON.stringify(String(cafeId || ''))};
          const filterCafeUrl = ${JSON.stringify(cleanCafeUrl)};
          let cafes = ${JSON.stringify(joinedCafes)};

          try {
            const r = await fetch('https://apis.naver.com/cafe-home-web/cafe-home/v1/cafes/join?page=1&perPage=100', { credentials: 'include' });
            if (r.ok) {
              const j = await r.json();
              const list = j?.message?.result?.cafes || j?.result?.cafes || [];
              if (list.length > 0) {
                cafes = list.map(c => ({
                  cafeId: String(c.cafeId || ''),
                  cafeUrl: String(c.cafeUrl || ''),
                  cafeName: c.cafeName || c.cafeUrl,
                  url: c.cafeUrl ? ('https://cafe.naver.com/' + c.cafeUrl) : ''
                }));
              }
            }
          } catch (_) {}

          let targets = cafes;
          if (filterCafeId || filterCafeUrl) {
            targets = cafes.filter(c => (filterCafeId && c.cafeId === filterCafeId) || (filterCafeUrl && c.cafeUrl.toLowerCase() === filterCafeUrl.toLowerCase()));
            if (targets.length === 0) {
              targets = [{ cafeId: filterCafeId, cafeUrl: filterCafeUrl, cafeName: filterCafeUrl || filterCafeId }];
            }
          } else {
            targets = cafes.slice(0, 15);
          }

          const articles = [];
          for (const c of targets) {
            let cid = c.cafeId;
            if (!cid && c.cafeUrl) {
              try {
                const gr = await fetch('https://apis.naver.com/cafe-web/cafe2/CafeGateInfo.json?cluburl=' + encodeURIComponent(c.cafeUrl), { credentials: 'include' });
                if (gr.ok) {
                  const gj = await gr.json();
                  cid = String(gj?.message?.result?.cafeInfoView?.cafeId || '');
                }
              } catch (_) {}
            }
            if (!cid) continue;
            try {
              const sr = await fetch('https://apis.naver.com/cafe-web/cafe-search-api/v1.0/cafes/' + cid + '/search/articles?query=' + encodeURIComponent(query) + '&page=1&perPage=12&sortBy=TIME', { credentials: 'include' });
              if (sr.ok) {
                const sj = await sr.json();
                const list = sj?.result?.articleList || sj?.message?.result?.articleList || [];
                for (const item of list) {
                  const e = item.item || item;
                  const aid = String(e.articleId || e.id || '');
                  if (!aid) continue;
                  articles.push({
                    articleId: aid,
                    cafeId: cid,
                    cafeUrl: c.cafeUrl || '',
                    cafeName: c.cafeName || c.cafeUrl || cid,
                    title: String(e.subject || e.title || '').replace(/<[^>]*>/g, ''),
                    snippet: String(e.contentSummary || e.summary || '').replace(/<[^>]*>/g, ''),
                    author: e.writerNickname || e.writerInfo?.nickName || '',
                    date: e.writeDateTimestamp ? new Date(e.writeDateTimestamp).toLocaleString('ko-KR') : (e.addDate || ''),
                    url: c.cafeUrl ? ('https://cafe.naver.com/' + c.cafeUrl + '/' + aid) : ('https://cafe.naver.com/ArticleRead.nhn?clubid=' + cid + '&articleid=' + aid)
                  });
                }
              }
            } catch (_) {}
          }
          return { joinedCafes: cafes, articles, query };
        })()
      `;
      const evaluated = await evaluateInCdpTab(naverTab.webSocketDebuggerUrl, cdpSearchExpr);
      if (evaluated && Array.isArray(evaluated.articles) && evaluated.articles.length > 0) {
        return updateNaverCafeState(evaluated, 'cdp-live');
      }
    } catch (_) {}
  }

  // 2. Try Chrome Extension background worker task (uses browser's logged-in cookies)
  if (extensionSyncedTabs.length > 0) {
    const extRes = await dispatchExtensionCafeTask(
      {
        type: 'search-articles',
        query: trimmedQuery,
        cafeId,
        cafeUrl: cleanCafeUrl,
        targetCafes: joinedCafes,
      },
      3200
    );
    if (extRes && Array.isArray(extRes.articles) && extRes.articles.length > 0) {
      return updateNaverCafeState(extRes, 'extension-live');
    }
  }

  // 3. Server-side search across the user's joined cafes (or specified cafe)
  let cafesToSearch = joinedCafes;
  if (cafeId || cleanCafeUrl) {
    cafesToSearch = joinedCafes.filter(
      (c) =>
        (cafeId && c.cafeId === String(cafeId)) ||
        (cleanCafeUrl && c.cafeUrl.toLowerCase() === cleanCafeUrl.toLowerCase())
    );
    if (cafesToSearch.length === 0) {
      cafesToSearch = [
        {
          cafeId: String(cafeId || ''),
          cafeUrl: cleanCafeUrl,
          cafeName: cleanCafeUrl || String(cafeId),
        },
      ];
    }
  }

  let articles = [];
  if (cafesToSearch.length > 0) {
    const batches = await Promise.all(
      cafesToSearch.slice(0, 12).map((c) => searchCafeArticlesFromServer(c, trimmedQuery, 12))
    );
    articles = batches.flat();
  } else {
    articles = await searchCafeArticlesFromServer({}, trimmedQuery, 20);
  }

  return updateNaverCafeState(
    {
      joinedCafes,
      articles,
      query: trimmedQuery,
      fetchedAt: new Date().toISOString(),
    },
    'server-search'
  );
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
  updateGmailState,
  fetchGmailFromBrowser,
  loadSavedJoinedCafes,
  addJoinedCafe,
  deleteJoinedCafe,
  updateNaverCafeState,
  fetchNaverCafeFromBrowser,
  searchJoinedNaverCafes,
  getPendingCafeTask,
  resolveCafeTaskResult,
};
