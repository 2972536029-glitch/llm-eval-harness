// E2E:不依赖真 LLM、不依赖 learning-log-qa 真跑(任务说明 M1 验收要求)。
// judge 全程用桩(LLME_JUDGE=stub),适配器用 fixture 脚本,零外部依赖、零成本。
// 覆盖:五条规则正反例 / 引用一致性 / 适配器 JSON+裸文本协议 / 重试 / 超时 / 并发度
//       / 规则失败不烧 judge / 报告结构 / 门禁与 CLI 退出码 / 用例 schema 校验
process.env.LLME_JUDGE = 'stub';
delete process.env.GLM_API_KEY; // 证明整条 E2E 不碰真钱:桩路径不该要 key

import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRule, checkCitations, stripJsonFence } from '../src/assert.ts';
import { parseAdapterStdout, AdapterError } from '../src/adapter.ts';
import { runPipeline, summarize, THRESHOLDS } from '../src/runner.ts';
import { createJudge } from '../src/judge.ts';
import { loadCases, parseCaseFile } from '../src/cases.ts';
import { renderReport } from '../src/report.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ROUTER = join(ROOT, 'adapters', 'fixtures', 'router.mjs');
const SLOW = join(ROOT, 'adapters', 'fixtures', 'slow.mjs');
const GOOD = join(ROOT, 'adapters', 'fixtures', 'good.mjs');
const FLAKY_FLAG = join(tmpdir(), 'llme-e2e-flaky.flag');

let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}  ${extra}`); }
};

// ── 1. 五条规则:正例 + 反例 ────────────────────────────────────────────
const R = (type, extra = {}) => runRule({ type, ...extra }, '依据:材料1。答案正文足够长。');
assert(R('contains', { value: '材料1' }).pass, 'contains 正例');
assert(!R('contains', { value: '不存在' }).pass, 'contains 反例');
assert(R('not_contains', { value: '幻觉' }).pass, 'not_contains 正例');
assert(!R('not_contains', { value: '依据' }).pass, 'not_contains 反例');
assert(R('regex', { pattern: '依据[:：]' }).pass, 'regex 正例');
assert(!R('regex', { pattern: '^\\d+$' }).pass, 'regex 反例');
{
  const bad = R('regex', { pattern: '([bad' });
  assert(!bad.pass && bad.detail.includes('配置错误'), 'regex 坏配置按不通过处理且说明原因');
}
assert(R('len_range', { min: 5, max: 100 }).pass, 'len_range 正例');
assert(!R('len_range', { max: 5 }).pass, 'len_range 超上限反例');
assert(!R('len_range', { min: 500 }).pass, 'len_range 不足下限反例');
assert(runRule({ type: 'json_valid' }, '{"a":1}').pass, 'json_valid 正例');
assert(runRule({ type: 'json_valid' }, '```json\n{"a":1}\n```').pass, 'json_valid 剥代码围栏');
assert(!runRule({ type: 'json_valid' }, '{bad json').pass, 'json_valid 反例');
assert(stripJsonFence('```json\n{"a":1}\n```') === '{"a":1}', 'stripJsonFence 提取内容');

// ── 2. 引用一致性 ────────────────────────────────────────────────────────
const mkCase = (over = {}) => ({ id: 't', question: 'q', expectSessions: [12], ruleAssertions: [], ...over });
const mkOut = (answer, sessions) => ({
  answer,
  hits: sessions.map((s, i) => ({ material: i + 1, score: 0.9, session: s, cite: `Session ${s}` })),
});
assert(checkCitations(mkCase(), mkOut('xxx\n依据:材料1', [12])).pass, '引用一致性:引用在期望内 → 过');
assert(!checkCitations(mkCase(), mkOut('xxx\n依据:材料1', [7])).pass, '引用一致性:Session 超出期望 → 不过');
assert(!checkCitations(mkCase(), mkOut('xxx\n依据:材料3', [12, 19])).pass, '引用一致性:材料号越界(幽灵引用)→ 不过');
assert(!checkCitations(mkCase(), mkOut('没有依据行的回答', [12])).pass, '引用一致性:缺依据行 → 不过');
assert(checkCitations(mkCase({ expectSessions: [12, 19] }), mkOut('xxx\n依据:材料1、材料2', [12, 19])).pass, '引用一致性:多条引用都在期望内 → 过');
assert(checkCitations(mkCase({ expectSessions: [19, 20, 21] }), mkOut('xxx\n依据:材料1', [19])).pass,
  '引用一致性:期望为 any-of 数组,引用其中之一 → 过(any-of 语义)');
assert(checkCitations(mkCase({ expectSessions: null }), mkOut('拒答', [])) === null, 'expectSessions=null → 检查不适用');

// ── 3. 适配器协议:JSON 与裸文本 ─────────────────────────────────────────
const j = parseAdapterStdout('{"answer":"答","hits":[{"session":12,"score":0.5,"cite":"c"}]}');
assert(j.answer === '答' && j.hits[0].material === 1 && j.hits[0].session === 12, '适配器 JSON 协议解析(material 缺省补位)');
const raw = parseAdapterStdout('  纯文本回答没有 JSON 壳  ');
assert(raw.answer === '纯文本回答没有 JSON 壳' && raw.hits.length === 0, '适配器裸文本兜底');
let emptyErr = null;
try { parseAdapterStdout('  \n  '); } catch (e) { emptyErr = e; }
assert(emptyErr instanceof AdapterError && emptyErr.retryable, '适配器空输出 → 可重试错误');

// ── 4. 管线综合:router fixture 一次跑全部分支 ──────────────────────────
const judge = createJudge('stub');
assert(judge.impl === 'stub', 'judge 桩注入生效');
const cases = [
  { id: 'ok-1', question: 'ok:Helm 哪次学的?', expectSessions: [12, 19],
    ruleAssertions: [{ type: 'regex', pattern: '依据[:：]' }, { type: 'len_range', min: 10, max: 500 }] },
  { id: 'wrong-1', question: 'wrong:Hooks 哪次学的?', expectSessions: [12],
    ruleAssertions: [{ type: 'regex', pattern: '依据[:：]' }] },
  { id: 'fab-1', question: 'fab:Kustomize 呢?', expectSessions: [12, 19],
    ruleAssertions: [{ type: 'regex', pattern: '依据[:：]' }, { type: 'len_range', min: 10, max: 500 }] },
  { id: 'refuse-1', question: 'refuse:考研成绩?', expectSessions: null,
    ruleAssertions: [{ type: 'contains', value: '没有足够信息' }] },
  { id: 'flaky-1', question: 'flaky:Docker 哪次学的?', expectSessions: [12, 19],
    ruleAssertions: [{ type: 'len_range', min: 10, max: 500 }] },
  { id: 'hang-1', question: 'hang:CSS 换肤?', expectSessions: [12, 19],
    ruleAssertions: [{ type: 'len_range', min: 10, max: 500 }] },
  { id: 'crash-1', question: 'crash:own words?', expectSessions: [12, 19],
    ruleAssertions: [{ type: 'len_range', min: 10, max: 500 }] },
];
rmSync(FLAKY_FLAG, { force: true });
const judgeCallsBefore = judge.callCount;
const t0 = Date.now();
const run = await runPipeline({ cases, adapterCmd: ['node', ROUTER], judge, concurrency: 2, adapterTimeoutMs: 3000 });
const wall = Date.now() - t0;
const byId = Object.fromEntries(run.results.map(r => [r.id, r]));

assert(run.results.length === cases.length && run.results[0].id === 'ok-1', '结果按用例顺序保序');
assert(byId['ok-1'].status === 'pass' && byId['ok-1'].judge?.score === 4, '好答案全链路:规则过 + 桩 judge 4 分');
assert(byId['wrong-1'].status === 'fail' && byId['wrong-1'].rules.some(r => r.type === 'citation_consistency' && !r.pass),
  '引用越界:引用一致性失败');
assert(byId['wrong-1'].judge === null, '规则失败的 case 不烧 judge');
assert(judge.callCount === judgeCallsBefore + 4, `judge 只被调 4 次(ok/fab/refuse/flaky 过规则;wrong/crash/hang 不烧),实际 ${judge.callCount - judgeCallsBefore}`);
assert(byId['fab-1'].status === 'pass' && byId['fab-1'].judge?.score === 1, '编造答案:规则放行、桩 judge 抓出来打 1 分');
assert(byId['refuse-1'].status === 'pass' && byId['refuse-1'].judge?.score === 5, '拒答场景(裸文本协议):规则过 + judge 5 分');
assert(byId['flaky-1'].status === 'pass' && byId['flaky-1'].attempts === 2, 'flaky 适配器:重试一次后通过,attempts=2');
assert(byId['hang-1'].status === 'error' && byId['hang-1'].adapterError?.includes('超时'), '超时适配器:标记 error 且说明超时');
assert(byId['crash-1'].status === 'error' && byId['crash-1'].attempts === 2 && byId['crash-1'].adapterError?.includes('退出码 3'),
  '崩溃适配器:重试耗尽,保留退出码归因');
// 超时(3s)× 重试上限(2 次)= 单 case 最坏 6s 预算,这是设计内行为;关键是别把整趟拖到无限等
assert(wall < 8000, `hang 按预算被杀(超时×重试≈6s),实际耗时 ${wall}ms`);
assert(run.meta.judgeCalls === judge.callCount && run.meta.adapterCalls === run.results.reduce((s, r) => s + r.attempts, 0),
  'meta 计数与实际一致');
assert(run.summary.cost.judgePromptTokens > 0 && run.summary.cost.sutCalls > 0, '成本两本账都有数');

// ── 5. 并发度:6 条 × 400ms,并发 2 → 墙钟 ≈ 3 × 400ms,既非串行也非不设限 ──
const slowCases = Array.from({ length: 6 }, (_, i) => ({
  id: `slow-${i}`, question: `ok:并发 ${i}`, expectSessions: null,
  ruleAssertions: [{ type: 'len_range', min: 5, max: 500 }],
}));
const t1 = Date.now();
await runPipeline({ cases: slowCases, adapterCmd: ['node', SLOW], judge, concurrency: 2, adapterTimeoutMs: 10_000 });
const wall2 = Date.now() - t1;
assert(wall2 > 700 && wall2 < 2100, `并发度 2 生效(6×400ms,墙钟 ${wall2}ms,串行≈2400)`, `wall=${wall2}`);

// ── 6. 报告结构 ──────────────────────────────────────────────────────────
const md = renderReport({ ...run, meta: { ...run.meta, casesDir: '(e2e)' } }, 'e2e');
for (const section of ['# LLM 输出评测报告', '## 总览', '门禁判定', '## 逐 case 明细', '## 成本(两本账)', '## 失败与错误明细']) {
  assert(md.includes(section), `报告含「${section}」`);
}
assert(md.includes('wrong-1') && md.includes('citation_consistency'), '失败明细可归因到具体断言');
assert(md.includes('hang-1') && md.includes('适配器错误'), 'error case 有归因明细');

// ── 7. 门禁语义(阈值边界) ─────────────────────────────────────────────
const okResult = byId['ok-1'];
const badResult = byId['wrong-1'];
const errResult = byId['crash-1'];
const lowJudge = { ...okResult, judge: { ...okResult.judge, score: 1 } };
{
  const { gate, summary } = summarize([okResult, okResult, okResult, badResult], THRESHOLDS);
  assert(!gate.passed && summary.rulePassRate < THRESHOLDS.rulePassRate && gate.reasons.some(r => r.includes('通过率')),
    '门禁:通过率 0.75 < 0.8 → 不过并给出原因');
}
{
  const { gate, summary } = summarize([okResult, okResult, okResult, okResult, badResult], THRESHOLDS);
  assert(gate.passed && Math.abs(summary.rulePassRate - 0.8) < 1e-9, '门禁:通过率恰为 0.8 → 过(边界含等号)');
}
{
  const { gate } = summarize([okResult, okResult, okResult, okResult, lowJudge], THRESHOLDS);
  assert(!gate.passed && gate.reasons.some(r => r.includes('judge')), '门禁:规则全过但 judge 均分 3.4 < 4.0 → 不过');
}
{
  const { gate } = summarize([errResult, errResult], THRESHOLDS);
  assert(!gate.passed && gate.reasons.length > 0, '门禁:全 error 无有效信号 → 不过');
}

// ── 8. 用例 schema 校验 ─────────────────────────────────────────────────
assert(loadCases(join(ROOT, 'cases')).length === 12, '真实用例目录加载 12 条');
const throws = fn => { try { fn(); return false; } catch { return true; } };
assert(throws(() => parseCaseFile('x.json', '{"id":"","question":"q","ruleAssertions":[{"type":"contains","value":"a"}]}')), 'schema:空 id 拒绝');
assert(throws(() => parseCaseFile('x.json', '{"id":"a","question":"q","ruleAssertions":[{"type":"nope"}]}')), 'schema:未知规则类型拒绝');
assert(throws(() => parseCaseFile('x.json', '{"id":"a","question":"q","ruleAssertions":[{"type":"regex","pattern":"([bad"}]}')), 'schema:regex 编译失败拒绝');
assert(throws(() => parseCaseFile('x.json', '{"id":"a","question":"q","expectSessions":[0],"ruleAssertions":[{"type":"contains","value":"a"}]}')), 'schema:expectSessions 含 0 拒绝');
assert(throws(() => parseCaseFile('x.json', '{"id":"a","question":"q","ruleAssertions":[]}')), 'schema:空断言数组拒绝(用例必须证明点什么)');
assert(!throws(() => parseCaseFile('x.json', '{"id":"a","question":"q","expectSessions":null,"ruleAssertions":[{"type":"contains","value":"a"}]}')), 'schema:显式 null expectSessions 合法');

// ── 9. CLI 冒烟:退出码 + 报告落盘 ──────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'llme-e2e-cli-'));
const tmpCases = join(tmp, 'cases');
const tmpCasesPass = join(tmp, 'cases-pass');
const tmpOut = join(tmp, 'reports');
writeCase(tmpCases, 'pass.json', { id: 'cli-pass', question: 'ok:x', expectSessions: null, ruleAssertions: [{ type: 'contains', value: '材料1' }] });
writeCase(tmpCases, 'fail.json', { id: 'cli-fail', question: 'ok:x', expectSessions: null, ruleAssertions: [{ type: 'contains', value: '这句话不可能出现' }] });
writeCase(tmpCasesPass, 'pass.json', { id: 'cli-pass', question: 'ok:x', expectSessions: null, ruleAssertions: [{ type: 'contains', value: '材料1' }] });
// 命令字符串形式:规避 spawnSync(shell:true) + args 数组的 DEP0190(参数不转义告警),引号自己管好
const cliRun = casesDir => spawnSync(
  `npx tsx src/cli.ts --cases "${casesDir}" --adapter "${GOOD}" --judge stub --out "${tmpOut}" --tag e2e-cli`,
  { cwd: ROOT, shell: true, encoding: 'utf-8', timeout: 120_000 });
const rPass = cliRun(tmpCasesPass);
assert(rPass.status === 0, 'CLI:全过 → 退出码 0', `status=${rPass.status} stderr=${rPass.stderr?.slice(-300)}`);
assert(existsSync(join(tmpOut, 'latest.md')) && existsSync(join(tmpOut, 'latest.json')), 'CLI:latest.md/latest.json 落盘');
rmSync(tmpOut, { recursive: true, force: true });
const rFail = cliRun(tmpCases);
assert(rFail.status === 1, 'CLI:含失败 → 退出码 1', `status=${rFail.status}`);
assert((rFail.stdout + rFail.stderr).includes('门禁未过'), 'CLI:失败原因可见');
rmSync(tmp, { recursive: true, force: true });

// ── 收尾 ─────────────────────────────────────────────────────────────────
console.log(`\nE2E: ${pass} 通过, ${fail} 失败`);
process.exitCode = fail ? 1 : 0;

function writeCase(dir, name, obj) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(obj, null, 2), 'utf-8');
}
