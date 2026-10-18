#!/usr/bin/env node
/**
 * learning-log-qa 适配器(被测对象:D:\learning-log-qa 的生成端)。
 * 协议:stdin 进问题 → stdout 出 JSON {answer, hits[]}。
 *
 * 为什么直连 tsx 而不是 spawn `npm run ask`:Windows 上 Node ≥20.12 出于 CVE-2024-27980
 * 禁止无 shell 直接 spawn .cmd(npm.cmd),加 shell 又会引入命令行转义问题;
 * node + tsx/cli.mjs 全程是 exe + 参数数组,零 shell、零转义。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const LLQA_DIR = process.env.LLQA_DIR ?? 'D:\\learning-log-qa';
const ASK_TIMEOUT_MS = Number(process.env.LLQA_ASK_TIMEOUT_MS ?? '150000'); // ask 自身上游超时 120s,留余量

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', d => { buf += d; });
    process.stdin.on('end', () => resolve(buf.trim()));
    process.stdin.on('error', reject);
  });
}

function fail(msg) {
  process.stderr.write(`[learning-log-qa adapter] ${msg}\n`);
  process.exit(1);
}

// ── 解析 ask 输出:答案正文 + "── 检索命中(余弦相似度)──" 段(材料N  分数  Session N(日期)…) ──
function parseAskOutput(stdout) {
  const sep = stdout.indexOf('── 检索命中');
  const answer = (sep >= 0 ? stdout.slice(0, sep) : stdout).trim();
  const hits = [];
  if (sep >= 0) {
    for (const m of stdout.slice(sep).matchAll(/^材料\s*(\d+)\s+([\d.]+)\s+(.+)$/gm)) {
      const sessionMatch = /Session\s+(\d+)/.exec(m[3]);
      hits.push({
        material: Number(m[1]),
        score: Number(m[2]),
        session: sessionMatch ? Number(sessionMatch[1]) : null,
        cite: m[3].trim(),
      });
    }
  }
  return { answer, hits };
}

const question = await readStdin();
if (!question) fail('stdin 没有收到问题');

if (!existsSync(join(LLQA_DIR, 'package.json'))) {
  fail(`被测目录不存在:${LLQA_DIR}(可用环境变量 LLQA_DIR 覆盖)`);
}

let tsxCli;
try {
  tsxCli = createRequire(join(LLQA_DIR, 'package.json')).resolve('tsx/cli');
} catch {
  fail(`在 ${LLQA_DIR} 里找不到 tsx——先在那边跑一次 npm install`);
}

const child = spawn(process.execPath, [tsxCli, 'src/ask.ts', question], {
  cwd: LLQA_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, ASK_TIMEOUT_MS);
child.stdout.setEncoding('utf-8');
child.stderr.setEncoding('utf-8');
child.stdout.on('data', d => { stdout += d; });
child.stderr.on('data', d => { stderr += d; });
child.on('error', e => { clearTimeout(timer); fail(`无法启动 ask 进程:${e.message}`); });
child.on('close', code => {
  clearTimeout(timer);
  if (timedOut) fail(`ask 超时(${ASK_TIMEOUT_MS}ms)`);
  if (code !== 0) fail(`ask 退出码 ${code}:${stderr.slice(-400).trim()}`);
  const parsed = parseAskOutput(stdout);
  if (!parsed.answer) fail('ask 输出里解析不出回答正文');
  process.stdout.write(JSON.stringify(parsed));
});
