/**
 * 运行历史:每次运行往 history.jsonl 追加一行摘要(含逐 case 状态与 judge 分)。
 * 支撑两件事:趋势(最近 N 次的通过率/分数/成本)与回归 diff(对比上次完整运行:
 * 谁从过变挂 = 回归,谁从挂变过 = 修复,谁的 judge 分漂了)。
 * JSONL 而非整文件 JSON:追加写永远安全,崩了也只损最后一行。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunResult } from './types.ts';

export interface HistoryCase { id: string; status: string; score: number | null }

export interface HistoryEntry {
  ts: string;
  tag: string;
  /** false = --only/--filter 只跑了子集(对比时只看重叠 case) */
  complete: boolean;
  total: number;
  pass: number;
  fail: number;
  error: number;
  rulePassRate: number;
  judgeAvg: number | null;
  costYuan: number;
  gatePassed: boolean;
  cases: HistoryCase[];
}

export interface RunDiff {
  regressions: { id: string; was: string; now: string }[];
  fixes: { id: string; was: string; now: string }[];
  scoreChanges: { id: string; from: number; to: number }[];
  overlap: number;
}

export function entryFromRun(run: RunResult, complete: boolean, tag: string): HistoryEntry {
  const { meta, summary, results, gate } = run;
  return {
    ts: meta.finishedAt,
    tag,
    complete,
    total: summary.total,
    pass: summary.pass,
    fail: summary.fail,
    error: summary.error,
    rulePassRate: summary.rulePassRate,
    judgeAvg: summary.judgeAvg,
    costYuan: summary.cost.totalEstCostYuan,
    gatePassed: gate.passed,
    cases: results.map(r => ({ id: r.id, status: r.status, score: r.judge?.score ?? null })),
  };
}

export function appendHistory(file: string, e: HistoryEntry): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(e) + '\n', 'utf-8');
}

export function loadHistory(file: string): HistoryEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split(/\r?\n/)
    .filter(l => l.trim())
    .map(l => {
      try { return JSON.parse(l) as HistoryEntry; } catch { return null; }
    })
    .filter((e): e is HistoryEntry => e !== null);
}

/** 上一次"完整"运行:部分运行不作为对比基线(子集对子集才知道变化,子集对全量会误报) */
export function previousCompleteRun(history: HistoryEntry[], beforeIndex: number): HistoryEntry | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (history[i].complete) return history[i];
  }
  return null;
}

export function diffRuns(prev: HistoryEntry, cur: HistoryEntry): RunDiff {
  const prevById = new Map(prev.cases.map(c => [c.id, c]));
  const diff: RunDiff = { regressions: [], fixes: [], scoreChanges: [], overlap: 0 };
  for (const now of cur.cases) {
    const was = prevById.get(now.id);
    if (!was) continue; // 上次没跑过这条,无从对比
    diff.overlap++;
    if (was.status === 'pass' && now.status !== 'pass') {
      diff.regressions.push({ id: now.id, was: was.status, now: now.status });
    } else if (was.status !== 'pass' && now.status === 'pass') {
      diff.fixes.push({ id: now.id, was: was.status, now: now.status });
    } else if (was.status === 'pass' && now.status === 'pass' && was.score !== null && now.score !== null) {
      if (Math.abs(was.score - now.score) >= 1) diff.scoreChanges.push({ id: now.id, from: was.score, to: now.score });
    }
  }
  return diff;
}
