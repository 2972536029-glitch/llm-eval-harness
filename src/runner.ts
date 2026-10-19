/**
 * 批量执行器:小并发(默认 2)、适配器失败重试一次、judge 可多采样中位数聚合、答案缓存、逐 case 归因。
 * 纪律不变:重试只包适配器(基础设施);规则失败绝不重跑;规则不过不烧 judge。
 */
import { createHash } from 'node:crypto';
import { runAdapter } from './adapter.ts';
import { checkCitations, parseCitedMaterials, runRules } from './assert.ts';
import type { AdapterOutput, CaseFile, CaseResult, Gate, JudgeLike, JudgeVerdict, RunResult, RunSummary } from './types.ts';

export const THRESHOLDS = { rulePassRate: 0.8, judgeAvg: 4.0 };
const MAX_ADAPTER_ATTEMPTS = 2;

/** 答案缓存接口:runner 只认 get/put,持久化由 cli 层负责(E2E 可注入内存实现) */
export interface AnswerCache {
  get(key: string, question: string): AdapterOutput | null;
  put(key: string, question: string, out: AdapterOutput): void;
}

export function cacheKey(id: string, question: string, adapterCmd: string[]): string {
  return createHash('sha1').update([id, question, adapterCmd.join(' ')].join('\0')).digest('hex');
}

/**
 * judge 分数是 1-5 的序数尺度:均值没有意义(4.5 不存在于档位上),离群单次打分会把均值拖偏。
 * 用中位数聚合;偶数个采样取偏低的那半(从严:裁判分歧时倾向低判)。
 */
export function aggregateScores(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? 0;
}

export interface PipelineOptions {
  cases: CaseFile[];
  adapterCmd: string[];
  judge: JudgeLike;
  concurrency?: number;
  adapterTimeoutMs?: number;
  judgeSamples?: number;
  thresholds?: { rulePassRate: number; judgeAvg: number };
  priceYuanPerKTokens?: number;
  answerCache?: AnswerCache;
  onProgress?: (r: CaseResult) => void;
}

interface Resolved {
  adapterCmd: string[];
  judge: JudgeLike;
  adapterTimeoutMs: number;
  judgeSamples: number;
  answerCache: AnswerCache | undefined;
}

async function runOne(c: CaseFile, opts: Resolved): Promise<CaseResult> {
  let latency = 0;
  let adapterError: string | null = null;
  let out: AdapterOutput | null = null;
  let attempts = 0;
  let reused = false;

  const key = opts.answerCache ? cacheKey(c.id, c.question, opts.adapterCmd) : '';
  if (opts.answerCache && key) {
    const hit = opts.answerCache.get(key, c.question);
    if (hit) { out = hit; reused = true; }
  }
  if (!out) {
    for (let i = 0; i < MAX_ADAPTER_ATTEMPTS; i++) {
      attempts = i + 1;
      try {
        const r = await runAdapter(opts.adapterCmd, c.question, opts.adapterTimeoutMs);
        if (!r.output.answer.trim()) throw new Error('回答为空');
        latency = r.latencyMs;
        out = r.output;
        adapterError = null;
        break;
      } catch (e) {
        adapterError = e instanceof Error ? e.message : String(e);
        out = null;
      }
    }
    // 真实跑出来的回答才值得缓存;重试耗尽的失败不缓存(下次还给它机会)
    if (out && opts.answerCache && key) opts.answerCache.put(key, c.question, out);
  }
  if (!out) {
    return {
      id: c.id, question: c.question, status: 'error',
      adapterLatencyMs: latency, attempts, reused, adapterError,
      rules: [], rulesPassed: false, judge: null, judgeError: null,
      citedSessions: [], hitSessions: [], answerChars: 0, answer: '', hits: [],
    };
  }

  const rules = [...runRules(c.ruleAssertions, out.answer), checkCitations(c, out)].filter(r => r !== null);
  const rulesPassed = rules.every(r => r.pass);

  // 省钱原则不变:规则不过不进 judge。多采样时任一次失败都记 judge 故障(从严,不静默丢样本)
  let judge = null as CaseResult['judge'];
  let judgeError = null as string | null;
  if (rulesPassed) {
    const samples: number[] = [];
    let promptTokens = 0, completionTokens = 0, latencyMs = 0;
    let reasons = '', impl = '';
    try {
      for (let i = 0; i < opts.judgeSamples; i++) {
        const v: JudgeVerdict = await opts.judge.judge(c, out);
        samples.push(v.score);
        promptTokens += v.promptTokens;
        completionTokens += v.completionTokens;
        latencyMs += v.latencyMs;
        reasons = v.reasons;
        impl = v.impl;
      }
      const score = aggregateScores(samples);
      judge = {
        score,
        reasons: samples.length > 1 ? `${reasons}(采样 ${samples.join(',')} → 中位数 ${score})` : reasons,
        promptTokens, completionTokens, latencyMs, impl,
        ...(samples.length > 1 ? { samples } : {}),
      };
    } catch (e) {
      judgeError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    id: c.id, question: c.question,
    status: rulesPassed ? 'pass' : 'fail',
    adapterLatencyMs: latency, attempts, reused, adapterError: null,
    rules, rulesPassed, judge, judgeError,
    citedSessions: parseCitedMaterials(out.answer),
    hitSessions: out.hits.map(h => h.session).filter((s): s is number => s !== null),
    answerChars: out.answer.trim().length,
    answer: out.answer,
    hits: out.hits,
  };
}

export function summarize(
  results: CaseResult[],
  thresholds: { rulePassRate: number; judgeAvg: number },
  pricePerK = 0.001,
): { summary: RunSummary; gate: Gate } {
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const error = results.filter(r => r.status === 'error').length;
  const judged = results.filter(r => r.judge !== null);
  const judgeAvg = judged.length > 0
    ? judged.reduce((s, r) => s + (r.judge?.score ?? 0), 0) / judged.length
    : null;

  const judgeScores: Record<number, number> = {};
  for (const r of judged) {
    const s = r.judge?.score ?? 0;
    judgeScores[s] = (judgeScores[s] ?? 0) + 1;
  }

  // 成本两本账:judge 侧 API usage 精确计量(多采样已含全部调用);被测系统侧按字数估算并明确标注
  const judgePromptTokens = judged.reduce((s, r) => s + (r.judge?.promptTokens ?? 0), 0);
  const judgeCompletionTokens = judged.reduce((s, r) => s + (r.judge?.completionTokens ?? 0), 0);
  const judgeCostYuan = ((judgePromptTokens + judgeCompletionTokens) / 1000) * pricePerK;

  const sutCalls = results.reduce((s, r) => s + r.attempts, 0);
  const sutAnswerChars = results.reduce((s, r) => s + r.answerChars, 0);
  // 估算公式:中文为主语料,GLM 系 tokenizer 约 0.6 token/字;每次调用另计 20 token 查询开销
  const sutEstTokens = Math.round(sutAnswerChars / 0.6) + sutCalls * 20;
  const sutEstCostYuan = (sutEstTokens / 1000) * pricePerK;

  const summary: RunSummary = {
    total: results.length, pass, fail, error,
    // error(基础设施故障)不计入通过率分母——它不是质量信号,单看 error 数
    rulePassRate: pass + fail > 0 ? pass / (pass + fail) : 0,
    judgeAvg,
    judgeScores,
    cost: {
      judgePromptTokens, judgeCompletionTokens, judgeCostYuan,
      sutCalls, sutAnswerChars, sutEstTokens, sutEstCostYuan,
      totalEstCostYuan: judgeCostYuan + sutEstCostYuan,
    },
  };

  const reasons: string[] = [];
  if (results.length === 0) reasons.push('没有任何 case 结果');
  if (summary.rulePassRate < thresholds.rulePassRate) {
    reasons.push(`规则通过率 ${summary.rulePassRate.toFixed(2)} < ${thresholds.rulePassRate}`);
  }
  if (judgeAvg !== null && judgeAvg < thresholds.judgeAvg) {
    reasons.push(`judge 均分 ${judgeAvg.toFixed(2)} < ${thresholds.judgeAvg}`);
  }
  if (error === results.length && results.length > 0) reasons.push('全部 case 都是基础设施 error,无有效评测信号');
  return { summary, gate: { passed: reasons.length === 0, reasons } };
}

export async function runPipeline(opts: PipelineOptions): Promise<RunResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const resolved: Resolved = {
    adapterCmd: opts.adapterCmd,
    judge: opts.judge,
    adapterTimeoutMs: opts.adapterTimeoutMs ?? 150_000,
    judgeSamples: Math.max(1, Math.floor(opts.judgeSamples ?? 1)),
    answerCache: opts.answerCache,
  };
  const thresholds = opts.thresholds ?? { ...THRESHOLDS };
  const startedAt = new Date();

  // worker 池按索引取队列,results 按占位保序(报告顺序稳定,与完成顺序无关)
  const results: CaseResult[] = new Array(opts.cases.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, opts.cases.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= opts.cases.length) return;
      const r = await runOne(opts.cases[i], resolved);
      results[i] = r;
      opts.onProgress?.(r);
    }
  });
  await Promise.all(workers);
  const finishedAt = new Date();

  const meta: RunResult['meta'] = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    casesDir: '',
    adapterCmd: resolved.adapterCmd.join(' '),
    judgeImpl: opts.judge.impl,
    judgeModel: opts.judge.model,
    adapterCalls: results.reduce((s, r) => s + r.attempts, 0),
    judgeCalls: opts.judge.callCount,
    thresholds,
    partial: false, // cli 层在过滤后覆写
    judgeSamples: resolved.judgeSamples,
    reusedCount: results.filter(r => r.reused).length,
  };

  const { summary, gate } = summarize(results, thresholds, opts.priceYuanPerKTokens);
  return { meta, results, summary, gate };
}

// re-export:cli 与 e2e 组合使用
export { parseCitedMaterials };
