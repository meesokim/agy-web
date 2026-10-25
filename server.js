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
const MAX_SCROLLBACK_LENGTH = 4 * 1024 * 1024; // 4MB scrollback buffer per session (supports inline images)

const app = express();
app.use(express.json({ limit: '15mb' }));

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
app.use('/vendor/addon-image', express.static(path.join(__dirname, 'node_modules/@xterm/addon-image')));

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

  const extraPaths = [path.join(__dirname, 'bin')];

  if (process.platform === 'win32') {
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
  } else {
    const localBin = path.join(os.homedir(), '.local', 'bin');
    if (fs.existsSync(localBin)) {
      extraPaths.push(localBin);
    }
  }

  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = [...extraPaths, env[pathKey] || ''].join(path.delimiter);

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
const IMAGE_EXTENSIONS_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)(\?.*)?$/i;
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};
const recentImages = [];

function writeInlineImageToSession(session, { title, resolvedPath, url, b64, byteSize }) {
  if (!session || session.exited || !b64) return;
  const cols = session.cols || 140;
  const label = title || (resolvedPath ? path.basename(resolvedPath) : url || 'image');
  const oscImg = `\x1b]1337;File=inline=1;size=${byteSize || b64.length};height=14;preserveAspectRatio=1:${b64}\x07`;

  // Check if session scrollback ends with agy's 4-line "> " prompt box
  const tail = session.scrollback.slice(-1200);
  const isAgyPrompt = tail.includes('? for shortcuts') && tail.includes('\x1b[2A\x1b[2C');

  let seq;
  if (isAgyPrompt) {
    const border = '─'.repeat(Math.max(40, cols));
    seq =
      `\r\x1b[1A\x1b[J` +
      `\x1b[38;2;133;153;0m●\x1b[m \x1b[38;2;181;137;0;1mImage\x1b[m \x1b[38;2;238;232;213m${label}\x1b[m\r\n` +
      `  ${oscImg}\r\n\n` +
      `\x1b[38;2;7;54;66m${border}\x1b[m\r\n` +
      `\x1b[38;2;38;139;210m>\x1b[m\r\n` +
      `\x1b[38;2;7;54;66m${border}\x1b[m\r\n` +
      `\x1b[38;2;131;148;150m? for shortcuts\x1b[m\r\x1b[2A\x1b[2C\x1b[?25h`;
  } else {
    seq =
      `\r\x1b[K\x1b[38;2;133;153;0m●\x1b[m \x1b[38;2;181;137;0;1mImage\x1b[m \x1b[38;2;238;232;213m${label}\x1b[m\r\n` +
      `${oscImg}\r\n`;
  }

  session.scrollback += seq;
  if (session.scrollback.length > MAX_SCROLLBACK_LENGTH) {
    session.scrollback = session.scrollback.slice(session.scrollback.length - MAX_SCROLLBACK_LENGTH);
  }
  const raw = JSON.stringify({ type: 'output', data: seq });
  for (const ws of session.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}

function recordAndBroadcastImage({
  filePath = '',
  url = '',
  dataUrl = '',
  title = '',
  caption = '',
  sessionId = '',
}) {
  let resolvedPath = filePath;
  if (resolvedPath && resolvedPath.startsWith('file://')) {
    try {
      resolvedPath = decodeURIComponent(new URL(resolvedPath).pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(resolvedPath)) {
        resolvedPath = resolvedPath.slice(1).replace(/\//g, '\\');
      }
    } catch (_) {}
  }

  let src = url || dataUrl;
  let b64 = '';
  let byteSize = 0;

  if (resolvedPath && fs.existsSync(resolvedPath)) {
    if (!src) {
      src = `/api/local-image?path=${encodeURIComponent(resolvedPath)}&t=${Date.now()}`;
    }
    try {
      const buf = fs.readFileSync(resolvedPath);
      byteSize = buf.length;
      b64 = buf.toString('base64');
    } catch (_) {}
  } else if (dataUrl && dataUrl.includes(';base64,')) {
    b64 = dataUrl.split(';base64,')[1] || '';
    byteSize = Math.floor((b64.length * 3) / 4);
  }
  if (!src) return null;

  const entry = {
    id: `img-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    src,
    filePath: resolvedPath || '',
    url: url || '',
    title: title || (resolvedPath ? path.basename(resolvedPath) : url || '이미지'),
    caption: caption || '',
    createdAt: new Date().toISOString(),
  };

  recentImages.unshift(entry);
  if (recentImages.length > 50) {
    recentImages.length = 50;
  }

  const targetSession =
    (sessionId && sessions.get(sessionId)) ||
    sessions.get(PRIMARY_SESSION_ID) ||
    sessions.values().next().value;
  if (targetSession) {
    const inlineEntry = {
      id: entry.id,
      title: entry.title,
      html: `<img src="${entry.src}" alt="${entry.title || ''}" />`,
      kind: 'Image',
      rows: 14,
      sessionId: targetSession.id,
      createdAt: entry.createdAt,
    };
    writeInlineItemToSession(targetSession, inlineEntry);
  }

  broadcastToAllClients({ type: 'show_image', image: entry, renderedInline: true });
  return entry;
}

const recentHtmlOutputs = [];

function estimateHtmlRows(html) {
  if (!html || typeof html !== 'string') return 4;
  const trMatches = html.match(/<tr\b/gi);
  if (trMatches && trMatches.length > 0) {
    return Math.min(24, Math.max(4, trMatches.length * 2 + 1));
  }
  const imgMatches = html.match(/<img\b/gi);
  if (imgMatches && imgMatches.length > 0) {
    return 14;
  }
  const lineCount = (html.match(/<br\b|<p\b|<div\b|\n/gi) || []).length;
  return Math.min(20, Math.max(4, lineCount + 2));
}

function writeInlineItemToSession(session, entry) {
  if (!session || session.exited) return;
  const rowsNeeded = entry.rows || estimateHtmlRows(entry.html);
  entry.rows = rowsNeeded;

  if (!session.inlineItems) {
    session.inlineItems = new Map();
  }
  session.inlineItems.set(entry.id, entry);

  const oscSeq = `\x1b]7777;html;id=${entry.id};rows=${rowsNeeded}\x07`;
  const reservedLines = '\r\n'.repeat(rowsNeeded);
  const badge = `\r\n\x1b[38;2;133;153;0m●\x1b[m \x1b[38;2;38;139;210;1m${entry.kind || 'HTML'}\x1b[m \x1b[38;2;238;232;213m${entry.title || '출력'}\x1b[m\r\n`;

  const seq = badge + oscSeq + reservedLines;
  session.scrollback += seq;
  if (session.scrollback.length > MAX_SCROLLBACK_LENGTH) {
    session.scrollback = session.scrollback.slice(session.scrollback.length - MAX_SCROLLBACK_LENGTH);
  }

  const raw = JSON.stringify({ type: 'output', data: seq });
  for (const ws of session.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}

function rewriteLocalImagesInHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  return rawHtml.replace(
    /(<img\b[^>]*?\bsrc=["'])(?:file:\/\/)?(\/[^"']+|[A-Za-z]:\\[^"']+)(["'][^>]*>)/gi,
    (full, prefix, localPath, suffix) => {
      if (localPath.startsWith('/api/') || localPath.startsWith('/vendor/')) return full;
      return `${prefix}/api/local-image?path=${encodeURIComponent(localPath)}${suffix}`;
    }
  );
}

function recordAndBroadcastHtml({ html = '', filePath = '', title = '', sessionId = '' }) {
  let resolvedPath = filePath;
  if (resolvedPath && resolvedPath.startsWith('file://')) {
    try {
      resolvedPath = decodeURIComponent(new URL(resolvedPath).pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(resolvedPath)) {
        resolvedPath = resolvedPath.slice(1).replace(/\//g, '\\');
      }
    } catch (_) {}
  }

  let content = html;
  if (!content && resolvedPath && fs.existsSync(resolvedPath)) {
    try {
      content = fs.readFileSync(resolvedPath, 'utf8');
    } catch (_) {}
  }
  if (!content || !String(content).trim()) return null;

  const processedHtml = rewriteLocalImagesInHtml(String(content));
  const entry = {
    id: `html-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    title: title || (resolvedPath ? path.basename(resolvedPath) : 'HTML Output'),
    filePath: resolvedPath || '',
    html: processedHtml,
    kind: 'HTML',
    sessionId: sessionId || PRIMARY_SESSION_ID,
    createdAt: new Date().toISOString(),
  };

  recentHtmlOutputs.unshift(entry);
  if (recentHtmlOutputs.length > 30) {
    recentHtmlOutputs.length = 30;
  }

  const targetSession =
    (sessionId && sessions.get(sessionId)) ||
    sessions.get(PRIMARY_SESSION_ID) ||
    sessions.values().next().value;
  if (targetSession) {
    writeInlineItemToSession(targetSession, entry);
  }

  broadcastToAllClients({ type: 'show_html', item: entry });
  return entry;
}

/**
 * Open a URL or file:// resource by notifying connected browser clients and/or the host OS.
 */
function dispatchOpenUrl(rawTarget, targetSession = null) {
  const cleaned = sanitizeUrl(rawTarget);
  if (!cleaned) return false;

  const now = Date.now();
  const lastTime = recentOpenedUrls.get(cleaned) || 0;
  if (now - lastTime < 1500) {
    return true;
  }
  recentOpenedUrls.set(cleaned, now);

  // If it's a file:// URL or local path, check if it's an image first so we can display it directly inside agy-web
  if (
    cleaned.startsWith('file://') ||
    /^[A-Za-z]:\\/.test(cleaned) ||
    (process.platform !== 'win32' && cleaned.startsWith('/'))
  ) {
    let filePath = cleaned;
    if (filePath.startsWith('file://')) {
      try {
        filePath = decodeURIComponent(new URL(filePath).pathname);
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.slice(1).replace(/\//g, '\\');
        }
      } catch (_) {}
    }
    // Strip optional line/column suffixes if any
    const cleanFilePath = filePath.replace(/#L\d+.*$/, '');
    if (IMAGE_EXTENSIONS_RE.test(cleanFilePath) && fs.existsSync(cleanFilePath)) {
      recordAndBroadcastImage({
        filePath: cleanFilePath,
        title: path.basename(cleanFilePath),
      });
      return true;
    }

    if (process.platform === 'win32') {
      execFile('explorer.exe', [filePath], () => {});
    } else if (process.platform === 'darwin') {
      execFile('/usr/bin/open', [filePath], () => {});
    } else {
      execFile('/usr/bin/xdg-open', [filePath], () => {});
    }
    return true;
  }

  if (/^https?:\/\//i.test(cleaned)) {
    if (IMAGE_EXTENSIONS_RE.test(cleaned)) {
      recordAndBroadcastImage({
        url: cleaned,
        title: path.basename(new URL(cleaned).pathname) || cleaned,
      });
      return true;
    }
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
      if (!sentToBrowser) {
        if (process.platform === 'win32') {
          execFile('cmd.exe', ['/c', 'start', '', cleaned], { windowsHide: true }, () => {});
        } else if (process.platform === 'darwin') {
          execFile('/usr/bin/open', [cleaned], () => {});
        } else {
          execFile('/usr/bin/xdg-open', [cleaned], () => {});
        }
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
const INPUT_HISTORY_FILE = path.join(__dirname, 'input-history.json');
const MAX_INPUT_HISTORY = 500;

function loadInputHistory() {
  try {
    if (!fs.existsSync(INPUT_HISTORY_FILE)) return [];
    const raw = fs.readFileSync(INPUT_HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveInputHistory(list) {
  try {
    fs.writeFileSync(
      INPUT_HISTORY_FILE,
      JSON.stringify(list.slice(0, MAX_INPUT_HISTORY), null, 2),
      'utf8'
    );
  } catch (_) {}
}

let inputHistoryList = loadInputHistory();

function broadcastToAllClients(payload) {
  const raw = JSON.stringify(payload);
  for (const s of sessions.values()) {
    for (const client of s.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }
}

function recordInputHistoryEntry({ sessionId, sessionTitle, cwd, text, source = 'terminal' }) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return null;

  const entry = {
    id: `hist-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    sessionId: sessionId || PRIMARY_SESSION_ID,
    sessionTitle: sessionTitle || '콘솔',
    cwd: cwd || os.homedir(),
    text: cleaned,
    source,
    createdAt: new Date().toISOString(),
  };

  inputHistoryList.unshift(entry);
  if (inputHistoryList.length > MAX_INPUT_HISTORY) {
    inputHistoryList.length = MAX_INPUT_HISTORY;
  }
  saveInputHistory(inputHistoryList);
  broadcastToAllClients({ type: 'input_logged', entry });
  return entry;
}

/**
 * Parse raw terminal input stream for a session and log completed lines on Enter (\r or \n).
 */
function processSessionInputForHistory(session, rawData) {
  if (!rawData || typeof rawData !== 'string') return;
  if (typeof session.inputLineBuffer !== 'string') {
    session.inputLineBuffer = '';
  }

  // Strip ANSI escape sequences (arrow keys, function keys, bracketed paste markers, mouse reporting)
  const stripped = rawData
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .replace(/\x1b\[[0-9;<=>?]*[ -/]*[@-~]/g, '')
    .replace(/\x1bO[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');

  for (const ch of stripped) {
    if (ch === '\r' || ch === '\n') {
      const committed = session.inputLineBuffer.trim();
      session.inputLineBuffer = '';
      if (committed.length > 0) {
        recordInputHistoryEntry({
          sessionId: session.id,
          sessionTitle: session.title,
          cwd: session.cwd,
          text: committed,
          source: 'web-terminal',
        });
      }
    } else if (ch === '\x7f' || ch === '\b') {
      const chars = Array.from(session.inputLineBuffer);
      chars.pop();
      session.inputLineBuffer = chars.join('');
    } else if (ch === '\x03' || ch === '\x15' || ch === '\x1b') {
      session.inputLineBuffer = '';
    } else if (ch.charCodeAt(0) >= 32 || ch === '\t') {
      session.inputLineBuffer += ch;
      if (session.inputLineBuffer.length > 4000) {
        session.inputLineBuffer = session.inputLineBuffer.slice(-4000);
      }
    }
  }
}

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
    useConpty: process.platform === 'win32',
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
    compactLogs: true,
  };

  const compactAgyProgress = (raw) => {
    if (!session.compactLogs || !raw) return raw;
    return raw
      .replace(/ \x1b\[38;2;147;161;161m\([^)\r\n]*\)(?:\x1b\[m)?/g, '')
      .replace(/(\x1b\[\?7[hl])\x1b\[\d+G/g, '$1\x1b[K');
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

  ptyProcess.onData((rawData) => {
    let processed = rawData;
    // Intercept inline HTML escape sequence: \x1b]7777;html;<base64>\x07
    if (processed.includes('\x1b]7777;html;')) {
      processed = processed.replace(
        /\x1b\]7777;html;([A-Za-z0-9+/=\s]+?)\x07/g,
        (_, b64) => {
          try {
            const decodedHtml = Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8');
            if (decodedHtml) {
              recordAndBroadcastHtml({
                html: decodedHtml,
                title: 'Inline HTML',
                sessionId: session.id,
              });
            }
          } catch (_) {}
          return '';
        }
      );
    }

    const data = compactAgyProgress(processed);
    appendScrollback(data);
    broadcast({ type: 'output', data });

    // Trigger `agy` automatically once the initial shell stream starts
    if (session.autoRunAgy && !session.agyTriggered) {
      session.agyTriggered = true;
      setTimeout(() => {
        if (!session.exited) {
          // Clear shell startup text and launch agy with --effort low for minimal progress logs
          session.scrollback = '';
          const cmd =
            process.platform === 'win32'
              ? continueConversation
                ? 'cls; agy --effort low -c; if (-not $?) { agy --effort low }\r'
                : 'cls; agy --effort low\r'
              : continueConversation
                ? 'clear; agy --effort low -c || agy --effort low\r'
                : 'clear; agy --effort low\r';
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

// REST API: Serve local image file safely for inline viewer in agy-web
app.get('/api/local-image', (req, res) => {
  const rawPath = String(req.query.path || '');
  if (!rawPath) {
    return res.status(400).send('Missing path');
  }
  const resolved = path.resolve(rawPath);
  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return res.status(400).send('Unsupported image extension');
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).send('Image not found');
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(resolved).pipe(res);
});

// REST API: Show image directly in agy-web viewer & gallery
app.post('/api/show-image', (req, res) => {
  const { path: filePath, url, dataUrl, title, caption } = req.body || {};
  const entry = recordAndBroadcastImage({ filePath, url, dataUrl, title, caption });
  if (!entry) {
    return res.status(400).json({ error: '유효한 이미지 파일 경로 또는 URL을 지정해 주세요.' });
  }
  res.json({ ok: true, image: entry });
});

app.get('/api/images', (req, res) => {
  res.json({ images: recentImages });
});

app.delete('/api/images', (req, res) => {
  recentImages.length = 0;
  res.json({ ok: true });
});

// REST API: Render HTML directly inside the web console screen
app.post('/api/show-html', (req, res) => {
  const { html, path: filePath, title, sessionId } = req.body || {};
  const entry = recordAndBroadcastHtml({ html, filePath, title, sessionId });
  if (!entry) {
    return res.status(400).json({ error: '출력할 HTML 내용(html) 또는 파일 경로(path)가 필요합니다.' });
  }
  res.json({ ok: true, item: entry });
});

app.get('/api/html-outputs', (req, res) => {
  res.json({ items: recentHtmlOutputs });
});

app.delete('/api/html-outputs', (req, res) => {
  recentHtmlOutputs.length = 0;
  broadcastToAllClients({ type: 'clear_html' });
  res.json({ ok: true });
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

// REST API: Joined Naver Cafe & Article Search
app.get('/api/naver-cafe', async (req, res) => {
  try {
    const state = await browserBridge.fetchNaverCafeFromBrowser();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message || '네이버 카페 조회 실패' });
  }
});

app.post('/api/naver-cafe/sync', (req, res) => {
  const state = browserBridge.updateNaverCafeState(req.body || {}, 'extension/bookmarklet');
  res.json({
    ok: true,
    cafeCount: (state.joinedCafes || []).length,
    articleCount: (state.articles || []).length,
  });
});

app.post('/api/naver-cafe/search', async (req, res) => {
  try {
    const { query, cafeId, cafeUrl } = req.body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: '검색어를 입력해 주세요.' });
    }
    const state = await browserBridge.searchJoinedNaverCafes({ query, cafeId, cafeUrl });
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message || '가입 카페 글 검색 실패' });
  }
});

app.post('/api/naver-cafe/cafes', (req, res) => {
  const { cafeUrl, cafeName, cafeId } = req.body || {};
  const added = browserBridge.addJoinedCafe({ cafeUrl, cafeName, cafeId });
  if (!added) {
    return res.status(400).json({ error: '유효한 네이버 카페 주소 또는 ID를 입력해 주세요.' });
  }
  res.status(201).json({ cafe: added, joinedCafes: browserBridge.loadSavedJoinedCafes() });
});

app.delete('/api/naver-cafe/cafes/:key', (req, res) => {
  const ok = browserBridge.deleteJoinedCafe(req.params.key);
  res.json({ ok, joinedCafes: browserBridge.loadSavedJoinedCafes() });
});

app.get('/api/naver-cafe/pending-task', (req, res) => {
  res.json({ task: browserBridge.getPendingCafeTask() });
});

app.post('/api/naver-cafe/task-result', (req, res) => {
  browserBridge.resolveCafeTaskResult(req.body || {});
  res.json({ ok: true });
});

// REST API: Web Input History Log
app.get('/api/input-history', (req, res) => {
  const { sessionId, q } = req.query || {};
  let list = inputHistoryList;
  if (sessionId) {
    list = list.filter((item) => item.sessionId === sessionId);
  }
  if (q && String(q).trim()) {
    const kw = String(q).trim().toLowerCase();
    list = list.filter(
      (item) =>
        (item.text && item.text.toLowerCase().includes(kw)) ||
        (item.sessionTitle && item.sessionTitle.toLowerCase().includes(kw))
    );
  }
  res.json({ history: list });
});

app.post('/api/input-history', (req, res) => {
  const { sessionId, text, source } = req.body || {};
  const session = sessionId ? sessions.get(sessionId) : null;
  const entry = recordInputHistoryEntry({
    sessionId: session?.id || sessionId || PRIMARY_SESSION_ID,
    sessionTitle: session?.title || '콘솔',
    cwd: session?.cwd || os.homedir(),
    text,
    source: source || 'web-action',
  });
  if (!entry) {
    return res.status(400).json({ error: '기록할 입력 내용이 없습니다.' });
  }
  res.status(201).json({ entry });
});

app.delete('/api/input-history', (req, res) => {
  inputHistoryList = [];
  saveInputHistory(inputHistoryList);
  res.json({ ok: true });
});

app.delete('/api/input-history/:id', (req, res) => {
  const prevLen = inputHistoryList.length;
  inputHistoryList = inputHistoryList.filter((item) => item.id !== req.params.id);
  if (inputHistoryList.length !== prevLen) {
    saveInputHistory(inputHistoryList);
  }
  res.json({ ok: inputHistoryList.length !== prevLen });
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

// REST API: Send a message or command directly to an agy-web console session
function handleSendToSession(req, res) {
  const targetId = req.params.id || req.body?.sessionId || PRIMARY_SESSION_ID;
  if (sessions.size === 0) {
    ensurePrimarySession();
  }
  const session = sessions.get(targetId) || sessions.values().next().value;
  if (!session || session.exited) {
    return res.status(404).json({ error: '활성 콘솔 세션을 찾을 수 없습니다.' });
  }

  const { text, message, submit = true, mode = 'input' } = req.body || {};
  const content = String(text ?? message ?? '');
  if (!content) {
    return res.status(400).json({ error: '전송할 메시지(text)가 필요합니다.' });
  }

  if (mode === 'notice') {
    const banner = `\r\n\x1b[36m💬 [외부 메시지] ${content}\x1b[0m\r\n`;
    session.scrollback += banner;
    const raw = JSON.stringify({ type: 'output', data: banner });
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
    return res.json({ ok: true, sessionId: session.id, mode: 'notice' });
  }

  const payloadStr = submit ? `${content}\r` : content;
  processSessionInputForHistory(session, payloadStr);
  session.ptyProcess.write(payloadStr);
  return res.json({ ok: true, sessionId: session.id, submitted: Boolean(submit) });
}

app.post('/api/send', handleSendToSession);
app.post('/api/sessions/:id/send', handleSendToSession);

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
      inlineItems: session.inlineItems ? Array.from(session.inlineItems.values()) : [],
    })
  );

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        if (!session.exited && typeof msg.data === 'string') {
          processSessionInputForHistory(session, msg.data);
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
          // Strip ANSI sequences from the tail of scrollback to detect whether we are at a shell prompt or inside agy TUI
          const tailPlain = session.scrollback
            .slice(-1000)
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
            .trimEnd();
          const isPowerShellPrompt = /PS [A-Za-z]:\\[^>]*>$/.test(tailPlain);
          const isPosixShellPrompt =
            process.platform !== 'win32' &&
            /[$#%]\s*$/.test(tailPlain) &&
            !tailPlain.includes('Antigravity CLI') &&
            !tailPlain.includes('? for shortcuts');

          const wipeScreenAndScrollback = () => {
            session.scrollback = '';
            const payload = JSON.stringify({ type: 'output', data: '\x1b[2J\x1b[3J\x1b[H' });
            const clearHtmlPayload = JSON.stringify({ type: 'clear_html', sessionId: session.id });
            for (const client of session.clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
                client.send(clearHtmlPayload);
              }
            }
          };

          if (isPowerShellPrompt) {
            // In PowerShell: clear current input line (Esc), wipe scrollback/screen, and run cls
            wipeScreenAndScrollback();
            session.ptyProcess.write('\x1bcls\r');
          } else if (isPosixShellPrompt) {
            // In bash/zsh: clear current input line (Ctrl+U), wipe scrollback/screen, and run clear
            wipeScreenAndScrollback();
            session.ptyProcess.write('\x15clear\r');
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
  console.log(`🚀 AGY Web Console: http://${HOST}:${PORT}`);
  ensurePrimarySession();
});
