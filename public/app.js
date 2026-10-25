(() => {
  const STORAGE_ACTIVE_SESSION_KEY = 'agy_web_active_session_id';

  // State
  let defaultCwd = '/home/msx';
  let activeSessionId = localStorage.getItem(STORAGE_ACTIVE_SESSION_KEY) || null;
  const clientSessions = new Map();

  // DOM Elements
  const tabsContainer = document.getElementById('tabsContainer');
  const terminalStage = document.getElementById('terminalStage');
  const emptyState = document.getElementById('emptyState');

  const connStatusDot = document.getElementById('connStatusDot');
  const connStatusText = document.getElementById('connStatusText');
  const sessionMetaShell = document.getElementById('sessionMetaShell');
  const sessionMetaCwd = document.getElementById('sessionMetaCwd');
  const sessionMetaSize = document.getElementById('sessionMetaSize');

  const btnNewSession = document.getElementById('btnNewSession');
  const btnNewSessionCustom = document.getElementById('btnNewSessionCustom');
  const btnEmptyCreate = document.getElementById('btnEmptyCreate');

  const btnRunAgy = document.getElementById('btnRunAgy');
  const btnSendHelp = document.getElementById('btnSendHelp');
  const btnSendCtrlC = document.getElementById('btnSendCtrlC');
  const btnSendCtrlD2 = document.getElementById('btnSendCtrlD2');
  const btnClearTerm = document.getElementById('btnClearTerm');

  // Modal Elements
  const newSessionModal = document.getElementById('newSessionModal');
  const newSessionForm = document.getElementById('newSessionForm');
  const inputSessionTitle = document.getElementById('inputSessionTitle');
  const inputSessionCwd = document.getElementById('inputSessionCwd');
  const inputAutoRunAgy = document.getElementById('inputAutoRunAgy');
  const modalError = document.getElementById('modalError');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const btnCancelModal = document.getElementById('btnCancelModal');

  let lastOpenedUrl = '';
  let lastOpenedTime = 0;
  // Map of normalized URL key -> WindowProxy so opening the same URL focuses the existing tab instead of duplicating
  const openedTabWindows = new Map();

  function getStableTabTarget(uri) {
    try {
      const u = new URL(uri);
      const key = (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase();
      let hash = 0;
      for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
      }
      return { key, targetName: `agy_tab_${hash.toString(36)}` };
    } catch (_) {
      return { key: uri, targetName: '_blank' };
    }
  }

  /**
   * Clean trailing Korean suffixes or unmatched punctuation from a detected URL.
   */
  function cleanTerminalUrl(raw) {
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

  /**
   * Show a clickable banner when a background URL open is blocked by browser popup policy.
   */
  function showUrlToast(url) {
    let toast = document.getElementById('urlOpenToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'urlOpenToast';
      toast.className = 'url-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `
      <span class="url-toast-label">🔗 링크 열기:</span>
      <a href="${url}" target="_blank" rel="noopener noreferrer" class="url-toast-link">${url}</a>
      <button type="button" class="url-toast-close" title="닫기">✕</button>
    `;
    toast.hidden = false;
    toast.querySelector('.url-toast-link').addEventListener('click', () => {
      toast.hidden = true;
    });
    toast.querySelector('.url-toast-close').addEventListener('click', () => {
      toast.hidden = true;
    });
  }

  const IMAGE_URI_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)(\?.*)?$/i;

  /**
   * Open an http(s):// or file:// link from the terminal or server event.
   */
  function openTerminalLink(rawUri, fromServerEvent = false) {
    const uri = cleanTerminalUrl(rawUri);
    if (!uri) return;

    const now = Date.now();
    if (uri === lastOpenedUrl && now - lastOpenedTime < 800) {
      return;
    }
    lastOpenedUrl = uri;
    lastOpenedTime = now;

    if (uri.startsWith('file://') || /^[A-Za-z]:\\/.test(uri) || uri.startsWith('/')) {
      const cleanPath = uri
        .replace(/^file:\/\//i, '')
        .replace(/#L\d+.*$/, '');
      if (IMAGE_URI_RE.test(cleanPath)) {
        const decodedPath = (() => {
          try {
            return decodeURIComponent(cleanPath);
          } catch (_) {
            return cleanPath;
          }
        })();
        fetch('/api/show-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: decodedPath }),
        }).catch(() => {
          renderImageInlineInTerminal({
            src: `/api/local-image?path=${encodeURIComponent(decodedPath)}&t=${Date.now()}`,
            filePath: decodedPath,
            title: decodedPath.split(/[\\/]/).pop() || '이미지',
          });
        });
        return;
      }

      fetch('/api/open-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: uri, sessionId: activeSessionId }),
      }).catch(() => {});
      return;
    }

    if (/^https?:\/\//i.test(uri)) {
      if (IMAGE_URI_RE.test(uri)) {
        showImageInDock({
          src: uri,
          url: uri,
          title: uri.split('/').pop() || '이미지',
        });
        return;
      }
      const { key, targetName } = getStableTabTarget(uri);
      const existingWin = openedTabWindows.get(key);
      if (existingWin && !existingWin.closed) {
        try {
          existingWin.focus();
          return;
        } catch (_) {}
      }

      // Using a deterministic targetName reuses the same browser tab for the same URL
      const win = window.open(uri, targetName);
      if (win) {
        openedTabWindows.set(key, win);
        try {
          win.focus();
        } catch (_) {}
      } else if (fromServerEvent) {
        showUrlToast(uri);
      }
    }
  }

  /**
   * Build an xterm.js Terminal instance configured to feel identical to Windows Terminal.
   */
  function createTerminalInstance(paneEl, sessionId) {
    let hoveredLink = null;

    const term = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"Cascadia Code", "JetBrains Mono", "D2Coding", Consolas, "Malgun Gothic", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (ev, text) => {
          openTerminalLink(text, false);
        },
        hover: (ev, text) => {
          hoveredLink = cleanTerminalUrl(text);
          paneEl.style.cursor = 'pointer';
        },
        leave: () => {
          hoveredLink = null;
          paneEl.style.cursor = '';
        },
      },
      theme: {
        background: '#0b0e14',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0b0e14',
        selectionBackground: 'rgba(88, 166, 255, 0.3)',
        black: '#0b0e14',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
      // Stop URL matching before Korean characters or closing parentheses/brackets
      const koreanSafeUrlRegex =
        /(https?:\/\/[^\s"'!*(){}|\\\^<>`\u3131-\u318E\uAC00-\uD7A3]+[^\s"':,.!?{}|\\\^~\[\]`()<>\u3131-\u318E\uAC00-\uD7A3])/;
      term.loadAddon(
        new window.WebLinksAddon.WebLinksAddon(
          (ev, uri) => {
            openTerminalLink(uri, false);
          },
          {
            urlRegex: koreanSafeUrlRegex,
            hover: (ev, uri) => {
              hoveredLink = cleanTerminalUrl(uri);
              paneEl.style.cursor = 'pointer';
            },
            leave: () => {
              hoveredLink = null;
              paneEl.style.cursor = '';
            },
          }
        )
      );
    }

    if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) {
      const unicode11Addon = new window.Unicode11Addon.Unicode11Addon();
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = '11';
    }

    if (window.ImageAddon && window.ImageAddon.ImageAddon) {
      const imageAddon = new window.ImageAddon.ImageAddon({
        enableSizeReports: false,
        iipSupport: true,
        sixelSupport: true,
        showPlaceholder: true,
      });
      term.loadAddon(imageAddon);
    }

    term.open(paneEl);

    term.parser?.registerOscHandler(7777, (data) => {
      try {
        const m = data.match(/id=([^;]+)/);
        const id = m ? m[1] : '';
        const item = sessionInlineItems.get(id);
        if (item) {
          const entry = clientSessions.get(sessionId);
          if (entry) {
            attachDecorationAtCurrentLine(entry, item);
          }
        }
      } catch (_) {}
      return true;
    });

    // Allow single left-click on hovered links even when TUI Mouse Tracking Mode (?1000h) is active
    let mouseDownPos = null;
    paneEl.addEventListener(
      'mousedown',
      (ev) => {
        if (ev.button === 0) {
          mouseDownPos = { x: ev.clientX, y: ev.clientY };
        }
      },
      true
    );
    paneEl.addEventListener(
      'mouseup',
      (ev) => {
        if (ev.button === 0 && hoveredLink && mouseDownPos) {
          const dx = Math.abs(ev.clientX - mouseDownPos.x);
          const dy = Math.abs(ev.clientY - mouseDownPos.y);
          if (dx < 5 && dy < 5 && !term.hasSelection()) {
            openTerminalLink(hoveredLink, false);
          }
        }
        mouseDownPos = null;
      },
      true
    );

    // Handle clipboard copy (Ctrl+C with selection / Ctrl+Shift+C) and paste (Ctrl+V / Ctrl+Shift+V)
    let isPastingFromKey = false;
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;

      const isCtrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;

      // Ctrl+C or Ctrl+Shift+C: Copy selection if text is selected; otherwise let Ctrl+C send SIGINT (\x03)
      if (isCtrl && ev.code === 'KeyC') {
        if (term.hasSelection()) {
          const selected = term.getSelection();
          if (selected && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(selected).catch(() => {});
          }
          term.clearSelection();
          return false;
        }
        if (ev.shiftKey) {
          return false;
        }
        return true;
      }

      // Ctrl+V or Ctrl+Shift+V: Paste from clipboard into terminal pipeline
      if (isCtrl && ev.code === 'KeyV') {
        ev.preventDefault();
        ev.stopPropagation();
        if (navigator.clipboard && navigator.clipboard.readText) {
          isPastingFromKey = true;
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) {
                term.paste(text);
              }
            })
            .catch(() => {})
            .finally(() => {
              setTimeout(() => {
                isPastingFromKey = false;
              }, 50);
            });
        }
        return false;
      }

      return true;
    });

    // Prevent duplicate paste if browser also fires a native paste event after keydown
    paneEl.addEventListener(
      'paste',
      (ev) => {
        if (isPastingFromKey) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      true
    );

    term.onData((data) => {
      const entry = clientSessions.get(sessionId);
      if (entry && entry.isReplaying) return;
      sendInput(sessionId, data);
    });

    term.onResize(({ cols, rows }) => {
      sendResize(sessionId, cols, rows);
      if (sessionId === activeSessionId) {
        sessionMetaSize.textContent = `${cols}×${rows}`;
      }
    });

    return { term, fitAddon };
  }

  /**
   * Send raw keystrokes / data to the session PTY over WebSocket.
   */
  function sendInput(sessionId, data) {
    const entry = clientSessions.get(sessionId);
    if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) return;
    entry.ws.send(JSON.stringify({ type: 'input', data }));
  }

  /**
   * Synchronize terminal dimensions with the server ConPTY.
   */
  function sendResize(sessionId, cols, rows) {
    const entry = clientSessions.get(sessionId);
    if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) return;
    entry.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  /**
   * Connect (or reconnect) WebSocket for a given session.
   */
  function connectSessionWebSocket(sessionId) {
    const entry = clientSessions.get(sessionId);
    if (!entry) return;

    if (entry.ws) {
      try {
        entry.ws.onclose = null;
        entry.ws.close();
      } catch (_) {}
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
    entry.ws = ws;

    ws.onopen = () => {
      entry.connected = true;
      updateToolbarStatus();
    };

    function compactTerminalProgress(raw) {
      if (!raw || typeof raw !== 'string') return raw;
      return raw
        .replace(/ \x1b\[38;2;147;161;161m\([^)\r\n]*\)(?:\x1b\[m)?/g, '')
        .replace(/(\x1b\[\?7[hl])\x1b\[\d+G/g, '$1\x1b[K');
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init') {
          entry.meta = msg.session;
          entry.isReplaying = true;
          if (Array.isArray(msg.inlineItems)) {
            for (const it of msg.inlineItems) {
              sessionInlineItems.set(it.id, it);
            }
          }
          if (msg.agentActivity) {
            handleHermesAgentStatus(msg.agentActivity);
          }
          if (Array.isArray(msg.hermesHistory)) {
            for (const item of msg.hermesHistory) {
              renderHermesHistoryItem(item);
            }
          }
          // Fit terminal to viewport before reset and write so columns/rows match exactly
          entry.fitAddon.fit();
          entry.term.reset();
          if (msg.scrollback) {
            entry.term.write(compactTerminalProgress(msg.scrollback), () => {
              entry.isReplaying = false;
              entry.initialized = true;
              renderTabs();
              updateToolbarStatus();
            });
          } else {
            entry.isReplaying = false;
            entry.initialized = true;
            renderTabs();
            updateToolbarStatus();
          }
        } else if (msg.type === 'hermes_agent_status') {
          handleHermesAgentStatus(msg);
        } else if (msg.type === 'hermes_prompt_dispatched') {
          handleHermesPromptDispatched(msg);
        } else if (msg.type === 'output') {
          entry.term.write(compactTerminalProgress(msg.data));
        } else if (msg.type === 'open_url') {
          if (msg.url) {
            openTerminalLink(msg.url, true);
          }
        } else if (msg.type === 'show_image') {
          if (msg.image) {
            const inlineItem = {
              id: msg.image.id,
              title: msg.image.title || 'Image',
              html: `<img src="${msg.image.src}" alt="${msg.image.title || ''}" />`,
              kind: 'Image',
              rows: 14,
            };
            sessionInlineItems.set(inlineItem.id, inlineItem);
            cachedImages = [
              msg.image,
              ...cachedImages.filter((it) => it.src !== msg.image.src),
            ].slice(0, 50);
            if (hubPanelImages && !hubPanelImages.hidden) {
              renderImageGalleryPanel();
            }
          }
        } else if (msg.type === 'show_html') {
          if (msg.item && msg.item.html) {
            sessionInlineItems.set(msg.item.id, msg.item);
          }
        } else if (msg.type === 'clear_html') {
          sessionInlineItems.clear();
        } else if (msg.type === 'input_logged') {
          if (msg.entry) {
            cachedInputHistory.unshift(msg.entry);
            if (cachedInputHistory.length > 500) cachedInputHistory.length = 500;
            if (hubPanelInputHistory && !hubPanelInputHistory.hidden) {
              renderInputHistoryPanel();
            }
          }
        } else if (msg.type === 'exit') {
          entry.meta.exited = true;
          entry.meta.exitCode = msg.exitCode;
          entry.term.write(
            `\r\n\x1b[33m[콘솔 프로세스가 종료되었습니다 (코드: ${msg.exitCode ?? 0})]\x1b[0m\r\n`
          );
          renderTabs();
          updateToolbarStatus();
        }
      } catch (err) {
        console.error('Failed to process WS message:', err);
      }
    };

    ws.onclose = () => {
      entry.connected = false;
      updateToolbarStatus();
      if (clientSessions.has(sessionId) && !entry.meta.exited) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = setTimeout(() => {
          if (clientSessions.has(sessionId)) {
            connectSessionWebSocket(sessionId);
          }
        }, 1500);
      }
    };
  }

  /**
   * Ensure a client-side terminal pane & WebSocket exist for a server session.
   */
  function mountSession(sessionMeta) {
    if (clientSessions.has(sessionMeta.id)) {
      const existing = clientSessions.get(sessionMeta.id);
      existing.meta = sessionMeta;
      return existing;
    }

    const paneEl = document.createElement('div');
    paneEl.className = 'terminal-pane';
    paneEl.dataset.sessionId = sessionMeta.id;
    terminalStage.appendChild(paneEl);

    const { term, fitAddon } = createTerminalInstance(paneEl, sessionMeta.id);

    const entry = {
      meta: sessionMeta,
      term,
      fitAddon,
      paneEl,
      ws: null,
      connected: false,
      initialized: false,
      isReplaying: false,
      reconnectTimer: null,
    };

    clientSessions.set(sessionMeta.id, entry);
    connectSessionWebSocket(sessionMeta.id);
    return entry;
  }

  /**
   * Switch the active visible session tab.
   */
  function activateSession(sessionId) {
    if (!clientSessions.has(sessionId)) return;
    activeSessionId = sessionId;
    localStorage.setItem(STORAGE_ACTIVE_SESSION_KEY, sessionId);

    for (const [id, entry] of clientSessions.entries()) {
      if (id === sessionId) {
        entry.paneEl.classList.add('active');
      } else {
        entry.paneEl.classList.remove('active');
      }
    }

    renderTabs();
    updateToolbarStatus();
    fitActiveTerminal();

    const activeEntry = clientSessions.get(sessionId);
    if (activeEntry) {
      setTimeout(() => activeEntry.term.focus(), 30);
    }
  }

  /**
   * Fit the active terminal to its container and notify the server ConPTY.
   */
  function fitActiveTerminal() {
    if (!activeSessionId) return;
    const entry = clientSessions.get(activeSessionId);
    if (!entry) return;
    try {
      entry.fitAddon.fit();
      const { cols, rows } = entry.term;
      sendResize(activeSessionId, cols, rows);
      sessionMetaSize.textContent = `${cols}×${rows}`;
    } catch (_) {}
  }

  /**
   * Render the top tab bar and toggle empty state.
   */
  function renderTabs() {
    tabsContainer.innerHTML = '';

    if (clientSessions.size === 0) {
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    for (const [id, entry] of clientSessions.entries()) {
      const tab = document.createElement('div');
      tab.className = `session-tab${id === activeSessionId ? ' active' : ''}${
        entry.meta.exited ? ' exited' : ''
      }`;
      tab.setAttribute('role', 'tab');
      tab.title = `${entry.meta.title} (${entry.meta.cwd}) — 더블클릭하여 이름 변경`;

      const dot = document.createElement('span');
      dot.className = 'session-tab-dot';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-tab-title';
      titleSpan.textContent = entry.meta.title;

      titleSpan.addEventListener('dblclick', async (ev) => {
        ev.stopPropagation();
        const nextTitle = prompt('세션 이름을 입력하세요:', entry.meta.title);
        if (nextTitle && nextTitle.trim()) {
          await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: nextTitle.trim() }),
          });
          entry.meta.title = nextTitle.trim();
          renderTabs();
        }
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'session-tab-close';
      closeBtn.innerHTML = '✕';
      closeBtn.title = '세션 종료 및 닫기';
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeSession(id);
      });

      tab.addEventListener('click', () => activateSession(id));

      tab.appendChild(dot);
      tab.appendChild(titleSpan);
      tab.appendChild(closeBtn);
      tabsContainer.appendChild(tab);
    }
  }

  /**
   * Update status bar metadata for the currently active session.
   */
  function updateToolbarStatus() {
    const entry = activeSessionId ? clientSessions.get(activeSessionId) : null;
    if (!entry) {
      connStatusDot.className = 'status-indicator disconnected';
      connStatusText.textContent = '세션 없음';
      sessionMetaShell.textContent = '-';
      sessionMetaCwd.textContent = defaultCwd;
      return;
    }

    if (entry.meta.exited) {
      connStatusDot.className = 'status-indicator disconnected';
      connStatusText.textContent = `종료됨 (PID ${entry.meta.pid})`;
    } else if (entry.connected) {
      connStatusDot.className = 'status-indicator connected';
      connStatusText.textContent = `연결됨 (PID ${entry.meta.pid})`;
    } else {
      connStatusDot.className = 'status-indicator';
      connStatusText.textContent = '재연결 중...';
    }

    sessionMetaShell.textContent = entry.meta.shell || 'powershell.exe';
    sessionMetaCwd.textContent = entry.meta.cwd || defaultCwd;
    sessionMetaSize.textContent = `${entry.term.cols}×${entry.term.rows}`;
  }

  /**
   * Create a new session via REST API and activate it.
   */
  async function createNewSession({ cwd, title, autoRunAgy = true } = {}) {
    const approxCols = Math.max(60, Math.floor((terminalStage.clientWidth - 20) / 8.5));
    const approxRows = Math.max(18, Math.floor((terminalStage.clientHeight - 16) / 17));

    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: cwd || defaultCwd,
        title,
        cols: approxCols,
        rows: approxRows,
        autoRunAgy,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || '세션 생성 실패');
    }

    const entry = mountSession(data.session);
    activateSession(entry.meta.id);
    return entry;
  }

  /**
   * Terminate and remove a session.
   */
  async function closeSession(sessionId) {
    const entry = clientSessions.get(sessionId);
    if (!entry) return;

    clearTimeout(entry.reconnectTimer);
    if (entry.ws) {
      try {
        entry.ws.onclose = null;
        entry.ws.close();
      } catch (_) {}
    }

    try {
      entry.term.dispose();
    } catch (_) {}
    entry.paneEl.remove();
    clientSessions.delete(sessionId);

    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    } catch (_) {}

    if (activeSessionId === sessionId) {
      const remainingIds = Array.from(clientSessions.keys());
      if (remainingIds.length > 0) {
        activateSession(remainingIds[remainingIds.length - 1]);
      } else {
        activeSessionId = null;
        localStorage.removeItem(STORAGE_ACTIVE_SESSION_KEY);
        renderTabs();
        updateToolbarStatus();
      }
    } else {
      renderTabs();
    }
  }

  /**
   * Bootstrap: fetch existing sessions on page load, or create the initial one.
   */
  async function bootstrap() {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (data.defaultCwd) {
        defaultCwd = data.defaultCwd;
        inputSessionCwd.value = defaultCwd;
      }

      if (Array.isArray(data.sessions) && data.sessions.length > 0) {
        for (const s of data.sessions) {
          mountSession(s);
        }
        const targetId =
          activeSessionId && clientSessions.has(activeSessionId)
            ? activeSessionId
            : data.sessions[0].id;
        activateSession(targetId);
      } else {
        await createNewSession({ cwd: defaultCwd, autoRunAgy: true });
      }
    } catch (err) {
      console.error('Bootstrap error:', err);
      connStatusText.textContent = '서버 연결 실패';
    }
  }

  // Event Listeners: Top Bar & Empty State
  btnNewSession.addEventListener('click', () => {
    createNewSession({ cwd: defaultCwd, autoRunAgy: true }).catch((err) => alert(err.message));
  });

  btnEmptyCreate.addEventListener('click', () => {
    createNewSession({ cwd: defaultCwd, autoRunAgy: true }).catch((err) => alert(err.message));
  });

  btnNewSessionCustom.addEventListener('click', () => {
    modalError.hidden = true;
    inputSessionTitle.value = '';
    inputSessionCwd.value = defaultCwd;
    inputAutoRunAgy.checked = true;
    newSessionModal.hidden = false;
    inputSessionCwd.focus();
  });

  function closeModal() {
    newSessionModal.hidden = true;
  }

  btnCloseModal.addEventListener('click', closeModal);
  btnCancelModal.addEventListener('click', closeModal);

  newSessionForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    modalError.hidden = true;
    try {
      await createNewSession({
        title: inputSessionTitle.value.trim() || undefined,
        cwd: inputSessionCwd.value.trim() || defaultCwd,
        autoRunAgy: inputAutoRunAgy.checked,
      });
      closeModal();
    } catch (err) {
      modalError.textContent = err.message;
      modalError.hidden = false;
    }
  });

  // Event Listeners: Quick CLI Pipeline Actions
  btnRunAgy.addEventListener('click', () => {
    if (!activeSessionId) return;
    sendInput(activeSessionId, 'agy --effort low\r');
    clientSessions.get(activeSessionId)?.term.focus();
  });

  btnSendHelp.addEventListener('click', () => {
    if (!activeSessionId) return;
    sendInput(activeSessionId, '/help\r');
    clientSessions.get(activeSessionId)?.term.focus();
  });

  btnSendCtrlC.addEventListener('click', () => {
    if (!activeSessionId) return;
    sendInput(activeSessionId, '\x03');
    clientSessions.get(activeSessionId)?.term.focus();
  });

  btnSendCtrlD2.addEventListener('click', () => {
    if (!activeSessionId) return;
    sendInput(activeSessionId, '\x04');
    setTimeout(() => sendInput(activeSessionId, '\x04'), 120);
    clientSessions.get(activeSessionId)?.term.focus();
  });

  btnClearTerm.addEventListener('click', () => {
    clearConsoleHtmlBlocks();
    if (!activeSessionId) return;
    const entry = clientSessions.get(activeSessionId);
    if (entry && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify({ type: 'clear' }));
      entry.term.focus();
    }
  });

  // Automatically resize ConPTY when the browser window or stage resizes
  const resizeObserver = new ResizeObserver(() => {
    fitActiveTerminal();
  });
  resizeObserver.observe(terminalStage);
  window.addEventListener('resize', fitActiveTerminal);

  // =========================================================================
  // Bookmarks, Naver Mail & Browser Tabs Hub
  // =========================================================================
  const bookmarkChips = document.getElementById('bookmarkChips');
  const btnToggleHub = document.getElementById('btnToggleHub');
  const btnQuickAddBookmark = document.getElementById('btnQuickAddBookmark');
  const btnOpenTabsInspector = document.getElementById('btnOpenTabsInspector');

  const hubDrawer = document.getElementById('hubDrawer');
  const btnCloseHub = document.getElementById('btnCloseHub');
  const hubTabs = Array.from(document.querySelectorAll('.hub-tab'));
  const hubPanelInternal = document.getElementById('hubPanelInternal');
  const hubPanelNaverMail = document.getElementById('hubPanelNaverMail');
  const hubPanelNaverCafe = document.getElementById('hubPanelNaverCafe');
  const hubPanelInputHistory = document.getElementById('hubPanelInputHistory');
  const hubPanelImages = document.getElementById('hubPanelImages');
  const hubPanelBrowserBm = document.getElementById('hubPanelBrowserBm');
  const hubPanelOpenTabs = document.getElementById('hubPanelOpenTabs');

  const bmAddForm = document.getElementById('bmAddForm');
  const bmInputTitle = document.getElementById('bmInputTitle');
  const bmInputUrl = document.getElementById('bmInputUrl');
  const bmInputCategory = document.getElementById('bmInputCategory');
  const internalBookmarksList = document.getElementById('internalBookmarksList');

  const browserBmSearch = document.getElementById('browserBmSearch');
  const btnRefreshBrowserBm = document.getElementById('btnRefreshBrowserBm');
  const browserBookmarksList = document.getElementById('browserBookmarksList');

  const btnRefreshOpenTabs = document.getElementById('btnRefreshOpenTabs');
  const btnLaunchCdpBrowser = document.getElementById('btnLaunchCdpBrowser');
  const openTabsList = document.getElementById('openTabsList');

  let internalBookmarks = [];
  let cachedBrowserBookmarks = [];
  let latestNaverMailData = null;
  let latestNaverCafeData = null;
  let cachedInputHistory = [];
  let cachedImages = [];
  let currentDockImage = null;
  let isImageZoomed = false;

  const imageOpenForm = document.getElementById('imageOpenForm');
  const imagePathInput = document.getElementById('imagePathInput');
  const imageGalleryList = document.getElementById('imageGalleryList');

  const sessionInlineItems = new Map();

  function getTerminalCellDimensions(term) {
    try {
      const c = term._core?._renderService?.dimensions?.css?.cell;
      if (c && c.height > 0 && c.width > 0) {
        return { width: c.width, height: c.height };
      }
    } catch (_) {}
    const screenEl = term.element?.querySelector('.xterm-screen');
    if (screenEl && term.rows && term.cols) {
      return {
        width: screenEl.clientWidth / term.cols || 8.4,
        height: screenEl.clientHeight / term.rows || 17,
      };
    }
    return { width: 8.4, height: 17 };
  }

  function attachDecorationAtCurrentLine(entry, item) {
    if (!entry || !entry.term || !item) return;
    const term = entry.term;
    const marker = term.registerMarker(0);
    if (!marker) return;

    const rowsNeeded = item.rows || 5;
    const decoration = term.registerDecoration({
      marker,
      x: 2,
      width: Math.max(20, term.cols - 3),
      height: rowsNeeded,
      layer: 'top',
    });
    if (!decoration) return;

    const syncPosition = (el) => {
      if (!el || marker.isDisposed) return;
      const dims = getTerminalCellDimensions(term);
      const ydisp = term.buffer.active.viewportY;
      const rowOffset = marker.line - ydisp;

      if (rowOffset + rowsNeeded > 0 && rowOffset < term.rows) {
        el.style.display = 'block';
        el.style.position = 'absolute';
        el.style.top = `${Math.round(rowOffset * dims.height)}px`;
        el.style.left = `${Math.round(dims.width * 2)}px`;
        el.style.width = `${Math.max(120, Math.round((term.cols - 3) * dims.width))}px`;
        el.style.height = `${Math.round(rowsNeeded * dims.height)}px`;
        el.style.pointerEvents = 'none';
      } else {
        el.style.display = 'none';
      }
    };

    decoration.onRender((el) => {
      if (!el.dataset.mounted) {
        el.dataset.mounted = '1';
        const card = document.createElement('div');
        card.className = 'inline-console-card';
        card.innerHTML = `
          <div class="inline-card-header">
            <span class="inline-card-tag">${item.kind === 'Image' ? '🖼️' : '📊'} ${item.title || '출력'}</span>
            <div class="inline-card-actions">
              <button type="button" class="inline-btn-copy" title="텍스트/표 복사">📋 복사</button>
            </div>
          </div>
          <div class="inline-card-body">${item.html}</div>
        `;
        card.querySelector('.inline-btn-copy')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const bodyEl = card.querySelector('.inline-card-body');
          const textToCopy = bodyEl?.innerText || item.html;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy).catch(() => {});
          }
        });
        el.appendChild(card);
      }
      syncPosition(el);
    });

    const sDisp = term.onScroll(() => decoration.element && syncPosition(decoration.element));
    const rDisp = term.onRender(() => decoration.element && syncPosition(decoration.element));

    marker.onDispose(() => {
      sDisp.dispose();
      rDisp.dispose();
    });
  }

  function showImageInDock(imgObj) {
    if (!imgObj || !imgObj.src) return;
    fetch('/api/show-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        imgObj.url
          ? { url: imgObj.src, title: imgObj.title || 'Image' }
          : { path: imgObj.filePath || imgObj.src, title: imgObj.title || 'Image' }
      ),
    }).catch(() => {});
  }

  async function fetchImagesGallery() {
    if (!imageGalleryList) return;
    try {
      const res = await fetch('/api/images');
      const data = await res.json();
      cachedImages = Array.isArray(data.images) ? data.images : cachedImages;
      renderImageGalleryPanel();
    } catch (_) {
      renderImageGalleryPanel();
    }
  }

  function renderImageGalleryPanel() {
    if (!imageGalleryList) return;
    imageGalleryList.innerHTML = '';

    if (cachedImages.length === 0) {
      imageGalleryList.innerHTML = `
        <div class="hub-note">
          표시된 이미지가 없습니다.<br/>
          • 위 입력창에 로컬 이미지 경로(예: <code>/home/msx/.../image.png</code>)나 이미지 URL을 입력해 바로 볼 수 있습니다.<br/>
          • 터미널에서 <code>agy-web-image 파일경로.png</code> 또는 <code>xdg-open 파일경로.png</code>를 실행하거나 터미널 내 이미지 링크를 클릭해도 화면에 바로 표시됩니다.
        </div>`;
      return;
    }

    for (const img of cachedImages) {
      const card = document.createElement('div');
      card.className = 'hub-item';
      card.style.flexDirection = 'column';
      card.style.alignItems = 'stretch';
      card.style.gap = '6px';

      const topRow = document.createElement('div');
      topRow.style.display = 'flex';
      topRow.style.justifyContent = 'space-between';
      topRow.style.alignItems = 'center';

      const tEl = document.createElement('div');
      tEl.className = 'hub-item-title';
      tEl.textContent = img.title || '이미지';

      const act = document.createElement('div');
      act.className = 'hub-item-actions';

      const viewBtn = document.createElement('button');
      viewBtn.className = 'btn btn-chip';
      viewBtn.textContent = '🖼️ 미리보기';
      viewBtn.addEventListener('click', () => showImageInDock(img));

      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn btn-chip';
      sendBtn.textContent = '⌨️ 경로';
      sendBtn.addEventListener('click', () =>
        insertTextToActiveConsole((img.filePath || img.url || '') + ' ')
      );

      act.appendChild(viewBtn);
      act.appendChild(sendBtn);
      topRow.appendChild(tEl);
      topRow.appendChild(act);

      const thumb = document.createElement('img');
      thumb.src = img.src;
      thumb.alt = img.title || '';
      thumb.style.maxWidth = '100%';
      thumb.style.maxHeight = '160px';
      thumb.style.objectFit = 'contain';
      thumb.style.background = '#0b0e14';
      thumb.style.borderRadius = '4px';
      thumb.style.cursor = 'pointer';
      thumb.addEventListener('click', () => showImageInDock(img));

      const subEl = document.createElement('div');
      subEl.className = 'hub-item-sub';
      subEl.textContent = img.filePath || img.url || '';

      card.appendChild(topRow);
      card.appendChild(thumb);
      card.appendChild(subEl);
      imageGalleryList.appendChild(card);
    }
  }

  const BOOKMARKLET_CODE =
    "javascript:(()=>{const s=[];document.querySelectorAll('li.mail_item,div.mail_item,ul.mail_list>li,[class*=\"mail_item\"],tr[mailsn]').forEach((e,i)=>{const t=e.querySelector('.mail_title_link,.mail_title,strong.mail_title,a[href*=\"/read/\"],.subject')||e.querySelector('a'),f=e.querySelector('.mail_sender,.button_sender,[class*=\"sender\"],.name'),d=e.querySelector('.mail_date,[class*=\"date\"],.time'),l=e.querySelector('a[href*=\"/read/\"],a.mail_title_link');let sub=(t?t.innerText:'').replace(/\\s+/g,' ').replace(/^메일 제목\\s*/,'').trim();if(!sub)return;s.push({mailSn:String(i),subject:sub,sender:(f?f.innerText:'').replace(/\\s+/g,' ').replace(/^보낸 사람\\s*/,'').trim(),date:(d?d.innerText:'').replace(/\\s+/g,' ').trim(),unread:e.classList.contains('unreads')||e.classList.contains('unread'),url:l?l.href:location.href});});let om=null;const vb=document.querySelector('.mail_view_contents,.mail_view_body,#readFrame,[class*=\"mail_view_contents\"]');if(vb){const vt=document.querySelector('.mail_view_title,h4.view_title,[class*=\"mail_view_title\"]');om={subject:vt?vt.innerText.trim():document.title,body:vb.innerText.trim().slice(0,15000),url:location.href};}fetch('http://127.0.0.1:3080/api/naver-mail/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageUrl:location.href,pageTitle:document.title,mails:s,openMail:om})}).then(()=>alert('AGY 웹 콘솔로 네이버 메일 '+s.length+'건을 전송했습니다!')).catch(e=>alert('전송 실패: '+e));})();";

  function insertTextToActiveConsole(text) {
    if (!activeSessionId) return;
    sendInput(activeSessionId, text);
    clientSessions.get(activeSessionId)?.term.focus();
  }

  async function fetchInternalBookmarks() {
    try {
      const res = await fetch('/api/bookmarks');
      const data = await res.json();
      internalBookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
      renderBookmarkBar();
      renderInternalBookmarksPanel();
    } catch (err) {
      console.error('Failed to load bookmarks:', err);
    }
  }

  function renderBookmarkBar() {
    if (!bookmarkChips) return;
    bookmarkChips.innerHTML = '';

    for (const bm of internalBookmarks) {
      const chip = document.createElement('div');
      chip.className = 'bm-chip';
      chip.title = `${bm.title} (${bm.url}) — 클릭하여 열기`;

      const label = document.createElement('span');
      label.textContent = bm.title;
      chip.addEventListener('click', () => {
        openTerminalLink(bm.url, false);
      });

      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'bm-chip-send';
      sendBtn.textContent = '⌨️';
      sendBtn.title = '현재 콘솔 프롬프트에 이 URL 입력';
      sendBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        insertTextToActiveConsole(bm.url + ' ');
      });

      chip.appendChild(label);
      chip.appendChild(sendBtn);
      bookmarkChips.appendChild(chip);
    }
  }

  function renderInternalBookmarksPanel() {
    if (!internalBookmarksList) return;
    internalBookmarksList.innerHTML = '';

    if (internalBookmarks.length === 0) {
      internalBookmarksList.innerHTML =
        '<div class="hub-note">등록된 내부 북마크가 없습니다. 위 폼에서 추가해 보세요.</div>';
      return;
    }

    for (const bm of internalBookmarks) {
      const row = document.createElement('div');
      row.className = 'hub-item';

      const info = document.createElement('div');
      info.className = 'hub-item-info';
      const titleEl = document.createElement('div');
      titleEl.className = 'hub-item-title';
      titleEl.textContent = `[${bm.category || '기본'}] ${bm.title}`;
      const subEl = document.createElement('div');
      subEl.className = 'hub-item-sub';
      subEl.textContent = bm.url;
      info.appendChild(titleEl);
      info.appendChild(subEl);

      const actions = document.createElement('div');
      actions.className = 'hub-item-actions';

      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-chip';
      openBtn.textContent = '🔗 열기';
      openBtn.addEventListener('click', () => openTerminalLink(bm.url, false));

      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn btn-chip';
      sendBtn.textContent = '⌨️ 콘솔입력';
      sendBtn.title = '콘솔에 URL 붙여넣기';
      sendBtn.addEventListener('click', () => insertTextToActiveConsole(bm.url + ' '));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-chip';
      delBtn.textContent = '🗑️';
      delBtn.title = '삭제';
      delBtn.addEventListener('click', async () => {
        await fetch(`/api/bookmarks/${encodeURIComponent(bm.id)}`, { method: 'DELETE' });
        fetchInternalBookmarks();
      });

      actions.appendChild(openBtn);
      actions.appendChild(sendBtn);
      actions.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(actions);
      internalBookmarksList.appendChild(row);
    }
  }

  async function fetchNaverMail(readUrl = null) {
    const naverMailList = document.getElementById('naverMailList');
    if (!naverMailList) return;
    naverMailList.innerHTML = '<div class="hub-note">네이버 메일 데이터를 불러오는 중...</div>';

    try {
      const qs = readUrl ? `?readUrl=${encodeURIComponent(readUrl)}` : '';
      const res = await fetch(`/api/naver-mail${qs}`);
      const data = await res.json();
      latestNaverMailData = data;
      renderNaverMailPanel(data);
    } catch (err) {
      naverMailList.innerHTML = `<div class="hub-note">네이버 메일 조회 오류: ${err.message}</div>`;
    }
  }

  function renderNaverMailPanel(data) {
    const naverMailList = document.getElementById('naverMailList');
    if (!naverMailList) return;
    naverMailList.innerHTML = '';

    const mails = Array.isArray(data?.mails) ? data.mails : [];
    const openMail = data?.openMail || null;

    if (mails.length === 0 && !openMail) {
      const guide = document.createElement('div');
      guide.className = 'hub-note';
      guide.innerHTML = `
        <div style="font-weight:700;color:#fff;margin-bottom:6px;">📧 열려 있는 네이버 메일 페이지 연동 방법 (택1)</div>
        <div style="margin-bottom:8px;">
          <b>방법 1 (현재 일반 브라우저 그대로 사용 — 북마크릿):</b><br/>
          아래 파란 버튼을 마우스로 끌어 브라우저 <b>북마크 바(즐겨찾기 바)</b>에 놓은 뒤, 열려 있는 네이버 메일 탭에서 클릭하면 즉시 메일 목록과 본문이 이곳으로 전송됩니다.<br/>
          <a href="${BOOKMARKLET_CODE.replace(/"/g, '&quot;')}" class="btn btn-primary" style="margin-top:6px;text-decoration:none;display:inline-block;" onclick="event.preventDefault();alert('이 버튼을 마우스로 끌어서 브라우저 상단 북마크 바에 놓으세요!');">📥 네이버 메일 → AGY 전송</a>
        </div>
        <div style="margin-bottom:8px;">
          <b>방법 2 (Chrome/Edge 확장 프로그램 100% 자동 동기화):</b><br/>
          브라우저 주소창에 <code>chrome://extensions</code> (또는 <code>edge://extensions</code>) 입력 → 우측 상단 <b>개발자 모드</b> 켜기 → <b>압축해제된 확장 프로그램을 로드합니다</b> 클릭 → <code>/home/msx/agy-web/extension</code> 폴더 선택 시 네이버 메일/카페 탭을 열 때마다 자동으로 읽어옵니다.
        </div>
        <div>
          <b>방법 3 (실시간 연동 브라우저 실행):</b><br/>
          <button type="button" class="btn btn-subtle" id="btnLaunchCdpFromMail" style="margin-top:4px;">🔌 실시간 연동 브라우저로 네이버 메일 열기</button>
        </div>
      `;
      naverMailList.appendChild(guide);
      guide.querySelector('#btnLaunchCdpFromMail')?.addEventListener('click', async () => {
        await fetch('/api/browser/launch-cdp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ browser: 'chrome' }),
        });
      });
      return;
    }

    const statusNote = document.createElement('div');
    statusNote.className = 'hub-note';
    statusNote.textContent = `✅ 연동됨 (${data.source || 'sync'}) · 메일 ${mails.length}건 · 업데이트: ${
      data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString('ko-KR') : '-'
    }`;
    naverMailList.appendChild(statusNote);

    if (openMail && openMail.body) {
      const bodyHeader = document.createElement('div');
      bodyHeader.className = 'hub-section-title';
      bodyHeader.textContent = `📖 현재 열려 있는 메일 본문`;
      naverMailList.appendChild(bodyHeader);

      const bodyCard = document.createElement('div');
      bodyCard.className = 'hub-item';
      bodyCard.style.flexDirection = 'column';
      bodyCard.style.alignItems = 'stretch';

      const topRow = document.createElement('div');
      topRow.style.display = 'flex';
      topRow.style.justifyContent = 'space-between';
      topRow.style.alignItems = 'center';
      topRow.style.gap = '8px';

      const titleEl = document.createElement('div');
      titleEl.className = 'hub-item-title';
      titleEl.textContent = openMail.subject || '(제목 없음)';

      const sendBodyBtn = document.createElement('button');
      sendBodyBtn.className = 'btn btn-primary';
      sendBodyBtn.textContent = '🤖 본문 콘솔에 전달';
      sendBodyBtn.addEventListener('click', () => {
        const promptText = `[네이버 메일 본문] 제목: ${openMail.subject || ''} / 보낸사람: ${
          openMail.sender || ''
        } / 내용: ${openMail.body.replace(/\r?\n/g, ' ').slice(0, 2000)} `;
        insertTextToActiveConsole(promptText);
      });

      topRow.appendChild(titleEl);
      topRow.appendChild(sendBodyBtn);

      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.fontSize = '11.5px';
      pre.style.color = '#c9d1d9';
      pre.style.maxHeight = '180px';
      pre.style.overflowY = 'auto';
      pre.style.marginTop = '8px';
      pre.style.padding = '8px';
      pre.style.background = '#131824';
      pre.style.borderRadius = '4px';
      pre.textContent = openMail.body;

      bodyCard.appendChild(topRow);
      bodyCard.appendChild(pre);
      naverMailList.appendChild(bodyCard);
    }

    const listHeader = document.createElement('div');
    listHeader.className = 'hub-section-title';
    listHeader.textContent = `📬 메일 목록 (${mails.length}건)`;
    naverMailList.appendChild(listHeader);

    for (const m of mails) {
      const row = document.createElement('div');
      row.className = 'hub-item';

      const info = document.createElement('div');
      info.className = 'hub-item-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'hub-item-title';
      titleEl.textContent = `${m.unread ? '🔵 [안읽음] ' : ''}${m.subject}`;

      const subEl = document.createElement('div');
      subEl.className = 'hub-item-sub';
      subEl.textContent = `${m.sender || ''}${m.date ? ` · ${m.date}` : ''}`;

      info.appendChild(titleEl);
      info.appendChild(subEl);

      const actions = document.createElement('div');
      actions.className = 'hub-item-actions';

      if (m.url) {
        const readBtn = document.createElement('button');
        readBtn.className = 'btn btn-chip';
        readBtn.textContent = '📖 본문';
        readBtn.title = '이 메일 열기 / 본문 읽기';
        readBtn.addEventListener('click', () => {
          if (data.source === 'cdp-live') {
            fetchNaverMail(m.url);
          } else {
            openTerminalLink(m.url, false);
          }
        });
        actions.appendChild(readBtn);
      }

      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn btn-chip';
      sendBtn.textContent = '🤖 콘솔전달';
      sendBtn.title = '이 메일 정보를 agy 콘솔 프롬프트에 입력';
      sendBtn.addEventListener('click', () => {
        insertTextToActiveConsole(
          `[네이버 메일] 보낸사람: ${m.sender || '-'} | 제목: ${m.subject} | 일시: ${m.date || '-'} `
        );
      });
      actions.appendChild(sendBtn);

      row.appendChild(info);
      row.appendChild(actions);
      naverMailList.appendChild(row);
    }
  }

  async function fetchBrowserBookmarks() {
    if (!browserBookmarksList) return;
    browserBookmarksList.innerHTML =
      '<div class="hub-note">로컬 브라우저(Chrome, Edge, Whale, Brave) 북마크를 스캔 중...</div>';
    try {
      const res = await fetch('/api/browser/bookmarks');
      const data = await res.json();
      cachedBrowserBookmarks = Array.isArray(data.browsers) ? data.browsers : [];
      renderBrowserBookmarksPanel();
    } catch (err) {
      browserBookmarksList.innerHTML = `<div class="hub-note">북마크 조회 실패: ${err.message}</div>`;
    }
  }

  function renderBrowserBookmarksPanel() {
    if (!browserBookmarksList) return;
    browserBookmarksList.innerHTML = '';
    const query = (browserBmSearch?.value || '').trim().toLowerCase();

    if (cachedBrowserBookmarks.length === 0) {
      browserBookmarksList.innerHTML =
        '<div class="hub-note">로컬 브라우저에서 북마크 파일을 찾지 못했습니다.</div>';
      return;
    }

    for (const group of cachedBrowserBookmarks) {
      const filtered = group.items.filter(
        (it) =>
          !query ||
          (it.title && it.title.toLowerCase().includes(query)) ||
          (it.url && it.url.toLowerCase().includes(query)) ||
          (it.folder && it.folder.toLowerCase().includes(query))
      );
      if (filtered.length === 0) continue;

      const header = document.createElement('div');
      header.className = 'hub-section-title';
      header.textContent = `${group.browserName} (${group.profile}) — ${filtered.length}개`;
      browserBookmarksList.appendChild(header);

      for (const item of filtered.slice(0, 120)) {
        const row = document.createElement('div');
        row.className = 'hub-item';

        const info = document.createElement('div');
        info.className = 'hub-item-info';
        const titleEl = document.createElement('div');
        titleEl.className = 'hub-item-title';
        titleEl.textContent = item.title;
        const subEl = document.createElement('div');
        subEl.className = 'hub-item-sub';
        subEl.textContent = `${item.folder ? `[${item.folder}] ` : ''}${item.url}`;
        info.appendChild(titleEl);
        info.appendChild(subEl);

        const actions = document.createElement('div');
        actions.className = 'hub-item-actions';

        const openBtn = document.createElement('button');
        openBtn.className = 'btn btn-chip';
        openBtn.textContent = '🔗';
        openBtn.title = '새 탭에서 열기';
        openBtn.addEventListener('click', () => openTerminalLink(item.url, false));

        const sendBtn = document.createElement('button');
        sendBtn.className = 'btn btn-chip';
        sendBtn.textContent = '⌨️';
        sendBtn.title = '콘솔에 URL 입력';
        sendBtn.addEventListener('click', () => insertTextToActiveConsole(item.url + ' '));

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-chip';
        saveBtn.textContent = '⭐저장';
        saveBtn.title = '내부 북마크로 추가';
        saveBtn.addEventListener('click', async () => {
          await fetch('/api/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: item.title,
              url: item.url,
              category: group.browserName,
            }),
          });
          fetchInternalBookmarks();
        });

        actions.appendChild(openBtn);
        actions.appendChild(sendBtn);
        actions.appendChild(saveBtn);

        row.appendChild(info);
        row.appendChild(actions);
        browserBookmarksList.appendChild(row);
      }
    }
  }

  async function fetchOpenBrowserTabs() {
    if (!openTabsList) return;
    openTabsList.innerHTML =
      '<div class="hub-note">열려 있는 브라우저 창 및 탭 상태를 스캔 중...</div>';
    try {
      const res = await fetch('/api/browser/tabs');
      const data = await res.json();
      openTabsList.innerHTML = '';

      const cdpHeader = document.createElement('div');
      cdpHeader.className = 'hub-section-title';
      cdpHeader.textContent = `🔌 실시간 브라우저 탭 (${(data.cdpTabs || []).length}개)`;
      openTabsList.appendChild(cdpHeader);

      if (Array.isArray(data.cdpTabs) && data.cdpTabs.length > 0) {
        for (const tab of data.cdpTabs) {
          openTabsList.appendChild(
            createTabRow({
              title: tab.title,
              sub: tab.url,
              url: tab.url,
            })
          );
        }
      } else {
        const note = document.createElement('div');
        note.className = 'hub-note';
        note.textContent =
          '브라우저의 모든 개별 탭 URL을 실시간으로 읽으려면 상단의 [🔌 실시간 탭 추적 브라우저 열기]를 클릭하거나 C:\\Users\\meesokim\\agy-web\\extension 확장 프로그램을 로드하세요.';
        openTabsList.appendChild(note);
      }

      const winHeader = document.createElement('div');
      winHeader.className = 'hub-section-title';
      winHeader.textContent = `🪟 현재 열려 있는 브라우저 창 (${(data.windows || []).length}개)`;
      openTabsList.appendChild(winHeader);

      if (Array.isArray(data.windows) && data.windows.length > 0) {
        for (const w of data.windows) {
          openTabsList.appendChild(
            createTabRow({
              title: w.windowTitle,
              sub: `프로세스: ${w.processName}.exe (PID: ${w.pid})`,
              textToInsert: w.windowTitle,
            })
          );
        }
      }

      if (Array.isArray(data.consoleOpenedTabs) && data.consoleOpenedTabs.length > 0) {
        const conHeader = document.createElement('div');
        conHeader.className = 'hub-section-title';
        conHeader.textContent = `⚡ 웹 콘솔에서 연 탭 (${data.consoleOpenedTabs.length}개)`;
        openTabsList.appendChild(conHeader);

        for (const t of data.consoleOpenedTabs) {
          openTabsList.appendChild(
            createTabRow({
              title: t.title,
              sub: t.url,
              url: t.url,
            })
          );
        }
      }

      if (Array.isArray(data.recentSessionUrls) && data.recentSessionUrls.length > 0) {
        const sessHeader = document.createElement('div');
        sessHeader.className = 'hub-section-title';
        sessHeader.textContent = `🕒 브라우저 세션(Session/Tabs) 감지 URL (${data.recentSessionUrls.length}개)`;
        openTabsList.appendChild(sessHeader);

        for (const s of data.recentSessionUrls) {
          openTabsList.appendChild(
            createTabRow({
              title: s.url,
              sub: `${s.browserName} 세션 파일`,
              url: s.url,
            })
          );
        }
      }
    } catch (err) {
      openTabsList.innerHTML = `<div class="hub-note">열린 탭 조회 실패: ${err.message}</div>`;
    }
  }

  function createTabRow({ title, sub, url, textToInsert }) {
    const row = document.createElement('div');
    row.className = 'hub-item';

    const info = document.createElement('div');
    info.className = 'hub-item-info';
    const titleEl = document.createElement('div');
    titleEl.className = 'hub-item-title';
    titleEl.textContent = title;
    const subEl = document.createElement('div');
    subEl.className = 'hub-item-sub';
    subEl.textContent = sub;
    info.appendChild(titleEl);
    info.appendChild(subEl);

    const actions = document.createElement('div');
    actions.className = 'hub-item-actions';

    if (url) {
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-chip';
      openBtn.textContent = '🔗';
      openBtn.title = '열기';
      openBtn.addEventListener('click', () => openTerminalLink(url, false));
      actions.appendChild(openBtn);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-chip';
      saveBtn.textContent = '⭐';
      saveBtn.title = '내부 북마크에 저장';
      saveBtn.addEventListener('click', async () => {
        await fetch('/api/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title || url, url, category: '열린 탭' }),
        });
        fetchInternalBookmarks();
      });
      actions.appendChild(saveBtn);
    }

    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn-chip';
    sendBtn.textContent = '⌨️';
    sendBtn.title = '콘솔에 입력';
    sendBtn.addEventListener('click', () =>
      insertTextToActiveConsole((url || textToInsert || title) + ' ')
    );
    actions.appendChild(sendBtn);

    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  // =========================================================================
  // Joined Naver Cafe Article Search
  // =========================================================================
  const cafeSelectFilter = document.getElementById('cafeSelectFilter');
  const cafeSearchForm = document.getElementById('cafeSearchForm');
  const cafeSearchInput = document.getElementById('cafeSearchInput');
  const btnSyncJoinedCafes = document.getElementById('btnSyncJoinedCafes');
  const btnToggleAddCafeForm = document.getElementById('btnToggleAddCafeForm');
  const btnSendCafeResultsToAgy = document.getElementById('btnSendCafeResultsToAgy');
  const cafeAddForm = document.getElementById('cafeAddForm');
  const cafeAddUrlInput = document.getElementById('cafeAddUrlInput');
  const cafeAddNameInput = document.getElementById('cafeAddNameInput');
  const naverCafeList = document.getElementById('naverCafeList');

  function updateCafeSelectOptions(joinedCafes = []) {
    if (!cafeSelectFilter) return;
    const prevValue = cafeSelectFilter.value;
    cafeSelectFilter.innerHTML = `<option value="">전체 가입 카페 (${joinedCafes.length}개)</option>`;
    for (const c of joinedCafes) {
      const opt = document.createElement('option');
      const val = c.cafeUrl || c.cafeId;
      opt.value = val;
      opt.dataset.cafeId = c.cafeId || '';
      opt.dataset.cafeUrl = c.cafeUrl || '';
      opt.textContent = `${c.cafeName || val}${c.cafeUrl ? ` (${c.cafeUrl})` : ''}`;
      cafeSelectFilter.appendChild(opt);
    }
    if (prevValue) {
      cafeSelectFilter.value = prevValue;
    }
  }

  async function fetchNaverCafe() {
    if (!naverCafeList) return;
    naverCafeList.innerHTML =
      '<div class="hub-note">내가 가입한 네이버 카페 목록을 불러오는 중...</div>';
    try {
      const res = await fetch('/api/naver-cafe');
      const data = await res.json();
      latestNaverCafeData = data;
      updateCafeSelectOptions(data.joinedCafes || []);
      renderNaverCafePanel(data);
    } catch (err) {
      naverCafeList.innerHTML = `<div class="hub-note">네이버 카페 조회 실패: ${err.message}</div>`;
    }
  }

  async function searchNaverCafe(query) {
    if (!naverCafeList) return;
    const selectedOpt = cafeSelectFilter?.selectedOptions?.[0];
    const cafeId = selectedOpt?.dataset?.cafeId || '';
    const cafeUrl = selectedOpt?.dataset?.cafeUrl || cafeSelectFilter?.value || '';

    naverCafeList.innerHTML = `<div class="hub-note">🔍 가입 카페에서 "<b>${query}</b>" 게시글을 검색 중...</div>`;
    try {
      const res = await fetch('/api/naver-cafe/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, cafeId, cafeUrl }),
      });
      const data = await res.json();
      latestNaverCafeData = data;
      updateCafeSelectOptions(data.joinedCafes || []);
      renderNaverCafePanel(data);
    } catch (err) {
      naverCafeList.innerHTML = `<div class="hub-note">가입 카페 검색 오류: ${err.message}</div>`;
    }
  }

  function renderNaverCafePanel(data) {
    if (!naverCafeList) return;
    naverCafeList.innerHTML = '';

    const joinedCafes = Array.isArray(data?.joinedCafes) ? data.joinedCafes : [];
    const articles = Array.isArray(data?.articles) ? data.articles : [];
    const openArticle = data?.openArticle || null;
    const lastQuery = data?.lastQuery || '';

    const statusNote = document.createElement('div');
    statusNote.className = 'hub-note';
    statusNote.innerHTML = `☕ 가입 카페 <b>${joinedCafes.length}개</b> 등록됨 · 검색 결과 <b>${articles.length}건</b>${
      lastQuery ? ` (검색어: "${lastQuery}")` : ''
    }<br/><span style="font-size:11px;color:#8b949e;">Chrome 확장 프로그램(<code>/home/msx/agy-web/extension</code>)을 로드하거나 아래 [+ 가입 카페 직접 등록]으로 카페를 추가하면 가입 카페 글을 즉시 검색합니다.</span>`;
    naverCafeList.appendChild(statusNote);

    if (openArticle && openArticle.body) {
      const openHeader = document.createElement('div');
      openHeader.className = 'hub-section-title';
      openHeader.textContent = '📖 현재 열려 있는 카페 게시글 본문';
      naverCafeList.appendChild(openHeader);

      const card = document.createElement('div');
      card.className = 'hub-item';
      card.style.flexDirection = 'column';
      card.style.alignItems = 'stretch';

      const topRow = document.createElement('div');
      topRow.style.display = 'flex';
      topRow.style.justifyContent = 'space-between';
      topRow.style.alignItems = 'center';
      topRow.style.gap = '8px';

      const tEl = document.createElement('div');
      tEl.className = 'hub-item-title';
      tEl.textContent = openArticle.title || '(제목 없음)';

      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn btn-primary';
      sendBtn.textContent = '🤖 본문 콘솔 전달';
      sendBtn.addEventListener('click', () => {
        insertTextToActiveConsole(
          `[네이버 카페 게시글] 제목: ${openArticle.title || ''} | 작성자: ${
            openArticle.author || ''
          } | 내용: ${openArticle.body.replace(/\r?\n/g, ' ').slice(0, 2000)} `
        );
      });

      topRow.appendChild(tEl);
      topRow.appendChild(sendBtn);

      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.fontSize = '11.5px';
      pre.style.color = '#c9d1d9';
      pre.style.maxHeight = '160px';
      pre.style.overflowY = 'auto';
      pre.style.marginTop = '6px';
      pre.style.padding = '8px';
      pre.style.background = '#131824';
      pre.style.borderRadius = '4px';
      pre.textContent = openArticle.body;

      card.appendChild(topRow);
      card.appendChild(pre);
      naverCafeList.appendChild(card);
    }

    if (articles.length > 0) {
      const artHeader = document.createElement('div');
      artHeader.className = 'hub-section-title';
      artHeader.textContent = `📝 카페 게시글 검색 결과 (${articles.length}건)`;
      naverCafeList.appendChild(artHeader);

      for (const art of articles) {
        const row = document.createElement('div');
        row.className = 'hub-item';

        const info = document.createElement('div');
        info.className = 'hub-item-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'hub-item-title';
        titleEl.textContent = `[${art.cafeName || art.cafeUrl || '카페'}] ${art.title}`;

        const subEl = document.createElement('div');
        subEl.className = 'hub-item-sub';
        const metaParts = [art.author, art.date, art.snippet].filter(Boolean);
        subEl.textContent = metaParts.join(' · ') || art.url;

        info.appendChild(titleEl);
        info.appendChild(subEl);

        const actions = document.createElement('div');
        actions.className = 'hub-item-actions';

        if (art.url) {
          const openBtn = document.createElement('button');
          openBtn.className = 'btn btn-chip';
          openBtn.textContent = '🔗 열기';
          openBtn.addEventListener('click', () => openTerminalLink(art.url, false));
          actions.appendChild(openBtn);
        }

        const sendBtn = document.createElement('button');
        sendBtn.className = 'btn btn-chip';
        sendBtn.textContent = '🤖 콘솔전달';
        sendBtn.addEventListener('click', () => {
          insertTextToActiveConsole(
            `[네이버 카페 글] 카페: ${art.cafeName || art.cafeUrl || '-'} | 제목: ${art.title} | 요약: ${
              art.snippet || '-'
            } | 링크: ${art.url || ''} `
          );
        });
        actions.appendChild(sendBtn);

        row.appendChild(info);
        row.appendChild(actions);
        naverCafeList.appendChild(row);
      }
    } else if (lastQuery) {
      const emptyNote = document.createElement('div');
      emptyNote.className = 'hub-note';
      emptyNote.innerHTML = `"<b>${lastQuery}</b>"에 대한 검색 결과가 없습니다. 브라우저에서 직접 검색 결과를 확인하려면 아래 버튼을 클릭하세요.<br/>`;
      const openBrowserSearchBtn = document.createElement('button');
      openBrowserSearchBtn.className = 'btn btn-subtle';
      openBrowserSearchBtn.style.marginTop = '6px';
      openBrowserSearchBtn.textContent = '🌐 네이버 카페 검색 페이지 열기';
      openBrowserSearchBtn.addEventListener('click', () => {
        const selectedSlug = cafeSelectFilter?.value;
        const targetUrl = selectedSlug
          ? `https://cafe.naver.com/${selectedSlug}?iframe_url=/ArticleSearchList.nhn%3Fsearch.query=${encodeURIComponent(lastQuery)}`
          : `https://section.cafe.naver.com/ca-fe/home/search/articles?q=${encodeURIComponent(lastQuery)}`;
        openTerminalLink(targetUrl, false);
      });
      emptyNote.appendChild(openBrowserSearchBtn);
      naverCafeList.appendChild(emptyNote);
    }

    const cafeHeader = document.createElement('div');
    cafeHeader.className = 'hub-section-title';
    cafeHeader.textContent = `🏘️ 내 가입 카페 목록 (${joinedCafes.length}개)`;
    naverCafeList.appendChild(cafeHeader);

    if (joinedCafes.length === 0) {
      const noCafe = document.createElement('div');
      noCafe.className = 'hub-note';
      noCafe.textContent =
        '등록된 가입 카페가 없습니다. 상단 [+ 가입 카페 직접 등록] 버튼을 눌러 자주 찾는 카페 주소(예: https://cafe.naver.com/중고나라)를 추가하거나, 브라우저에서 네이버 카페 홈(section.cafe.naver.com)을 열어 동기화하세요.';
      naverCafeList.appendChild(noCafe);
    } else {
      for (const c of joinedCafes) {
        const row = document.createElement('div');
        row.className = 'hub-item';

        const info = document.createElement('div');
        info.className = 'hub-item-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'hub-item-title';
        titleEl.textContent = `${c.cafeName}${c.memberLevelName ? ` (${c.memberLevelName})` : ''}`;

        const subEl = document.createElement('div');
        subEl.className = 'hub-item-sub';
        subEl.textContent = c.url || c.cafeUrl || c.cafeId;

        info.appendChild(titleEl);
        info.appendChild(subEl);

        const actions = document.createElement('div');
        actions.className = 'hub-item-actions';

        const filterBtn = document.createElement('button');
        filterBtn.className = 'btn btn-chip';
        filterBtn.textContent = '🔍 이 카페 선택';
        filterBtn.addEventListener('click', () => {
          if (cafeSelectFilter) {
            cafeSelectFilter.value = c.cafeUrl || c.cafeId;
            cafeSearchInput?.focus();
          }
        });
        actions.appendChild(filterBtn);

        if (c.url) {
          const openBtn = document.createElement('button');
          openBtn.className = 'btn btn-chip';
          openBtn.textContent = '🔗';
          openBtn.title = '카페 열기';
          openBtn.addEventListener('click', () => openTerminalLink(c.url, false));
          actions.appendChild(openBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-chip';
        delBtn.textContent = '🗑️';
        delBtn.title = '목록에서 제거';
        delBtn.addEventListener('click', async () => {
          const key = c.cafeUrl || c.cafeId;
          const res = await fetch(`/api/naver-cafe/cafes/${encodeURIComponent(key)}`, {
            method: 'DELETE',
          });
          const updated = await res.json();
          if (latestNaverCafeData) {
            latestNaverCafeData.joinedCafes = updated.joinedCafes || [];
            updateCafeSelectOptions(latestNaverCafeData.joinedCafes);
            renderNaverCafePanel(latestNaverCafeData);
          }
        });
        actions.appendChild(delBtn);

        row.appendChild(info);
        row.appendChild(actions);
        naverCafeList.appendChild(row);
      }
    }
  }

  // =========================================================================
  // Web Input History Log & Chronological Summary
  // =========================================================================
  const inputHistorySearch = document.getElementById('inputHistorySearch');
  const inputHistorySessionFilter = document.getElementById('inputHistorySessionFilter');
  const btnRefreshInputHistory = document.getElementById('btnRefreshInputHistory');
  const btnDownloadInputHistory = document.getElementById('btnDownloadInputHistory');
  const btnClearInputHistory = document.getElementById('btnClearInputHistory');
  const inputHistoryList = document.getElementById('inputHistoryList');
  const btnOpenHistorySummary = document.getElementById('btnOpenHistorySummary');
  const btnToggleHistorySort = document.getElementById('btnToggleHistorySort');
  const btnHermesQuickHistorySummary = document.getElementById('btnHermesQuickHistorySummary');

  // History Summary Modal
  const historySummaryModal = document.getElementById('historySummaryModal');
  const historySummaryBadge = document.getElementById('historySummaryBadge');
  const summaryStatsBar = document.getElementById('summaryStatsBar');
  const summaryTimelineList = document.getElementById('summaryTimelineList');
  const summaryMarkdownContent = document.getElementById('summaryMarkdownContent');
  const btnCloseHistorySummary = document.getElementById('btnCloseHistorySummary');
  const btnSendHistoryToAgent = document.getElementById('btnSendHistoryToAgent');
  const btnCopyHistorySummary = document.getElementById('btnCopyHistorySummary');
  const btnDownloadHistorySummary = document.getElementById('btnDownloadHistorySummary');

  let historySortOrder = 'desc'; // 'desc' = 최신순, 'asc' = 시간순 (과거순)
  let cachedSummaryData = null;

  async function fetchInputHistory() {
    if (!inputHistoryList) return;
    try {
      const res = await fetch('/api/input-history');
      const data = await res.json();
      cachedInputHistory = Array.isArray(data.history) ? data.history : [];
      renderInputHistoryPanel();
    } catch (err) {
      inputHistoryList.innerHTML = `<div class="hub-note">입력 히스토리 조회 실패: ${err.message}</div>`;
    }
  }

  function renderInputHistoryPanel() {
    if (!inputHistoryList) return;
    inputHistoryList.innerHTML = '';

    const kw = (inputHistorySearch?.value || '').trim().toLowerCase();
    const currentOnly = Boolean(inputHistorySessionFilter?.checked);

    const filtered = cachedInputHistory.filter((item) => {
      if (currentOnly && activeSessionId && item.sessionId !== activeSessionId) {
        return false;
      }
      if (kw) {
        const hay = `${item.text || ''} ${item.sessionTitle || ''} ${item.cwd || ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    // Sort order: 'asc' = 과거순 (시간순), 'desc' = 최신순
    filtered.sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime();
      const tb = new Date(b.createdAt || 0).getTime();
      return historySortOrder === 'asc' ? ta - tb : tb - ta;
    });

    if (btnToggleHistorySort) {
      btnToggleHistorySort.textContent = historySortOrder === 'asc' ? '⬆️ 과거순 (시간순)' : '⬇️ 최신순';
    }

    if (filtered.length === 0) {
      inputHistoryList.innerHTML =
        '<div class="hub-note">기록된 웹 콘솔 입력 히스토리가 없습니다. 웹 터미널이나 에이전트 입력창에서 명령어나 프롬프트를 입력하고 전송하면 자동으로 이곳에 기록됩니다.</div>';
      return;
    }

    const summaryHeader = document.createElement('div');
    summaryHeader.className = 'hub-section-title';
    summaryHeader.textContent = `📜 웹 입력 히스토리 로그 (${filtered.length}건, ${historySortOrder === 'asc' ? '과거순' : '최신순'})`;
    inputHistoryList.appendChild(summaryHeader);

    for (const item of filtered) {
      const row = document.createElement('div');
      row.className = 'hub-item';

      const info = document.createElement('div');
      info.className = 'hub-item-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'hub-item-title';
      titleEl.style.fontFamily = '"Cascadia Code", "JetBrains Mono", "D2Coding", monospace';
      titleEl.style.whiteSpace = 'pre-wrap';
      titleEl.style.wordBreak = 'break-all';
      titleEl.textContent = item.text;

      const subEl = document.createElement('div');
      subEl.className = 'hub-item-sub';
      const timeStr = item.createdAt ? new Date(item.createdAt).toLocaleString('ko-KR') : '';
      subEl.textContent = `${timeStr} · ${item.sessionTitle || item.sessionId} (${item.cwd || '~'})`;

      info.appendChild(titleEl);
      info.appendChild(subEl);

      const actions = document.createElement('div');
      actions.className = 'hub-item-actions';

      const insertBtn = document.createElement('button');
      insertBtn.className = 'btn btn-chip';
      insertBtn.textContent = '⌨️ 입력';
      insertBtn.title = '현재 콘솔에 텍스트 붙여넣기 (Enter 제외)';
      insertBtn.addEventListener('click', () => insertTextToActiveConsole(item.text));

      const runBtn = document.createElement('button');
      runBtn.className = 'btn btn-chip';
      runBtn.textContent = '🚀 실행';
      runBtn.title = '현재 콘솔에 입력 후 즉시 실행 (Enter 포함)';
      runBtn.addEventListener('click', () => insertTextToActiveConsole(item.text + '\r'));

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-chip';
      copyBtn.textContent = '📋';
      copyBtn.title = '클립보드에 복사';
      copyBtn.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(item.text).catch(() => {});
        }
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-chip';
      delBtn.textContent = '🗑️';
      delBtn.title = '이 기록 삭제';
      delBtn.addEventListener('click', async () => {
        await fetch(`/api/input-history/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        cachedInputHistory = cachedInputHistory.filter((h) => h.id !== item.id);
        renderInputHistoryPanel();
      });

      actions.appendChild(insertBtn);
      actions.appendChild(runBtn);
      actions.appendChild(copyBtn);
      actions.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(actions);
      inputHistoryList.appendChild(row);
    }
  }

  async function openHistorySummaryModal() {
    if (!historySummaryModal) return;
    historySummaryModal.hidden = false;
    if (historySummaryBadge) historySummaryBadge.textContent = '분석 중...';
    if (summaryStatsBar) summaryStatsBar.innerHTML = '<div class="hub-note">시간순 요약 데이터를 집계하고 분석하는 중입니다...</div>';
    if (summaryTimelineList) summaryTimelineList.innerHTML = '<div class="hub-note">타임라인 구성 중...</div>';
    if (summaryMarkdownContent) summaryMarkdownContent.textContent = '보고서 생성 중...';

    try {
      const currentOnly = Boolean(inputHistorySessionFilter?.checked);
      const sessionParam = currentOnly && activeSessionId ? `&sessionId=${encodeURIComponent(activeSessionId)}` : '';
      const res = await fetch(`/api/input-history/summary?order=asc${sessionParam}`);
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || '요약 데이터 로드 실패');

      const data = json.summary;
      cachedSummaryData = data;

      // Update badge & stats
      if (historySummaryBadge) {
        historySummaryBadge.textContent = `총 ${data.totalCount}건 분석 완료`;
      }

      const stats = data.statistics;
      if (summaryStatsBar) {
        summaryStatsBar.innerHTML = `
          <span class="stat-pill accent">총 <strong>${stats.total}</strong>건</span>
          <span class="stat-pill success">💬 에이전트 지시 <strong>${stats.promptCount}</strong>건</span>
          <span class="stat-pill">🚀 CLI 명령 <strong>${stats.commandCount}</strong>건</span>
          <span class="stat-pill warning">💡 슬래시 <strong>${stats.slashCount}</strong>건</span>
          <span class="stat-pill">🕒 분석 기간: <strong>${stats.dateRange.start} ~ ${stats.dateRange.end}</strong></span>
        `;
      }

      // Render Timeline
      if (summaryTimelineList) {
        summaryTimelineList.innerHTML = '';
        if (!Array.isArray(data.dateGroups) || data.dateGroups.length === 0) {
          summaryTimelineList.innerHTML = '<div class="hub-note">분석할 입력 히스토리 데이터가 없습니다.</div>';
        } else {
          for (const dg of data.dateGroups) {
            const dgEl = document.createElement('div');
            dgEl.className = 'timeline-date-group';

            const headerEl = document.createElement('div');
            headerEl.className = 'timeline-date-header';
            const dateItemsCount = dg.blocks.reduce((acc, b) => acc + b.items.length, 0);
            headerEl.innerHTML = `<span>🗓️ ${escapeHtml(dg.dateLabel)}</span> <span style="font-size:11px;color:var(--text-secondary);font-weight:normal;">(${dateItemsCount}건)</span>`;
            dgEl.appendChild(headerEl);

            for (let bi = 0; bi < dg.blocks.length; bi++) {
              const b = dg.blocks[bi];
              const timeSpan = b.startTime === b.endTime ? b.startTime : `${b.startTime} ~ ${b.endTime}`;
              const blockEl = document.createElement('div');
              blockEl.className = 'timeline-block-card';

              blockEl.innerHTML = `
                <div class="timeline-block-header">
                  <span class="timeline-block-time">🕒 세션 ${bi + 1}: ${escapeHtml(timeSpan)}</span>
                  <span class="timeline-block-session">${escapeHtml(b.sessionTitle)} (${b.items.length}개 작업)</span>
                </div>
                <div class="timeline-block-items"></div>
              `;

              const itemsContainer = blockEl.querySelector('.timeline-block-items');
              for (const it of b.items) {
                const itemRow = document.createElement('div');
                itemRow.className = 'timeline-item';
                const timeStr = it.createdAt ? new Date(it.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                const icon = it.type === 'prompt' ? '💬' : it.type === 'command' ? '🚀' : '💡';
                const repeat = it.repeatCount > 1 ? `<span class="timeline-item-repeat">(×${it.repeatCount}회)</span>` : '';

                itemRow.innerHTML = `
                  <div class="timeline-item-left">
                    <span class="timeline-item-time">[${timeStr}]</span>
                    <span class="item-type-badge ${it.type}">${icon} ${escapeHtml(it.typeLabel)}</span>
                    <div class="timeline-item-text">${escapeHtml(it.text)}${repeat}</div>
                  </div>
                  <div class="timeline-item-actions">
                    <button type="button" class="btn btn-chip btn-sm" title="콘솔 입력창에 삽입" data-act="input">⌨️</button>
                    <button type="button" class="btn btn-chip btn-sm" title="클립보드 복사" data-act="copy">📋</button>
                  </div>
                `;

                itemRow.querySelector('[data-act="input"]').addEventListener('click', () => {
                  insertTextToActiveConsole(it.text);
                  historySummaryModal.hidden = true;
                });
                itemRow.querySelector('[data-act="copy"]').addEventListener('click', () => {
                  if (navigator.clipboard) navigator.clipboard.writeText(it.text);
                });

                itemsContainer.appendChild(itemRow);
              }

              dgEl.appendChild(blockEl);
            }
            summaryTimelineList.appendChild(dgEl);
          }
        }
      }

      // Render Markdown
      if (summaryMarkdownContent) {
        summaryMarkdownContent.textContent = data.markdown || '';
      }
    } catch (err) {
      if (summaryStatsBar) {
        summaryStatsBar.innerHTML = `<div class="hub-note" style="color:var(--danger)">오류: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  // Summary Modal Event Listeners
  btnOpenHistorySummary?.addEventListener('click', () => {
    openHistorySummaryModal();
  });

  btnToggleHistorySort?.addEventListener('click', () => {
    historySortOrder = historySortOrder === 'desc' ? 'asc' : 'desc';
    renderInputHistoryPanel();
  });

  btnHermesQuickHistorySummary?.addEventListener('click', () => {
    openHistorySummaryModal();
  });

  btnCloseHistorySummary?.addEventListener('click', () => {
    if (historySummaryModal) historySummaryModal.hidden = true;
  });

  historySummaryModal?.addEventListener('click', (ev) => {
    if (ev.target === historySummaryModal) {
      historySummaryModal.hidden = true;
    }
  });

  btnCopyHistorySummary?.addEventListener('click', () => {
    if (!cachedSummaryData || !cachedSummaryData.markdown) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(cachedSummaryData.markdown).then(() => {
        const orig = btnCopyHistorySummary.textContent;
        btnCopyHistorySummary.textContent = '✓ 복사됨';
        setTimeout(() => { btnCopyHistorySummary.textContent = orig; }, 1500);
      });
    }
  });

  btnDownloadHistorySummary?.addEventListener('click', () => {
    if (!cachedSummaryData || !cachedSummaryData.markdown) return;
    const blob = new Blob([cachedSummaryData.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `input-history-summary-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  btnSendHistoryToAgent?.addEventListener('click', () => {
    if (!cachedSummaryData || !cachedSummaryData.aiPrompt) return;
    const prompt = cachedSummaryData.aiPrompt;

    if (historySummaryModal) historySummaryModal.hidden = true;
    if (hubDrawer) hubDrawer.hidden = true;

    if (currentViewMode === 'hermes') {
      if (hermesPromptInput) {
        hermesPromptInput.value = prompt;
        hermesPromptInput.style.height = 'auto';
        hermesPromptInput.style.height = `${Math.min(hermesPromptInput.scrollHeight, 140)}px`;
        dispatchHermesPrompt(prompt);
      }
    } else {
      insertTextToActiveConsole(prompt + '\r');
    }
  });

  const summaryTabs = document.querySelectorAll('.summary-tab');
  for (const tab of summaryTabs) {
    tab.addEventListener('click', () => {
      const target = tab.dataset.summaryTab;
      for (const t of summaryTabs) t.classList.toggle('active', t === tab);
      const timelineView = document.getElementById('summaryViewTimeline');
      const mdView = document.getElementById('summaryViewMarkdown');
      if (timelineView) timelineView.classList.toggle('active', target === 'timeline');
      if (timelineView) timelineView.hidden = target !== 'timeline';
      if (mdView) mdView.classList.toggle('active', target === 'markdown');
      if (mdView) mdView.hidden = target !== 'markdown';
    });
  }

  function switchHubTab(tabName) {
    hubDrawer.hidden = false;
    for (const btn of hubTabs) {
      btn.classList.toggle('active', btn.dataset.hubTab === tabName);
    }
    hubPanelInternal.hidden = tabName !== 'internal';
    if (hubPanelNaverMail) hubPanelNaverMail.hidden = tabName !== 'naver-mail';
    if (hubPanelNaverCafe) hubPanelNaverCafe.hidden = tabName !== 'naver-cafe';
    if (hubPanelInputHistory) hubPanelInputHistory.hidden = tabName !== 'input-history';
    if (hubPanelImages) hubPanelImages.hidden = tabName !== 'images';
    hubPanelBrowserBm.hidden = tabName !== 'browser-bm';
    hubPanelOpenTabs.hidden = tabName !== 'open-tabs';

    if (tabName === 'internal') {
      fetchInternalBookmarks();
    } else if (tabName === 'naver-mail') {
      fetchNaverMail();
    } else if (tabName === 'naver-cafe') {
      fetchNaverCafe();
      setTimeout(() => cafeSearchInput?.focus(), 50);
    } else if (tabName === 'input-history') {
      fetchInputHistory();
    } else if (tabName === 'images') {
      fetchImagesGallery();
      setTimeout(() => imagePathInput?.focus(), 50);
    } else if (tabName === 'browser-bm') {
      fetchBrowserBookmarks();
    } else if (tabName === 'open-tabs') {
      fetchOpenBrowserTabs();
    }
  }

  btnToggleHub?.addEventListener('click', () => {
    if (hubDrawer.hidden) {
      switchHubTab('internal');
    } else {
      hubDrawer.hidden = true;
    }
  });

  btnQuickAddBookmark?.addEventListener('click', () => {
    switchHubTab('internal');
    bmInputTitle?.focus();
  });

  document.getElementById('btnOpenNaverMailReader')?.addEventListener('click', () => {
    switchHubTab('naver-mail');
  });

  document.getElementById('btnOpenNaverCafeSearch')?.addEventListener('click', () => {
    switchHubTab('naver-cafe');
  });

  document.getElementById('btnOpenInputHistory')?.addEventListener('click', () => {
    switchHubTab('input-history');
  });

  document.getElementById('btnOpenImageGallery')?.addEventListener('click', () => {
    switchHubTab('images');
  });

  imageOpenForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const val = imagePathInput?.value?.trim();
    if (!val) return;
    const isHttp = /^https?:\/\//i.test(val);
    const res = await fetch('/api/show-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isHttp ? { url: val } : { path: val }),
    });
    if (res.ok) {
      imagePathInput.value = '';
      fetchImagesGallery();
    } else {
      // Fallback: render directly even if server wasn't restarted yet
      const entry = {
        src: isHttp ? val : `/api/local-image?path=${encodeURIComponent(val)}`,
        filePath: isHttp ? '' : val,
        url: isHttp ? val : '',
        title: val.split(/[\\/]/).pop() || '이미지',
      };
      showImageInDock(entry);
    }
  });

  document.getElementById('btnRefreshNaverMail')?.addEventListener('click', () => {
    fetchNaverMail();
  });

  cafeSearchForm?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = cafeSearchInput?.value?.trim();
    if (!q) return;
    searchNaverCafe(q);
  });

  btnSyncJoinedCafes?.addEventListener('click', () => {
    fetchNaverCafe();
  });

  btnToggleAddCafeForm?.addEventListener('click', () => {
    if (cafeAddForm) {
      cafeAddForm.hidden = !cafeAddForm.hidden;
      if (!cafeAddForm.hidden) cafeAddUrlInput?.focus();
    }
  });

  cafeAddForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cafeUrl = cafeAddUrlInput?.value?.trim();
    const cafeName = cafeAddNameInput?.value?.trim();
    if (!cafeUrl) return;
    const res = await fetch('/api/naver-cafe/cafes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cafeUrl, cafeName }),
    });
    if (res.ok) {
      const data = await res.json();
      cafeAddUrlInput.value = '';
      cafeAddNameInput.value = '';
      cafeAddForm.hidden = true;
      if (!latestNaverCafeData) latestNaverCafeData = {};
      latestNaverCafeData.joinedCafes = data.joinedCafes || [];
      updateCafeSelectOptions(latestNaverCafeData.joinedCafes);
      renderNaverCafePanel(latestNaverCafeData);
    }
  });

  btnSendCafeResultsToAgy?.addEventListener('click', () => {
    const articles = latestNaverCafeData?.articles || [];
    if (articles.length === 0) {
      alert('먼저 가입 카페 게시글을 검색해 주세요.');
      return;
    }
    const summary = articles
      .slice(0, 12)
      .map(
        (a, i) =>
          `${i + 1}. [${a.cafeName || a.cafeUrl || '카페'}] ${a.title} (${a.url || ''})`
      )
      .join(' / ');
    insertTextToActiveConsole(
      `다음은 내가 가입한 네이버 카페에서 "${latestNaverCafeData?.lastQuery || ''}"로 검색한 게시글 목록이야: ${summary} — 핵심 내용을 정리해줘.`
    );
  });

  inputHistorySearch?.addEventListener('input', () => renderInputHistoryPanel());
  inputHistorySessionFilter?.addEventListener('change', () => renderInputHistoryPanel());
  btnRefreshInputHistory?.addEventListener('click', () => fetchInputHistory());

  btnDownloadInputHistory?.addEventListener('click', () => {
    if (cachedInputHistory.length === 0) {
      alert('다운로드할 입력 히스토리가 없습니다.');
      return;
    }
    const lines = cachedInputHistory.map(
      (item) =>
        `[${item.createdAt || ''}] (${item.sessionTitle || item.sessionId} @ ${item.cwd || ''}) ${item.text}`
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agy-web-input-history-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  btnClearInputHistory?.addEventListener('click', async () => {
    if (!confirm('웹 입력 히스토리 로그를 모두 삭제하시겠습니까?')) return;
    await fetch('/api/input-history', { method: 'DELETE' });
    cachedInputHistory = [];
    renderInputHistoryPanel();
  });

  document.getElementById('btnSendAllMailsToAgy')?.addEventListener('click', () => {
    const mails = latestNaverMailData?.mails || [];
    if (mails.length === 0) {
      alert('먼저 네이버 메일 목록을 불러와 주세요.');
      return;
    }
    const summary = mails
      .slice(0, 15)
      .map(
        (m, i) =>
          `${i + 1}. ${m.unread ? '[안읽음]' : '[읽음]'} ${m.subject} (보낸사람: ${m.sender || '-'}, ${
            m.date || ''
          })`
      )
      .join(' / ');
    insertTextToActiveConsole(
      `다음은 내 네이버 메일함 최근 목록이야: ${summary} — 중요한 메일 요약해줘.`
    );
  });

  btnOpenTabsInspector?.addEventListener('click', () => {
    switchHubTab('open-tabs');
  });

  btnCloseHub?.addEventListener('click', () => {
    hubDrawer.hidden = true;
  });

  for (const btn of hubTabs) {
    btn.addEventListener('click', () => switchHubTab(btn.dataset.hubTab));
  }

  bmAddForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = bmInputTitle.value.trim();
    const url = bmInputUrl.value.trim();
    const category = bmInputCategory.value.trim() || '기본';
    if (!url) return;
    await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, url, category }),
    });
    bmInputTitle.value = '';
    bmInputUrl.value = '';
    fetchInternalBookmarks();
  });

  browserBmSearch?.addEventListener('input', () => renderBrowserBookmarksPanel());
  btnRefreshBrowserBm?.addEventListener('click', () => fetchBrowserBookmarks());
  btnRefreshOpenTabs?.addEventListener('click', () => fetchOpenBrowserTabs());

  btnLaunchCdpBrowser?.addEventListener('click', async () => {
    await fetch('/api/browser/launch-cdp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome' }),
    });
    setTimeout(() => fetchOpenBrowserTabs(), 1500);
  });

  // ==========================================================================
  // Hermes Desktop Agent Integration
  // ==========================================================================

  const STORAGE_VIEW_MODE_KEY = 'agy_web_view_mode';
  let currentViewMode = localStorage.getItem(STORAGE_VIEW_MODE_KEY) || 'hermes';

  const workspaceContainer = document.getElementById('workspaceContainer');
  const viewModeSelector = document.getElementById('viewModeSelector');
  const hermesWorkspace = document.getElementById('hermesWorkspace');
  const terminalStageContainer = document.getElementById('terminalStageContainer');
  const railTerminalHost = document.getElementById('railTerminalHost');

  // Hermes Left Sidebar & Status Elements
  const hermesStatusBadge = document.getElementById('hermesStatusBadge');
  const hermesAgentSub = document.getElementById('hermesAgentSub');
  const hermesModelSelect = document.getElementById('hermesModelSelect');
  const hermesCwdDisplay = document.getElementById('hermesCwdDisplay');
  const btnRefreshWorkspaceDir = document.getElementById('btnRefreshWorkspaceDir');
  const hermesStatToolCount = document.getElementById('hermesStatToolCount');
  const hermesStatState = document.getElementById('hermesStatState');

  // Hermes Chat Feed & Composer
  const hermesChatFeed = document.getElementById('hermesChatFeed');
  const hermesWelcomeCard = document.getElementById('hermesWelcomeCard');
  const composerModelTag = document.getElementById('composerModelTag');
  const composerStatusText = document.getElementById('composerStatusText');
  const hermesPromptInput = document.getElementById('hermesPromptInput');
  const btnHermesSend = document.getElementById('btnHermesSend');
  const btnHermesInterrupt = document.getElementById('btnHermesInterrupt');

  // Hermes Rail Elements
  const hermesRailTabs = document.querySelectorAll('.hermes-rail-tab');
  const hermesRailPanels = document.querySelectorAll('.hermes-rail-panel');
  const btnPopoutTerminal = document.getElementById('btnPopoutTerminal');
  const railFilesPath = document.getElementById('railFilesPath');
  const btnRailFilesParent = document.getElementById('btnRailFilesParent');
  const btnRailFilesRefresh = document.getElementById('btnRailFilesRefresh');
  const railFileTree = document.getElementById('railFileTree');
  const railAuditList = document.getElementById('railAuditList');
  const btnRailAuditClear = document.getElementById('btnRailAuditClear');
  const railPreviewBody = document.getElementById('railPreviewBody');

  // File Viewer Modal
  const fileViewerModal = document.getElementById('fileViewerModal');
  const fileViewerTitle = document.getElementById('fileViewerTitle');
  const fileViewerContent = document.getElementById('fileViewerContent');
  const btnCloseFileViewer = document.getElementById('btnCloseFileViewer');

  let currentRailDir = defaultCwd;
  let currentRailParent = null;
  const renderedMessageIds = new Set();
  const renderedToolIds = new Set();

  function escapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setViewMode(mode) {
    currentViewMode = mode;
    localStorage.setItem(STORAGE_VIEW_MODE_KEY, mode);
    if (workspaceContainer) {
      workspaceContainer.dataset.viewMode = mode;
    }

    // Update active button
    if (viewModeSelector) {
      for (const btn of viewModeSelector.querySelectorAll('.view-mode-btn')) {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      }
    }

    // Dock or undock terminalStage
    if (terminalStage) {
      if (mode === 'hermes' && railTerminalHost) {
        if (!railTerminalHost.contains(terminalStage)) {
          railTerminalHost.appendChild(terminalStage);
        }
      } else if (terminalStageContainer) {
        if (!terminalStageContainer.contains(terminalStage)) {
          terminalStageContainer.appendChild(terminalStage);
        }
      }
    }

    setTimeout(() => {
      fitActiveTerminal();
    }, 50);
  }

  function handleHermesAgentStatus(data) {
    if (!data) return;
    const status = data.status || 'idle';
    const currentTool = data.currentTool || null;

    if (hermesStatusBadge) {
      hermesStatusBadge.className = `hermes-status-badge ${status === 'tool_executing' ? 'tool' : status}`;
      hermesStatusBadge.textContent =
        status === 'tool_executing' ? '도구 실행' : status === 'thinking' ? '사고 중' : '대기 중';
    }

    if (hermesAgentSub) {
      hermesAgentSub.textContent =
        status === 'tool_executing' && currentTool ? currentTool : 'Antigravity CLI Core';
    }

    if (composerStatusText) {
      composerStatusText.textContent =
        status === 'tool_executing' && currentTool
          ? `실행 중: ${currentTool}`
          : status === 'thinking'
          ? '추론 및 생각 중...'
          : '대기 중';
    }

    if (hermesStatState) {
      hermesStatState.textContent =
        status === 'tool_executing' ? '도구 실행' : status === 'thinking' ? '추론 진행' : '준비 완료';
    }

    if (Array.isArray(data.recentToolCalls)) {
      if (hermesStatToolCount) {
        hermesStatToolCount.textContent = `${data.recentToolCalls.length}회`;
      }
      renderAuditLog(data.recentToolCalls);
      // Also render active or recent tool call in chat feed
      for (const tc of data.recentToolCalls.slice(0, 5).reverse()) {
        appendHermesToolCard(tc);
      }
    }
  }

  function handleHermesPromptDispatched(msg) {
    if (!msg || !msg.entry) return;
    appendHermesMessage(msg.entry);
  }

  function appendHermesMessage(entry) {
    if (!hermesChatFeed || !entry) return;
    if (entry.id && renderedMessageIds.has(entry.id)) return;
    if (entry.id) renderedMessageIds.add(entry.id);

    if (hermesWelcomeCard) {
      hermesWelcomeCard.style.display = 'none';
    }

    const isUser = entry.role === 'user';
    const msgEl = document.createElement('div');
    msgEl.className = `hermes-message ${isUser ? 'user' : 'agent'}`;

    const timeStr = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    msgEl.innerHTML = `
      <div class="hermes-message-header">
        <span>${isUser ? '👤 사용자' : '🏛️ Hermes Agent'}</span>
        ${entry.model ? `<span class="composer-tag">${escapeHtml(entry.model)}</span>` : ''}
        <span>${timeStr}</span>
      </div>
      <div class="hermes-message-bubble">${escapeHtml(entry.content).replace(/\n/g, '<br/>')}</div>
    `;

    hermesChatFeed.appendChild(msgEl);
    hermesChatFeed.scrollTop = hermesChatFeed.scrollHeight;
  }

  function appendHermesToolCard(tool) {
    if (!hermesChatFeed || !tool || !tool.id) return;

    if (hermesWelcomeCard) {
      hermesWelcomeCard.style.display = 'none';
    }

    let existingCard = hermesChatFeed.querySelector(`[data-tool-id="${tool.id}"]`);
    if (existingCard) {
      // Update status
      existingCard.className = `hermes-tool-card ${tool.status || 'completed'}`;
      const statusPill = existingCard.querySelector('.tool-status-pill');
      if (statusPill) {
        statusPill.className = `tool-status-pill ${tool.status || 'completed'}`;
        statusPill.textContent = tool.status === 'running' ? '실행 중' : '완료됨';
      }
      return;
    }

    renderedToolIds.add(tool.id);
    const card = document.createElement('div');
    card.className = `hermes-tool-card ${tool.status || 'completed'}`;
    card.dataset.toolId = tool.id;

    card.innerHTML = `
      <div class="tool-header">
        <div class="tool-left">
          <span class="tool-action-badge">● ${escapeHtml(tool.action || 'Tool')}</span>
          <span class="tool-target-text">${escapeHtml(tool.target || '')}</span>
        </div>
        <span class="tool-status-pill ${tool.status || 'completed'}">
          ${tool.status === 'running' ? '실행 중' : '완료됨'}
        </span>
      </div>
      <div class="tool-body" hidden>도구 실행 명령: ${escapeHtml(tool.action)} ${escapeHtml(tool.target || '')}</div>
    `;

    card.querySelector('.tool-header').addEventListener('click', () => {
      const body = card.querySelector('.tool-body');
      body.hidden = !body.hidden;
    });

    hermesChatFeed.appendChild(card);
    hermesChatFeed.scrollTop = hermesChatFeed.scrollHeight;
  }

  function renderHermesHistoryItem(item) {
    if (!item) return;
    if (item.role === 'user' || item.role === 'agent') {
      appendHermesMessage(item);
    } else if (item.toolInfo) {
      appendHermesToolCard(item.toolInfo);
    }
  }

  function renderAuditLog(toolCalls) {
    if (!railAuditList || !Array.isArray(toolCalls)) return;
    railAuditList.innerHTML = '';
    if (toolCalls.length === 0) {
      railAuditList.innerHTML = '<div class="rail-preview-empty">아직 실행된 도구가 없습니다.</div>';
      return;
    }

    for (const tc of toolCalls) {
      const item = document.createElement('div');
      item.className = 'audit-item';
      const timeStr = tc.timestamp ? new Date(tc.timestamp).toLocaleTimeString() : '';
      item.innerHTML = `
        <div class="audit-item-header">
          <span class="tool-action-badge">${escapeHtml(tc.action || 'Tool')}</span>
          <span class="audit-item-time">${timeStr}</span>
        </div>
        <div class="audit-item-target">${escapeHtml(tc.target || '')}</div>
      `;
      railAuditList.appendChild(item);
    }
  }

  async function loadWorkspaceFiles(targetDir) {
    if (!railFileTree) return;
    const session = activeSessionId ? clientSessions.get(activeSessionId)?.meta : null;
    const baseDir = targetDir || (session ? session.cwd : defaultCwd);
    railFileTree.innerHTML = '<div class="rail-preview-empty">파일 목록 불러오는 중...</div>';

    try {
      const res = await fetch(`/api/hermes/workspace?dir=${encodeURIComponent(baseDir)}&sessionId=${activeSessionId || ''}`);
      if (!res.ok) throw new Error('디렉토리 읽기 실패');
      const data = await res.json();
      currentRailDir = data.cwd;
      currentRailParent = data.parent;

      if (railFilesPath) {
        railFilesPath.textContent = data.cwd;
      }
      if (hermesCwdDisplay) {
        hermesCwdDisplay.textContent = data.cwd;
      }

      railFileTree.innerHTML = '';
      if (!Array.isArray(data.items) || data.items.length === 0) {
        railFileTree.innerHTML = '<div class="rail-preview-empty">폴더가 비어 있습니다.</div>';
        return;
      }

      for (const item of data.items) {
        const el = document.createElement('div');
        el.className = `tree-item ${item.isDirectory ? 'directory' : 'file'}`;
        const icon = item.isDirectory ? '📁' : getFileIcon(item.ext);
        const sizeStr = item.isDirectory ? '' : formatFileSize(item.size);

        el.innerHTML = `
          <div class="tree-item-main">
            <span>${icon}</span>
            <span>${escapeHtml(item.name)}</span>
          </div>
          <span class="tree-item-size">${sizeStr}</span>
        `;

        el.addEventListener('click', () => {
          if (item.isDirectory) {
            loadWorkspaceFiles(item.path);
          } else {
            openFileInspection(item.path);
          }
        });

        railFileTree.appendChild(el);
      }
    } catch (err) {
      railFileTree.innerHTML = `<div class="rail-preview-empty" style="color:var(--danger)">${escapeHtml(err.message)}</div>`;
    }
  }

  function getFileIcon(ext) {
    if (!ext) return '📄';
    const map = {
      '.js': '🟨',
      '.ts': '🔷',
      '.json': '📋',
      '.html': '🌐',
      '.css': '🎨',
      '.md': '📝',
      '.png': '🖼️',
      '.jpg': '🖼️',
      '.jpeg': '🖼️',
      '.svg': '🎨',
      '.sh': '⚡',
      '.py': '🐍',
    };
    return map[ext] || '📄';
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function openFileInspection(filePath) {
    if (!fileViewerModal || !fileViewerTitle || !fileViewerContent) return;
    fileViewerTitle.textContent = `📄 ${filePath.split('/').pop() || filePath}`;
    fileViewerContent.textContent = '파일 내용을 불러오는 중...';
    fileViewerModal.hidden = false;

    try {
      const res = await fetch(`/api/hermes/file?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '파일 읽기 실패');
      fileViewerContent.textContent = data.content || '';
    } catch (err) {
      fileViewerContent.textContent = `오류: ${err.message}`;
    }
  }

  async function dispatchHermesPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) return;
    const model = hermesModelSelect?.value || 'gemini-2.5-pro';

    try {
      const res = await fetch('/api/hermes/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSessionId,
          prompt: prompt.trim(),
          model,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '프롬프트 전송 실패');
        return;
      }
      if (hermesPromptInput) {
        hermesPromptInput.value = '';
        hermesPromptInput.style.height = 'auto';
      }
    } catch (err) {
      alert(`프롬프트 전송 오류: ${err.message}`);
    }
  }

  async function interruptHermesAgent() {
    try {
      await fetch('/api/hermes/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId }),
      });
    } catch (err) {
      console.error('Failed to interrupt agent:', err);
    }
  }

  function setupHermesDesktop() {
    // 1. View Mode Buttons
    if (viewModeSelector) {
      for (const btn of viewModeSelector.querySelectorAll('.view-mode-btn')) {
        btn.addEventListener('click', () => {
          setViewMode(btn.dataset.mode);
        });
      }
    }

    // Set initial view mode
    setViewMode(currentViewMode);

    // 2. Right Rail Tabs
    for (const tab of hermesRailTabs) {
      tab.addEventListener('click', () => {
        const target = tab.dataset.railTab;
        for (const t of hermesRailTabs) t.classList.toggle('active', t === tab);
        for (const p of hermesRailPanels) {
          p.classList.toggle('active', p.id === `railPanel${target.charAt(0).toUpperCase() + target.slice(1)}`);
        }
        if (target === 'terminal') {
          setTimeout(() => fitActiveTerminal(), 30);
        } else if (target === 'files') {
          loadWorkspaceFiles(currentRailDir);
        }
      });
    }

    // 3. Popout Terminal Button
    btnPopoutTerminal?.addEventListener('click', () => {
      setViewMode('terminal');
    });

    // 4. File Explorer Parent & Refresh Buttons
    btnRailFilesParent?.addEventListener('click', () => {
      if (currentRailParent) {
        loadWorkspaceFiles(currentRailParent);
      }
    });
    btnRailFilesRefresh?.addEventListener('click', () => {
      loadWorkspaceFiles(currentRailDir);
    });
    btnRefreshWorkspaceDir?.addEventListener('click', () => {
      loadWorkspaceFiles(currentRailDir);
    });

    // 5. Audit Log Clear
    btnRailAuditClear?.addEventListener('click', () => {
      if (railAuditList) {
        railAuditList.innerHTML = '<div class="rail-preview-empty">감사 로그가 비워졌습니다.</div>';
      }
    });

    // 6. Composer Input & Key Events
    if (hermesPromptInput) {
      hermesPromptInput.addEventListener('input', () => {
        hermesPromptInput.style.height = 'auto';
        hermesPromptInput.style.height = `${Math.min(hermesPromptInput.scrollHeight, 140)}px`;
      });

      hermesPromptInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          dispatchHermesPrompt(hermesPromptInput.value);
        }
      });
    }

    btnHermesSend?.addEventListener('click', () => {
      if (hermesPromptInput) {
        dispatchHermesPrompt(hermesPromptInput.value);
      }
    });

    btnHermesInterrupt?.addEventListener('click', () => {
      interruptHermesAgent();
    });

    // 7. Quick Composer Commands (/help, /compact, /clear)
    const composerQuickBtns = document.querySelectorAll('.composer-quick-actions button');
    for (const btn of composerQuickBtns) {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        if (cmd) {
          dispatchHermesPrompt(cmd);
        }
      });
    }

    // 8. Quick Prompt Chips
    const promptChips = document.querySelectorAll('.hermes-prompt-chip');
    for (const chip of promptChips) {
      chip.addEventListener('click', () => {
        const text = chip.dataset.prompt;
        if (hermesPromptInput) {
          hermesPromptInput.value = text;
          hermesPromptInput.focus();
          hermesPromptInput.style.height = 'auto';
          hermesPromptInput.style.height = `${Math.min(hermesPromptInput.scrollHeight, 140)}px`;
        }
      });
    }

    // 9. Model Select
    hermesModelSelect?.addEventListener('change', () => {
      if (composerModelTag) {
        const opt = hermesModelSelect.options[hermesModelSelect.selectedIndex];
        composerModelTag.textContent = opt ? opt.text.split(' ')[0] : hermesModelSelect.value;
      }
    });

    // 10. File Viewer Modal Close
    btnCloseFileViewer?.addEventListener('click', () => {
      if (fileViewerModal) fileViewerModal.hidden = true;
    });
    fileViewerModal?.addEventListener('click', (ev) => {
      if (ev.target === fileViewerModal) {
        fileViewerModal.hidden = true;
      }
    });
  }

  fetchInternalBookmarks();
  setupHermesDesktop();
  bootstrap();
})();
