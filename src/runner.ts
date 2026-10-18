/**
 * 批量执行器:小并发(默认 2)、适配器失败重试一次、逐 case 归因。
 * 关键纪律:重试只包适配器(基础设施故障);规则失败绝不重跑——那是被测系统的真实输出,
 * 重跑换一个好答案等于帮被测对象作弊。
 */
import { runAdapter } from './adapter.ts';
import { checkCitations, parseCitedMaterials, runRules } from './assert.ts';import type { CaseFile, CaseResult, JudgeLike, RunResult, RunSummary, CostEstimate, Gate } from './types.ts';

export const THRESHOLDS = { rulePassRate: 0.8, judgeAvg: 4.0 };

export interface PipelineOptions {
  cases: CaseFile[];
  adapterCmd: string[];
  judge: JudgeLike;
  concurrency?: number;
  adapterTimeoutMs?: number;
  onProgress?: (r: CaseResult) => void;
}

const MAX_ADAPTER_ATTEMPTS = 2;

async function runOne(c: CaseFile, opts: Required<Pick<PipelineOptions, 'adapterCmd' | 'judge' | 'adapterTimeoutMs'>>): Promise<CaseResult> {
  let latency = 0;
  let adapterError: string | null = null;
  let out: Awaited<ReturnType<typeof runAdapter>>['output'] | null = null;
  let attempts = 0;
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
  if (!out) {
    return {
      id: c.id, question: c.question, status: 'error',
      adapterLatencyMs: latency, attempts, adapterError,
      rules: [], rulesPassed: false, judge: null, judgeError: null,
      citedSessions: [], hitSessions: [], answerChars: 0, answer: '', hits: [],
    };
  }

  const rules = [...runRules(c.ruleAssertions, out.answer), checkCitations(c, out)].filter(r => r !== null);
  const rulesPassed = rules.every(r => r.pass);

  // 省钱原则:任何规则失败都不进 judge;judge 自身故障单独记账,不影响 case 状态
  let judge = null as CaseResult['judge'];
  let judgeError = null as string | null;
  if (rulesPassed) {
    try { judge = await opts.judge.judge(c, out); }
    catch (e) { judgeError = e instanceof Error ? e.message : String(e); }
  }

  return {
    id: c.id, question: c.question,
    status: rulesPassed ? 'pass' : 'fail',
    adapterLatencyMs: latency, attempts, adapterError: null,
    rules, rulesPassed, judge, judgeError,
    citedSessions: parseCitedMaterials(out.answer),
    hitSessions: out.hits.map(h => h.session).filter((s): s is number => s !== null),
    answerChars: out.answer.trim().length,
    answer: out.answer,
    hits: out.hits,
  };
}

export function summarize(results: CaseResult[], thresholds: { rulePassRate: number; judgeAvg: number }): { summary: RunSummary; gate: Gate } {
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

  // 成本两本账:judge 侧 API usage 精确计量;被测系统侧不回吐 usage,按字数估算并明确标注
  const judgePromptTokens = judged.reduce((s, r) => s + (r.judge?.promptTokens ?? 0), 0);
  const judgeCompletionTokens = judged.reduce((s, r) => s + (r.judge?.completionTokens ?? 0), 0);
  const pricePerK = Number(process.env.LLME_PRICE_PER_K ?? '0.001'); // 元/千 tokens,flash 档,以智谱官网为准
  const judgeCostYuan = ((judgePromptTokens + judgeCompletionTokens) / 1000) * pricePerK;

  const sutCalls = results.reduce((s, r) => s + r.attempts, 0);
  const sutAnswerChars = results.reduce((s, r) => s + r.answerChars, 0);
  // 估算公式:中文为主语料,GLM 系 tokenizer 约 0.6 token/字;嵌入查询 + 生成按同价粗算
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
  const adapterTimeoutMs = opts.adapterTimeoutMs ?? 150_000;
  const required = { adapterCmd: opts.adapterCmd, judge: opts.judge, adapterTimeoutMs };
  const startedAt = new Date();

  // 简单 worker 池:按索引取队列,results 按占位保序(报告顺序稳定,与完成顺序无关)
  const results: CaseResult[] = new Array(opts.cases.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, opts.cases.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= opts.cases.length) return;
      const r = await runOne(opts.cases[i], required);
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
    adapterCmd: required.adapterCmd.join(' '),
    judgeImpl: opts.judge.impl,
    judgeModel: opts.judge.model,
    adapterCalls: results.reduce((s, r) => s + r.attempts, 0),
    judgeCalls: opts.judge.callCount,
    thresholds: { ...THRESHOLDS },
  };

  const { summary, gate } = summarize(results, meta.thresholds);
  return { meta, results, summary, gate };
}
