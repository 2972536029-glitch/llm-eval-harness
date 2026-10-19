/**
 * 答案缓存(--reuse):按 (case id + 问题 + 适配器命令) 哈希存"当时被测系统的真实回答"。
 * 场景:迭代规则/judge 时反复全量重跑,被测系统的调用是大头成本——缓存让重跑只花 judge 的钱。
 * 默认关闭:缓存无法感知被测系统内部变化(如语料重建),正确性优先,提速是 opt-in。
 * 持久化走临时文件 + 原子改名(learning-log-qa corpus.json 同款纪律),读写端不见半截文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AdapterOutput, Hit } from './types.ts';

export interface AnswerCacheEntry {
  question: string;
  answer: string;
  hits: Hit[];
  cachedAt: string;
}

export function createFileAnswerCache(file: string) {
  let store: Record<string, AnswerCacheEntry> = {};
  if (existsSync(file)) {
    try { store = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, AnswerCacheEntry>; }
    catch { store = {}; /* 坏缓存不致命:当空缓存重新积累,而不是让整趟评测挂掉 */ }
  }
  const memory = new Map<string, AnswerCacheEntry>(Object.entries(store));
  return {
    /** key 命中但题目对不上(哈希碰撞/文件被手改)一律视为未命中,question 是第二道校验 */
    get(key: string, question: string): AdapterOutput | null {
      const e = memory.get(key);
      if (!e || e.question !== question) return null;
      return { answer: e.answer, hits: e.hits };
    },
    put(key: string, question: string, out: AdapterOutput): void {
      memory.set(key, { question, answer: out.answer, hits: out.hits, cachedAt: new Date().toISOString() });
    },
    size(): number { return memory.size; },
    save(): void {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.answer-cache.tmp-${process.pid}`);
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(memory), null, 2), 'utf-8');
      renameSync(tmp, file);
    },
  };
}
