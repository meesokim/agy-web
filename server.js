const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');
const crypto = require('crypto');
const { execFile } = require('child_process');
const browserBridge = require('./browser-bridge');

const PORT = parseInt(process.env.PORT || '3080', 10);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_SCROLLBACK_LENGTH = 250 * 1024; // 250KB scrollback buffer per session

const app = express();
app.use(express.json({ limit: '5mb' }));

// Allow CORS from Naver Mail bookmarklet / Chrome extension to push mail & tab state to localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Serve xterm assets from node_modules for offline reliability
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use('/vendor/addon-unicode11', express.static(path.join(__dirname, 'node_modules/@xterm/addon-unicode11')));

/**
 * Resolve the preferred PowerShell executable on Windows.
 */
function resolveShell() {
  if (process.platform !== 'win32') {
    return process.env.SHELL || '/bin/bash';
  }
  // Prefer PowerShell 7 (pwsh.exe) if installed, otherwise Windows PowerShell (powershell.exe)
  const pwshPaths = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ];
  for (const p of pwshPaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return 'powershell.exe';
}

/**
 * Build environment variables for the PTY session.
 * Prioritizes local `./bin` shims (Start-Process, open, xdg-open) and Git Bash over WSL WindowsApps stub.
 */
function buildSessionEnv() {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    AGY_WEB_CONSOLE: '1',
    PORT: String(PORT),
  };

  if (process.platform === 'win32') {
    const extraPaths = [path.join(__dirname, 'bin')];
    const gitCandidates = [
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\usr\\bin',
      'C:\\Program Files (x86)\\Git\\bin',
    ];
    for (const gp of gitCandidates) {
      if (fs.existsSync(gp)) {
        extraPaths.push(gp);
      }
    }
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = [...extraPaths, env[pathKey] || ''].join(path.delimiter);
  }

  return env;
}

/**
 * Clean a matched URL string (strip trailing Korean particles or unmatched closing parens).
 */
function sanitizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let url = raw.trim().replace(/[\u3131-\u318E\uAC00-\uD7A3]+.*$/, '');
  while (/[).,;!'"]$/.test(url)) {
    if (url.endsWith(')') && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) {
      break;
    }
    url = url.slice(0, -1);
  }
  return url;
}

const recentOpenedUrls = new Map();

/**
 * Open a URL or file:// resource by notifying connected browser clients and/or the host OS.
 */
function dispatchOpenUrl(rawTarget, targetSession = null) {
  const cleaned = sanitizeUrl(rawTarget);
  if (!cleaned) return false;

  const now = Date.now();
  const lastTime = recentOpenedUrls.get(cleaned) || 0;
  if (now - lastTime < 3000) {
    return true;
  }
  recentOpenedUrls.set(cleaned, now);

  // If it's a file:// URL or Windows local path, open via explorer.exe on host
  if (cleaned.startsWith('file://') || /^[A-Za-z]:\\/.test(cleaned)) {
    let filePath = cleaned;
    if (filePath.startsWith('file://')) {
      try {
        filePath = decodeURIComponent(new URL(filePath).pathname);
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.slice(1).replace(/\//g, '\\');
        }
      } catch (_) {}
    }
    if (process.platform === 'win32') {
      execFile('explorer.exe', [filePath], () => {});
    }
    return true;
  }

  if (/^https?:\/\//i.test(cleaned)) {
    browserBridge.recordOpenedTab(cleaned);
    browserBridge.focusExistingCdpTab(cleaned).then((focused) => {
      if (focused) return;
      const payload = JSON.stringify({ type: 'open_url', url: cleaned });
      const targetSessions = targetSession ? [targetSession] : Array.from(sessions.values());
      let sentToBrowser = false;
      for (const s of targetSessions) {
        for (const ws of s.clients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
            sentToBrowser = true;
          }
        }
      }
      if (!sentToBrowser && process.platform === 'win32') {
        execFile('cmd.exe', ['/c', 'start', '', cleaned], { windowsHide: true }, () => {});
      }
    });
    return true;
  }

  return false;
}

/**
 * In-memory session store
 * Map<sessionId, Session>
 */
const sessions = new Map();
let sessionCounter = 1;
let isShuttingDown = false;
const PRIMARY_SESSION_ID = 'session-primary';
const CONTINUITY_FILE = path.join(__dirname, '.session-continuity.json');

function hasPreviousContinuity() {
  try {
    return fs.existsSync(CONTINUITY_FILE);
  } catch (_) {
    return false;
  }
}

function markContinuityActive() {
  try {
    fs.writeFileSync(
      CONTINUITY_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString() }),
      'utf8'
    );
  } catch (_) {}
}

function createSession({
  id: customId,
  cwd,
  title,
  cols = 140,
  rows = 38,
  autoRunAgy = true,
  isPrimary = false,
  continueConversation = false,
} = {}) {
  const id =
    customId || `session-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const sessionNumber = sessionCounter++;
  const sessionTitle = title || (isPrimary ? '상시 콘솔 #1' : `콘솔 #${sessionNumber}`);
  const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const shell = resolveShell();
  const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-ExecutionPolicy', 'Bypass'] : [];

  const env = buildSessionEnv();

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: Math.max(20, Math.min(500, Number(cols) || 140)),
    rows: Math.max(5, Math.min(200, Number(rows) || 38)),
    cwd: resolvedCwd,
    env,
    useConpty: true,
  });

  const session = {
    id,
    title: sessionTitle,
    cwd: resolvedCwd,
    shell: path.basename(shell),
    pid: ptyProcess.pid,
    createdAt: new Date().toISOString(),
    cols: Number(cols) || 140,
    rows: Number(rows) || 38,
    autoRunAgy: Boolean(autoRunAgy),
    isPrimary: Boolean(isPrimary),
    exited: false,
    exitCode: null,
    scrollback: '',
    ptyProcess,
    clients: new Set(),
    agyTriggered: false,
    agyBootCleaned: false,
  };

  const appendScrollback = (data) => {
    // Strip terminal capability queries so replaying scrollback never causes xterm.js to send synthetic replies into agy
    let cleanedData = data
      .replace(/\x1b\]7501;\?\x07/g, '')
      .replace(/\x1b\[\?u/g, '')
      .replace(/\x1b\[>[0-9;]*[mu]/g, '')
      .replace(/\x1b\[<[0-9;]*u/g, '')
      .replace(/\x1b\[6n/g, '');

    // If agy just exited the temporary "Signing in..." alternate screen buffer (\x1b[?1049l),
    // discard everything prior to it so only the live main TUI screen is kept.
    const altExitIdx = cleanedData.lastIndexOf('\x1b[?1049l');
    if (altExitIdx !== -1) {
      session.agyBootCleaned = true;
      session.scrollback = cleanedData.slice(altExitIdx + '\x1b[?1049l'.length);
      markContinuityActive();
      return;
    }

    // Strip initial PowerShell boot prompt once agy TUI starts drawing
    if (session.autoRunAgy && session.agyTriggered && !session.agyBootCleaned) {
      if (cleanedData.includes('Antigravity CLI') || cleanedData.includes('? for shortcuts')) {
        session.agyBootCleaned = true;
        session.scrollback = '\x1b[2J\x1b[H' + cleanedData;
        markContinuityActive();
        return;
      }
    }

    // If the terminal stream contains Erase Scrollback (\x1b[3J) or Full Reset (\x1bc),
    // discard previous scrollback so old content never reappears on reconnect.
    const clearIdx = Math.max(cleanedData.lastIndexOf('\x1b[3J'), cleanedData.lastIndexOf('\x1bc'));
    if (clearIdx !== -1) {
      session.scrollback = cleanedData.slice(clearIdx);
      return;
    }
    session.scrollback += cleanedData;
    if (session.scrollback.length > MAX_SCROLLBACK_LENGTH) {
      session.scrollback = session.scrollback.slice(session.scrollback.length - MAX_SCROLLBACK_LENGTH);
    }
  };

  const broadcast = (payload) => {
    const raw = JSON.stringify(payload);
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  };

  ptyProcess.onData((data) => {
    appendScrollback(data);
    broadcast({ type: 'output', data });

    // Trigger `agy` automatically once the initial PowerShell stream starts
    if (session.autoRunAgy && !session.agyTriggered) {
      session.agyTriggered = true;
      setTimeout(() => {
        if (!session.exited) {
          // Clear PowerShell startup text and launch agy (with -c if resuming warm primary session)
          session.scrollback = '';
          const cmd = continueConversation
            ? 'cls; agy -c; if (-not $?) { agy }\r'
            : 'cls; agy\r';
          ptyProcess.write(cmd);
        }
      }, 250);
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode;
    const exitBanner = `\r\n\x1b[33m[콘솔 프로세스가 종료되었습니다 (코드: ${exitCode}${signal ? `, 시그널: ${signal}` : ''})]\x1b[0m\r\n`;
    appendScrollback(exitBanner);
    broadcast({ type: 'exit', exitCode, signal });

    // If the primary always-on session exited unexpectedly and server is still running, respawn it automatically
    if (session.isPrimary && !isShuttingDown) {
      setTimeout(() => {
        if (!isShuttingDown && (!sessions.has(PRIMARY_SESSION_ID) || sessions.get(PRIMARY_SESSION_ID).exited)) {
          sessions.delete(PRIMARY_SESSION_ID);
          ensurePrimarySession();
        }
      }, 1000);
    }
  });

  sessions.set(id, session);
  return session;
}

/**
 * Ensure the always-on primary session is running in the background.
 */
function ensurePrimarySession() {
  const existing = sessions.get(PRIMARY_SESSION_ID);
  if (existing && !existing.exited) {
    return existing;
  }
  const shouldContinue = hasPreviousContinuity();
  console.log(
    `[Always-On] Spawning background primary session (${PRIMARY_SESSION_ID}, continue=${shouldContinue})...`
  );
  return createSession({
    id: PRIMARY_SESSION_ID,
    title: '상시 콘솔 #1',
    cwd: os.homedir(),
    autoRunAgy: true,
    isPrimary: true,
    continueConversation: shouldContinue,
  });
}

function serializeSession(session) {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    shell: session.shell,
    pid: session.pid,
    createdAt: session.createdAt,
    cols: session.cols,
    rows: session.rows,
    isPrimary: Boolean(session.isPrimary),
    exited: session.exited,
    exitCode: session.exitCode,
    clientCount: session.clients.size,
  };
}

// REST API: Open URL or local file resource
app.post('/api/open-url', (req, res) => {
  const { url, sessionId } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '유효한 URL이 필요합니다.' });
  }
  const session = sessionId ? sessions.get(sessionId) : null;
  const ok = dispatchOpenUrl(url, session);
  res.json({ ok });
});

// REST API: Internal Bookmarks CRUD
app.get('/api/bookmarks', (req, res) => {
  res.json({ bookmarks: browserBridge.loadInternalBookmarks() });
});

app.post('/api/bookmarks', (req, res) => {
  const { title, url, category } = req.body || {};
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'URL을 입력해 주세요.' });
  }
  const item = browserBridge.addInternalBookmark({ title, url, category });
  res.status(201).json({ bookmark: item });
});

app.patch('/api/bookmarks/:id', (req, res) => {
  const updated = browserBridge.updateInternalBookmark(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ error: '북마크를 찾을 수 없습니다.' });
  }
  res.json({ bookmark: updated });
});

app.delete('/api/bookmarks/:id', (req, res) => {
  const ok = browserBridge.deleteInternalBookmark(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: '북마크를 찾을 수 없습니다.' });
  }
  res.json({ ok: true });
});

// REST API: Read installed browser bookmarks (Chrome, Edge, Whale, Brave)
app.get('/api/browser/bookmarks', (req, res) => {
  res.json({ browsers: browserBridge.readLocalBrowserBookmarks() });
});

// REST API: Inspect open browser windows & tabs (CDP + Windows Processes + Chromium Session files)
app.get('/api/browser/tabs', async (req, res) => {
  try {
    const info = await browserBridge.inspectOpenBrowserTabs();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message || '브라우저 탭 조회 실패' });
  }
});

// REST API: Launch CDP-enabled browser for 100% live tab inspection
app.post('/api/browser/launch-cdp', (req, res) => {
  try {
    const { browser = 'chrome' } = req.body || {};
    const result = browserBridge.launchCdpBrowser(browser);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST API: Receive live tabs from Chrome/Edge extension
app.post('/api/browser/extension-tabs', (req, res) => {
  const { tabs } = req.body || {};
  browserBridge.updateExtensionTabs(tabs);
  res.json({ ok: true });
});

// REST API: Receive Naver Mail data from Extension or Bookmarklet
app.post('/api/naver-mail/sync', (req, res) => {
  const state = browserBridge.updateNaverMailState(req.body || {}, 'extension/bookmarklet');
  res.json({ ok: true, count: (state.mails || []).length });
});

// REST API: Fetch Naver Mail list & open mail body (via CDP or synced state)
app.get('/api/naver-mail', async (req, res) => {
  try {
    const readUrl = req.query.readUrl || null;
    const state = await browserBridge.fetchNaverMailFromBrowser({ readUrl });
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message || '네이버 메일 조회 실패' });
  }
});

// REST API: Get all sessions (always guarantees at least the warm primary session)
app.get('/api/sessions', (req, res) => {
  if (sessions.size === 0) {
    ensurePrimarySession();
  }
  const list = Array.from(sessions.values()).map(serializeSession);
  res.json({
    defaultCwd: os.homedir(),
    sessions: list,
  });
});

// REST API: Create new session
app.post('/api/sessions', (req, res) => {
  try {
    const { cwd, title, cols, rows, autoRunAgy = true } = req.body || {};
    if (cwd && !fs.existsSync(cwd)) {
      return res.status(400).json({ error: `지정한 경로가 존재하지 않습니다: ${cwd}` });
    }
    const session = createSession({ cwd, title, cols, rows, autoRunAgy });
    res.status(201).json({ session: serializeSession(session) });
  } catch (err) {
    console.error('Failed to create PTY session:', err);
    res.status(500).json({ error: err.message || '콘솔 세션 생성에 실패했습니다.' });
  }
});

// REST API: Rename session
app.patch('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  }
  const { title } = req.body || {};
  if (typeof title === 'string' && title.trim()) {
    session.title = title.trim();
  }
  res.json({ session: serializeSession(session) });
});

// REST API: Delete / terminate session
app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  }
  try {
    if (!session.exited) {
      session.ptyProcess.kill();
    }
  } catch (err) {
    console.warn(`Error killing PTY for ${session.id}:`, err);
  }
  for (const ws of session.clients) {
    try {
      ws.close(1000, 'Session closed');
    } catch (_) {}
  }
  sessions.delete(session.id);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const sessionId = url.searchParams.get('sessionId');
  const session = sessions.get(sessionId);

  if (!session) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: '요청한 콘솔 세션을 찾을 수 없습니다.',
      })
    );
    ws.close(1008, 'Session not found');
    return;
  }

  session.clients.add(ws);

  // Send metadata and scrollback buffer so browser refresh preserves full state
  ws.send(
    JSON.stringify({
      type: 'init',
      session: serializeSession(session),
      scrollback: session.scrollback,
    })
  );

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        if (!session.exited && typeof msg.data === 'string') {
          session.ptyProcess.write(msg.data);
        }
      } else if (msg.type === 'resize') {
        const cols = Math.max(20, Math.min(500, Number(msg.cols) || session.cols));
        const rows = Math.max(5, Math.min(200, Number(msg.rows) || session.rows));
        if (!session.exited && (cols !== session.cols || rows !== session.rows)) {
          session.cols = cols;
          session.rows = rows;
          session.ptyProcess.resize(cols, rows);
        }
      } else if (msg.type === 'clear') {
        if (!session.exited) {
          // Strip ANSI sequences from the tail of scrollback to detect whether we are at PowerShell prompt or inside agy TUI
          const tailPlain = session.scrollback
            .slice(-1000)
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
            .trimEnd();
          const isPowerShellPrompt = /PS [A-Za-z]:\\[^>]*>$/.test(tailPlain);

          const wipeScreenAndScrollback = () => {
            session.scrollback = '';
            const payload = JSON.stringify({ type: 'output', data: '\x1b[2J\x1b[3J\x1b[H' });
            for (const client of session.clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
              }
            }
          };

          if (isPowerShellPrompt) {
            // In PowerShell: clear current input line (Esc), wipe scrollback/screen, and run cls
            wipeScreenAndScrollback();
            session.ptyProcess.write('\x1bcls\r');
          } else {
            // Inside agy TUI: send Ctrl+U as a separate packet, then /clear, then Enter
            session.ptyProcess.write('\x15');
            setTimeout(() => {
              if (!session.exited) {
                session.ptyProcess.write('/clear');
              }
            }, 40);
            setTimeout(() => {
              if (!session.exited) {
                wipeScreenAndScrollback();
                session.ptyProcess.write('\r');
              }
            }, 100);
          }
        }
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
  });
});

// Clean up PTY processes on server shutdown
function cleanupAndExit() {
  isShuttingDown = true;
  for (const session of sessions.values()) {
    try {
      if (!session.exited) {
        session.ptyProcess.kill();
      }
    } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

server.listen(PORT, HOST, () => {
  console.log(`\n========================================================`);
  console.log(` 🚀 AGY Web Console Server is running!`);
  console.log(` 🔗 URL: http://${HOST}:${PORT}`);
  console.log(` 🖥️  Pipeline: Browser (xterm.js) <-> WebSocket <-> ConPTY (PowerShell -> agy)`);
  console.log(`========================================================\n`);
  // Immediately pre-warm the always-on primary PowerShell + agy session on server startup
  ensurePrimarySession();
});
