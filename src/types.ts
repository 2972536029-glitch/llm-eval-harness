/** 全仓共享类型。字段语义见 README 设计决策表 */

/** 规则断言:便宜、确定,先跑。type 决定哪些参数必填(见 cases.ts 校验) */
export type RuleAssertion =
  | { type: 'contains'; value: string; name?: string }
  | { type: 'not_contains'; value: string; name?: string }
  | { type: 'contains_any'; values: string[]; name?: string }
  | { type: 'contains_all'; values: string[]; name?: string }
  | { type: 'regex'; pattern: string; flags?: string; name?: string }
  | { type: 'not_regex'; pattern: string; flags?: string; name?: string }
  | { type: 'starts_with'; value: string; name?: string }
  | { type: 'ends_with'; value: string; name?: string }
  | { type: 'equals'; value: string; name?: string }
  | { type: 'len_range'; min?: number; max?: number; name?: string }
  | { type: 'json_valid'; name?: string };

export interface Hit {
  /** 材料号,从 1 起(与 learning-log-qa ask 输出的 材料N 对应) */
  material: number;
  /** 余弦相似度,adapter 解析失败时为 null */
  score: number | null;
  /** 命中块的 Session 号;解析不出为 null */
  session: number | null;
  /** 引用行原文,如 "Session 6(2026-09-15) data-persistence · review 反馈" */
  cite: string;
}

/** 适配器统一输出协议:stdout 必须是含 answer 的 JSON;裸文本会被当作 answer 兜底 */
export interface AdapterOutput {
  answer: string;
  hits: Hit[];
}

/** cases/*.json 单条用例。expectSessions 为 null 表示语料外拒答场景(跳过引用一致性) */
export interface CaseFile {
  id: string;
  question: string;
  expectSessions: number[] | null;
  ruleAssertions: RuleAssertion[];
  /** 追加到默认 rubric 之后的场景化评分指引(可缺省) */
  judgeRubric?: string;
}

export interface RuleResult {
  name: string;
  type: RuleAssertion['type'] | 'citation_consistency';
  pass: boolean;
  /** 机器可读的判定依据,报告失败明细直接展示 */
  detail: string;
}

export interface JudgeVerdict {
  score: number; // 1-5 整数(多采样时为中位数聚合结果)
  reasons: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  impl: string; // 'real' | 'stub'
  /** 多采样(--judge-samples > 1)时记录每次原始分,报告展示;单采样不设 */
  samples?: number[];
}

/** judge 的可替换接口:real(GLM)与 stub(E2E 桩)都实现它 */
export interface JudgeLike {
  readonly impl: string;
  readonly model: string;
  /** 供 E2E 断言"规则失败的 case 不烧 judge" */
  callCount: number;
  judge(c: CaseFile, out: AdapterOutput): Promise<JudgeVerdict>;
}

export type CaseStatus = 'pass' | 'fail' | 'error';

export interface CaseResult {
  id: string;
  question: string;
  /** pass/fail 只由规则决定;judge 是附加指标,不改变 case 状态 */
  status: CaseStatus;
  adapterLatencyMs: number;
  /** 适配器实际执行次数(含重试);命中缓存的复用运行为 0 */
  attempts: number;
  /** 本次结果是否来自答案缓存(--reuse)而非真实调用 */
  reused: boolean;
  adapterError: string | null;
  /** 被测系统回答的字符数(成本估算的原料) */
  answerChars: number;
  /** 回答原文,latest.json 留档;幂等性对比(stability)靠它只重跑 judge */
  answer: string;
  /** 检索命中原文,stability 重评时保持 judge 视野与原跑一致 */
  hits: Hit[];
  rules: RuleResult[];
  rulesPassed: boolean;
  /** 规则全过才有 judge 结果;judge 自身故障记 judgeError */
  judge: JudgeVerdict | null;
  judgeError: string | null;
  /** 从"依据:材料N"解析出的材料号(空数组 = 回答没有依据行) */
  citedSessions: number[];
  /** 检索命中的 Session 号(按材料号顺序) */
  hitSessions: number[];
}

export interface RunMeta {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  casesDir: string;
  adapterCmd: string;
  judgeImpl: string;
  judgeModel: string;
  /** 规则断言调用次数 / judge 调用次数(成本与省钱原则的量化) */
  adapterCalls: number;
  judgeCalls: number;
  thresholds: { rulePassRate: number; judgeAvg: number };
  /** --only/--filter 只跑了子集时为 true(报告会标注,历史对比只算重叠 case) */
  partial: boolean;
  judgeSamples: number;
  /** 命中答案缓存的 case 数 */
  reusedCount: number;
}

export interface CostEstimate {
  /** judge 侧:API usage 精确计量 */
  judgePromptTokens: number;
  judgeCompletionTokens: number;
  judgeCostYuan: number;
  /** 被测系统侧:ask 不回吐 usage,只能估算(公式在报告脚注声明) */
  sutCalls: number;
  sutAnswerChars: number;
  sutEstTokens: number;
  sutEstCostYuan: number;
  totalEstCostYuan: number;
}

export interface RunSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  rulePassRate: number;
  judgeAvg: number | null;
  judgeScores: Record<number, number>; // 分数 -> 个数
  cost: CostEstimate;
}

export interface Gate {
  passed: boolean;
  reasons: string[]; // 不通过时逐条说明差多少
}

export interface RunResult {
  meta: RunMeta;
  results: CaseResult[];
  summary: RunSummary;
  gate: Gate;
}
