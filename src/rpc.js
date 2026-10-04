/**
 * The Host surface the browser talks to.
 *
 * Both channels are exact Fetch routes on `ctx.connection`. Deliberately NOT `connection.rpc.handle`:
 * that API scopes its registration to the PROVIDER's own context
 * (`get rpc() { const owner = this.ctx; ... }`) and then reaches for `owner.webServer`, whose
 * accessor refuses any fiber that did not inject it — so a consumer-side `inject: ['webServer']`
 * cannot satisfy it. In this deployment it throws
 *   cannot get property "webServer" without inject
 * and takes the whole plugin down at boot.
 * `connection.fetch.register` has no such dependency: it validates the path, records the route on
 * the connection service's own map, and owns an ordinary effect.
 *
 *  - POST /api/dsh-ssh/invoke → one unary call, JSON `{ ok, value | error }`
 *  - POST /api/dsh-ssh/stream → long-lived NDJSON frame stream (output, state, approvals)
 *
 * The stream is the primary push channel; the client falls back to polling `invoke` if it cannot
 * be established.
 */

import { SshError } from './session.js';

export const INVOKE_PATH = '/api/dsh-ssh/invoke';
export const STREAM_PATH = '/api/dsh-ssh/stream';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Fan-out hub between sessions/approvals and the browser stream subscribers. */
export function createHub() {
  const listeners = new Set();
  return {
    listeners,
    broadcast(frame) {
      for (const listener of listeners) {
        try { listener(frame); } catch { /* one broken subscriber must not break others */ }
      }
    },
  };
}

export function createSshRpc({ manager, config, deliverNote, hub, onClientError, resolveCwd }) {
  /** Dispatch one unary call. Throwing produces `{ok:false, error}` for the client. */
  async function invoke(payload) {
    const method = payload?.method;
    const params = payload?.params ?? {};
    switch (method) {
      case 'hello':
        return {
          sessions: manager.list(params.dshSessionId),
          hosts: manager.hosts.list(),
          logDir: manager.logDir,
          hostsFile: manager.hosts.path,
          defaultPermission: config.defaultPermission,
          streamPath: STREAM_PATH,
          invokePath: INVOKE_PATH,
        };
      case 'hosts.list':
        return { hosts: manager.hosts.list(), file: manager.hosts.path };
      case 'hosts.save':
        return { host: manager.hosts.save(params.profile ?? {}), hosts: manager.hosts.list() };
      case 'hosts.remove':
        return { removed: manager.hosts.remove(String(params.id ?? '')), hosts: manager.hosts.list() };
      case 'sessions.list':
        return { sessions: manager.list(params.dshSessionId) };
      case 'session.open': {
        const session = await manager.open({
          dshSessionId: params.dshSessionId,
          target: params.target,
          user: params.user,
          port: params.port === undefined || params.port === '' ? undefined : Number(params.port),
          name: params.name,
          cwd: params.cwd ?? resolveCwd?.(params.dshSessionId),
          rows: params.rows ?? config.defaultRows,
          cols: params.cols ?? config.defaultCols,
          permission: params.permission ?? config.defaultPermission,
        });
        try { manager.sweepLogs(); } catch { /* housekeeping is best-effort */ }
        return { session, banner: manager.get(params.dshSessionId, session.id).banner(1500) };
      }
      case 'session.close':
        return manager.close(params.dshSessionId, params.sessionId);
      case 'session.rename':
        return { session: manager.rename(params.dshSessionId, params.sessionId, params.name) };
      case 'session.permission':
        return { session: manager.setPermission(params.dshSessionId, params.sessionId, params.permission) };
      case 'session.resize':
        return await manager.resize(params.dshSessionId, params.sessionId, params.cols, params.rows);
      case 'session.revokeAi':
        return manager.revokeAi(params.dshSessionId, params.sessionId);
      case 'input.write':
        return await manager.writeUser(params.dshSessionId, params.sessionId, String(params.data ?? ''));
      case 'approval.answer':
        return manager.answerApproval(params.dshSessionId, params.sessionId, params.approvalId, params.approve === true);
      case 'note.send':
        return deliverNote({
          dshSessionId: params.dshSessionId,
          sessionId: params.sessionId,
          kind: params.kind === 'error' || params.kind === 'notebook' ? params.kind : 'question',
          text: String(params.text ?? ''),
        });
      case 'log.list':
        return manager.listLogs(Math.min(500, Number(params.limit ?? 200)));
      case 'log.readFile':
        return manager.readLogFile(String(params.name ?? ''), Math.min(2000, Number(params.maxLines ?? 300)));
      case 'log.read':
        return manager.logRead(params.dshSessionId, params.sessionId, {
          actor: typeof params.actor === 'string' && params.actor.length > 0 ? params.actor : undefined,
          kind: typeof params.kind === 'string' && params.kind.length > 0 ? params.kind : undefined,
          limit: Math.min(1000, Number(params.limit ?? 200)),
        });
      case 'output.since': {
        const session = manager.get(params.dshSessionId, params.sessionId);
        return { seq: session.ring.seq, data: session.ring.since(Number(params.from ?? 0)) };
      }
      case 'client.error': {
        const report = {
          scope: String(params.scope ?? 'unknown'),
          message: String(params.message ?? '').slice(0, 4000),
          detail: String(params.detail ?? '').slice(0, 4000),
          sessionId: params.sessionId === undefined ? null : String(params.sessionId),
          ua: String(params.ua ?? '').slice(0, 300),
        };
        try { onClientError?.(report); } catch { /* diagnostics must never break the call */ }
        return { logged: true };
      }
      default:
        throw new SshError('SSH_BAD_METHOD', `未知方法 ${String(method)}`);
    }
  }

  /** POST body `{ method, params }` → the invoke envelope. */
  async function invokeResponse(request) {
    let payload = null;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: { code: 'SSH_BAD_BODY', message: '请求体不是 JSON', details: {} } }, 400);
    }
    try {
      return json({ ok: true, value: await invoke(payload) });
    } catch (error) {
      const code = error instanceof SshError ? error.code : (error?.code ?? 'SSH_ERROR');
      return json({
        ok: false,
        error: { code: String(code), message: String(error?.message ?? error), details: error?.details ?? {} },
      });
    }
  }

  function streamResponse(request) {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream({
      async start(controller) {
        let payload = {};
        try {
          payload = await request.json();
        } catch {
          controller.enqueue(encoder.encode(`${JSON.stringify({ t: 'error', message: '缺少请求体' })}\n`));
          controller.close();
          return;
        }
        const dshSessionId = String(payload?.dshSessionId ?? '');
        const send = (frame) => {
          try { controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`)); } catch { /* closed */ }
        };
        send({
          t: 'hello',
          at: Date.now(),
          sessions: manager.list(dshSessionId),
          hosts: manager.hosts.list(),
          logDir: manager.logDir,
          streamPath: STREAM_PATH,
        });
        const listener = (frame) => {
          if (dshSessionId === '' || frame.dshSessionId === dshSessionId) send(frame);
        };
        hub.listeners.add(listener);
        const ping = setInterval(() => send({ t: 'ping', at: Date.now() }), 20000);
        ping.unref?.();
        cleanup = () => {
          clearInterval(ping);
          hub.listeners.delete(listener);
        };
        request.signal.addEventListener('abort', () => {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        });
      },
      cancel() { cleanup(); },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    });
  }

  /** Unary channel: one exact Fetch route, no `webServer` involvement. */
  function registerInvoke(ctx) {
    return ctx.connection.fetch.register({
      path: INVOKE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: invokeResponse,
    });
  }

  /** Live frame stream: the second exact Fetch route. */
  function registerStream(ctx) {
    return ctx.connection.fetch.register({
      path: STREAM_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => streamResponse(request),
    });
  }

  return { invoke, invokeResponse, streamResponse, registerInvoke, registerStream };
}
