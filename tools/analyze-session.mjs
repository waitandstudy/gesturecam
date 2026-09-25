/**
 * 一次性诊断脚本：分析一个 DSH 会话的 transcript，找出 token 花在哪。
 * 只读会话文件，不做任何修改。
 * 用法: node tools/analyze-session.mjs <session.v3.jsonl.zstd>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

/** 粗略 token 估算: CJK 约 1 token/字, 其他约 4 字符/token */
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3000 && code <= 0x9fff) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk + other / 4);
}

function pad(value, width) {
  const text = String(value);
  if (text.length >= width) return text;
  return text + ' '.repeat(width - text.length);
}

const path = process.argv[2];
if (!path) {
  console.error('用法: node tools/analyze-session.mjs <session.v3.jsonl.zstd>');
  process.exit(1);
}

const compressedBytes = readFileSync(path).length;
const raw = zstdDecompressSync(readFileSync(path)).toString('utf8');
const lines = raw.split('\n').filter(function (line) { return line.trim().length > 0; });

const records = [];
for (const line of lines) {
  try {
    records.push(JSON.parse(line));
  } catch {
    /* 坏行跳过 */
  }
}

console.log('=== 体积 ===');
console.log('压缩后        ' + (compressedBytes / 1048576).toFixed(2) + ' MB');
console.log('解压后        ' + (raw.length / 1048576).toFixed(2) + ' MB');
console.log('JSONL 行数    ' + lines.length);
console.log('可解析记录    ' + records.length);
console.log('整体估算 token ' + estimateTokens(raw).toLocaleString());

const kinds = new Map();
for (const record of records) {
  const kind = record.type || record.kind || 'unknown';
  kinds.set(kind, (kinds.get(kind) || 0) + 1);
}
console.log('');
console.log('=== 记录类型分布 ===');
const kindList = Array.from(kinds.entries()).sort(function (a, b) { return b[1] - a[1]; });
for (const entry of kindList) {
  console.log('  ' + pad(entry[0], 26) + entry[1]);
}

function flatten(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out);
    return;
  }
  if (typeof value === 'object') {
    out.push(JSON.stringify(value));
  }
}

/** 把一条记录压成文本载荷 */
function extract(record) {
  const message = record.message || record;
  const role = message.role || record.role || record.type || 'unknown';
  const parts = [];
  flatten(message.content || record.content, parts);
  let tool = record.toolName || record.tool_name || null;
  const content = message.content || record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        if (block.type === 'tool_use' && block.name) tool = block.name;
        if (block.name && !tool) tool = block.name;
      }
    }
  }
  return { role: role, tool: tool, text: parts.join('\n') };
}

const buckets = new Map();
const toolBuckets = new Map();
const perRecord = [];
let totalTokens = 0;

records.forEach(function (record, index) {
  const info = extract(record);
  if (!info.text) return;
  const tokens = estimateTokens(info.text);
  totalTokens += tokens;

  const key = info.tool ? info.role + ':' + info.tool : info.role;
  const bucket = buckets.get(key) || { tokens: 0, count: 0 };
  bucket.tokens += tokens;
  bucket.count += 1;
  buckets.set(key, bucket);

  if (info.tool) {
    const t = toolBuckets.get(info.tool) || { tokens: 0, count: 0 };
    t.tokens += tokens;
    t.count += 1;
    toolBuckets.set(info.tool, t);
  }

  perRecord.push({ index: index, tokens: tokens, role: info.role, tool: info.tool, text: info.text });
});

console.log('');
console.log('=== 按角色/工具聚合 (估算 token, 降序) ===');
const bucketList = Array.from(buckets.entries()).sort(function (a, b) { return b[1].tokens - a[1].tokens; });
for (const entry of bucketList.slice(0, 30)) {
  const pct = ((entry[1].tokens / totalTokens) * 100).toFixed(1);
  console.log(
    '  ' + pad(entry[0], 32) + pad(entry[1].count, 7) + ' 条 ' + pad(entry[1].tokens.toLocaleString(), 12) + ' tok ' + pad(pct + '%', 7),
  );
}

console.log('');
console.log('=== 单工具总量 (降序) ===');
const toolList = Array.from(toolBuckets.entries()).sort(function (a, b) { return b[1].tokens - a[1].tokens; });
for (const entry of toolList) {
  const pct = ((entry[1].tokens / totalTokens) * 100).toFixed(1);
  console.log(
    '  ' + pad(entry[0], 32) + pad(entry[1].count, 7) + ' 次 ' + pad(entry[1].tokens.toLocaleString(), 12) + ' tok ' + pad(pct + '%', 7),
  );
}

console.log('');
console.log('=== 单条最大的 25 个载荷 ===');
perRecord.sort(function (a, b) { return b.tokens - a.tokens; });
for (const entry of perRecord.slice(0, 25)) {
  const preview = entry.text.replace(/\s+/g, ' ').slice(0, 100);
  console.log(
    '  #' + pad(entry.index, 6) + pad(entry.tokens.toLocaleString(), 10) + ' tok  ' + pad(entry.role, 12) + pad(entry.tool || '-', 14) + preview,
  );
}

console.log('');
console.log('=== 最大的 20 个工具结果按工具归类 ===');
const biggestTool = perRecord.filter(function (e) { return e.tool; }).slice(0, 20);
for (const entry of biggestTool) {
  console.log('  ' + pad(entry.tool, 18) + pad(entry.tokens.toLocaleString(), 10) + ' tok  ' + entry.text.replace(/\s+/g, ' ').slice(0, 70));
}
