const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');
const crypto = require('crypto');
const { execFile, execSync } = require('child_process');
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

/**
 * Compact and clean terminal scrollback buffer:
 * - Removes intermediate/stale prompt boxes (e.g. "esc to cancel") that accumulated during streaming
 * - Resolves cursor-up rewrites (\r\x1b[<N>A) so overwritten lines do not stack redundantly
 * - Collapses consecutive/stacked horizontal divider lines (─, ━, ═, -) into a single clean border
 */
function compactTerminalBuffer(input) {
  if (!input || typeof input !== 'string') return '';
  // 1. Remove intermediate/stale prompt boxes with 'esc to cancel'
  const stalePromptRe = /(?:\r?\n)?(?:\x1b\[[0-9;?]*[a-zA-Z])*[─━═-]{10,}(?:\x1b\[[0-9;?]*[a-zA-Z])*\r?\n(?:\x1b\[[0-9;?]*[a-zA-Z])*>[\s\S]*?(?:\x1b\[[0-9;?]*[a-zA-Z])*[─━═-]{10,}(?:\x1b\[[0-9;?]*[a-zA-Z])*\r?\n(?:\x1b\[[0-9;?]*[a-zA-Z])*esc to cancel[^\r\n]*(?:\r?\n)?/g;
  let text = input.replace(stalePromptRe, '');

  // 2. Process cursor-up rewrites (\r\x1b[(\d+)A) when text contains ANSI rewrites
  if (text.length > 2000 && text.includes('\x1b[')) {
    const regex = /\r\x1b\[(\d+)A(?:\x1b\[[0-9;?]*[a-zA-Z])*/g;
    let lastIndex = 0;
    let buffer = '';
    let m;
    let matched = false;

    while ((m = regex.exec(text)) !== null) {
      matched = true;
      buffer += text.slice(lastIndex, m.index);
      const upCount = parseInt(m[1], 10);
      if (upCount > 0 && upCount <= 60) {
        let lines = buffer.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        const removeLines = Math.min(upCount, lines.length);
        lines = lines.slice(0, lines.length - removeLines);
        buffer = lines.length > 0 ? lines.join('\n') + '\n' : '';
      }
      lastIndex = regex.lastIndex;
    }
    if (matched) {
      buffer += text.slice(lastIndex);
      text = buffer;
    }
  }

  // 3. Collapse stacked / consecutive horizontal divider lines
  const borderPattern = '(?:(?:\\x1b\\[[0-9;?]*[a-zA-Z])*[─━═-]{6,}(?:\\x1b\\[[0-9;?]*[a-zA-Z])*\\s*[\\r\\n]+)';
  const stackedBordersRe = new RegExp('(' + borderPattern + ')(?:\\s*[\\r\\n]*' + borderPattern + ')+', 'g');
  text = text.replace(stackedBordersRe, '$1');

  // 4. Collapse excessive blank lines surrounding horizontal divider lines
  text = text.replace(/(?:[\r\n]{3,})((?:\x1b\[[0-9;?]*[a-zA-Z])*[─━═-]{6,})/g, '\r\n\r\n$1');
  text = text.replace(/((?:\x1b\[[0-9;?]*[a-zA-Z])*[─━═-]{6,})(?:[\r\n]{3,})/g, '$1\r\n\r\n');

  return text;
}

function writeInlineImageToSession(session, { title, resolvedPath, url, b64, byteSize }) {
  if (!session || session.exited || !b64) return;
  const cols = session.cols || 140;
  const label = title || (resolvedPath ? path.basename(resolvedPath) : url || 'image');
  const oscImg = `\x1b]1337;File=inline=1;size=${byteSize || b64.length};height=14;preserveAspectRatio=1:${b64}\x07`;

  // Write image line cleanly without creating unnecessary redundant synthetic border boxes
  const tail = session.scrollback.slice(-1200);
  const isAgyPrompt = tail.includes('? for shortcuts') && tail.includes('\x1b[2A\x1b[2C');

  let seq;
  if (isAgyPrompt) {
    seq =
      `\r\x1b[1A\x1b[J` +
      `\x1b[38;2;133;153;0m●\x1b[m \x1b[38;2;181;137;0;1mImage\x1b[m \x1b[38;2;238;232;213m${label}\x1b[m\r\n` +
      `  ${oscImg}\r\n`;
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

function checkAndAutoApprovePrompt(session, plainChunk) {
  if (!session || session.exited || session.autoApprove === false) return;
  const now = Date.now();
  if (now - (session.lastAutoApproveTime || 0) < 300) {
    return;
  }

  // Extract recent tail from scrollback and current chunk (up to 1500 chars to cover multiline menu options)
  const tailBuffer = (
    session.scrollback.slice(-1500).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') +
    ' ' +
    plainChunk
  ).slice(-1500);

  let responseInput = null;
  let matchedStr = '';
  let inputLabel = '';
  let promptSig = '';

  // 1. AGY / Ink Interactive Selection Menu (e.g. "Run this command? > 1. Yes, run command", "Apply these changes? > 1. Yes")
  const hasMenuFooter =
    tailBuffer.includes('esc to cancel') ||
    tailBuffer.includes('Navigate') ||
    tailBuffer.includes('No, cancel') ||
    tailBuffer.includes('ctrl+g') ||
    tailBuffer.includes('tab Amend');
  const hasOptionOne =
    tailBuffer.includes('> 1.') ||
    tailBuffer.includes('1. Yes') ||
    tailBuffer.includes('1. 허용') ||
    tailBuffer.includes('1. 실행');
  const hasPermissionContext =
    tailBuffer.includes('Run this command?') ||
    tailBuffer.includes('Requesting permission') ||
    tailBuffer.includes('Apply these changes?') ||
    tailBuffer.includes('Allow ') ||
    tailBuffer.includes('permission') ||
    tailBuffer.includes('tool') ||
    tailBuffer.includes('changes?') ||
    tailBuffer.includes('file?') ||
    tailBuffer.includes('승인') ||
    tailBuffer.includes('실행');

  if (hasMenuFooter && hasOptionOne && hasPermissionContext) {
    const cmdMatch = tailBuffer.match(/(?:Requesting permission for|command|changes to):\s*\n\s*([^\r\n]+)/i);
    const cmdName = cmdMatch ? cmdMatch[1].trim().slice(0, 50) : '1. Yes';
    responseInput = '\r'; // Submits the highlighted 1. Yes option
    matchedStr = `1. Yes (${cmdName})`;
    inputLabel = '1 (Enter)';
    promptSig = `menu:${cmdName}:${tailBuffer.slice(-250).trim()}`;
  }

  // 2. Generic Numbered Choice Menu: "선택 [1]:", "Enter choice [1]:", "Choose [1-X]:"
  if (!responseInput) {
    const NUMBERED_CHOICE_REGEX =
      /(?:선택\s*\(?\s*1\s*[-~]\s*\d+\s*\)?\s*:|enter\s+choice\s*(?:\(1-\d+\)|\[1\])?\s*:|select\s+an\s+option\s*\[?1\]?\s*:|choice\s*\[\s*1\s*\]\s*:)/i;
    const matchNum = tailBuffer.match(NUMBERED_CHOICE_REGEX);
    if (matchNum) {
      const afterPrompt = tailBuffer.slice(matchNum.index + matchNum[0].length).replace(/[\s\r\n:?]/g, '');
      if (afterPrompt.length <= 5) {
        responseInput = '1\r';
        matchedStr = matchNum[0].trim();
        inputLabel = '1';
        promptSig = `num:${matchedStr}@${session.scrollback.length}`;
      }
    }
  }

  // 3. Common CLI confirmation prompt patterns:
  // [y/n], (y/n), [y/N], (y/N), [Y/n], [yes/no], (yes/no), [예/아니오], (예/아니오)
  // 한국어: 계속하시겠습니까, 진행하시겠습니까, 실행하시겠습니까, 승인하시겠습니까, 덮어쓰시겠습니까
  // 영어: proceed?, continue?, allow?, approve?, confirm?, apply?, are you sure?, overwrite?
  if (!responseInput) {
    const CONFIRM_Y_REGEX =
      /(?:\[[Yy]\/[Nn]\]|\([Yy]\/[Nn]\)|\[(?:yes|no)\]|\((?:yes|no)\)|\[예\/아니오\]|\(예\/아니오\)|\b(?:계속|진행|실행|승인|덮어쓰|저장)하시겠습니까|\b(?:proceed|continue|allow|approve|confirm|apply|overwrite)\b[^\r\n?]*\?|\bare\s+you\s+sure\b[^\r\n?]*\?)/i;
    const matchY = tailBuffer.match(CONFIRM_Y_REGEX);
    if (matchY) {
      const afterPrompt = tailBuffer.slice(matchY.index + matchY[0].length).replace(/[\s\r\n:?]/g, '');
      if (afterPrompt.length <= 5) {
        responseInput = 'y\r';
        matchedStr = matchY[0].trim();
        inputLabel = 'y';
        promptSig = `y:${matchedStr}@${session.scrollback.length}`;
      }
    }
  }

  // 4. Press Enter to continue
  if (!responseInput) {
    const CONFIRM_ENTER_REGEX =
      /(?:press\s+(?:enter|return)\s+to\s+continue|press\s+\[?enter\]?\s+to|\b엔터를\s*누르(?:시오|세요))/i;
    const matchEnter = tailBuffer.match(CONFIRM_ENTER_REGEX);
    if (matchEnter) {
      const afterPrompt = tailBuffer.slice(matchEnter.index + matchEnter[0].length).replace(/[\s\r\n:?]/g, '');
      if (afterPrompt.length <= 5) {
        responseInput = '\r';
        matchedStr = matchEnter[0].trim();
        inputLabel = 'Enter';
        promptSig = `enter:${matchedStr}@${session.scrollback.length}`;
      }
    }
  }

  if (responseInput && matchedStr && promptSig) {
    // Prevent repeatedly approving the exact same waiting prompt signature
    if (session.lastApprovedPromptSignature === promptSig && now - (session.lastAutoApproveTime || 0) < 5000) {
      return;
    }

    session.lastAutoApproveTime = now;
    session.lastApprovedPromptSignature = promptSig;

    clearTimeout(session.autoApproveTimer);
    session.autoApproveTimer = setTimeout(() => {
      if (session.exited) return;

      session.ptyProcess.write(responseInput);

      // Record in recent tool calls for visibility
      if (session.agentActivity) {
        session.agentActivity.recentToolCalls.unshift({
          id: `auto-appr-${Date.now().toString(36)}`,
          action: 'AutoApprove',
          target: `${matchedStr} → [${inputLabel || responseInput.trim() || 'Enter'}]`,
          timestamp: new Date().toISOString(),
          status: 'completed',
        });
      }

      // Broadcast notification to all connected clients
      const noticePayload = JSON.stringify({
        type: 'auto_approved',
        sessionId: session.id,
        matched: matchedStr,
        input: inputLabel || (responseInput === '\r' ? 'Enter' : responseInput.trim()),
        timestamp: new Date().toISOString(),
      });

      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(noticePayload);
        }
      }
    }, 200); // 200ms debounce
  }
}

function writeInputToSessionPty(session, text, submit = true) {
  if (!session || session.exited) return;
  const str = String(text ?? '');
  if (!str) return;

  if (submit) {
    if (str.includes('\n')) {
      // Use bracketed paste so CLI/TUI receives the full multiline text as one prompt without prematurely submitting on \n
      session.ptyProcess.write(`\x1b[200~${str}\x1b[201~\r`);
    } else {
      session.ptyProcess.write(`${str}\r`);
    }
  } else {
    session.ptyProcess.write(str);
  }
}

function extractAgentResponse(rawText, userPrompt = '') {
  if (!rawText || typeof rawText !== 'string') return '';
  const plain = rawText
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '');

  let textAfterPrompt = '';
  if (userPrompt && userPrompt.trim()) {
    const firstLine = userPrompt.trim().split(/\r?\n/)[0].trim();
    const idx = plain.lastIndexOf(firstLine);
    if (idx !== -1) {
      textAfterPrompt = plain.slice(idx + firstLine.length);
    }
  }
  if (!textAfterPrompt) {
    const promptIdx = plain.lastIndexOf('\n> ');
    textAfterPrompt = promptIdx !== -1 ? plain.slice(promptIdx + 3) : plain;
    const lines = textAfterPrompt.split(/\r?\n/);
    lines.shift();
    textAfterPrompt = lines.join('\n');
  }

  const lines = textAfterPrompt.split(/\r?\n/);
  const responseLines = [];
  for (const line of lines) {
    if (
      line.includes('? for shortcuts') ||
      line.includes('────────') ||
      line.includes('esc to dismiss') ||
      line.includes('Verbosity now defaults')
    ) {
      break;
    }
    if (
      line.includes('● Ran') ||
      line.includes('● Explored') ||
      line.includes('● Read') ||
      line.includes('● Edited') ||
      line.includes('● Created') ||
      line.includes('Thought for') ||
      line.includes('Thinking...')
    ) {
      continue;
    }
    responseLines.push(line.trimEnd());
  }

  while (responseLines.length && !responseLines[0].trim()) responseLines.shift();
  while (responseLines.length && !responseLines[responseLines.length - 1].trim()) responseLines.pop();

  return responseLines.map((l) => l.replace(/^ {1,2}/, '')).join('\n');
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
    autoApprove: true,
    lastAutoApproveTime: 0,
    autoApproveTimer: null,
    agentActivity: {
      status: 'idle',
      currentTool: null,
      recentToolCalls: [],
    },
    hermesHistory: [],
  };

  const compactAgyProgress = (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    // Collapse consecutive horizontal divider lines that arrive together
    const borderPattern = '(?:(?:\\x1b\\[[0-9;?]*[a-zA-Z])*[─━═-]{6,}(?:\\x1b\\[[0-9;?]*[a-zA-Z])*\\s*[\\r\\n]+)';
    const stackedBordersRe = new RegExp('(' + borderPattern + ')(?:\\s*[\\r\\n]*' + borderPattern + ')+', 'g');
    return raw.replace(stackedBordersRe, '$1');
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

    // Cursor up line rewrites (\r\x1b[NA): pop overwritten lines from scrollback buffer
    const cursorUpMatch = cleanedData.match(/^\r\x1b\[(\d+)A/);
    if (cursorUpMatch) {
      const upCount = parseInt(cursorUpMatch[1], 10);
      if (upCount > 0 && upCount <= 60 && session.scrollback.length > 0) {
        let lines = session.scrollback.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        const removeCount = Math.min(upCount, lines.length);
        lines = lines.slice(0, lines.length - removeCount);
        session.scrollback = lines.length > 0 ? lines.join('\n') + '\n' : '';
      }
    }

    session.scrollback += cleanedData;

    // Periodically compact scrollback if it grows large to avoid unbounded redraw bloat
    if (session.scrollback.length > 120 * 1024) {
      session.scrollback = compactTerminalBuffer(session.scrollback);
    }

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

    // Hermes Agent Activity Detection from PTY Stream
    if (!session.agentActivity) {
      session.agentActivity = {
        status: 'idle',
        currentTool: null,
        recentToolCalls: [],
      };
    }
    const plain = rawData
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
    let statusChanged = false;

    if (plain.includes('Thought for') || plain.includes('Thinking...')) {
      if (session.agentActivity.status !== 'thinking') {
        session.agentActivity.status = 'thinking';
        statusChanged = true;
      }
    } else if (
      plain.includes('Running command...') ||
      plain.includes('● Ran') ||
      plain.includes('● Explored') ||
      plain.includes('● Read') ||
      plain.includes('● Edited') ||
      plain.includes('● Created')
    ) {
      const match = plain.match(
        /●\s+(Ran|Explored|Read|Edited|Created|Running command\.\.\.)\s*([^\r\n]*)/
      );
      const toolAction = match ? match[1] : 'tool';
      const toolTarget = match ? match[2].trim() : '';
      const fullLabel = toolTarget ? `${toolAction}: ${toolTarget}` : toolAction;
      if (
        session.agentActivity.status !== 'tool_executing' ||
        session.agentActivity.currentTool !== fullLabel
      ) {
        session.agentActivity.status = 'tool_executing';
        session.agentActivity.currentTool = fullLabel;
        session.agentActivity.recentToolCalls.unshift({
          id: `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          action: toolAction,
          target: toolTarget,
          timestamp: new Date().toISOString(),
          status: 'running',
        });
        if (session.agentActivity.recentToolCalls.length > 50) {
          session.agentActivity.recentToolCalls.length = 50;
        }
        statusChanged = true;
      }
    } else if (plain.includes('? for shortcuts') || plain.includes('Goodbye!')) {
      if (session.agentActivity.status !== 'idle') {
        const wasBusy =
          session.agentActivity.status === 'thinking' ||
          session.agentActivity.status === 'tool_executing';
        session.agentActivity.status = 'idle';
        if (
          session.agentActivity.recentToolCalls.length > 0 &&
          session.agentActivity.recentToolCalls[0].status === 'running'
        ) {
          session.agentActivity.recentToolCalls[0].status = 'completed';
        }
        session.agentActivity.currentTool = null;
        statusChanged = true;

        // When transition from thinking/tool to idle, extract and dispatch the agent response!
        if (wasBusy) {
          const agentText = extractAgentResponse(
            session.scrollback.slice(-15000),
            session.lastUserPrompt || ''
          );
          if (agentText && agentText !== session.lastEmittedAgentResponse) {
            session.lastEmittedAgentResponse = agentText;
            const agentEntry = {
              id: `msg-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
              role: 'agent',
              content: agentText,
              model: session.activeModel || null,
              timestamp: new Date().toISOString(),
            };
            if (!session.hermesHistory) session.hermesHistory = [];
            session.hermesHistory.push(agentEntry);
            if (session.hermesHistory.length > 200) {
              session.hermesHistory = session.hermesHistory.slice(-200);
            }
            broadcast({
              type: 'hermes_agent_message',
              sessionId: session.id,
              entry: agentEntry,
            });
          }
        }
      }
    }

    if (statusChanged) {
      broadcast({
        type: 'hermes_agent_status',
        status: session.agentActivity.status,
        currentTool: session.agentActivity.currentTool,
        recentToolCalls: session.agentActivity.recentToolCalls.slice(0, 20),
      });
    }

    // Auto-Approve confirmation prompts in real-time terminal
    if (session.autoApprove !== false && !session.exited) {
      checkAndAutoApprovePrompt(session, plain);
    }

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

          // Send Esc after 1.5s to automatically dismiss any initial tip/verbosity modal banner
          setTimeout(() => {
            if (!session.exited) {
              ptyProcess.write('\x1b');
            }
          }, 1500);
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
    autoApprove: session.autoApprove !== false,
    agentActivity: session.agentActivity || {
      status: 'idle',
      currentTool: null,
      recentToolCalls: [],
    },
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

function classifyInputEntry(text) {
  const t = String(text || '').trim();
  if (t.startsWith('/')) {
    return { type: 'slash', label: '슬래시 명령', typeLabel: '슬래시 명령' };
  }
  const firstWord = t.split(/\s+/)[0].toLowerCase();
  const COMMON_CLI = new Set([
    'git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'pip', 'curl',
    'wget', 'ls', 'dir', 'cd', 'cat', 'echo', 'mkdir', 'rm', 'cp', 'mv', 'ps', 'kill',
    'grep', 'find', 'sudo', 'docker', 'ssh', 'clear', 'cls', 'open', 'xdg-open',
    'which', 'where', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'agy'
  ]);
  if (COMMON_CLI.has(firstWord) || /^[a-z0-9_.-]+(\s+-[a-zA-Z0-9]+|\s+--[a-z0-9-]+)/.test(t)) {
    return { type: 'command', label: 'CLI 쉘 명령', typeLabel: 'CLI 쉘 명령' };
  }
  return { type: 'prompt', label: '에이전트 지시/프롬프트', typeLabel: '에이전트 지시/프롬프트' };
}

function summarizeInputHistory(entries, options = {}) {
  const {
    sessionId,
    q,
    date,
    order = 'asc', // 'asc' = 시간순 (과거 -> 최신), 'desc' = 최신순
    dedup = true,
  } = options;

  let filtered = [...entries];
  if (sessionId) {
    filtered = filtered.filter((it) => it.sessionId === sessionId);
  }
  if (date && date !== 'all') {
    filtered = filtered.filter((it) => it.createdAt && it.createdAt.startsWith(date));
  }
  if (q && String(q).trim()) {
    const kw = String(q).trim().toLowerCase();
    filtered = filtered.filter(
      (it) =>
        (it.text && it.text.toLowerCase().includes(kw)) ||
        (it.sessionTitle && it.sessionTitle.toLowerCase().includes(kw)) ||
        (it.cwd && it.cwd.toLowerCase().includes(kw))
    );
  }

  // Sort by createdAt
  filtered.sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return order === 'asc' ? ta - tb : tb - ta;
  });

  // Deduplication: collapse identical consecutive entries within 1 minute
  if (dedup && dedup !== 'false') {
    const deduped = [];
    for (const item of filtered) {
      const prev = deduped[deduped.length - 1];
      if (
        prev &&
        prev.text.trim() === item.text.trim() &&
        Math.abs(new Date(item.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 60000
      ) {
        prev.repeatCount = (prev.repeatCount || 1) + 1;
        continue;
      }
      deduped.push({ ...item, repeatCount: 1 });
    }
    filtered = deduped;
  }

  let promptCount = 0;
  let commandCount = 0;
  let slashCount = 0;
  const commandFreq = new Map();

  // Annotate classification
  for (const item of filtered) {
    const { type, label } = classifyInputEntry(item.text);
    item.type = type;
    item.typeLabel = label;
    if (type === 'prompt') promptCount++;
    else if (type === 'command') {
      commandCount++;
      const first = item.text.trim().split(/\s+/)[0];
      commandFreq.set(first, (commandFreq.get(first) || 0) + 1);
    } else if (type === 'slash') {
      slashCount++;
    }
  }

  // Cluster by Date (YYYY-MM-DD), then by Time Blocks (gap > 20 mins)
  const dateGroups = [];
  let currentDateGroup = null;
  let currentBlock = null;

  for (const item of filtered) {
    const d = new Date(item.createdAt || 0);
    const dateKey = !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '날짜 미상';
    const dayOfWeek = !isNaN(d.getTime()) ? ['일', '월', '화', '수', '목', '금', '토'][d.getDay()] : '';
    const dateLabel = `${dateKey} (${dayOfWeek})`;
    const timeMs = d.getTime();

    if (!currentDateGroup || currentDateGroup.dateKey !== dateKey) {
      currentDateGroup = {
        dateKey,
        dateLabel,
        blocks: [],
      };
      dateGroups.push(currentDateGroup);
      currentBlock = null;
    }

    // New block if gap > 20 minutes or first item in date group
    if (!currentBlock || timeMs - currentBlock.lastTimeMs > 20 * 60 * 1000) {
      currentBlock = {
        blockId: `blk-${currentDateGroup.blocks.length + 1}`,
        startTime: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        endTime: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        startTimeMs: timeMs,
        lastTimeMs: timeMs,
        sessionTitle: item.sessionTitle || '콘솔',
        items: [],
      };
      currentDateGroup.blocks.push(currentBlock);
    }

    currentBlock.lastTimeMs = timeMs;
    currentBlock.endTime = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    currentBlock.items.push(item);
  }

  // Generate Markdown Summary
  const startDateStr = filtered.length > 0 ? new Date(filtered[0].createdAt).toLocaleString('ko-KR') : '-';
  const endDateStr = filtered.length > 0 ? new Date(filtered[filtered.length - 1].createdAt).toLocaleString('ko-KR') : '-';

  let md = `# 📅 웹 입력 명령문 시간순 히스토리 요약 보고서\n\n`;
  md += `- **분석 기간**: ${startDateStr} ~ ${endDateStr}\n`;
  md += `- **총 명령/프롬프트 수**: ${filtered.length}건 (에이전트 지시: ${promptCount}건, 쉘 명령: ${commandCount}건, 슬래시: ${slashCount}건)\n`;
  md += `- **정렬 기준**: ${order === 'asc' ? '과거순 (시간 순서대로)' : '최신순'}\n\n`;

  for (const dg of dateGroups) {
    const totalDateItems = dg.blocks.reduce((sum, b) => sum + b.items.length, 0);
    md += `## 🗓️ ${dg.dateLabel} (총 ${totalDateItems}건)\n\n`;

    for (let bi = 0; bi < dg.blocks.length; bi++) {
      const b = dg.blocks[bi];
      const timeSpan = b.startTime === b.endTime ? b.startTime : `${b.startTime} ~ ${b.endTime}`;
      md += `### 🕒 세션 ${bi + 1}: ${timeSpan} [${b.sessionTitle}]\n`;

      for (const it of b.items) {
        const itemTime = it.createdAt ? new Date(it.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        const icon = it.type === 'prompt' ? '💬' : it.type === 'command' ? '🚀' : '💡';
        const repeat = it.repeatCount > 1 ? ` *(×${it.repeatCount}회 반복)*` : '';
        md += `- [${itemTime}] ${icon} **${it.typeLabel}**: \`${it.text}\`${repeat}\n`;
      }
      md += `\n`;
    }
  }

  // Top Commands
  const topCommands = Array.from(commandFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cmd, count]) => ({ cmd, count }));

  // AI Prompt text for agy
  const promptList = filtered.slice(order === 'asc' ? -30 : 0, order === 'asc' ? undefined : 30);
  const aiPrompt =
    `다음은 웹 콘솔에서 사용자가 시간순서대로 입력한 작업 명령문 및 프롬프트 히스토리입니다:\n\n` +
    promptList
      .map((it, i) => `${i + 1}. [${it.createdAt?.slice(11, 19) || ''}] (${it.typeLabel}) ${it.text}`)
      .join('\n') +
    `\n\n위 작업 내역을 바탕으로:\n1. 사용자가 중점적으로 진행한 핵심 작업 주제 요약\n2. 주요 발견점 또는 완료된 사항\n3. 이어서 진행하기 좋은 다음 권장 작업\n을 3~5문장으로 명확히 요약 정리해줘.`;

  return {
    totalCount: filtered.length,
    statistics: {
      total: filtered.length,
      promptCount,
      commandCount,
      slashCount,
      dateRange: { start: startDateStr, end: endDateStr },
      topCommands,
    },
    dateGroups,
    markdown: md,
    aiPrompt,
  };
}

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

// REST API: Web Input History Chronological Summary
app.get('/api/input-history/summary', (req, res) => {
  const summary = summarizeInputHistory(inputHistoryList, req.query || {});
  res.json({ ok: true, summary });
});

// Helper: Calculate workday start time (04:00 AM today, or yesterday 04:00 AM if currently before 4 AM)
function getTodayWorkdayStartTime() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(4, 0, 0, 0); // 04:00:00.000 AM
  if (now.getTime() < start.getTime()) {
    start.setDate(start.getDate() - 1);
  }
  return start;
}

// Helper: Detect if user input is asking for today's work summary
function isTodayWorkSummaryIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.replace(/[\s\t\r\n]+/g, ' ').trim().toLowerCase();
  const patterns = [
    /금일\s*(작업|업무|한\s*일).*(정리|요약|알려|보고)/,
    /오늘\s*(작업|업무|한\s*일).*(정리|요약|알려|보고)/,
    /오전\s*4시.*(정리|요약|알려|보고)/,
    /4시부터.*(정리|요약|알려|보고)/,
    /(작업|업무)\s*(내용)?\s*(정리|요약)해줘/,
    /오늘\s*뭐\s*했(는지|어)/,
  ];
  return patterns.some((p) => p.test(normalized));
}

// Helper: Build comprehensive work summary from 04:00 AM today to now
function buildTodayWorkSummary(targetSession) {
  const startTime = getTodayWorkdayStartTime();
  const now = new Date();
  const startTimeMs = startTime.getTime();

  // 1. Filter input history from 04:00 AM to now
  const todayInputs = inputHistoryList
    .filter((it) => {
      const t = new Date(it.createdAt || 0).getTime();
      return t >= startTimeMs;
    })
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  // 2. Classify and group
  const todayAnnotatedInputs = todayInputs.map((it) => {
    const classification = classifyInputEntry(it.text);
    return { ...it, ...classification };
  });

  const promptItems = todayAnnotatedInputs.filter((it) => it.type === 'prompt');
  const commandItems = todayAnnotatedInputs.filter((it) => it.type === 'command');
  const slashItems = todayAnnotatedInputs.filter((it) => it.type === 'slash');

  // 3. Git commits since 04:00 AM
  let gitCommits = [];
  let gitBranch = '';
  let gitChanges = '';
  try {
    const candidateCwds = [targetSession?.cwd, __dirname, process.cwd()].filter(Boolean);
    let cwd = __dirname;
    for (const c of candidateCwds) {
      if (fs.existsSync(path.join(c, '.git'))) {
        cwd = c;
        break;
      }
    }
    const gitLogOut = execSync(
      'git log --since="today 04:00:00" --pretty=format:"%h|%s|%ad" --date=format:"%H:%M"',
      { cwd, encoding: 'utf8', timeout: 3000, stdio: 'pipe' }
    ).trim();
    if (gitLogOut) {
      gitCommits = gitLogOut.split('\n').map((line) => {
        const [hash, msg, time] = line.split('|');
        return { hash, msg: msg || '', time: time || '' };
      });
    }
    gitBranch = execSync('git branch --show-current', { cwd, encoding: 'utf8', timeout: 2000, stdio: 'pipe' }).trim();
    gitChanges = execSync('git status -s', { cwd, encoding: 'utf8', timeout: 2000, stdio: 'pipe' }).trim();
  } catch (_) {}

  // 4. Session agent tools
  const tools = targetSession?.agentActivity?.recentToolCalls || [];
  const todayTools = tools.filter((tc) => {
    const t = new Date(tc.timestamp || 0).getTime();
    return t >= startTimeMs;
  });

  const startStr = `${startTime.toLocaleDateString('ko-KR')} 오전 04:00`;
  const endStr = `${now.toLocaleDateString('ko-KR')} ${now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;

  // 5. Generate formatted markdown
  let md = `# 📅 금일 작업한 내용 정리 (오전 4시 ~ 현재)\n\n`;
  md += `- **작업 기준 기간**: ${startStr} ~ ${endStr}\n`;
  md += `- **작업 브랜치**: \`${gitBranch || 'main'}\`\n`;
  md += `- **웹 입력 작업 총계**: ${todayInputs.length}건 (에이전트 지시: ${promptItems.length}건, CLI 명령: ${commandItems.length}건, 도구 호출: ${todayTools.length}건)\n\n`;

  md += `## 🕒 1. 웹 입력 및 작업 지시 내역 (오전 4시 이후, 시간순)\n`;
  if (todayAnnotatedInputs.length === 0) {
    md += `- *(오늘 오전 4시 이후 웹 콘솔에 기록된 사용자 입력이 없습니다.)*\n`;
  } else {
    for (const it of todayAnnotatedInputs) {
      const timeStr = it.createdAt ? new Date(it.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const icon = it.type === 'prompt' ? '💬' : it.type === 'command' ? '🚀' : '💡';
      md += `- [${timeStr}] ${icon} **${it.typeLabel}**: ${it.text}\n`;
    }
  }
  md += `\n`;

  if (gitCommits.length > 0) {
    md += `## 💻 2. 금일 Git 커밋 변경 내역 (오전 4시 이후 총 ${gitCommits.length}건)\n`;
    for (const c of gitCommits) {
      md += `- \`${c.hash}\` (${c.time}) - **${c.msg}**\n`;
    }
    md += `\n`;
  }

  if (todayTools.length > 0) {
    md += `## 🔧 3. 실행된 도구 및 파일 작업 (총 ${todayTools.length}건)\n`;
    for (const tc of todayTools.slice(0, 15)) {
      const tcTime = tc.timestamp ? new Date(tc.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      md += `- [${tcTime}] **${tc.action}**: \`${tc.target}\` (${tc.status === 'completed' ? '완료' : '진행'})\n`;
    }
    md += `\n`;
  }

  return {
    startTime: startTime.toISOString(),
    endTime: now.toISOString(),
    startFormatted: startStr,
    endFormatted: endStr,
    gitBranch,
    inputCount: todayInputs.length,
    promptCount: promptItems.length,
    commandCount: commandItems.length,
    toolCount: todayTools.length,
    commitCount: gitCommits.length,
    inputs: todayInputs,
    commits: gitCommits,
    tools: todayTools,
    markdown: md,
  };
}

// REST API: Get Today's Work Summary (04:00 AM to Now)
app.get('/api/daily-work-summary', (req, res) => {
  const sessionId = req.query.sessionId || PRIMARY_SESSION_ID;
  const session = sessions.get(sessionId) || sessions.values().next().value;
  const summary = buildTodayWorkSummary(session);
  res.json({ ok: true, summary });
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

  const isDailySummary = isTodayWorkSummaryIntent(content);
  let payloadContent = content;
  let dailySummaryData = null;

  if (isDailySummary && submit) {
    dailySummaryData = buildTodayWorkSummary(session);
    payloadContent =
      `${dailySummaryData.markdown}\n\n` +
      `위는 오늘 오전 4시부터 지금까지 웹 콘솔에서 작업한 실제 명령문, 프롬프트, 도구 실행 및 Git 커밋 기록입니다.\n` +
      `이 실제 기록을 바탕으로 오늘(오전 4시부터 지금까지) 작업한 내용을 다음 순서로 일목요연하게 정리해서 보고서 형식으로 알려줘:\n` +
      `1. 🎯 금일 작업 목표 및 핵심 테마 요약\n` +
      `2. 🕒 시간대별 작업 진행 내역 (오전 4시~현재)\n` +
      `3. 💻 개발 및 Git 커밋/코드 변경 사항\n` +
      `4. ✅ 달성된 결과물 및 향후 권장 작업`;
  }

  session.lastUserPrompt = content;
  processSessionInputForHistory(session, submit ? `${content}\r` : content);
  writeInputToSessionPty(session, payloadContent, submit);

  if (dailySummaryData) {
    const cardMsg = JSON.stringify({
      type: 'today_work_summary_card',
      sessionId: session.id,
      summary: dailySummaryData,
    });
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(cardMsg);
      }
    }
  }

  return res.json({ ok: true, sessionId: session.id, submitted: Boolean(submit), isDailySummary });
}

app.post('/api/send', handleSendToSession);
app.post('/api/sessions/:id/send', handleSendToSession);

// REST API: Set or toggle Auto-Approve mode for a session
function handleSetAutoApprove(req, res) {
  const targetId = req.params.id || req.body?.sessionId || PRIMARY_SESSION_ID;
  const session = sessions.get(targetId) || sessions.values().next().value;
  if (!session) {
    return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  }
  const { enabled } = req.body || {};
  session.autoApprove = enabled !== undefined ? Boolean(enabled) : !session.autoApprove;

  const payload = JSON.stringify({
    type: 'auto_approve_changed',
    sessionId: session.id,
    enabled: session.autoApprove,
  });
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }

  res.json({ ok: true, sessionId: session.id, autoApprove: session.autoApprove });
}

app.post('/api/auto-approve', handleSetAutoApprove);
app.post('/api/sessions/:id/auto-approve', handleSetAutoApprove);

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

// --- Hermes Desktop Agent API ---

// 1. Get Hermes Agent status & history
app.get('/api/hermes/status', (req, res) => {
  const sessionId = req.query.sessionId || PRIMARY_SESSION_ID;
  if (sessions.size === 0) ensurePrimarySession();
  const session = sessions.get(sessionId) || sessions.values().next().value;
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });

  res.json({
    session: serializeSession(session),
    agentActivity: session.agentActivity || { status: 'idle', currentTool: null, recentToolCalls: [] },
    history: session.hermesHistory || [],
  });
});

// 2. Dispatch Prompt to Hermes Agent
app.post('/api/hermes/prompt', (req, res) => {
  const { sessionId = PRIMARY_SESSION_ID, prompt, model } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: '프롬프트 내용이 비어있습니다.' });
  }

  if (sessions.size === 0) ensurePrimarySession();
  const session = sessions.get(sessionId) || sessions.values().next().value;
  if (!session || session.exited) {
    return res.status(404).json({ error: '활성 콘솔 세션을 찾을 수 없습니다.' });
  }

  const promptText = prompt.trim();
  const isDailySummary = isTodayWorkSummaryIntent(promptText);
  let dailySummaryData = null;
  let enrichedPrompt = null;

  if (isDailySummary) {
    dailySummaryData = buildTodayWorkSummary(session);
    enrichedPrompt =
      `${dailySummaryData.markdown}\n\n` +
      `위는 오늘 오전 4시부터 지금까지 웹 콘솔에서 작업한 실제 명령문, 프롬프트, 도구 실행 및 Git 커밋 기록입니다.\n` +
      `이 실제 기록을 바탕으로 오늘(오전 4시부터 지금까지) 작업한 내용을 다음 순서로 일목요연하게 정리해서 보고서 형식으로 알려줘:\n` +
      `1. 🎯 금일 작업 목표 및 핵심 테마 요약\n` +
      `2. 🕒 시간대별 작업 진행 내역 (오전 4시~현재)\n` +
      `3. 💻 개발 및 Git 커밋/코드 변경 사항\n` +
      `4. ✅ 달성된 결과물 및 향후 권장 작업`;
  }

  const historyEntry = {
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'user',
    content: promptText,
    model: model || null,
    timestamp: new Date().toISOString(),
  };

  if (!session.hermesHistory) session.hermesHistory = [];
  session.hermesHistory.push(historyEntry);
  if (session.hermesHistory.length > 200) {
    session.hermesHistory = session.hermesHistory.slice(-200);
  }

  // Update agentActivity status to thinking
  if (!session.agentActivity) {
    session.agentActivity = { status: 'thinking', currentTool: null, recentToolCalls: [] };
  } else {
    session.agentActivity.status = 'thinking';
  }

  session.lastUserPrompt = promptText;
  session.activeModel = model || session.activeModel || null;

  // Write prompt to PTY with bracketed paste if multiline
  processSessionInputForHistory(session, `${promptText}\r`);
  writeInputToSessionPty(session, isDailySummary ? enrichedPrompt : promptText, true);

  // Broadcast to WS clients
  const broadcastMsg = JSON.stringify({
    type: 'hermes_prompt_dispatched',
    sessionId: session.id,
    entry: historyEntry,
    agentActivity: session.agentActivity,
  });
  for (const ws of session.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(broadcastMsg);
    }
  }

  if (dailySummaryData) {
    const cardMsg = JSON.stringify({
      type: 'today_work_summary_card',
      sessionId: session.id,
      summary: dailySummaryData,
    });
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(cardMsg);
      }
    }
  }

  res.json({ ok: true, sessionId: session.id, entry: historyEntry });
});

// 3. Send SIGINT / Interrupt to Agent
app.post('/api/hermes/interrupt', (req, res) => {
  const { sessionId = PRIMARY_SESSION_ID } = req.body || {};
  const session = sessions.get(sessionId) || sessions.values().next().value;
  if (!session || session.exited) {
    return res.status(404).json({ error: '활성 콘솔 세션을 찾을 수 없습니다.' });
  }

  session.ptyProcess.write('\x03');
  if (session.agentActivity) {
    session.agentActivity.status = 'idle';
    session.agentActivity.currentTool = null;
  }

  const broadcastMsg = JSON.stringify({
    type: 'hermes_agent_status',
    status: 'idle',
    currentTool: null,
    recentToolCalls: session.agentActivity ? session.agentActivity.recentToolCalls : [],
  });
  for (const ws of session.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(broadcastMsg);
    }
  }

  res.json({ ok: true, sessionId: session.id });
});

// 4. Workspace Directory Inspection
app.get('/api/hermes/workspace', (req, res) => {
  const sessionId = req.query.sessionId || PRIMARY_SESSION_ID;
  const session = sessions.get(sessionId);
  const baseCwd = session ? session.cwd : process.cwd();
  let targetDir = req.query.dir || baseCwd;

  try {
    if (!path.isAbsolute(targetDir)) {
      targetDir = path.resolve(baseCwd, targetDir);
    }
    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ error: '디렉토리가 존재하지 않습니다.' });
    }
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: '디렉토리가 아닙니다.' });
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (entry.name === '.git' && !req.query.all) {
        items.push({
          name: entry.name,
          path: path.join(targetDir, entry.name),
          isDirectory: true,
          size: 0,
          ext: '',
          isSpecial: true,
        });
        continue;
      }
      const fullPath = path.join(targetDir, entry.name);
      try {
        const entStat = fs.statSync(fullPath);
        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entStat.isDirectory(),
          size: entStat.size,
          mtime: entStat.mtime.toISOString(),
          ext: path.extname(entry.name).toLowerCase(),
        });
      } catch (_) {
        // Skip inaccessible entries
      }
    }

    // Sort: directories first, then alphabetically
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    res.json({
      cwd: targetDir,
      parent: path.dirname(targetDir) !== targetDir ? path.dirname(targetDir) : null,
      items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || '작업 디렉토리 탐색 실패' });
  }
});

// 5. Workspace File Content Inspection
app.get('/api/hermes/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: '파일 경로(path)를 지정해야 합니다.' });
  }

  try {
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: '파일이 존재하지 않습니다.' });
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: '폴더는 직접 읽을 수 없습니다.' });
    }

    // Protect against huge files
    const MAX_PREVIEW_SIZE = 2 * 1024 * 1024; // 2MB
    if (stat.size > MAX_PREVIEW_SIZE) {
      return res.json({
        path: filePath,
        name: path.basename(filePath),
        size: stat.size,
        ext: path.extname(filePath).toLowerCase(),
        truncated: true,
        content: `// 파일 크기(${Math.round(stat.size / 1024)}KB)가 커서 앞부분만 표시합니다.\n` +
          fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 100000),
      });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    res.json({
      path: filePath,
      name: path.basename(filePath),
      size: stat.size,
      ext: path.extname(filePath).toLowerCase(),
      content,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || '파일 읽기 실패' });
  }
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
  // Compact scrollback to eliminate stacked horizontal lines and obsolete intermediate frames
  const compacted = compactTerminalBuffer(session.scrollback);
  session.scrollback = compacted;
  ws.send(
    JSON.stringify({
      type: 'init',
      session: serializeSession(session),
      scrollback: compacted,
      inlineItems: session.inlineItems ? Array.from(session.inlineItems.values()) : [],
      agentActivity: session.agentActivity || { status: 'idle', currentTool: null, recentToolCalls: [] },
      hermesHistory: session.hermesHistory || [],
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
      } else if (msg.type === 'set_auto_approve') {
        session.autoApprove = Boolean(msg.enabled);
        const autoMsg = JSON.stringify({
          type: 'auto_approve_changed',
          sessionId: session.id,
          enabled: session.autoApprove,
        });
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(autoMsg);
          }
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
