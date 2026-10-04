/**
 * Lazy chunk: the xterm.js renderer for one SSH tab.
 *
 * Bundled by `build.mjs` into `client.xterm.js`, a sibling of `client.js`, loaded on demand with
 * `require.async('./client.xterm.js')`.
 *
 * Two deliberate shapes here:
 *  - the xterm requires sit at module top level so esbuild inlines them (a `require` shadowed by a
 *    factory parameter would be left as a runtime call);
 *  - React is NOT imported: `createSshTerminal(React)` receives the page's single React copy from
 *    `client.js`, so the bundle can never grow a second React.
 *
 * The component is deliberately dumb: it paints bytes and reports keystrokes/resizes. Every Host
 * call lives in `client.js`, which passes an `api` object in.
 */

const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const xtermCss = require('@xterm/xterm/css/xterm.css');

window.__ModuleLoader__.load({
  id: 'dsh-likemobaxtearm-chumc',
  chunk: 'client.xterm.js',
  factory() {
    const COMPONENT_CSS = [
      '.dsh-ssh-term { position: absolute; inset: 0; padding: 4px 0 0 6px; }',
      '.dsh-ssh-term .xterm { height: 100%; }',
      '.dsh-ssh-term .xterm-viewport { background: transparent !important; }',
    ].join('\n');

    /**
     * @param {any} React the page's React copy
     * @returns a component taking `{ api, sessionId, theme, visible }`
     */
    function createSshTerminal(React) {
      const h = React.createElement;

      function SshTerminal(props) {
        const { api, sessionId, theme, visible } = props;
        const hostRef = React.useRef(null);
        const termRef = React.useRef(null);
        const fitRef = React.useRef(null);

        React.useEffect(() => {
          if (hostRef.current === null) return undefined;
          const term = new Terminal({
            allowProposedApi: true,
            convertEol: false,
            cursorBlink: true,
            cursorStyle: 'block',
            fontSize: 12.5,
            lineHeight: 1.2,
            scrollback: 8000,
            fontFamily: 'var(--ds-font-family-code), ui-monospace, SFMono-Regular, Menlo, monospace',
            theme,
          });
          const fit = new FitAddon();
          term.loadAddon(fit);
          term.open(hostRef.current);
          termRef.current = term;
          fitRef.current = fit;

          const safeFit = () => {
            try {
              const size = fit.proposeDimensions();
              if (size !== undefined && Number.isFinite(size.cols) && Number.isFinite(size.rows) && size.cols > 2 && size.rows > 1) {
                fit.fit();
              }
            } catch { /* a zero-sized or detached pane is not an error */ }
          };
          safeFit();

          // Attach first (synchronously), then paint history: no gap, no duplicated bytes.
          const attachment = api.attach(sessionId, (data) => term.write(data));
          if (attachment.history.length > 0) term.write(attachment.history);

          const dataSub = term.onData((data) => api.write(sessionId, data));
          const resizeSub = term.onResize(({ cols, rows }) => api.resize(sessionId, cols, rows));
          const observer = new ResizeObserver(() => safeFit());
          observer.observe(hostRef.current);
          const onWindowResize = () => safeFit();
          window.addEventListener('resize', onWindowResize);

          return () => {
            window.removeEventListener('resize', onWindowResize);
            observer.disconnect();
            dataSub.dispose();
            resizeSub.dispose();
            attachment.detach();
            term.dispose();
            termRef.current = null;
            fitRef.current = null;
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [sessionId]);

        React.useEffect(() => {
          if (termRef.current !== null && theme !== undefined) termRef.current.options.theme = theme;
        }, [theme]);

        React.useEffect(() => {
          if (visible === false) return undefined;
          const timer = setTimeout(() => {
            try { fitRef.current?.fit(); } catch { /* pane not laid out yet */ }
          }, 30);
          return () => clearTimeout(timer);
        }, [visible]);

        return h(React.Fragment, null,
          h('style', null, xtermCss),
          h('style', null, COMPONENT_CSS),
          h('div', { className: 'dsh-ssh-term', ref: hostRef }));
      }

      return SshTerminal;
    }

    return { createSshTerminal };
  },
});
