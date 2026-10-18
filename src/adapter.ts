/**
 * 适配器执行器:spawn 一个外部进程,stdin 进问题、stdout 出 JSON/裸文本。
 * 进程边界契约的好处:被测对象零侵入、语言无关,E2E 可以拿 fixture 脚本顶替真实系统。
 */
import { spawn } from 'node:child_process';
import type { AdapterOutput, Hit } from './types.ts';

export class AdapterError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

interface SpawnOutcome { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function spawnAdapter(cmd: string[], question: string, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise(resolve => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    // 问题走 stdin:UTF-8 整段写入,无 shell 转义问题;写完即关,适配器读到 EOF 开工
    child.stdin.end(question, 'utf-8');
  });
}

function parseHits(raw: unknown): Hit[] {
  if (!Array.isArray(raw)) throw new Error('hits 不是数组');
  return raw.map((h, i) => {
    const o = (h ?? {}) as Record<string, unknown>;
    return {
      material: typeof o.material === 'number' ? o.material : i + 1,
      score: typeof o.score === 'number' ? o.score : null,
      session: typeof o.session === 'number' ? o.session : null,
      cite: typeof o.cite === 'string' ? o.cite : '',
    };
  });
}

/** stdout → AdapterOutput。优先 JSON{answer,hits};裸文本整体当 answer(最简适配器的兜底契约) */
export function parseAdapterStdout(stdout: string): AdapterOutput {
  const text = stdout.trim();
  if (!text) throw new AdapterError('适配器 stdout 为空', true);
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (typeof o.answer !== 'string') throw new Error('JSON 里没有 answer 字符串字段');
    return { answer: o.answer, hits: parseHits(o.hits ?? []) };
  } catch {
    // 不是 JSON → 裸文本协议
    return { answer: text, hits: [] };
  }
}

export interface AdapterRun { output: AdapterOutput; latencyMs: number }

export async function runAdapter(cmd: string[], question: string, timeoutMs: number): Promise<AdapterRun> {
  const t0 = Date.now();
  const r = await spawnAdapter(cmd, question, timeoutMs);
  if (r.timedOut) throw new AdapterError(`适配器超时(${timeoutMs}ms),已强杀`, true);
  if (r.code !== 0) {
    throw new AdapterError(`适配器退出码 ${r.code}:${(r.stderr || r.stdout).slice(-400).trim() || '(无输出)'}`, true);
  }
  const output = parseAdapterStdout(r.stdout);
  return { output, latencyMs: Date.now() - t0 };
}
