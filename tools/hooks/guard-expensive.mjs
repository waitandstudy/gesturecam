/**
 * PreToolUse 守卫：机械地拦住"最贵的那条命令"。
 *
 * 为什么需要它：写在 AGENTS.md / SKILL.md 里的规矩只是**建议** —— 而"再跑一次验收看看"
 * 这种冲动恰恰发生在判断力最弱的时候。这个脚本把最贵的一条做成硬约束：
 * **同一个会话里 `tools/verify-browser.mjs` 只允许跑一次**，第二次直接被拒绝并说明原因。
 *
 * 协议（Claude Code hooks 兼容）：从 stdin 读 JSON，退出码 2 = 阻塞并把 stderr 交给模型。
 * 任何解析异常都放行（fail-open）—— 守卫不该因为自己坏了而卡住正常工作。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** 允许通过（不输出任何东西，退出码 0） */
function allow() {
  process.exit(0);
}

/** 阻塞：stderr 会作为理由交给模型 */
function block(reason) {
  process.stderr.write(reason + '\n');
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readStdin());
} catch {
  allow();
}

const command = String(payload?.tool_input?.command ?? payload?.tool_input?.cmd ?? '');
if (!command) allow();

// 只关心这个项目里的浏览器验收
const isVerify = /verify-browser\.mjs/i.test(command);
if (!isVerify) allow();

const sessionId = String(payload?.session_id ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const stampDir = join(tmpdir(), 'gesturecam-hook-state');
const stampFile = join(stampDir, 'verify-' + sessionId + '.txt');

let alreadyRan = null;
try {
  alreadyRan = readFileSync(stampFile, 'utf8').trim();
} catch {
  alreadyRan = null;
}

if (alreadyRan) {
  block(
    [
      '已阻塞：本会话已经跑过一次浏览器验收（tools/verify-browser.mjs）。',
      '',
      '它约 4 分钟、76 项，且 90% 的检查与当前改动无关；而每一轮工具调用都要把完整历史',
      '重发一次，所以重复运行是本项目最贵的浪费（见 docs/DECISIONS.md §22）。',
      '',
      '除非用户明确要求重跑，否则改用分级验证：',
      '  - 小改动：node_modules\\.bin\\tsc.cmd --noEmit + 相关的那一个测试文件',
      '  - 公共模块：node_modules\\.bin\\vitest.cmd run',
      '一句话说明"为什么这次必须重跑"，然后让用户放行。',
    ].join('\n'),
  );
}

try {
  mkdirSync(stampDir, { recursive: true });
  writeFileSync(stampFile, new Date().toISOString() + '\n', 'utf8');
} catch {
  /* 记不上就算了，放行优先 */
}

allow();
