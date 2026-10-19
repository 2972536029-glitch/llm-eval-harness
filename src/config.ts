/**
 * 配置层:默认值 < eval.config.json < 环境变量 < CLI 旗标。
 * 每层职责:默认值保证零配置能跑;文件承载项目级约定;env 撑 CI 变体;旗标撑一次性覆盖。
 * 未知字段直接拒绝(typo 保护):配置写错比没写更危险。
 */
import { existsSync, readFileSync } from 'node:fs';

export interface Thresholds { rulePassRate: number; judgeAvg: number }

export interface EvalConfig {
  cases: string;
  adapter: string;
  judge: 'real' | 'stub';
  judgeModel: string;
  judgeSamples: number;
  out: string;
  tag: string;
  concurrency: number;
  adapterTimeoutMs: number;
  thresholds: Thresholds;
  /** 元/千 tokens,成本估算用;按所用模型的官网价目填 */
  priceYuanPerKTokens: number;
}

export const DEFAULT_CONFIG: EvalConfig = {
  cases: 'cases',
  adapter: 'adapters/learning-log-qa.mjs',
  judge: 'real',
  judgeModel: 'glm-4-flash',
  judgeSamples: 1,
  out: 'reports',
  tag: '',
  concurrency: 2,
  adapterTimeoutMs: 150_000,
  thresholds: { rulePassRate: 0.8, judgeAvg: 4.0 },
  priceYuanPerKTokens: 0.001,
};

/** CLI 显式旗标:undefined = 用户没传(不覆盖下层) */
export interface CliOverrides {
  cases?: string;
  adapter?: string;
  judge?: 'real' | 'stub';
  judgeModel?: string;
  judgeSamples?: number;
  out?: string;
  tag?: string;
  concurrency?: number;
  adapterTimeoutMs?: number;
  thresholds?: Thresholds;
}

const NUM_KEYS = ['judgeSamples', 'concurrency', 'adapterTimeoutMs', 'priceYuanPerKTokens'] as const;
const STR_KEYS = ['cases', 'adapter', 'out', 'tag', 'judgeModel'] as const;

function bad(path: string, msg: string): Error {
  return new Error(`配置文件 ${path} 不合法:${msg}`);
}

export function loadConfigFile(path: string): Partial<EvalConfig> {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf-8')); }
  catch (e) { throw bad(path, `JSON 解析失败:${e instanceof Error ? e.message : e}`); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad(path, '顶层应是对象');
  const known = new Set([...Object.keys(DEFAULT_CONFIG)]);
  for (const k of Object.keys(raw as object)) {
    if (!known.has(k)) throw bad(path, `未知字段 "${k}"(已知字段:${[...known].join(', ')})`);
  }
  const c = raw as Record<string, unknown>;
  const out: Partial<EvalConfig> = {};
  for (const k of STR_KEYS) {
    if (c[k] !== undefined) {
      if (typeof c[k] !== 'string' || !(c[k] as string).trim()) throw bad(path, `${k} 应为非空字符串`);
      out[k] = c[k] as string;
    }
  }
  if (c.judge !== undefined) {
    if (c.judge !== 'real' && c.judge !== 'stub') throw bad(path, 'judge 只能是 "real" 或 "stub"');
    out.judge = c.judge;
  }
  for (const k of NUM_KEYS) {
    if (c[k] !== undefined) {
      const v = c[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw bad(path, `${k} 应为正数`);
      out[k] = v;
    }
  }
  if (c.thresholds !== undefined) {
    const t = c.thresholds as Record<string, unknown>;
    if (typeof t !== 'object' || t === null) throw bad(path, 'thresholds 应为对象');
    const outT: Partial<Thresholds> = {};
    // 两个阈值都可单独覆盖,没写的走默认(merge 层负责合并)
    if (t.rulePassRate !== undefined) {
      if (typeof t.rulePassRate !== 'number' || t.rulePassRate < 0 || t.rulePassRate > 1) {
        throw bad(path, 'thresholds.rulePassRate 应为 0-1 之间的小数');
      }
      outT.rulePassRate = t.rulePassRate;
    }
    if (t.judgeAvg !== undefined) {
      if (typeof t.judgeAvg !== 'number' || t.judgeAvg < 1 || t.judgeAvg > 5) {
        throw bad(path, 'thresholds.judgeAvg 应为 1-5 之间的数');
      }
      outT.judgeAvg = t.judgeAvg;
    }
    if (Object.keys(outT).length === 0) throw bad(path, 'thresholds 至少给 rulePassRate 或 judgeAvg 之一');
    out.thresholds = outT as Thresholds;
  }
  return out;
}

export function mergeConfig(
  file: Partial<EvalConfig>,
  cli: CliOverrides,
  env: NodeJS.ProcessEnv = process.env,
): EvalConfig {
  const c: EvalConfig = { ...DEFAULT_CONFIG, ...file, thresholds: { ...DEFAULT_CONFIG.thresholds, ...file.thresholds } };
  // env 层:比文件高、比 CLI 低——CI 里换个 judge/价格不用改文件
  if (env.LLME_JUDGE === 'real' || env.LLME_JUDGE === 'stub') c.judge = env.LLME_JUDGE;
  if (env.LLME_JUDGE_MODEL && env.LLME_JUDGE_MODEL.trim()) c.judgeModel = env.LLME_JUDGE_MODEL.trim();
  const p = Number(env.LLME_PRICE_PER_K);
  if (env.LLME_PRICE_PER_K !== undefined && Number.isFinite(p) && p >= 0) c.priceYuanPerKTokens = p;
  // CLI 层:一次性覆盖
  for (const k of STR_KEYS) if (cli[k] !== undefined) c[k] = cli[k];
  if (cli.judge !== undefined) c.judge = cli.judge;
  if (cli.judgeSamples !== undefined) c.judgeSamples = cli.judgeSamples;
  if (cli.concurrency !== undefined) c.concurrency = cli.concurrency;
  if (cli.adapterTimeoutMs !== undefined) c.adapterTimeoutMs = cli.adapterTimeoutMs;
  if (cli.thresholds) c.thresholds = { ...c.thresholds, ...cli.thresholds };
  return c;
}
