/**
 * Danger detection for SSH commands.
 *
 * The table is deliberately conservative: it warns about commands that can destroy data,
 * lock the operator out, or hand control to a remote script. It is a *warning* mechanism
 * (plus an approval gate under the `ask` permission), never a sandbox.
 */

/** Built-in danger patterns. `pattern` is a regular-expression source string. */
export const DEFAULT_DANGER_PATTERNS = [
  { id: 'rm-recursive-force', note: '递归强制删除', pattern: String.raw`\brm\s+(-[A-Za-z]*[rR][A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*[rR])\b` },
  { id: 'rm-root', note: '删除根目录/系统目录', pattern: String.raw`\brm\s+-[A-Za-z]*[rR][A-Za-z]*\s+/(\s|$|\*)` },
  { id: 'mkfs', note: '格式化文件系统', pattern: String.raw`\bmkfs(\.\w+)?\b` },
  { id: 'dd-to-device', note: '直接写块设备', pattern: String.raw`\bdd\b[^\n]*\bof=/dev/` },
  { id: 'wipefs', note: '擦除文件系统签名', pattern: String.raw`\bwipefs\b|\bblkdiscard\b` },
  { id: 'partition-edit', note: '修改分区表', pattern: String.raw`\b(fdisk|parted|sgdisk|cfdisk)\b` },
  { id: 'power-state', note: '关机/重启', pattern: String.raw`\b(shutdown|reboot|halt|poweroff)\b|\binit\s+0\b` },
  { id: 'fork-bomb', note: 'fork 炸弹', pattern: String.raw`:\s*\(\s*\)\s*\{` },
  { id: 'chmod-root', note: '递归放开根目录权限', pattern: String.raw`\bchmod\s+-[A-Za-z]*R[A-Za-z]*\s+[0-7]{3,4}\s+/(\s|$)` },
  { id: 'chown-recursive', note: '递归改属主', pattern: String.raw`\bchown\s+-[A-Za-z]*R\b` },
  { id: 'firewall-flush', note: '清空防火墙规则', pattern: String.raw`\biptables\s+-F\b|\bnft\s+flush\s+ruleset\b|\bufw\s+disable\b` },
  { id: 'account-delete', note: '删除用户/组', pattern: String.raw`\b(userdel|groupdel)\b` },
  { id: 'password-change', note: '修改口令', pattern: String.raw`\bpasswd\b|\bchpasswd\b` },
  { id: 'crontab-wipe', note: '清空计划任务', pattern: String.raw`\bcrontab\s+-r\b` },
  { id: 'history-wipe', note: '清空历史', pattern: String.raw`\bhistory\s+-c\b|>\s*~?/?\.bash_history` },
  { id: 'authorized-keys', note: '改写 authorized_keys', pattern: String.raw`authorized_keys` },
  { id: 'pipe-to-shell', note: '把远程脚本直接交给 shell', pattern: String.raw`\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b` },
  { id: 'service-stop', note: '停止/禁用系统服务', pattern: String.raw`\bsystemctl\s+(stop|disable|mask)\b|\bservice\s+\S+\s+stop\b` },
  { id: 'docker-destroy', note: '强删容器/大规模清理', pattern: String.raw`\bdocker\s+(rm\s+-f|system\s+prune|volume\s+rm)\b` },
  { id: 'sql-drop', note: '删除数据库对象', pattern: String.raw`\b(DROP|TRUNCATE)\s+(DATABASE|TABLE|SCHEMA)\b` },
  { id: 'kill-everything', note: '杀死全部进程', pattern: String.raw`\bkill\s+-9\s+-1\b` },
  { id: 'write-raw-device', note: '写入裸设备', pattern: String.raw`>\s*/dev/(sd|nvme|vd|hd)` },
  { id: 'sudo', note: '提权执行', pattern: String.raw`(^|[;&|]\s*)sudo\b` },
];

/** @returns {Array<{id: string, note: string, regex: RegExp}>} the effective compiled table. */
export function compileDangerPatterns(config = {}) {
  const source = Array.isArray(config.dangerPatterns) && config.dangerPatterns.length > 0
    ? config.dangerPatterns
    : DEFAULT_DANGER_PATTERNS;
  const disabled = new Set(Array.isArray(config.dangerDisabledIds) ? config.dangerDisabledIds : []);
  const compiled = [];
  for (const raw of source) {
    if (!raw || typeof raw.pattern !== 'string' || raw.pattern.length === 0) continue;
    if (disabled.has(raw.id)) continue;
    try {
      compiled.push({ id: String(raw.id ?? raw.pattern), note: String(raw.note ?? ''), regex: new RegExp(raw.pattern, 'i') });
    } catch {
      // An unusable operator-supplied pattern is skipped, never fatal.
    }
  }
  return compiled;
}

/**
 * @returns {null | {id: string, note: string, match: string}} the first matching danger entry.
 */
export function detectDanger(command, patterns) {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const entry of patterns) {
    const match = entry.regex.exec(command);
    if (match !== null) return { id: entry.id, note: entry.note, match: match[0].trim() };
  }
  return null;
}
