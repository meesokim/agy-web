(() => {
  const STORAGE_ACTIVE_SESSION_KEY = 'agy_web_active_session_id';

  // State
  let defaultCwd = 'C:\\Users\\meesokim';
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

    if (uri.startsWith('file://') || /^[A-Za-z]:\\/.test(uri)) {
      fetch('/api/open-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: uri, sessionId: activeSessionId }),
      }).catch(() => {});
      return;
    }

    if (/^https?:\/\//i.test(uri)) {
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

    term.open(paneEl);

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

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init') {
          entry.meta = msg.session;
          entry.isReplaying = true;
          // Clear terminal and replay server scrollback on initial attach / reconnect without firing onData
          entry.term.reset();
          if (msg.scrollback) {
            entry.term.write(msg.scrollback, () => {
              entry.isReplaying = false;
              entry.initialized = true;
              renderTabs();
              updateToolbarStatus();
              fitActiveTerminal();
            });
          } else {
            entry.isReplaying = false;
            entry.initialized = true;
            renderTabs();
            updateToolbarStatus();
            fitActiveTerminal();
          }
        } else if (msg.type === 'output') {
          entry.term.write(msg.data);
        } else if (msg.type === 'open_url') {
          if (msg.url) {
            openTerminalLink(msg.url, true);
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
    sendInput(activeSessionId, 'agy\r');
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
          브라우저 주소창에 <code>chrome://extensions</code> (또는 <code>edge://extensions</code>) 입력 → 우측 상단 <b>개발자 모드</b> 켜기 → <b>압축해제된 확장 프로그램을 로드합니다</b> 클릭 → <code>C:\\Users\\meesokim\\agy-web\\extension</code> 폴더 선택 시 네이버 메일 탭을 열 때마다 자동으로 읽어옵니다.
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

  function switchHubTab(tabName) {
    hubDrawer.hidden = false;
    for (const btn of hubTabs) {
      btn.classList.toggle('active', btn.dataset.hubTab === tabName);
    }
    hubPanelInternal.hidden = tabName !== 'internal';
    if (hubPanelNaverMail) hubPanelNaverMail.hidden = tabName !== 'naver-mail';
    hubPanelBrowserBm.hidden = tabName !== 'browser-bm';
    hubPanelOpenTabs.hidden = tabName !== 'open-tabs';

    if (tabName === 'internal') {
      fetchInternalBookmarks();
    } else if (tabName === 'naver-mail') {
      fetchNaverMail();
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

  document.getElementById('btnRefreshNaverMail')?.addEventListener('click', () => {
    fetchNaverMail();
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

  fetchInternalBookmarks();
  bootstrap();
})();
