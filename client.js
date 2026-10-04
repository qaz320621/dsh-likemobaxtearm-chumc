/**
 * Client half of the SSH console bundle.
 *
 * Owns three things: the right-sidebar tab types (`ssh` sessions, `ssh-manager`), the live frame
 * stream from the Host, and every Host call. The heavy terminal renderer lives in the lazy sibling
 * chunk `client.xterm.js`, which receives this module's React so the page keeps one React copy.
 */

const PACKAGE_ID = 'dsh-likemobaxtearm-chumc';

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const loadChunk = typeof require.async === 'function' ? require.async.bind(require) : null;

    // ---------------------------------------------------------------- browser-side memory
    // Session processes die with the Harness, but the browser keeps what it needs to reconnect:
    // a per-tab binding (keyed by the tab's persistent contentId) and a small "recent" list.
    const CLIENT_BUILD = '1.0.0 · 共享会话 · 三级权限 · 全程审计 · ConPTY 适配';
    const BINDING_PREFIX = 'dsh-ssh.binding.v1.';
    const RECENTS_KEY = 'dsh-ssh.recents.v1';
    const RECENTS_LIMIT = 12;

    function readJson(key, fallback) {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw === null || raw === undefined ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    }

    function writeJson(key, value) {
      try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
    }

    // Diagnostics/test seam: the store created by `apply`, so a test can assert frame effects.
    let activeStore = null;
    /** apply-scope helpers the wiring test drives directly (they need `ctx`). */
    const exposed = {};

    function readBinding(contentId) {
      if (typeof contentId !== 'string' || contentId.length === 0) return null;
      const value = readJson(BINDING_PREFIX + contentId, null);
      return value !== null && typeof value === 'object' && typeof value.target === 'string' ? value : null;
    }

    function writeBinding(contentId, binding) {
      if (typeof contentId !== 'string' || contentId.length === 0) return;
      writeJson(BINDING_PREFIX + contentId, binding);
    }

    function readRecents() {
      const list = readJson(RECENTS_KEY, []);
      return Array.isArray(list) ? list.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.target === 'string') : [];
    }

    /** Newest first, de-duplicated by target/user/port, capped. */
    function pushRecent(binding) {
      const entry = {
        target: binding.target,
        user: binding.user ?? '',
        port: binding.port ?? '',
        name: binding.name ?? '',
        at: binding.at ?? Date.now(),
      };
      const same = (item) => item.target === entry.target
        && String(item.user ?? '') === String(entry.user)
        && String(item.port ?? '') === String(entry.port);
      const next = [entry, ...readRecents().filter((item) => !same(item))].slice(0, RECENTS_LIMIT);
      writeJson(RECENTS_KEY, next);
      return next;
    }


    /** A session is usable only while it is connecting or ready; closed/exited tabs offer reconnect. */
    function isAliveSession(session) {
      return session !== undefined && session !== null && (session.state === 'ready' || session.state === 'connecting');
    }


    /** The descriptor for one tab: its own binding first, then the binding of its last session id. */
    function descriptorFor(contentId, sessionId) {
      const byContent = readBinding(contentId);
      if (byContent !== null) return byContent;
      if (typeof sessionId === 'string' && sessionId.length > 0) return readBinding(`session:${sessionId}`);
      return null;
    }

    // One Host tab hosts the whole plugin; every session lives on the plugin's own second-level
    // strip (the Host strip is overflow:hidden and we may not touch its DOM).
    const CONSOLE_TAB_ID = `${PACKAGE_ID}/console`;
    const LEGACY_TAB_ID = `${PACKAGE_ID}/legacy`;
    // Both channels are exact Fetch routes under the authenticated /api carrier:
    // `connection.rpc.handle` is unusable from a consumer (it needs webServer on the provider fiber).
    const INVOKE_PATH = 'api/dsh-ssh/invoke';
    const STREAM_PATH = 'api/dsh-ssh/stream';
    const PERMISSIONS = [
      { id: 'view', label: '仅可看', hint: 'AI 只能读取，写入一律被拒绝' },
      { id: 'ask', label: '问答', hint: 'AI 的每条命令都要你点确认' },
      { id: 'full', label: '完全', hint: 'AI 可直接执行；危险命令会先弹出可取消的告知' },
    ];
    const NOTE_KINDS = [
      { id: 'question', label: '提问', hint: '发送给 AI 并唤醒它作答' },
      { id: 'error', label: '报错', hint: '连同最近终端输出一起发给 AI' },
      { id: 'notebook', label: '仅记录', hint: '只写日志，不消耗 AI token' },
    ];

    /** Lazy xterm chunk; a failed load degrades to a message instead of a crashed slot entry. */
    const LazyTerminal = React.lazy(async () => {
      try {
        if (loadChunk === null) throw new Error('模块加载器不提供 require.async');
        const mod = await loadChunk('./client.xterm.js');
        return { default: mod.createSshTerminal(React) };
      } catch (error) {
        return { default: function TerminalUnavailable() {
          return h('div', { style: { padding: 12, color: 'var(--dsw-alias-state-error-primary)' } },
            `终端渲染组件加载失败：${String(error?.message ?? error)}（刷新页面重试）`);
        } };
      }
    });

    // ---------------------------------------------------------------- store + buffers

    function createStore(initial) {
      let state = initial;
      let version = 0;
      const listeners = new Set();
      return {
        get: () => state,
        version: () => version,
        set(patch) {
          state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
          version += 1;
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    const useStore = (store) => React.useSyncExternalStore(store.subscribe, store.version, store.version);

    function createBuffers() {
      const map = new Map();
      const MAX_CHARS = 2 * 1024 * 1024;
      return {
        ensure(sessionId) {
          let buffer = map.get(sessionId);
          if (buffer === undefined) {
            buffer = { seq: 0, chunks: [], chars: 0, terminals: new Set() };
            map.set(sessionId, buffer);
          }
          return buffer;
        },
        ingest(sessionId, seq, data) {
          const buffer = this.ensure(sessionId);
          if (typeof data !== 'string' || data.length === 0) return;
          if (seq !== undefined && seq !== null) {
            if (seq <= buffer.seq) return;
            buffer.seq = seq;
          }
          buffer.chunks.push(data);
          buffer.chars += data.length;
          while (buffer.chars > MAX_CHARS && buffer.chunks.length > 1) buffer.chars -= buffer.chunks.shift().length;
          for (const terminal of buffer.terminals) {
            try { terminal(data); } catch { /* a disposed terminal detaches itself */ }
          }
        },
        replace(sessionId, seq, data) {
          const buffer = this.ensure(sessionId);
          buffer.chunks = typeof data === 'string' && data.length > 0 ? [data] : [];
          buffer.chars = buffer.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          buffer.seq = seq ?? buffer.seq;
        },
        attach(sessionId, onData) {
          const buffer = this.ensure(sessionId);
          buffer.terminals.add(onData);
          return {
            history: buffer.chunks.join(''),
            detach: () => { buffer.terminals.delete(onData); },
          };
        },
        seqOf(sessionId) { return this.ensure(sessionId).seq; },
      };
    }

    // ---------------------------------------------------------------- styles

    const S = {
      panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 12 },
      header: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flexWrap: 'wrap', flex: '0 0 auto' },
      body: { position: 'relative', flex: '1 1 auto', minHeight: 0, background: 'var(--dsw-alias-bg-layer-1)' },
      btn: { font: 'inherit', padding: '3px 8px', borderRadius: 'var(--dsw-radius-sm, 4px)', border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      btnPrimary: { font: 'inherit', padding: '3px 10px', borderRadius: 'var(--dsw-radius-sm, 4px)', border: '1px solid var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-label-primary-foreground)', cursor: 'pointer' },
      btnDanger: { font: 'inherit', padding: '3px 10px', borderRadius: 'var(--dsw-radius-sm, 4px)', border: '1px solid var(--dsw-alias-state-error-primary)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer' },
      input: { font: 'inherit', padding: '3px 6px', borderRadius: 'var(--dsw-radius-sm, 4px)', border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', minWidth: 0 },
      dim: { color: 'var(--dsw-alias-label-secondary)' },
      chip: { padding: '1px 6px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l3)', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      mono: { fontFamily: 'var(--ds-font-family-code), ui-monospace, monospace' },
      drawer: { flex: '0 0 auto', borderTop: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', maxHeight: '42%', display: 'flex', flexDirection: 'column', minHeight: 0 },
      scroll: { overflow: 'auto', minHeight: 0, overscrollBehavior: 'contain' },
      row: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      banner: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)' },
      strip: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', flex: '0 0 auto' },
      stripBtn: { font: 'inherit', fontSize: 11, padding: '1px 6px', borderRadius: 'var(--dsw-radius-sm, 4px)', border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', flex: '0 0 auto' },
      stripScroll: { display: 'flex', gap: 4, alignItems: 'center', flex: '1 1 auto', minWidth: 0, overflowX: 'auto', overflowY: 'hidden', overscrollBehavior: 'contain', scrollbarWidth: 'thin' },
      stripTab: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto', padding: '1px 6px', borderRadius: 'var(--dsw-radius-sm, 4px)', border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      stripTabActive: { border: '1px solid var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      menu: { position: 'absolute', right: 0, top: '100%', zIndex: 30, minWidth: 190, maxHeight: 260, overflow: 'auto', background: 'var(--dsw-alias-bg-layer-3)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm, 4px)', boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)' },
    };

    function stateLabel(session) {
      if (session === undefined) return '未连接';
      if (session.state === 'ready') return '已连接';
      if (session.state === 'connecting') return '连接中';
      if (session.state === 'closed') return '已关闭';
      return `已退出${session.exitCode === null || session.exitCode === undefined ? '' : ` (${session.exitCode})`}`;
    }

    /**
     * The status dot's colour.
     *
     * Red is reserved for danger (a dangerous command, a deny button) — NOT for "this has no state"
     * or "this session ended", which is what made the pinned console page look broken: it carries no
     * session state, so it fell into the error branch and wore a permanent red dot.
     */
    function stateColor(session) {
      if (session === undefined || session === null) return 'var(--dsw-alias-label-tertiary)';
      if (session.state === 'ready') return 'var(--dsw-alias-state-success-primary)';
      if (session.state === 'connecting' || session.state === 'exited') return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-label-tertiary)';
    }

    // ---------------------------------------------------------------- apply

    return {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const store = createStore({
          stream: 'connecting',
          recents: readRecents(),
          projects: null,
          hosts: [],
          hostsFile: '',
          logDir: '',
          sessions: {},
          approvals: {},
          notes: {},
          logs: {},
          error: null,
          themeVersion: 0,
        });
        activeStore = store;
        const buffers = createBuffers();
        let dshSessionId = null;
        let pendingInput = new Map();
        const lastSize = new Map();
        const resizeTimers = new Map();
        let inputTimer = null;

        const set = (patch) => store.set(patch);
        const state = () => store.get();

        /** The tab inventory, tolerating both an observable and a plain array. */
        function tabInventory() {
          const source = ctx.sidebarRight.openTabs;
          try {
            if (source !== undefined && typeof source.getSnapshot === 'function') return source.getSnapshot() ?? [];
            return Array.isArray(source) ? source : [];
          } catch { return []; }
        }

        /** The Host tab id showing our console, when the Host strip has one. */
        function consoleTabId() {
          for (const tab of tabInventory()) if (tab?.kind === 'ssh-console') return tab.id;
          return undefined;
        }

        /** Bring the single console tab to the front, opening it when it is missing. */
        function ensureConsoleTab() {
          try {
            const existing = consoleTabId();
            if (existing !== undefined) ctx.sidebarRight.focus(existing);
            else ctx.sidebarRight.openTab('ssh-console');
            return true;
          } catch (error) {
            set({ error: String(error?.message ?? error) });
            return false;
          }
        }

        /** Show one session on the console's own strip. */
        function selectSession(id) {
          set({ activeView: id });
          ensureConsoleTab();
        }
        exposed.selectSession = selectSession;

        /**
         * The console's second-level strip.
         *
         * Derived from the sessions we know about — never from Host tabs — so AI-created and
         * disconnected sessions appear here too, and scrolling is entirely ours.
         */
        function consoleStripEntries(sessions) {
          return Object.values(sessions ?? {})
            .filter((session) => session !== undefined && session !== null && typeof session.id === 'string')
            .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
            .map((session) => ({
              id: session.id,
              host: session.host ?? session.id,
              state: session.state,
              permission: session.permission,
              alive: isAliveSession(session),
            }));
        }
        exposed.consoleStripEntries = consoleStripEntries;

        /**
         * The strip's rows: a pinned console page first (hosts, new connection, log directory), then
         * every known session. The pinned row is always there and cannot be closed.
         */
        function stripRows(sessions) {
          return [{ id: 'manager', label: '控制台', pinned: true, alive: true }, ...consoleStripEntries(sessions)];
        }
        exposed.stripRows = stripRows;

        async function invoke(method, params, signal) {
          const response = await fetch(INVOKE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, params }),
            signal,
            credentials: 'same-origin',
          });
          if (response.ok !== true) {
            const error = new Error(`调用 ${method} 传输失败：HTTP ${response.status}`);
            error.code = 'SSH_TRANSPORT';
            throw error;
          }
          const payload = await response.json();
          if (payload?.ok !== true) {
            const error = new Error(payload?.error?.message ?? `调用 ${method} 失败`);
            error.code = payload?.error?.code;
            throw error;
          }
          return payload.value;
        }

        /** The DSH session id, learned from the first tab body that mounts. */
        function dshId() { return dshSessionId ?? ''; }

        function updateSession(snapshot) {
          if (snapshot === undefined || snapshot === null) return;
          set((current) => ({ sessions: { ...current.sessions, [snapshot.id]: snapshot } }));
        }

        /**
         * Open a session from a descriptor and remember it: a binding for this tab (so `r` can bring
         * it back after a Harness restart), a binding for the new session id, and a recent entry.
         */
        async function openSession(descriptor, options = {}) {
          const result = await invoke('session.open', {
            dshSessionId: dshId(),
            target: descriptor.target,
            user: descriptor.user === undefined || descriptor.user === '' ? undefined : descriptor.user,
            port: descriptor.port === undefined || descriptor.port === '' ? undefined : Number(descriptor.port),
            name: descriptor.name === undefined || descriptor.name === '' ? undefined : descriptor.name,
          });
          updateSession(result.session);
          const binding = rememberConnection(descriptor, result.session);
          // Show it, unless the caller runs in the background: an AI-created session must not yank
          // the operator away from the session they are watching.
          if (options.select !== false) selectSession(result.session.id);
          return { session: result.session, binding };
        }

        function rememberConnection(descriptor, session) {
          const binding = {
            target: session.target,
            user: descriptor.user ?? '',
            port: descriptor.port ?? '',
            name: descriptor.name ?? session.host,
            sessionId: session.id,
            at: Date.now(),
          };
          writeBinding(`session:${session.id}`, binding);
          set({ recents: pushRecent(binding) });
          return binding;
        }

        function hydrateSession(id) {
          if (buffers.seqOf(id) > 0) return;
          void invoke('output.since', { dshSessionId: dshId(), sessionId: id, from: 0 })
            .then((value) => {
              if (buffers.seqOf(id) === 0) buffers.replace(id, value.seq, value.data);
            })
            .catch(() => { /* the session may already be gone */ });
        }

        function handleFrame(frame) {
          if (frame === null || typeof frame !== 'object') return;
          switch (frame.t) {
            case 'hello':
              dshSessionId = dshSessionId ?? frame.dshSessionId ?? dshSessionId;
              set({
                stream: 'stream',
                hosts: frame.hosts ?? [],
                logDir: frame.logDir ?? '',
                sessions: Object.fromEntries((frame.sessions ?? []).map((session) => [session.id, session])),
              });
              for (const session of frame.sessions ?? []) hydrateSession(session.id);
              break;
            case 'opened':
              updateSession(frame.session);
              if (frame.session !== undefined) {
                hydrateSession(frame.session.id);
                // New sessions join the console's own strip; reveal the console if it is missing, but
                // never switch the view the operator is watching.
                ensureConsoleTab();
              }
              break;
            case 'state':
              updateSession(frame.session);
              // The Host drops a closed session from its registry; mirror that so the tab can tell
              // "this session is gone" instead of rendering a frozen screen forever.
              if (frame.session?.state === 'closed') {
                set((current) => {
                  if (current.sessions[frame.session.id] === undefined) return {};
                  const sessions = { ...current.sessions };
                  delete sessions[frame.session.id];
                  return { sessions };
                });
              }
              break;
            case 'output':
              buffers.ingest(frame.sessionId, frame.seq, frame.data);
              break;
            case 'log':
              if (frame.entry !== undefined) {
                set((current) => {
                  const list = current.logs[frame.sessionId] ?? [];
                  const next = list.length > 500 ? list.slice(list.length - 500) : list.slice();
                  next.push(frame.entry);
                  return { logs: { ...current.logs, [frame.sessionId]: next } };
                });
              }
              break;
            case 'approval':
              set((current) => ({ approvals: { ...current.approvals, [frame.sessionId]: frame.approval } }));
              break;
            case 'approval-resolved':
              set((current) => {
                const approvals = { ...current.approvals };
                delete approvals[frame.sessionId];
                return { approvals };
              });
              break;
            case 'annotate':
              if (frame.annotation !== undefined) {
                set((current) => {
                  const list = current.logs[frame.sessionId] ?? [];
                  const next = list.slice();
                  next.push({ kind: 'ui.annotate', actor: 'ai', ts: new Date(frame.annotation.at ?? Date.now()).toISOString(), command: frame.annotation.command });
                  return { logs: { ...current.logs, [frame.sessionId]: next } };
                });
              }
              break;
            default:
              break;
          }
        }

        async function runStream(signal) {
          const response = await fetch(STREAM_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dshSessionId: dshId() }),
            signal,
            credentials: 'same-origin',
          });
          if (response.ok !== true || response.body === null) throw new Error(`HTTP ${response.status}`);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let rest = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done === true) break;
            rest += value;
            let index = rest.indexOf('\n');
            while (index >= 0) {
              const line = rest.slice(0, index);
              rest = rest.slice(index + 1);
              if (line.trim().length > 0) {
                try { handleFrame(JSON.parse(line)); } catch { /* ignore malformed frame */ }
              }
              index = rest.indexOf('\n');
            }
          }
          throw new Error('stream closed');
        }

        async function pollOnce() {
          try {
            const list = await invoke('sessions.list', { dshSessionId: dshId() });
            const sessions = {};
            for (const session of list.sessions ?? []) {
              sessions[session.id] = session;
              const from = buffers.seqOf(session.id);
              const chunk = await invoke('output.since', { dshSessionId: dshId(), sessionId: session.id, from });
              if (typeof chunk.data === 'string' && chunk.data.length > 0) buffers.ingest(session.id, chunk.seq, chunk.data);
              else if (from === 0) buffers.replace(session.id, chunk.seq, '');
            }
            set({ sessions, stream: 'poll' });
          } catch (error) {
            set({ stream: 'offline', error: String(error?.message ?? error) });
          }
        }

        // Stream first, degrade to polling; both are torn down with the plugin.
        ctx.effect(() => {
          const controller = new AbortController();
          let stopped = false;
          let poller = null;
          (async () => {
            let failures = 0;
            while (!stopped) {
              try {
                set({ stream: 'connecting' });
                await runStream(controller.signal);
              } catch (error) {
                if (stopped || controller.signal.aborted) break;
                failures += 1;
                if (failures >= 2 && poller === null) {
                  poller = setInterval(() => { void pollOnce(); }, 800);
                  void pollOnce();
                }
              }
              if (stopped) break;
              await new Promise((resolve) => setTimeout(resolve, failures >= 2 ? 15000 : 800));
            }
          })();
          return () => {
            stopped = true;
            controller.abort();
            if (poller !== null) clearInterval(poller);
          };
        }, 'dsh-ssh:stream');

        // Keystrokes are coalesced for ~12ms; control bytes and Enter flush immediately so ^C stays snappy.
        function queueInput(id, data) {
          pendingInput.set(id, (pendingInput.get(id) ?? '') + data);
          const urgent = /[\u0000-\u001f\u007f]/.test(data);
          const flush = () => {
            inputTimer = null;
            const pending = pendingInput;
            pendingInput = new Map();
            for (const [sessionId, text] of pending) {
              void invoke('input.write', { dshSessionId: dshId(), sessionId, data: text }).catch((error) => set({ error: String(error?.message ?? error) }));
            }
          };
          if (urgent) flush();
          else if (inputTimer === null) inputTimer = setTimeout(flush, 12);
        }

        const terminalApi = {
          attach: (id, onData) => buffers.attach(id, onData),
          write: (id, data) => queueInput(id, data),
          resize: (id, cols, rows) => {
            // A redundant resize makes the remote shell redraw its prompt; only send real changes.
            const previous = lastSize.get(id);
            if (previous !== undefined && previous.cols === cols && previous.rows === rows) return;
            lastSize.set(id, { cols, rows });
            // Debounce a burst: every PTY resize makes ConPTY repaint its whole screen, so a layout
            // animation (drawer, approval bar) must settle before the size goes out.
            const pending = resizeTimers.get(id);
            if (pending !== undefined) clearTimeout(pending);
            resizeTimers.set(id, setTimeout(() => {
              resizeTimers.delete(id);
              const current = lastSize.get(id);
              if (current === undefined) return;
              void invoke('session.resize', { dshSessionId: dshId(), sessionId: id, cols: current.cols, rows: current.rows })
                .catch(() => {});
            }, 250));
          },
        };

        // Theme: terminal colours follow the DSH tokens.
        function readTerminalTheme() {
          const style = getComputedStyle(document.documentElement);
          const read = (name, fallback) => {
            const value = style.getPropertyValue(name).trim();
            return value.length > 0 ? value : fallback;
          };
          return {
            background: read('--dsw-alias-bg-layer-1', '#1b1b1f'),
            foreground: read('--dsw-alias-label-primary', '#e6e6e6'),
            cursor: read('--dsw-alias-state-business-primary', '#8fd0ff'),
            cursorAccent: read('--dsw-alias-bg-layer-1', '#1b1b1f'),
            selectionBackground: read('--dsw-alias-interactive-bg-active', '#2d4a63'),
            black: read('--dsw-alias-label-primary', '#e6e6e6'),
          };
        }

        // ------------------------------------------------------------ components

        function reportClientError(scope, error, detail) {
          try {
            void invoke('client.error', {
              dshSessionId: dshId(),
              scope,
              message: String(error?.stack ?? error?.message ?? error).slice(0, 4000),
              detail: String(detail ?? '').slice(0, 4000),
              ua: typeof navigator === 'undefined' ? '' : String(navigator.userAgent ?? ''),
            }).catch(() => {});
          } catch { /* reporting must never throw */ }
        }

        class PluginErrorBoundary extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error };
          }

          componentDidCatch(error, info) {
            reportClientError(this.props.scope ?? 'component', error, info?.componentStack);
          }

          render() {
            if (this.state.error !== null) {
              return h('div', { style: { padding: 12, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' } },
                `SSH 界面渲染出错：${String(this.state.error?.message ?? this.state.error)}\n（已记录到工作区 .dsh-ssh/client-errors.log）`);
            }
            return this.props.children;
          }
        }

        function guarded(Component, scope) {
          return function Guarded(props) {
            return h(PluginErrorBoundary, { scope }, h(Component, props));
          };
        }

        function useTerminalTheme() {
          const version = useStore(store);
          void version;
          const [theme, setTheme] = React.useState(() => readTerminalTheme());
          React.useEffect(() => {
            const observer = new MutationObserver(() => setTheme(readTerminalTheme()));
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
            return () => observer.disconnect();
          }, []);
          return theme;
        }

        function PermissionPicker({ session }) {
          return h('div', { style: { display: 'flex', gap: 2, alignItems: 'center' } },
            PERMISSIONS.map((entry) => h('button', {
              key: entry.id,
              type: 'button',
              title: `${entry.label} — ${entry.hint}`,
              onClick: () => {
                void invoke('session.permission', { dshSessionId: dshId(), sessionId: session.id, permission: entry.id })
                  .then((value) => updateSession(value.session))
                  .catch((error) => set({ error: String(error?.message ?? error) }));
              },
              style: {
                ...S.btn,
                padding: '1px 7px',
                fontSize: 11,
                borderColor: session.permission === entry.id ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)',
                color: session.permission === entry.id ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)',
              },
            }, entry.label)));
        }

        function ApprovalBanner({ session, approval, overlay = false }) {
          // Hooks run before the conditional return so the hook order stays stable.
          const [tick, setTick] = React.useState(0);
          React.useEffect(() => {
            if (approval === undefined || approval.mode !== 'announce') return undefined;
            const timer = setInterval(() => setTick((value) => value + 1), 500);
            return () => clearInterval(timer);
          }, [approval?.id, approval?.mode]);
          if (approval === undefined) return null;
          void tick;
          const isAnnounce = approval.mode === 'announce';
          const seconds = Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000));
          const answer = (approve) => {
            void invoke('approval.answer', { dshSessionId: dshId(), sessionId: session.id, approvalId: approval.id, approve })
              .catch((error) => set({ error: String(error?.message ?? error) }));
          };
          return h('div', {
            style: {
              ...S.banner,
              // Overlay, not a block: it must not resize the terminal (see the 0.1.1 Windows report).
              ...(overlay === true ? { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5, boxShadow: '0 2px 10px rgba(0, 0, 0, 0.3)' } : null),
              borderLeft: `3px solid ${isAnnounce ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)'}`,
            },
          },
          h('span', { style: { color: isAnnounce ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)', fontWeight: 600 } },
            isAnnounce ? '⚠ 危险命令' : '🤖 AI 请求执行'),
          h('code', { style: { ...S.mono, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, approval.command),
          approval.danger !== undefined && approval.danger !== null
            ? h('span', { style: { ...S.chip, color: 'var(--dsw-alias-state-error-primary)' } }, `${approval.danger.note || approval.danger.id}`)
            : null,
          isAnnounce
            ? h('span', { style: S.dim }, `${seconds}s 后执行`)
            : null,
          isAnnounce
            ? h('button', { type: 'button', style: S.btnDanger, onClick: () => answer(false) }, '取消执行')
            : h(React.Fragment, null,
              h('button', { type: 'button', style: S.btnPrimary, onClick: () => answer(true) }, '允许'),
              h('button', { type: 'button', style: S.btnDanger, onClick: () => answer(false) }, '拒绝')));
        }

        function NotePanel({ session }) {
          const [kind, setKind] = React.useState('question');
          const [text, setText] = React.useState('');
          const [feedback, setFeedback] = React.useState(null);
          const notes = state().notes[session.id] ?? [];
          const send = () => {
            const value = text.trim();
            if (value.length === 0) return;
            void invoke('note.send', { dshSessionId: dshId(), sessionId: session.id, kind, text: value })
              .then((result) => {
                setText('');
                setFeedback(result.delivered === true ? '已发送给 AI' : (result.message ?? '已写入日志'));
                set((current) => ({
                  notes: { ...current.notes, [session.id]: [...(current.notes[session.id] ?? []), { kind, text: value, at: Date.now(), result }] },
                }));
              })
              .catch((error) => setFeedback(`失败：${String(error?.message ?? error)}`));
          };
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, minHeight: 0 } },
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
              NOTE_KINDS.map((entry) => h('button', {
                key: entry.id,
                type: 'button',
                title: entry.hint,
                style: {
                  ...S.btn,
                  borderColor: kind === entry.id ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)',
                  color: kind === entry.id ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)',
                },
                onClick: () => setKind(entry.id),
              }, entry.label)),
              h('span', { style: { ...S.dim, fontSize: 11 } }, NOTE_KINDS.find((entry) => entry.id === kind)?.hint ?? '')),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
              h('textarea', {
                value: text,
                placeholder: kind === 'notebook' ? '写给自己看的记录（不发送给 AI）' : '给 AI 留言：提问或贴报错…',
                onChange: (event) => setText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); }
                },
                style: { ...S.input, ...S.mono, flex: '1 1 auto', minHeight: 46, resize: 'vertical' },
              }),
              h('button', { type: 'button', style: S.btnPrimary, onClick: send }, '发送')),
            feedback !== null ? h('div', { style: S.dim }, feedback) : null,
            notes.length > 0 ? h('div', { style: { ...S.scroll, maxHeight: 120 } }, notes.slice(-20).reverse().map((note, index) => h('div', {
              key: `${note.at}-${index}`,
              style: { ...S.row, alignItems: 'flex-start' },
            },
            h('span', { style: S.chip }, NOTE_KINDS.find((entry) => entry.id === note.kind)?.label ?? note.kind),
            h('span', { style: { flex: '1 1 auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, note.text),
            h('span', { style: { ...S.dim, fontSize: 11 } }, note.result?.delivered === true ? '已投递' : '仅日志')))) : null);
        }

        function LogPanel({ session }) {
          const entries = state().logs[session.id] ?? [];
          const [actor, setActor] = React.useState('');
          const visible = actor === '' ? entries : entries.filter((entry) => entry.actor === actor);
          return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', flexWrap: 'wrap' } },
              ['', 'user', 'ai', 'system', 'remote'].map((value) => h('button', {
                key: value === '' ? 'all' : value,
                type: 'button',
                style: { ...S.btn, padding: '1px 7px', fontSize: 11, color: actor === value ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)' },
                onClick: () => setActor(value),
              }, value === '' ? '全部' : value)),
              h('span', { style: { ...S.dim, fontSize: 11, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, session.logPath ?? ''),
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => {
                  void invoke('log.read', { dshSessionId: dshId(), sessionId: session.id, limit: 300 })
                    .then((value) => set((current) => ({ logs: { ...current.logs, [session.id]: value.entries } })))
                    .catch((error) => set({ error: String(error?.message ?? error) }));
                },
              }, '刷新')),
            h('div', { style: { ...S.scroll, flex: '1 1 auto', minHeight: 0 } },
              visible.length === 0
                ? h('div', { style: { padding: 8, ...S.dim } }, '暂无日志')
                : visible.slice(-200).map((entry, index) => h(LogEntryRow, { entry, index }))));
        }

        /** One JSONL entry, shared by the live log and the history viewer so they read the same. */
        function LogEntryRow({ entry, index }) {
          return h('div', { key: `${entry.ts}-${index}`, style: { ...S.row, alignItems: 'flex-start' } },
            h('span', { style: { ...S.dim, fontSize: 11, ...S.mono, flex: '0 0 auto' } }, String(entry.ts ?? '').slice(11, 19)),
            h('span', {
              style: {
                ...S.chip,
                flex: '0 0 auto',
                color: entry.actor === 'ai' ? 'var(--dsw-alias-state-business-primary)'
                  : entry.actor === 'user' ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-label-secondary)',
              },
            }, `${entry.actor ?? '?'}/${entry.kind ?? '?'}`),
            h('span', { style: { ...S.mono, flex: '1 1 auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
              entry.command ?? entry.text ?? JSON.stringify(entry)),
            entry.truncated === true ? h('span', { style: { ...S.dim, fontSize: 11 } }, `截断 (${entry.fullBytes}B)`) : null);
        }

        /**
         * History: every log file on disk (current sessions and gzipped archives), not just the
         * session on screen. Retirement happens on the Host (see `logArchiveAfterDays`).
         */
        function HistoryPanel() {
          const [files, setFiles] = React.useState(null);
          const [opened, setOpened] = React.useState(null);
          const [error, setError] = React.useState(null);
          const [policy, setPolicy] = React.useState(null);
          const load = () => {
            setError(null);
            void invoke('log.list', { dshSessionId: dshId(), limit: 300 })
              .then((value) => {
                setFiles(value.files ?? []);
                setPolicy({ archiveAfterMs: value.archiveAfterMs ?? 0, retentionMs: value.retentionMs ?? 0 });
              })
              .catch((failure) => setError(String(failure?.message ?? failure)));
          };
          React.useEffect(() => { load(); }, []);
          const open = (name) => {
            setError(null);
            void invoke('log.readFile', { dshSessionId: dshId(), name, maxLines: 300 })
              .then((value) => setOpened(value))
              .catch((failure) => setError(String(failure?.message ?? failure)));
          };
          const size = (bytes) => (bytes < 1024 ? `${bytes} B`
            : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
          // Durations are configurable per hour, so render them the way they were written.
          const human = (ms) => {
            if (!(ms > 0)) return '关闭';
            if (ms >= 86400000) return `${Number((ms / 86400000).toFixed(2))} 天`;
            if (ms >= 3600000) return `${Number((ms / 3600000).toFixed(2))} 小时`;
            if (ms >= 60000) return `${Math.round(ms / 60000)} 分钟`;
            return `${Math.max(1, Math.round(ms / 1000))} 秒`;
          };
          const when = (stamp) => (typeof stamp === 'string' && stamp.length === 15
            ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}`
            : '');
          return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'flex', flexDirection: 'column', minHeight: 0, flex: '0 0 auto' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', flexWrap: 'wrap' } },
              h('span', null, '历史日志'),
              h('span', { style: { ...S.dim, fontSize: 11 } },
                policy === null
                  ? '按会话分文件；超过归档阈值的自动 gzip 到 archive/'
                  : `按会话分文件；归档阈值 ${human(policy.archiveAfterMs)}，归档保留 ${human(policy.retentionMs)}`)),
              h('span', { style: { flex: '1 1 auto' } }),
              h('button', { type: 'button', style: S.btn, onClick: load }, '刷新')),
            error !== null ? h('div', { style: { padding: '0 10px 6px', color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
            h('div', { style: { maxHeight: 190, ...S.scroll } },
              files === null
                ? h('div', { style: { padding: '0 10px 8px', ...S.dim } }, '正在读取…')
                : (files.length === 0
                  ? h('div', { style: { padding: '0 10px 8px', ...S.dim } }, '还没有日志文件。')
                  : files.map((file) => h('div', { key: `${file.kind}-${file.name}`, style: { ...S.row, cursor: 'pointer' } },
                    h('span', { style: { ...S.mono, flex: '0 0 auto' } }, when(file.stamp) || new Date(file.mtime).toLocaleString()),
                    h('span', { style: { ...S.mono, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      `${file.sessionId || '?'} · ${file.host || '?'}`),
                    file.kind === 'archived' ? h('span', { style: S.chip }, '已归档') : h('span', { style: S.chip }, '进行中'),
                    h('span', { style: { ...S.dim, fontSize: 11 } }, size(file.size)),
                    h('button', { type: 'button', style: S.btn, onClick: () => open(file.name) }, '查看')))),
            opened !== null
              ? h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', flexWrap: 'wrap' } },
                  h('span', { style: { ...S.mono } }, opened.name),
                  opened.kind === 'archived' ? h('span', { style: S.chip }, '已归档') : null,
                  h('span', { style: { ...S.dim, fontSize: 11 } },
                    `${opened.lines}/${opened.totalLines} 行${opened.truncated === true ? '（已截取末尾）' : ''}`),
                  h('span', { style: { flex: '1 1 auto' } }),
                  h('button', { type: 'button', style: S.btn, onClick: () => setOpened(null) }, '关闭')),
                (opened.entries ?? []).length === 0
                  ? h('div', { style: { padding: '0 10px 8px', ...S.dim } }, '（空文件）')
                  : (opened.entries ?? []).map((entry, index) => h(LogEntryRow, { entry, index })))
              : null);
        }

        /**
         * One session's view: header, terminal and drawers, plus a reconnect panel when the session
         * is gone. The console renders exactly one of these, so it is told which session to show
         * instead of deriving it from Host tab params — that is what removed the stale-tab bugs.
         */
        function SessionView(props) {
          const sessionId = props.sessionId;
          const onCycle = props.onCycle;
          const version = useStore(store);
          const theme = useTerminalTheme();
          // The session's own binding (written when it was opened) is what a reconnect needs; Host
          // tabs no longer carry it.
          const descriptor = React.useMemo(
            () => (typeof sessionId === 'string' && sessionId.length > 0 ? readBinding(`session:${sessionId}`) : null),
            [sessionId, version],
          );
          const candidate = typeof sessionId === 'string' ? state().sessions[sessionId] : undefined;
          const liveId = isAliveSession(candidate) ? candidate.id : undefined;
          const activeId = candidate?.id ?? sessionId;
          const approval = activeId === undefined ? undefined : state().approvals[activeId];
          const [drawer, setDrawer] = React.useState('log');
          const [busy, setBusy] = React.useState(false);
          const [reconnectError, setReconnectError] = React.useState(null);

          React.useEffect(() => {
            if (liveId === undefined) return undefined;
            hydrateSession(liveId);
            void invoke('output.since', { dshSessionId: dshId(), sessionId: liveId, from: 0 })
              .then((value) => { if (buffers.seqOf(liveId) === 0) buffers.replace(liveId, value.seq, value.data); })
              .catch(() => {});
            return undefined;
          }, [liveId]);

          const connect = React.useCallback(async (target) => {
            if (target === null || target === undefined || busy) return;
            setBusy(true);
            setReconnectError(null);
            try {
              // Reconnect inside this view; `select` keeps the console showing this same session.
              await openSession(target, { select: true });
            } catch (error) {
              setReconnectError(String(error?.message ?? error));
            } finally {
              setBusy(false);
            }
          }, [busy]);

          // `r` reconnects a dead session, exactly like the button; ignored while typing in a field.
          React.useEffect(() => {
            if (liveId !== undefined || descriptor === null) return undefined;
            const onKeyDown = (event) => {
              if (event.key !== 'r' && event.key !== 'R') return;
              if (event.metaKey || event.ctrlKey || event.altKey) return;
              const node = event.target;
              const tag = node?.tagName;
              if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node?.isContentEditable === true) return;
              event.preventDefault();
              void connect(descriptor);
            };
            window.addEventListener('keydown', onKeyDown);
            return () => window.removeEventListener('keydown', onKeyDown);
          }, [liveId, descriptor, connect]);

          // Ctrl+Alt+←/→ walks the sessions: our own strip is pointer-driven and the Host strip
          // cannot scroll, so keep one keyboard path to reach any session.
          React.useEffect(() => {
            const onKeyDown = (event) => {
              if (event.ctrlKey !== true || event.altKey !== true) return;
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              onCycle?.(event.key === 'ArrowRight' ? 1 : -1);
            };
            window.addEventListener('keydown', onKeyDown);
            return () => window.removeEventListener('keydown', onKeyDown);
          }, [onCycle]);

          if (liveId === undefined) {
            const recents = state().recents;
            const describe = (entry) => `${entry.user === undefined || entry.user === '' ? '' : `${entry.user}@`}${entry.target}`
              + `${entry.port === undefined || entry.port === '' ? '' : `:${entry.port}`}`
              + `${entry.name === undefined || entry.name === '' ? '' : `（${entry.name}）`}`;
            return h('div', { style: { ...S.panel } },
              h('div', { style: { ...S.scroll, flex: '1 1 auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', null, candidate === undefined
                ? '这个会话已不在当前进程里。'
                : (candidate.state === 'exited'
                  ? `这个会话已退出（exit ${candidate.exitCode ?? '?'}）。`
                  : '这个会话已断开（Harness 重启会结束所有 SSH 进程）。')),
              h('div', { style: { ...S.dim, fontSize: 11 } }, CLIENT_BUILD),
              descriptor !== null ? h('div', { style: { ...S.dim, ...S.mono } }, describe(descriptor)) : null,
              descriptor !== null
                ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void connect(descriptor) },
                    busy ? '重连中…' : '重新连接 (r)'),
                  h('span', { style: S.dim }, busy ? '正在建立会话…' : '或直接按 r 键'))
                : h('div', { style: S.dim }, '没有这个会话的连接记录，请到「管理」里新建。'),
              reconnectError !== null
                ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' } }, `重连失败：${reconnectError}`)
                : null,
              recents.length > 0
                ? h('div', { style: { marginTop: 4 } },
                  h('div', { style: { ...S.dim, fontSize: 11, marginBottom: 4 } }, '最近连接（浏览器本地记忆，Harness 重启后仍在）'),
                  recents.map((recent) => h('div', { key: `${recent.target}-${recent.user}-${recent.port}`, style: S.row },
                    h('span', { style: { ...S.mono, flex: '1 1 auto' } },
                      `${recent.user === undefined || recent.user === '' ? '' : `${recent.user}@`}${recent.target}${recent.port === undefined || recent.port === '' ? '' : `:${recent.port}`}`),
                    h('span', { style: S.dim }, recent.name ?? ''),
                    h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => void connect(recent) }, '连接'))))
                : h('div', { style: S.dim }, '到「管理」里新建连接；连过一次之后这里就记住了。')));
          }

          const liveSession = candidate;
          const alive = liveId !== undefined;
          return h('div', { style: { ...S.panel, flexDirection: 'column' } },
            h('div', { style: S.header },
              h('span', { style: { width: 8, height: 8, borderRadius: 999, background: stateColor(liveSession), flex: '0 0 auto' } }),
              h('span', { style: { fontFamily: 'var(--ds-font-family-code), monospace' } }, liveSession?.host ?? activeId),
              h('span', { style: S.chip }, stateLabel(liveSession)),
              liveSession !== undefined ? h(PermissionPicker, { session: liveSession }) : null,
              liveSession?.aiBusy === true
                ? h('span', { style: { ...S.chip, color: 'var(--dsw-alias-state-business-primary)' } }, '🤖 AI 正在操作')
                : h('span', { style: S.chip }, liveSession?.inputOwner === 'ai' ? 'AI 持有输入权' : '输入权：你'),
              h('span', { style: { flex: '1 1 auto' } }),
              alive ? h('button', {
                type: 'button',
                style: S.btn,
                title: '回收输入权并打断 AI 当前命令',
                onClick: () => { void invoke('session.revokeAi', { dshSessionId: dshId(), sessionId: activeId }).catch(() => {}); },
              }, '收回控制') : null,
              alive ? h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => {
                  const name = window.prompt('新的会话名', liveSession?.host ?? activeId);
                  if (name === null || name.trim().length === 0) return;
                  void invoke('session.rename', { dshSessionId: dshId(), sessionId: activeId, name: name.trim() })
                    .then((value) => updateSession(value.session))
                    .catch(() => {});
                },
              }, '重命名') : null),
            h('div', { style: S.body },
              h(React.Suspense, { fallback: h('div', { style: { padding: 12, ...S.dim } }, '正在加载终端渲染组件…') },
                h(LazyTerminal, { api: terminalApi, sessionId: liveId, theme, visible: true })),
              h(ApprovalBanner, { session: liveSession ?? { id: activeId, permission: 'ask' }, approval, overlay: true })),
            h('div', { style: { ...S.drawer, maxHeight: drawer === 'none' ? 34 : '46%' } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                [['log', '日志'], ['history', '历史'], ['note', '留言'], ['approval', `待确认${approval === undefined ? '' : ' •1'}`]].map(([key, label]) => h('button', {
                  key,
                  type: 'button',
                  style: { ...S.btn, padding: '1px 8px', fontSize: 11, color: drawer === key ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)' },
                  onClick: () => setDrawer(key),
                }, label)),
                h('span', { style: { flex: '1 1 auto' } }),
                h('span', { style: { ...S.dim, fontSize: 11 } }, `${liveSession?.bytesOut ?? 0} B 输出`),
                h('button', { type: 'button', style: S.btn, onClick: () => setDrawer(drawer === 'none' ? 'log' : 'none') }, drawer === 'none' ? '展开' : '折叠')),
              drawer === 'none' ? null : (drawer === 'log'
                ? h(LogPanel, { session: liveSession ?? { id: activeId } })
                : drawer === 'history'
                  ? h(HistoryPanel, {})
                  : drawer === 'note'
                  ? h(NotePanel, { session: liveSession ?? { id: activeId } })
                  : approval === undefined
                    ? h('div', { style: { padding: 8, ...S.dim } }, '当前没有等待确认的 AI 命令。')
                    : h('div', { style: { padding: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
                      h('div', null, approval.mode === 'announce' ? '危险命令告知窗口' : 'AI 请求执行命令'),
                      h('code', { style: S.mono }, approval.command),
                      approval.danger !== undefined && approval.danger !== null
                        ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, `命中规则：${approval.danger.note || approval.danger.id}`)
                        : null,
                      h('div', { style: { display: 'flex', gap: 6 } },
                        h('button', {
                          type: 'button',
                          style: S.btnPrimary,
                          onClick: () => void invoke('approval.answer', { dshSessionId: dshId(), sessionId: activeId, approvalId: approval.id, approve: approval.mode === 'announce' ? false : true }).catch(() => {}),
                        }, approval.mode === 'announce' ? '立即取消' : '允许'),
                        approval.mode === 'announce' ? null : h('button', {
                          type: 'button',
                          style: S.btnDanger,
                          onClick: () => void invoke('approval.answer', { dshSessionId: dshId(), sessionId: activeId, approvalId: approval.id, approve: false }).catch(() => {}),
                        }, '拒绝'))))));
        }

        /**
         * The plugin's own tab strip.
         *
         * The Host strip is `overflow: hidden` with no scrollbar and its DOM is off limits, so the
         * plugin renders its own strip inside one Host tab and owns the scrolling: wheel scrolls it
         * sideways, ◀/▶ nudge it, and ▾ lists every session no matter where the strip is scrolled.
         */
        function SessionStrip(props) {
          const scroller = React.useRef(null);
          const popup = React.useRef(null);
          const [menu, setMenu] = React.useState(false);
          React.useEffect(() => {
            const node = scroller.current;
            if (node === null) return undefined;
            const onWheel = (event) => {
              if (event.deltaY === 0) return;
              node.scrollLeft += event.deltaY;
              event.preventDefault();
            };
            node.addEventListener('wheel', onWheel, { passive: false });
            return () => node.removeEventListener('wheel', onWheel);
          }, []);
          // Host popovers close on an outside press or Escape: the toggle button opens them, but that
          // is not how people dismiss a menu, so do not require a second press on the button.
          React.useEffect(() => {
            if (!menu) return undefined;
            const onPointerDown = (event) => {
              const node = popup.current;
              if (node !== null && node.contains(event.target)) return;
              setMenu(false);
            };
            const onKeyDown = (event) => {
              if (event.key !== 'Escape') return;
              setMenu(false);
            };
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('keydown', onKeyDown, true);
            return () => {
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('keydown', onKeyDown, true);
            };
          }, [menu]);
          const nudge = (delta) => {
            const node = scroller.current;
            if (node !== null) node.scrollLeft += delta;
          };
          const rows = props.rows;
          return h('div', { style: S.strip },
            h('button', { type: 'button', style: S.stripBtn, title: '向左滚动', onClick: () => nudge(-160) }, '◀'),
            h('div', { ref: scroller, style: S.stripScroll },
              rows.map((row) => {
                const active = row.id === props.activeId;
                return h('div', {
                  key: row.id,
                  role: 'button',
                  title: row.pinned === true ? '常驻：主机管理、新建连接、日志目录' : `${row.id} · ${row.host} · ${row.state ?? ''}`,
                  style: { ...S.stripTab, ...(active ? S.stripTabActive : null) },
                  onClick: () => props.onSelect(row.id),
                },
                row.pinned === true
                  ? null
                  : h('span', { style: { width: 7, height: 7, borderRadius: 999, flex: '0 0 auto', background: stateColor(row) } }),
                h('span', { style: { ...S.mono, fontSize: 11, whiteSpace: 'nowrap' } }, row.pinned === true ? row.label : row.host),
                row.alive || row.pinned === true ? null : h('span', { style: { ...S.dim, fontSize: 10 } }, '已断'),
                row.pinned === true ? null : h('span', {
                  role: 'button',
                  title: '关闭这个会话',
                  style: { ...S.dim, cursor: 'pointer', padding: '0 2px' },
                  onClick: (event) => { event.stopPropagation(); props.onClose(row.id); },
                }, '✕'));
              })),
            h('button', { type: 'button', style: S.stripBtn, title: '向右滚动', onClick: () => nudge(160) }, '▶'),
            h('div', { ref: popup, style: { position: 'relative', flex: '0 0 auto' } },
              h('button', { type: 'button', style: S.stripBtn, title: '所有页面', onClick: () => setMenu(!menu) }, '▾'),
              menu ? h('div', { style: S.menu },
                rows.map((row) => h('div', {
                  key: `menu-${row.id}`,
                  style: { ...S.row, cursor: 'pointer' },
                  onClick: () => { props.onSelect(row.id); setMenu(false); },
                },
                  h('span', { style: { ...S.mono, flex: '1 1 auto' } }, row.pinned === true ? row.label : `${row.id} · ${row.host}`),
                  h('span', { style: S.dim }, row.pinned === true ? '常驻' : (row.alive ? (row.permission ?? '') : '已断'))))) : null),
            h('button', { type: 'button', style: S.stripBtn, onClick: props.onNew, title: '新建连接' }, '＋ 新建'));
        }

        /**
         * The single Host tab this plugin owns: its own strip plus either the manager view or one
         * session. Every session lives here, so the Host strip never grows past one entry.
         */
        function ConsoleBody(props) {
          const { useTabInfo } = props;
          useTabInfo();
          if (typeof props.sessionId === 'string' && props.sessionId.length > 0) dshSessionId = props.sessionId;
          useStore(store);
          const current = state();
          const rows = stripRows(current.sessions);
          const requested = current.activeView;
          const known = rows.map((row) => row.id);
          const active = typeof requested === 'string' && known.includes(requested)
            ? requested
            : 'manager';
          const key = known.join(',');
          React.useEffect(() => {
            // A session can vanish (closed by anyone, or lost with the process): fall back to a live
            // one instead of rendering an empty pane.
            if (active !== requested) set({ activeView: active });
          }, [active, requested]);
          const cycle = React.useCallback((step) => {
            if (known.length < 2) return;
            const index = known.indexOf(active);
            set({ activeView: known[(index + step + known.length) % known.length] });
          }, [active, key]);
          const closeSession = (id) => {
            void invoke('session.close', { dshSessionId: dshId(), sessionId: id }).catch(() => {});
          };
          return h('div', { style: { ...S.panel, flexDirection: 'column' } },
            h(SessionStrip, {
              rows,
              activeId: active,
              onSelect: (id) => set({ activeView: id }),
              onClose: closeSession,
              onNew: () => set({ activeView: 'manager' }),
            }),
            active === 'manager'
              ? h(ManagerBody, { sessionId: props.sessionId, onSelect: (id) => set({ activeView: id }) })
              : h(SessionView, { sessionId: active, onCycle: cycle }));
        }

        /**
         * Tabs from earlier versions carried one session each. Adopt that session into the console
         * and close this tab, so old layouts clean themselves up instead of lingering off-screen.
         */
        function LegacyTabBody(props) {
          const { useTabInfo } = props;
          const info = useTabInfo();
          if (typeof props.sessionId === 'string' && props.sessionId.length > 0) dshSessionId = props.sessionId;
          useStore(store);
          const tabId = info?.tab?.id;
          const contentId = info?.tab?.contentId;
          const paramsSessionId = info?.tab?.navigation?.params?.sessionId;
          React.useEffect(() => {
            const bound = readBinding(contentId)?.sessionId;
            const adopted = (typeof bound === 'string' && bound.length > 0)
              ? bound
              : (typeof paramsSessionId === 'string' && state().sessions[paramsSessionId] !== undefined ? paramsSessionId : undefined);
            if (adopted !== undefined) set({ activeView: adopted });
            ensureConsoleTab();
            if (tabId === undefined) return undefined;
            const timer = setTimeout(() => { try { ctx.sidebarRight.close(tabId); } catch { /* already gone */ } }, 500);
            return () => clearTimeout(timer);
          }, []);
          return h('div', { style: { ...S.panel, flexDirection: 'column', padding: 12, gap: 6 } },
            h('div', null, '这个标签来自旧版本：会话已并入「SSH 控制台」，它会自动关闭。'),
            h('div', { style: { ...S.dim, fontSize: 11 } }, '如果没有自动关掉，直接点 ✕ 关掉它即可。'));
        }

        function ManagerBody(props) {
          if (typeof props.sessionId === 'string' && props.sessionId.length > 0) dshSessionId = props.sessionId;
          useStore(store);
          const current = state();
          const [form, setForm] = React.useState({ target: 'localhost', user: '', port: '', name: '', save: false });
          const [busy, setBusy] = React.useState(false);
          const [message, setMessage] = React.useState(null);
          const field = (key) => ({
            value: form[key],
            onChange: (event) => setForm({ ...form, [key]: event.target.value }),
            style: { ...S.input, ...(key === 'target' ? S.mono : {}) },
          });
          const connectTo = (descriptor) => {
            setBusy(true);
            setMessage(null);
            void openSession(descriptor)
              .then(async (result) => {
                selectSession(result.session.id);
                if (descriptor.save === true) {
                  await invoke('hosts.save', { profile: { name: form.name || form.target, target: form.target, user: form.user, port: form.port } })
                    .then((value) => set({ hosts: value.hosts }))
                    .catch(() => {});
                }
                setMessage(`已创建 ${result.session.id}（${result.session.host}）`);
              })
              .catch((error) => setMessage(`连接失败：${error?.code ?? ''} ${String(error?.message ?? error)}`))
              .finally(() => setBusy(false));
          };
          const connect = () => {
            if (form.target.trim().length === 0) { setMessage('请填写主机地址'); return; }
            connectTo({
              target: form.target.trim(),
              user: form.user.trim(),
              port: form.port.trim(),
              name: form.name.trim(),
              save: form.save,
            });
          };
          const connectHost = (host) => {
            setForm({ target: host.target, user: host.user ?? '', port: host.port ?? '', name: host.name ?? '', save: false });
          };
          const sessions = Object.values(current.sessions);
          return h('div', { style: { ...S.panel, gap: 0 } },
            h('div', { style: { ...S.scroll, flex: '1 1 auto', display: 'flex', flexDirection: 'column' } },
            h('div', { style: { padding: 10, display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { ...S.dim, fontSize: 11 } }, `流状态：${current.stream}`),
                h('span', { style: { flex: '1 1 auto' } }),
                h('span', { style: { ...S.dim, fontSize: 11 } }, current.logDir)),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('input', { ...field('target'), placeholder: 'host / user@host / ~/.ssh/config 别名', style: { ...field('target').style, flex: '2 1 220px' } }),
                h('input', { ...field('user'), placeholder: 'user（可选）', style: { ...field('user').style, flex: '1 1 110px' } }),
                h('input', { ...field('port'), placeholder: '端口', style: { ...field('port').style, flex: '0 1 70px' } }),
                h('input', { ...field('name'), placeholder: '显示名（可选）', style: { ...field('name').style, flex: '1 1 120px' } })),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('label', { style: { display: 'flex', gap: 4, alignItems: 'center', ...S.dim, fontSize: 11 } },
                  h('input', { type: 'checkbox', checked: form.save, onChange: (event) => setForm({ ...form, save: event.target.checked }) }),
                  '同时保存为常用主机'),
                h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: connect }, busy ? '连接中…' : '连接'),
                message !== null ? h('span', { style: { ...S.dim, fontSize: 11 } }, message) : null)),
            h('div', { style: { padding: '8px 10px 4px', ...S.dim, fontSize: 11 } }, '最近连接（存在浏览器里，Harness 重启后仍在）'),
            current.recents.length === 0
              ? h('div', { style: { padding: '0 10px 8px', ...S.dim } }, '还没有记录；连过一次就会出现在这里。')
              : current.recents.map((recent) => h('div', { key: `recent-${recent.target}-${recent.user}-${recent.port}`, style: S.row },
                h('span', { style: { ...S.mono, flex: '1 1 auto' } },
                  `${recent.user === undefined || recent.user === '' ? '' : `${recent.user}@`}${recent.target}${recent.port === undefined || recent.port === '' ? '' : `:${recent.port}`}`),
                h('span', { style: S.dim }, recent.name ?? ''),
                h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => connectTo(recent) }, '连接'),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => setForm({ target: recent.target, user: recent.user ?? '', port: String(recent.port ?? ''), name: recent.name ?? '', save: false }),
                }, '填入'))),
            h('div', { style: { padding: '8px 10px 4px', ...S.dim, fontSize: 11 } }, '已保存的主机'),
            current.hosts.length === 0
              ? h('div', { style: { padding: '0 10px 8px', ...S.dim } }, '还没有保存的主机。认证沿用本机 OpenSSH，插件不保存任何口令。')
              : current.hosts.map((host) => h('div', { key: host.id, style: S.row },
                h('span', { style: { ...S.mono, flex: '1 1 auto' } }, `${host.user === undefined ? '' : `${host.user}@`}${host.target}${host.port === undefined ? '' : `:${host.port}`}`),
                h('span', { style: S.dim }, host.name ?? ''),
                h('button', { type: 'button', style: S.btn, onClick: () => connectHost(host) }, '填入'),
                h('button', {
                  type: 'button',
                  style: S.btnDanger,
                  onClick: () => { void invoke('hosts.remove', { id: host.id }).then((value) => set({ hosts: value.hosts })).catch(() => {}); },
                }, '删除'))),
            h('div', { style: { padding: '8px 10px 4px', ...S.dim, fontSize: 11 } }, '当前 SSH 会话（AI 也能看到同一批）'),
            h('div', { style: { padding: '0 10px 6px', ...S.dim, fontSize: 11 } },
              '会话都在上方这个标签条里：滚轮/◀▶ 滚动，▾ 看全部，Ctrl+Alt+←/→ 依次切换。'
              + '历史日志在下面「历史日志」一栏，也可以在任意会话底部的抽屉里点「历史」查看。'),
            sessions.length === 0
              ? h('div', { style: { padding: '0 10px 10px', ...S.dim } }, '还没有打开的会话。')
              : sessions.map((session) => h('div', { key: session.id, style: S.row },
                h('span', { style: { width: 8, height: 8, borderRadius: 999, background: stateColor(session) } }),
                h('span', { style: { ...S.mono } }, session.id),
                h('span', { style: { flex: '1 1 auto' } }, `${session.host} · ${stateLabel(session)} · ${session.permission}`),
                h('button', { type: 'button', style: S.btn, onClick: () => props.onSelect(session.id) }, '在控制台打开'),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => { void invoke('session.close', { dshSessionId: dshId(), sessionId: session.id }).catch(() => {}); },
                }, '关闭'))),
            current.error !== null ? h('div', { style: { padding: 10, color: 'var(--dsw-alias-state-error-primary)' } }, current.error) : null,
            h(HistoryPanel, {}),
            h('div', { style: { padding: 10, ...S.dim, fontSize: 11, lineHeight: 1.6 } },
              '权限：仅可看 = AI 只能读；问答 = AI 的每条命令都要你点确认；完全 = 直接执行，危险命令先弹可取消的告知窗口。',
              h('br'),
              `日志目录：${current.logDir}（命令原文完整保留，输出超过阈值会被截断并标注）`,
              h('br'),
              '历史：超过 logArchiveAfterDays 天的日志自动 gzip 进同目录 archive/；logRetentionDays > 0 时才删除归档（0 = 永久保留）。',
              h('br'),
              `主机配置：${current.hostsFile}`,
              h('br'),
              `客户端版本：${CLIENT_BUILD}（看不到这行说明页面还是旧代码，刷新即可）`)));
        }

        /** One Host tab, so the title carries the whole plugin's state: host, live count. */
        function ConsoleTitle(props) {
          props.useTabInfo();
          useStore(store);
          const current = state();
          const entries = consoleStripEntries(current.sessions);
          const shown = entries.find((entry) => entry.id === current.activeView);
          const alive = entries.filter((entry) => entry.alive).length;
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 } },
            h('span', { style: { width: 7, height: 7, borderRadius: 999, background: (shown?.alive === true) ? stateColor(shown) : 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' } }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shown?.host ?? 'SSH 控制台'),
            entries.length === 0 ? null : h('span', { style: { ...S.dim, fontSize: 10 } }, `${alive}/${entries.length}`));
        }

        function LegacyTitle() {
          return h('span', { style: { ...S.dim } }, 'SSH（旧标签）');
        }

        // ------------------------------------------------------------ registrations

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: CONSOLE_TAB_ID,
          kind: 'ssh-console',
          keepMounted: true,
          title: () => 'SSH 控制台',
          guide: [{
            id: 'console',
            order: 21,
            title: () => 'SSH 控制台',
            description: () => '本机 ssh 跑在真实 PTY 中；用户与 AI 共用同一条会话，所有会话都在这个标签自己的二级标签条上（可滚动）。',
          }],
        }), 'dsh-ssh:tab-type-console');

        // Tabs created by an earlier version carry one session each and live in the browser's saved
        // layout. Keep the type registered so they render an adoption panel instead of breaking, and
        // leave it out of the guide so it is not offered to new users.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: LEGACY_TAB_ID,
          kind: 'ssh',
          multiple: true,
          keepMounted: false,
          title: () => 'SSH（旧标签）',
        }), 'dsh-ssh:tab-type-legacy');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: CONSOLE_TAB_ID,
        }, guarded(ConsoleBody, 'console-body'))), 'dsh-ssh:body-console');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: CONSOLE_TAB_ID,
        }, ConsoleTitle)), 'dsh-ssh:title-console');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: LEGACY_TAB_ID,
        }, guarded(LegacyTabBody, 'legacy-body'))), 'dsh-ssh:body-legacy');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: LEGACY_TAB_ID,
        }, LegacyTitle)), 'dsh-ssh:title-legacy');

        // Initial snapshot, in case the stream takes a moment to connect.
        void invoke('hello', { dshSessionId: dshId() })
          .then((value) => set({ hosts: value.hosts ?? [], logDir: value.logDir ?? '', hostsFile: value.hostsFile ?? '' }))
          .catch(() => {});
      },
      // Test seam: the browser-memory helpers are pure functions of localStorage, and the wiring
      // test exercises them directly (the module loader ignores unknown plugin keys).
      __internals: {
        readRecents, pushRecent, readBinding, writeBinding, descriptorFor, isAliveSession, CLIENT_BUILD, stateColor,
        selectSession: (id) => exposed.selectSession?.(id),
        consoleStripEntries: (sessions) => exposed.consoleStripEntries?.(sessions) ?? [],
        stripRows: (sessions) => exposed.stripRows?.(sessions) ?? [],
        BINDING_PREFIX, RECENTS_KEY,
        snapshot: () => (activeStore === null ? null : activeStore.get()),
      },
    };
  },
});
