/**
 * The model-facing tool surface.
 *
 * Tools are registered as hand-built `ToolDefinition` objects rather than through
 * `defineTool(...)`: a profile-installed bundle cannot resolve `@deepseek-ai/*` specifiers, so the
 * bundle stays dependency-free and validates its own arguments.
 */

const TEXT_OUTPUT = {
  schema: {},
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
};

/**
 * Drop `undefined`-valued keys: a tool result must be a lossless JSON value, and the Harness
 * rejects one that carries an explicit `undefined` ("must be a lossless JSON value").
 */
function clean(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = entry;
  return out;
}

function requireAgent(exec) {
  const agent = exec?.agent;
  if (agent === undefined || agent === null) {
    throw new Error('SSH 工具需要在一个 Agent 会话中调用（没有发起 Agent）');
  }
  return agent;
}

/**
 * The DSH session id of the calling agent.
 *
 * The Agent interface has `id` and `session` — there is NO `sessionId` property, and reading one
 * yields `undefined`, which made every ownership check fail while an unscoped list still looked
 * fine. Ask for `session.id` first, then `id`, and refuse to guess.
 */
function dshSessionOf(agent) {
  const id = agent?.session?.id ?? agent?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('无法确定当前 DSH 会话 id（Agent 既没有 session.id 也没有 id）');
  }
  return id;
}

/** The owning session's workspace root, when it has one: logs belong next to that workspace. */
function sessionCwdOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

function requireString(args, field) {
  const value = args?.[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`参数 "${field}" 必须是非空字符串`);
  }
  return value;
}

function optionalNumber(args, field) {
  const value = args?.[field];
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`参数 "${field}" 必须是数字`);
  return parsed;
}

const SESSION_NOTE = '会话 id 由 ssh_connect / ssh_list_sessions 得到；会话由用户与 AI 共用同一条真实 PTY。';

/**
 * @param {object} deps
 * @param {import('./manager.js').SshManager} deps.manager
 * @param {() => object} deps.getConfig
 */
export function createSshTools({ manager, getConfig }) {
  const sessionsOf = (exec) => manager.list(dshSessionOf(requireAgent(exec)));

  return [
    {
      name: 'ssh_list_hosts',
      description:
        '列出已保存的 SSH 主机配置（别名/host、user、port、备注）。这些配置不含任何口令：认证沿用本机 OpenSSH 的 ~/.ssh/config、密钥与 ssh-agent。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute() {
        return clean({ hosts: manager.hosts.list(), hostsFile: manager.hosts.path, logDir: manager.logDir });
      },
    },
    {
      name: 'ssh_list_sessions',
      description:
        `列出当前 DSH 会话里打开的 SSH 会话及其权限、输入权归属和最后活动时间。${SESSION_NOTE} ` +
        'AI 只能看到本 DSH 会话创建的 SSH 会话。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute(_args, exec) {
        return clean({ sessions: sessionsOf(exec) });
      },
    },
    {
      name: 'ssh_connect',
      description:
        '新建一个 SSH 会话（本机 ssh 客户端跑在真实 PTY 中）。target 可以是 ~/.ssh/config 里的别名，也可以是 host 或 user@host；' +
        '需要密钥或口令时认证提示会出现在终端里，由用户完成——AI 不得代填凭据。新会话会立刻在右侧栏打开一个标签页，用户能看到 AI 的连接动作。' +
        `权限默认跟随配置（默认「问答」：每条命令都要用户确认）。${SESSION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'host / user@host / ~/.ssh/config 别名' },
          user: { type: 'string', description: '可选登录用户（target 未带 @ 时使用）' },
          port: { type: 'integer', description: '可选端口，默认 22' },
          name: { type: 'string', description: '可选显示名（标签页标题）' },
        },
        required: ['target'],
      },
      output: TEXT_OUTPUT,
      presentCall: (args) => ({ card: 'generic', title: `SSH 连接 ${args?.target ?? ''}`, kind: 'execute' }),
      async execute(args, exec) {
        const agent = requireAgent(exec);
        const target = requireString(args, 'target');
        const config = getConfig();
        const port = optionalNumber(args, 'port');
        const session = await manager.open({
          dshSessionId: dshSessionOf(agent),
          cwd: sessionCwdOf(agent),
          target,
          user: typeof args?.user === 'string' ? args.user : undefined,
          port,
          name: typeof args?.name === 'string' ? args.name : undefined,
          rows: config.defaultRows,
          cols: config.defaultCols,
          permission: config.defaultPermission,
        });
        return clean({
          session,
          banner: manager.get(dshSessionOf(agent), session.id).banner(1500),
          note: '会话已打开。用 ssh_exec 执行命令；用户在终端里的输入与 AI 的命令都会写入同一份日志。',
        });
      },
    },
    {
      name: 'ssh_exec',
      description:
        '在被共享的 SSH 会话里执行一条命令并等待结束，返回输出与退出码。' +
        '权限规则：仅可看=直接拒绝；问答=用户点确认后执行；完全=直接执行，但危险命令会先弹出可取消的告知窗口。' +
        '退出码靠哨兵标记解析（启发式：命令自己后台化、或把 shell 换掉时可能拿不到真实退出码）。' +
        '注意：哨兵用 POSIX printf，因此要求**远端**是 POSIX shell（bash/sh/zsh/ksh）；远端是 cmd/PowerShell 时请用 ssh_send + ssh_read。' +
        `用户随时可以打断：一旦用户按键收回输入权，本次执行会以 waitReason=revoked 结束。${SESSION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', description: 'SSH 会话 id' },
          command: { type: 'string', description: '要执行的命令（单条，可含管道/重定向）' },
          timeoutMs: { type: 'integer', description: '等待上限，默认由插件配置决定' },
        },
        required: ['sessionId', 'command'],
      },
      output: {
        schema: {},
        render: (_args, value) => {
          const head = `[exit ${value.exitCode ?? '?'}] [waitReason ${value.waitReason}] [permission ${value.permission}]` +
            (value.danger ? ` [danger ${value.danger.id}]` : '');
          return [{ type: 'text', text: `${head}\n${value.output ?? ''}` }];
        },
      },
      presentCall: (args) => ({ card: 'generic', title: `SSH 执行`, kind: 'execute', rawInput: args?.command }),
      async execute(args, exec) {
        const agent = requireAgent(exec);
        const sessionId = requireString(args, 'sessionId');
        const command = requireString(args, 'command');
        const result = await manager.execByAi(dshSessionOf(agent), sessionId, command, {
          timeoutMs: optionalNumber(args, 'timeoutMs'),
        });
        const config = getConfig();
        const cap = config.maxToolOutputBytes ?? 16384;
        const output = result.output.length > cap ? result.output.slice(result.output.length - cap) : result.output;
        return clean({
          sessionId,
          exitCode: result.exitCode,
          waitReason: result.waitReason,
          permission: result.permission,
          danger: result.danger === null
            ? undefined
            : { id: result.danger.id, note: result.danger.note, match: result.danger.match },
          output,
          truncated: result.output.length > cap || result.truncated,
          note: result.waitReason === 'timeout'
            ? '等待超时：远端 shell 可能未被识别（哨兵方言选错了）。用 ssh_status 看 detectedShell，'
              + '并把配置项 remoteShell 设为 posix / cmd / powershell 之一；也可以改用 ssh_send + ssh_read。'
            : '启发式退出码；完整输出见会话日志（ssh_log）。',
        });
      },
    },
    {
      name: 'ssh_send',
      description:
        '向共享会话写入原始文本（可选回车），用于交互式程序：回答提示、发送 Ctrl+C（"\\u0003"）、翻页等。' +
        `不等待输出；要看结果用 ssh_read。同样受三级权限约束。${SESSION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', description: 'SSH 会话 id' },
          text: { type: 'string', description: '要写入的原始文本' },
          submit: { type: 'boolean', description: '是否在末尾回车，默认 true' },
        },
        required: ['sessionId', 'text'],
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const agent = requireAgent(exec);
        return manager.sendRaw(dshSessionOf(agent), requireString(args, 'sessionId'), String(args.text ?? ''), args?.submit !== false);
      },
    },
    {
      name: 'ssh_read',
      description: `读取 SSH 会话的终端输出（按行分页，offset=0 是最后一行）。返回的是去掉控制序列后的纯文本。${SESSION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', description: 'SSH 会话 id' },
          offset: { type: 'integer', description: '从末尾往前跳过的行数，默认 0' },
          count: { type: 'integer', description: '返回行数，默认 200' },
        },
        required: ['sessionId'],
      },
      output: TEXT_OUTPUT,
      presentCall: (args) => ({ card: 'generic', title: 'SSH 读取输出', kind: 'read' }),
      execute(args, exec) {
        const agent = requireAgent(exec);
        const session = manager.get(dshSessionOf(agent), requireString(args, 'sessionId'));
        const cap = getConfig().maxReadBytes ?? 262144;
        const page = session.read({ offset: optionalNumber(args, 'offset') ?? 0, count: optionalNumber(args, 'count') ?? 200 });
        return clean({ ...page, text: page.text.length > cap ? page.text.slice(page.text.length - cap) : page.text });
      },
    },
    {
      name: 'ssh_status',
      description: `查看某个 SSH 会话的状态、权限、输入权归属、最后活动时间与日志文件路径。${SESSION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { sessionId: { type: 'string', description: 'SSH 会话 id' } },
        required: ['sessionId'],
      },
      output: TEXT_OUTPUT,
      execute(args, exec) {
        const agent = requireAgent(exec);
        const session = manager.get(dshSessionOf(agent), requireString(args, 'sessionId'));
        return clean({ ...session.snapshot(), recentOutput: session.tailPlainLines(8) });
      },
    },
    {
      name: 'ssh_log',
      description:
        '读取 SSH 会话的 JSONL 活动日志（用户与 AI 的操作都在里面，按 actor 区分）。' +
        '日志里命令原文完整保留，输出超过配置阈值（默认 200 字符）会被截断并标注 truncated/fullBytes。' +
        `用它了解用户在终端里做过什么，不需要让用户复述。${SESSION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', description: 'SSH 会话 id' },
          actor: { type: 'string', enum: ['user', 'ai', 'system', 'remote'], description: '只看某个来源' },
          kind: { type: 'string', description: '只看某种事件，例如 user.input / ai.command / output' },
          limit: { type: 'integer', description: '最多返回多少条（默认 100）' },
        },
        required: ['sessionId'],
      },
      output: TEXT_OUTPUT,
      presentCall: () => ({ card: 'generic', title: 'SSH 日志', kind: 'read' }),
      execute(args, exec) {
        const agent = requireAgent(exec);
        const sessionId = requireString(args, 'sessionId');
        const limit = Math.min(500, optionalNumber(args, 'limit') ?? 100);
        const { path, entries } = manager.logRead(dshSessionOf(agent), sessionId, {
          actor: typeof args?.actor === 'string' ? args.actor : undefined,
          kind: typeof args?.kind === 'string' ? args.kind : undefined,
          limit,
        });
        return clean({ path, entries });
      },
    },
    {
      name: 'ssh_disconnect',
      description: `关闭一个 SSH 会话并终止它的进程树（用户在界面上关标签页是等效操作）。${SESSION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { sessionId: { type: 'string', description: 'SSH 会话 id' } },
        required: ['sessionId'],
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const agent = requireAgent(exec);
        return manager.close(dshSessionOf(agent), requireString(args, 'sessionId'));
      },
    },
  ];
}

/** The prompt section that teaches the model the shared-session contract. */
export const SSH_PROMPT_SECTION = `## SSH 共享会话 (ssh_* tools)

右侧栏的 SSH 标签页里，用户和你在**同一条真实 PTY** 上工作，双方操作互相可见，并全部写入 JSONL 日志。

- 先 \`ssh_list_sessions\` 看有哪些会话和它们的权限；新连接用 \`ssh_connect\`。
- 三级权限由用户控制：\`view\`（你只能读，写入会被拒绝）、\`ask\`（每条命令都要用户点确认）、\`full\`（直接执行，但危险命令会先出现可取消的告知窗口）。被拒绝时不要重试同一条命令，改为向用户解释并请其调整。
- 用户可能随时按键收回输入权：这时你的 \`ssh_exec\` 以 \`waitReason=revoked\` 结束——这是用户的正常打断，不是错误。
- 认证提示（口令/2FA）只有用户能回答；远端在等凭据时你的写入会被拒绝（\`SSH_AUTH_REQUIRED\`）。
- 想了解用户刚做了什么，用 \`ssh_log\`/\`ssh_read\` **主动拉取**，不要让用户复述。
- 用户在会话里可以给你留言（提问/报错/仅记录），留言会作为用户消息到达；"仅记录"类留言不会消耗你的上下文。
- 命令输出在日志里按配置截断（默认 200 字符，带 truncated/fullBytes 标注），命令原文完整保留。`;
