// E2E:不依赖真 LLM、不依赖 learning-log-qa 真跑(任务说明 M1 验收要求)。
// judge 全程用桩(LLME_JUDGE=stub),适配器用 fixture 脚本,零外部依赖、零成本。
// 覆盖:五条规则正反例 / 引用一致性 / 适配器 JSON+裸文本协议 / 重试 / 超时 / 并发度
//       / 规则失败不烧 judge / 报告结构 / 门禁与 CLI 退出码 / 用例 schema 校验
process.env.LLME_JUDGE = 'stub';
delete process.env.GLM_API_KEY; // 证明整条 E2E 不碰真钱:桩路径不该要 key

import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRule, checkCitations, stripJsonFence } from '../src/assert.ts';
import { parseAdapterStdout, AdapterError } from '../src/adapter.ts';
import { runPipeline, summarize, THRESHOLDS, cacheKey, aggregateScores } from '../src/runner.ts';
import { createJudge } from '../src/judge.ts';
import { loadCases, parseCaseFile } from '../src/cases.ts';
import { renderReport } from '../src/report.ts';
import { renderHtmlReport } from '../src/html-report.ts';
import { loadConfigFile, mergeConfig } from '../src/config.ts';
import { createFileAnswerCache } from '../src/cache.ts';
import { appendHistory, loadHistory, entryFromRun, diffRuns, previousCompleteRun } from '../src/history.ts';

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
  { id: 'xss-1', question: 'xss:注入测试', expectSessions: [12],
    ruleAssertions: [{ type: 'len_range', min: 10, max: 5000 }] },
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
assert(judge.callCount === judgeCallsBefore + 5, `judge 只被调 5 次(ok/fab/refuse/flaky/xss 过规则;wrong/crash/hang 不烧),实际 ${judge.callCount - judgeCallsBefore}`);
assert(byId['fab-1'].status === 'pass' && byId['fab-1'].judge?.score === 1, '编造答案:规则放行、桩 judge 抓出来打 1 分');
assert(byId['refuse-1'].status === 'pass' && byId['refuse-1'].judge?.score === 5, '拒答场景(裸文本协议):规则过 + judge 5 分');
assert(byId['flaky-1'].status === 'pass' && byId['flaky-1'].attempts === 2, 'flaky 适配器:重试一次后通过,attempts=2');
assert(byId['hang-1'].status === 'error' && byId['hang-1'].adapterError?.includes('超时'), '超时适配器:标记 error 且说明超时');
assert(byId['crash-1'].status === 'error' && byId['crash-1'].attempts === 2 && byId['crash-1'].adapterError?.includes('退出码 3'),
  '崩溃适配器:重试耗尽,保留退出码归因');
assert(byId['xss-1'].status === 'pass' && byId['xss-1'].answer.includes('</script>'),
  'xss 载荷 case:管线层正常通过(防御在报告层)');
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
assert(existsSync(join(tmpOut, 'latest.html')) && existsSync(join(tmpOut, 'junit.xml')), 'CLI:latest.html/junit.xml 落盘(v0.2 产物)');
rmSync(tmpOut, { recursive: true, force: true });
const rFail = cliRun(tmpCases);
assert(rFail.status === 1, 'CLI:含失败 → 退出码 1', `status=${rFail.status}`);
assert((rFail.stdout + rFail.stderr).includes('门禁未过'), 'CLI:失败原因可见');
rmSync(tmp, { recursive: true, force: true });

// ── 10. v0.2 新规则:正例 + 反例 ────────────────────────────────────────
const NT = '依据:材料1。答案正文足够长。Answer text here.';
assert(runRule({ type: 'contains_any', values: ['材料1', 'zzz'] }, NT).pass, 'contains_any 正例');
assert(!runRule({ type: 'contains_any', values: ['foo', 'bar'] }, NT).pass, 'contains_any 反例');
assert(runRule({ type: 'contains_all', values: ['依据', '材料1'] }, NT).pass, 'contains_all 正例');
assert(!runRule({ type: 'contains_all', values: ['依据', '不存在'] }, NT).pass, 'contains_all 反例');
assert(runRule({ type: 'starts_with', value: '依据' }, NT).pass, 'starts_with 正例');
assert(!runRule({ type: 'starts_with', value: '答案' }, NT).pass, 'starts_with 反例');
assert(runRule({ type: 'ends_with', value: 'here.' }, NT).pass, 'ends_with 正例');
assert(!runRule({ type: 'ends_with', value: '?' }, NT).pass, 'ends_with 反例');
assert(runRule({ type: 'equals', value: NT }, NT).pass, 'equals 正例');
assert(!runRule({ type: 'equals', value: '别的' }, NT).pass, 'equals 反例');
assert(runRule({ type: 'not_regex', pattern: '幻觉xx' }, NT).pass, 'not_regex 正例');
assert(!runRule({ type: 'not_regex', pattern: '依据' }, NT).pass, 'not_regex 反例');
assert(!runRule({ type: 'not_regex', pattern: '([bad' }, NT).pass, 'not_regex 坏配置按不通过处理');
assert(throws(() => parseCaseFile('x.json', '{"id":"a","question":"q","ruleAssertions":[{"type":"contains_any","values":[]}]}')), 'schema:contains_any 空 values 拒绝');

// ── 11. 配置层:文件 / env / CLI 优先级 ────────────────────────────────
{
  const cfgDir = mkdtempSync(join(tmpdir(), 'llme-cfg-'));
  const cfgFile = join(cfgDir, 'eval.config.json');
  assert(Object.keys(loadConfigFile(join(cfgDir, 'nope.json'))).length === 0, 'config:文件缺失返回空(走默认)');
  writeFileSync(cfgFile, JSON.stringify({ concurrency: 3, judge: 'stub', thresholds: { rulePassRate: 0.9, judgeAvg: 3.5 } }));
  const f = loadConfigFile(cfgFile);
  assert(f.concurrency === 3 && f.judge === 'stub' && f.thresholds?.rulePassRate === 0.9, 'config:合法文件读回');
  const merged = mergeConfig(f, { concurrency: 5 }, { LLME_JUDGE: 'real' });
  assert(merged.concurrency === 5 && merged.judge === 'real' && merged.thresholds.judgeAvg === 3.5, 'config:优先级 CLI > env > 文件');
  assert(mergeConfig(f, {}, {}).concurrency === 3 && mergeConfig(f, {}, {}).judge === 'stub', 'config:无覆盖时文件生效');
  writeFileSync(cfgFile, JSON.stringify({ concurrencyx: 3 }));
  assert(throws(() => loadConfigFile(cfgFile)), 'config:未知字段拒绝(typo 保护)');
  writeFileSync(cfgFile, JSON.stringify({ thresholds: { rulePassRate: 2 } }));
  assert(throws(() => loadConfigFile(cfgFile)), 'config:阈值越界拒绝');
  rmSync(cfgDir, { recursive: true, force: true });
}

// ── 12. 答案缓存 ────────────────────────────────────────────────────────
{
  const k1 = cacheKey('a', 'q1', ['node', 'x.mjs']);
  assert(k1 === cacheKey('a', 'q1', ['node', 'x.mjs']), 'cache:相同输入同 key');
  assert(k1 !== cacheKey('a', 'q2', ['node', 'x.mjs']) && k1 !== cacheKey('b', 'q1', ['node', 'x.mjs'])
    && k1 !== cacheKey('a', 'q1', ['node', 'y.mjs']), 'cache:key 随 id/问题/适配器变化');
  const dir = mkdtempSync(join(tmpdir(), 'llme-cache-'));
  const file = join(dir, 'answer-cache.json');
  const c = createFileAnswerCache(file);
  const out1 = { answer: '答\n依据:材料1', hits: [{ material: 1, score: 0.9, session: 12, cite: 's' }] };
  c.put('k', 'q1', out1);
  assert(c.get('k', 'q1')?.answer === out1.answer, 'cache:put/get roundtrip');
  assert(c.get('k', '别的') === null, 'cache:question 对不上视为未命中');
  c.save();
  assert(createFileAnswerCache(file).get('k', 'q1')?.hits[0].session === 12, 'cache:落盘后新实例可读');
  writeFileSync(file, '{bad json', 'utf-8');
  assert(createFileAnswerCache(file).size() === 0, 'cache:坏文件当空缓存,不炸');
  rmSync(dir, { recursive: true, force: true });
  // runner 集成:同一缓存跑两遍,第二遍全复用、judge 照常
  const mem = new Map();
  const memCache = {
    get: (k, q) => (mem.get(k)?.question === q ? { answer: mem.get(k).answer, hits: mem.get(k).hits } : null),
    put: (k, q, o) => mem.set(k, { question: q, answer: o.answer, hits: o.hits }),
  };
  const oneCase = [{ id: 'cache-1', question: 'ok:缓存', expectSessions: [12, 19], ruleAssertions: [{ type: 'len_range', min: 10, max: 500 }] }];
  const jd = createJudge('stub');
  const first = await runPipeline({ cases: oneCase, adapterCmd: ['node', ROUTER], judge: jd, answerCache: memCache });
  const second = await runPipeline({ cases: oneCase, adapterCmd: ['node', ROUTER], judge: jd, answerCache: memCache });
  assert(first.results[0].attempts === 1 && !first.results[0].reused && first.results[0].answer.length > 0, 'cache:首跑真实调用并写缓存');
  assert(second.results[0].reused === true && second.results[0].attempts === 0 && second.results[0].status === 'pass', 'cache:二跑全复用,规则照常判');
  assert(second.meta.reusedCount === 1 && second.meta.adapterCalls === 0 && second.results[0].judge !== null, 'cache:meta 复用计数正确,judge 仍执行');
}

// ── 13. judge 多采样:中位数聚合 ────────────────────────────────────────
assert(aggregateScores([5]) === 5 && aggregateScores([4, 5, 5]) === 5 && aggregateScores([4, 4, 5]) === 4
  && aggregateScores([4, 5, 4, 5, 4]) === 4 && aggregateScores([3, 5]) === 3, '中位数聚合:偶数个取偏低(从严)');
{
  const cycleJudge = {
    i: 0, impl: 'cycle', model: 'cycle', callCount: 0,
    async judge(_c, _o) {
      this.callCount++;
      return { score: [5, 4, 5, 4, 5][this.i++ % 5], reasons: 'cycle', promptTokens: 1, completionTokens: 1, latencyMs: 1, impl: 'cycle' };
    },
  };
  const simpleCase = [{ id: 'samp-1', question: '任意问题', expectSessions: [6], ruleAssertions: [{ type: 'len_range', min: 5, max: 500 }] }];
  const r = await runPipeline({ cases: simpleCase, adapterCmd: ['node', GOOD], judge: cycleJudge, judgeSamples: 5 });
  assert(r.results[0].judge?.samples?.length === 5 && r.results[0].judge?.score === 5, 'judge 多采样:样本全记录,5,4,5,4,5 → 中位数 5');
  assert(r.meta.judgeCalls === 5 && r.summary.cost.judgePromptTokens === 5, 'judge 多采样:调用与成本按 ×5 计');
}

// ── 14. 运行历史与回归 diff ─────────────────────────────────────────────
{
  const hdir = mkdtempSync(join(tmpdir(), 'llme-hist-'));
  const hf = join(hdir, 'history.jsonl');
  const mk = (id, status, score) => ({ id, status, score });
  const prev = { ts: '2026-01-01T00:00:00Z', tag: 'a', complete: true, total: 3, pass: 2, fail: 1, error: 0, rulePassRate: 2 / 3, judgeAvg: 4.5, costYuan: 0.01, gatePassed: true, cases: [mk('x', 'pass', 5), mk('y', 'fail', null), mk('z', 'pass', 4)] };
  const cur = { ...prev, ts: '2026-01-02T00:00:00Z', cases: [mk('x', 'fail', null), mk('y', 'pass', 5), mk('z', 'pass', 5), mk('new', 'pass', 5)] };
  const d = diffRuns(prev, cur);
  assert(d.overlap === 3 && d.regressions.length === 1 && d.regressions[0].id === 'x', 'diff:pass→fail 记回归');
  assert(d.fixes.length === 1 && d.fixes[0].id === 'y', 'diff:fail→pass 记修复');
  assert(d.scoreChanges.length === 1 && d.scoreChanges[0].from === 4 && d.scoreChanges[0].to === 5, 'diff:judge 分变化(|Δ|≥1)被记录');
  appendHistory(hf, prev); appendHistory(hf, cur); appendHistory(hf, { ...cur, complete: false });
  const loaded = loadHistory(hf);
  assert(loaded.length === 3 && loaded[0].tag === 'a', 'history:JSONL 追加与读回');
  assert(previousCompleteRun(loaded, 3)?.ts === cur.ts, 'history:部分运行不作为对比基线');
  const e = entryFromRun(run, false, 'e2e-tag');
  assert(e.tag === 'e2e-tag' && e.complete === false && e.cases.length === run.results.length, 'history:从运行结果生成摘要行');
  rmSync(hdir, { recursive: true, force: true });
}

// ── 15. CLI 新旗标(桩路径,零真钱)────────────────────────────────────
{
  const CLI = args => spawnSync(`npx tsx src/cli.ts ${args}`, { cwd: ROOT, shell: true, encoding: 'utf-8', timeout: 120_000 });
  const t = mkdtempSync(join(tmpdir(), 'llme-cli2-'));
  const tc = join(t, 'cases');
  writeCase(tc, 'a.json', { id: 'cli-a', question: 'ok:甲', expectSessions: null, ruleAssertions: [{ type: 'contains', value: '材料1' }] });
  writeCase(tc, 'b.json', { id: 'cli-b', question: 'ok:乙', expectSessions: null, ruleAssertions: [{ type: 'contains', value: '不可能出现' }] });
  const base = `--cases "${tc}" --adapter "${GOOD}" --judge stub`;

  const rl = CLI(`${base} --list`);
  assert(rl.status === 0 && rl.stdout.includes('cli-a') && rl.stdout.includes('cli-b'), 'CLI --list:列出用例退出 0');

  const rd = CLI(`${base} --out "${join(t, 'dry')}" --dry-run`);
  assert(rd.status === 0 && rd.stdout.includes('执行计划') && rd.stdout.includes('2/2 条'), 'CLI --dry-run:输出执行计划');
  assert(!existsSync(join(t, 'dry')), 'CLI --dry-run:不写任何产物');

  const ro = CLI(`${base} --out "${join(t, 'o1')}" --only cli-a`);
  const roJson = JSON.parse(readFileSync(join(t, 'o1', 'latest.json'), 'utf-8'));
  assert(ro.status === 0 && roJson.results.length === 1 && roJson.results[0].id === 'cli-a' && roJson.meta.partial === true,
    'CLI --only:只跑所选且标记 partial');

  // 正则参数用双引号:cmd.exe 不认单引号,^ 在双引号内才是字面量
  const rf = CLI(`${base} --out "${join(t, 'o2')}" --filter "^cli-a$"`);
  assert(rf.status === 0 && JSON.parse(readFileSync(join(t, 'o2', 'latest.json'), 'utf-8')).results.length === 1, 'CLI --filter:按 id 正则筛');

  const rBad = CLI(`${base} --out "${join(t, 'o3')}" --only nope-id`);
  assert(rBad.status === 1 && (rBad.stderr + '').includes('未知 case id'), 'CLI --only:未知 id 报错并列出可用 id');

  const rGate = CLI(`${base} --out "${join(t, 'o4')}" --no-gate`);
  const gJson = JSON.parse(readFileSync(join(t, 'o4', 'latest.json'), 'utf-8'));
  assert(rGate.status === 0 && gJson.gate.passed === false, 'CLI --no-gate:报告如实判 FAIL 但退出码 0');

  const rCfg = mkdtempSync(join(tmpdir(), 'llme-cfgfile-'));
  writeFileSync(join(rCfg, 'eval.config.json'), JSON.stringify({ thresholds: { rulePassRate: 1.0 } }));
  const rStrict = CLI(`${base} --config "${join(rCfg, 'eval.config.json')}" --out "${join(t, 'o5')}" --only cli-a`);
  const sJson = JSON.parse(readFileSync(join(t, 'o5', 'latest.json'), 'utf-8'));
  assert(rStrict.status === 0 && sJson.meta.thresholds.rulePassRate === 1, 'CLI --config:配置文件阈值生效并回显');

  const r1 = CLI(`${base} --out "${join(t, 'rc')}" --reuse`);
  const j1 = JSON.parse(readFileSync(join(t, 'rc', 'latest.json'), 'utf-8'));
  const r2 = CLI(`${base} --out "${join(t, 'rc')}" --reuse`);
  const j2 = JSON.parse(readFileSync(join(t, 'rc', 'latest.json'), 'utf-8'));
  assert(j1.results.every(x => x.attempts >= 1 && !x.reused), 'CLI --reuse:首跑真实调用');
  assert(j2.results.every(x => x.reused === true && x.attempts === 0), 'CLI --reuse:二跑全复用(attempts=0)');
  assert(existsSync(join(t, 'rc', 'answer-cache.json')) && existsSync(join(t, 'rc', 'history.jsonl')),
    'CLI:answer-cache.json 与 history.jsonl 落盘');
  const h2 = loadHistory(join(t, 'rc', 'history.jsonl'));
  assert(h2.length === 2, 'CLI:两次运行各记一行历史');
  assert(readFileSync(join(t, 'rc', 'latest.md'), 'utf-8').includes('与上次完整运行对比'), 'CLI:第二次报告含回归对比段');

  const rs = CLI(`${base} --out "${join(t, 'o6')}" --only cli-a --judge-samples 2`);
  const sJson2 = JSON.parse(readFileSync(join(t, 'o6', 'latest.json'), 'utf-8'));
  assert(rs.status === 0 && sJson2.results[0].judge.samples.length === 2, 'CLI --judge-samples:采样数生效');
  rmSync(t, { recursive: true, force: true });
  rmSync(rCfg, { recursive: true, force: true });
}

// ── 16. JUnit XML ───────────────────────────────────────────────────────
{
  const t = mkdtempSync(join(tmpdir(), 'llme-junit-'));
  const tc = join(t, 'cases');
  writeCase(tc, 'a.json', { id: 'ju-pass', question: 'ok:甲', expectSessions: null, ruleAssertions: [{ type: 'contains', value: '材料1' }] });
  writeCase(tc, 'b.json', { id: 'ju-fail', question: 'ok:乙', expectSessions: null, ruleAssertions: [{ type: 'contains', value: '不可能出现' }] });
  spawnSync(`npx tsx src/cli.ts --cases "${tc}" --adapter "${GOOD}" --judge stub --out "${join(t, 'out')}"`,
    { cwd: ROOT, shell: true, encoding: 'utf-8', timeout: 120_000 });
  const xml = readFileSync(join(t, 'out', 'junit.xml'), 'utf-8');
  assert(xml.startsWith('<?xml') && xml.includes('<testsuites'), 'junit:XML 头与 testsuites');
  assert((xml.match(/<testcase /g) ?? []).length === 3, 'junit:2 case + 1 合成 gate(门禁未过)');
  assert(xml.includes('name="ju-fail"') && xml.includes('<failure'), 'junit:失败 case 带 failure 节点');
  assert(xml.includes('name="gate"'), 'junit:门禁失败进合成 testcase(CI 报告页可见)');
  rmSync(t, { recursive: true, force: true });
}

// ── 17. HTML 报告:注入防御 + 数据完整 ─────────────────────────────────
{
  const html = renderHtmlReport(run, []);
  assert(html.includes('\\u003c/script>'), 'HTML:数据段里 </script> 的 "<" 被转义(无法提前闭合标签;">" 无需转义)');
  assert(!html.includes('<script src=') && !html.includes('<link '), 'HTML:零外链资源(离线可用)');
  const m2 = /<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert(m2 !== null, 'HTML:内联数据节点存在');
  const parsed = m2 ? JSON.parse(m2[1]) : null;
  assert(parsed?.run?.results?.length === run.results.length && parsed.run.results.some(r => r.id === 'xss-1'),
    'HTML:内联 JSON 可解析且含全部 case');
}

// ── 18. demo 模式:零 API key 全链路体验 ───────────────────────────────
{
  const rd = spawnSync('npx tsx src/cli.ts', ['--help'], { cwd: ROOT, shell: true, encoding: 'utf-8', timeout: 60_000 });
  assert(rd.status === 0 && rd.stdout.includes('--reuse') && rd.stdout.includes('--judge-samples'), 'CLI --help:新旗标可见');
  const demo = spawnSync(`npx tsx src/cli.ts --cases "${join(ROOT, 'demo')}" --adapter "${ROUTER}" --judge stub --out "${join(ROOT, 'reports-demo')}" --tag demo --no-gate`,
    { cwd: ROOT, shell: true, encoding: 'utf-8', timeout: 120_000 });
  assert(demo.status === 0, 'demo:退出 0(--no-gate,含故意失败的演示用例)', demo.stderr?.slice(-200));
  assert(existsSync(join(ROOT, 'reports-demo', 'latest.html')), 'demo:HTML 报告生成');
  assert(readFileSync(join(ROOT, 'reports-demo', 'latest.md'), 'utf-8').includes('demo-citation-fail'), 'demo:报告含引用失败演示');
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
console.log(`\nE2E: ${pass} 通过, ${fail} 失败`);
process.exitCode = fail ? 1 : 0;

function writeCase(dir, name, obj) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(obj, null, 2), 'utf-8');
}
