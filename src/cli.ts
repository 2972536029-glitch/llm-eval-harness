/**
 * CLI 入口:npm run eval [-- 旗标]
 * 职责:配置解析(默认 < 文件 < env < 旗标)→ 用例选择(--only/--filter)→ 演练(--dry-run/--list)
 *       → 执行(可选 --reuse 缓存)→ 五件套产物(md/json/html/junit/history)→ 退出码。
 * 退出码即 CI 信号:门禁不过 = 非 0(--no-gate 只出报告不拦截,留给本地探索)。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCases } from './cases.ts';
import { createJudge } from './judge.ts';
import { cacheKey, runPipeline } from './runner.ts';
import { renderReport } from './report.ts';
import { renderHtmlReport } from './html-report.ts';
import { renderJunit } from './junit.ts';
import { appendHistory, diffRuns, entryFromRun, loadHistory, previousCompleteRun } from './history.ts';
import { createFileAnswerCache } from './cache.ts';
import { loadConfigFile, mergeConfig, type CliOverrides } from './config.ts';

const HELP = `llm-eval-harness v0.2 — 通用 LLM 输出评测管线

用法:npm run eval [-- 旗标]

用例与执行
  --cases <dir>          用例目录(默认 cases)
  --only <id,id,...>     只跑指定 case(逗号分隔)
  --filter <regex>       按 case id 正则筛选
  --adapter <file>       适配器脚本(默认 adapters/learning-log-qa.mjs)
  --concurrency <n>      并发数(默认 2)
  --adapter-timeout <ms> 单 case 适配器超时(默认 150000)
  --reuse                复用上次真实回答(答案缓存),只重跑规则与 judge——迭代省钱
judge
  --judge <real|stub>    judge 实现(默认 real;E2E/演示用 stub)
  --judge-model <name>   judge 模型(默认 glm-4-flash)
  --judge-samples <n>    judge 采样次数,中位数聚合(默认 1;>1 成本 ×n)
输出与门禁
  --out <dir>            产物目录(默认 reports):latest.md / latest.json / latest.html / junit.xml / history.jsonl
  --tag <name>           报告标记(如 v0.2-acceptance)
  --config <file>        配置文件路径(默认 eval.config.json,可缺省)
流程控制
  --list                 列出用例后退出(不执行)
  --dry-run              校验配置与用例、显示执行计划(含缓存命中预估),不执行
  --no-gate              照常出报告与判定,但退出码恒为 0(本地探索用)
  -h, --help             本帮助

配置优先级:CLI 旗标 > 环境变量(LLME_JUDGE / LLME_JUDGE_MODEL / LLME_PRICE_PER_K) > eval.config.json > 默认值
文档:docs/cases.md(用例编写)· docs/adapters.md(适配器协议)· README.md(总览)`;

interface RawArgs {
  overrides: CliOverrides;
  bool: Set<string>;
  only?: string[];
  filter?: string;
  config?: string;
  positional: string[];
}

function parseArgs(argv: string[]): RawArgs {
  const r: RawArgs = { overrides: {}, bool: new Set(), positional: [] };
  const valueFlags = new Map<string, keyof CliOverrides>([
    ['--cases', 'cases'], ['--adapter', 'adapter'], ['--judge', 'judge'], ['--judge-model', 'judgeModel'],
    ['--judge-samples', 'judgeSamples'], ['--out', 'out'], ['--tag', 'tag'],
    ['--concurrency', 'concurrency'], ['--adapter-timeout', 'adapterTimeoutMs'],
  ]);
  const numFlags = new Set(['judgeSamples', 'concurrency', 'adapterTimeoutMs']);
  const take = (a: string[], i: number, flag: string): string => {
    const v = a[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    let tok = argv[i];
    let val: string | undefined;
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq > 0) { val = tok.slice(eq + 1); tok = tok.slice(0, eq); }
    if (tok === '-h' || tok === '--help') { r.bool.add('help'); continue; }
    if (['--list', '--dry-run', '--no-gate', '--reuse'].includes(tok)) { r.bool.add(tok.slice(2)); continue; }
    if (tok === '--only') {
      const v = val ?? take(argv, i, tok); if (val === undefined) i++;
      r.only = v.split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (tok === '--filter') {
      const v = val ?? take(argv, i, tok); if (val === undefined) i++;
      r.filter = v;
      continue;
    }
    if (tok === '--config') {
      const v = val ?? take(argv, i, tok); if (val === undefined) i++;
      r.config = v;
      continue;
    }
    const key = valueFlags.get(tok);
    if (key) {
      const v = val ?? take(argv, i, tok); if (val === undefined) i++;
      if (numFlags.has(key as string)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${tok} 应为正数,得到 "${v}"`);
        (r.overrides as Record<string, unknown>)[key as string] = n;
      } else if (key === 'judge') {
        if (v !== 'real' && v !== 'stub') throw new Error(`--judge 只能是 real 或 stub,得到 "${v}"`);
        r.overrides.judge = v;
      } else {
        (r.overrides as Record<string, unknown>)[key as string] = v;
      }
      continue;
    }
    if (tok.startsWith('--')) throw new Error(`未知旗标:${tok}(--help 查看用法)`);
    r.positional.push(tok);
  }
  return r;
}

async function main(): Promise<void> {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.bool.has('help')) { console.log(HELP); return; }

  const configPath = raw.config ?? 'eval.config.json';
  const cfg = mergeConfig(loadConfigFile(configPath), raw.overrides);

  const all = loadCases(resolve(cfg.cases));

  // --list:只读用例,不需要适配器与 judge
  if (raw.bool.has('list')) {
    console.log(`用例目录 ${resolve(cfg.cases)}(配置 ${existsSync(configPath) ? configPath : '默认值'}):${all.length} 条`);
    for (const c of all) {
      console.log(`  ${c.id.padEnd(24)} expectSessions=${c.expectSessions === null ? 'null(拒答场景)' : c.expectSessions.join('/')}  规则 ${c.ruleAssertions.length} 条  ${c.question}`);
    }
    return;
  }

  // 子集选择:--only 优先于 --filter
  let selected = all;
  if (raw.only) {
    const known = new Set(all.map(c => c.id));
    const unknown = raw.only.filter(id => !known.has(id));
    if (unknown.length > 0) throw new Error(`--only 里的未知 case id:${unknown.join(', ')}(可用 id:${[...known].join(', ')})`);
    selected = all.filter(c => raw.only!.includes(c.id));
  } else if (raw.filter) {
    let re: RegExp;
    try { re = new RegExp(raw.filter); } catch (e) { throw new Error(`--filter 正则编译失败:${e instanceof Error ? e.message : e}`); }
    selected = all.filter(c => re.test(c.id));
    if (selected.length === 0) throw new Error(`--filter "${raw.filter}" 一条也没匹配到(共 ${all.length} 条)`);
  }
  const partial = selected.length < all.length;

  const adapterPath = resolve(cfg.adapter);
  if (!existsSync(adapterPath)) {
    throw new Error(`适配器不存在:${adapterPath}(docs/adapters.md 有协议说明与模板)`);
  }

  const outDir = resolve(cfg.out);
  const cacheFile = join(outDir, 'answer-cache.json');
  const historyFile = join(outDir, 'history.jsonl');
  const useCache = raw.bool.has('reuse');
  const fileCache = useCache ? createFileAnswerCache(cacheFile) : null;

  // --dry-run:把"会怎么跑"说清楚,不花一分钱、不写任何文件
  if (raw.bool.has('dry-run')) {
    const cacheHits = fileCache ? selected.filter(c => fileCache.get(cacheKey(c.id, c.question, ['node', adapterPath]), c.question) !== null).length : 0;
    console.log('[dry-run] 执行计划(不实际运行):');
    console.log(`  用例:${selected.length}/${all.length} 条${partial ? '(部分运行)' : ''}`);
    console.log(`  适配器:${adapterPath}(超时 ${cfg.adapterTimeoutMs}ms,并发 ${cfg.concurrency})`);
    console.log(`  judge:${cfg.judge} · ${cfg.judgeModel} × ${cfg.judgeSamples} 采样`);
    console.log(`  门禁:规则通过率 ≥ ${cfg.thresholds.rulePassRate} 且 judge 均分 ≥ ${cfg.thresholds.judgeAvg}`);
    console.log(`  产物目录:${outDir}`);
    console.log(`  --reuse:${useCache ? `开(缓存 ${fileCache!.size()} 条,本次预计命中 ${cacheHits}/${selected.length})` : '关'}`);
    return;
  }

  const judge = createJudge(cfg.judge, cfg.judgeModel);
  const adapterCmd = ['node', adapterPath];
  console.error(`[eval] ${selected.length}/${all.length} 条用例 · judge=${cfg.judge}(${cfg.judgeModel},x${cfg.judgeSamples}) · 阈值 ${cfg.thresholds.rulePassRate}/${cfg.thresholds.judgeAvg}${useCache ? ' · --reuse' : ''}`);

  const run = await runPipeline({
    cases: selected,
    adapterCmd,
    judge,
    concurrency: cfg.concurrency,
    adapterTimeoutMs: cfg.adapterTimeoutMs,
    judgeSamples: cfg.judgeSamples,
    thresholds: cfg.thresholds,
    priceYuanPerKTokens: cfg.priceYuanPerKTokens,
    answerCache: fileCache ?? undefined,
    onProgress: r => {
      const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '!';
      const judgeStr = r.judge ? ` judge=${r.judge.score}` : '';
      const reusedStr = r.reused ? ' ♻' : '';
      console.error(`  ${mark} ${r.id}(${r.status}${judgeStr}${reusedStr})`);
    },
  });
  run.meta.casesDir = resolve(cfg.cases);
  run.meta.partial = partial;

  // 历史先落盘(本次也算一行),再找上一次完整运行做对比
  appendHistory(historyFile, entryFromRun(run, !partial, cfg.tag));
  const history = loadHistory(historyFile);
  const prev = previousCompleteRun(history, history.length - 1);
  const extras = prev && prev !== history[history.length - 1]
    ? { diff: { prevTs: prev.ts, diff: diffRuns(prev, history[history.length - 1]) } }
    : {};

  mkdirSync(outDir, { recursive: true });
  const md = renderReport(run, cfg.tag, { ...extras, history });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  writeFileSync(resolve(outDir, `report-${stamp}.md`), md, 'utf-8');
  writeFileSync(resolve(outDir, 'latest.md'), md, 'utf-8');
  writeFileSync(resolve(outDir, 'latest.json'), JSON.stringify(run, null, 2), 'utf-8');
  writeFileSync(resolve(outDir, 'latest.html'), renderHtmlReport(run, history), 'utf-8');
  writeFileSync(resolve(outDir, 'junit.xml'), renderJunit(run, cfg.tag), 'utf-8');
  fileCache?.save();

  const s = run.summary;
  console.log(`\n通过 ${s.pass}/${s.total}(规则通过率 ${(s.rulePassRate * 100).toFixed(1)}%)` +
    (s.judgeAvg !== null ? `,judge 均分 ${s.judgeAvg.toFixed(2)}/5` : '') +
    (run.meta.reusedCount > 0 ? `,♻ 复用 ${run.meta.reusedCount} 条` : '') +
    `,估算成本 ${s.cost.totalEstCostYuan.toFixed(4)} 元`);
  console.log(`报告:${resolve(outDir, 'latest.md')}`);
  console.log(`交互报告:${resolve(outDir, 'latest.html')} · JUnit:${resolve(outDir, 'junit.xml')}`);
  if (extras.diff) {
    const d = extras.diff.diff;
    console.log(`对比上次(${extras.diff.prevTs.slice(0, 19)}):回归 ${d.regressions.length} · 修复 ${d.fixes.length} · 分数变化 ${d.scoreChanges.length}(重叠 ${d.overlap})`);
  }
  if (!run.gate.passed && !raw.bool.has('no-gate')) {
    console.error(`门禁未过:${run.gate.reasons.join(';')}(--no-gate 可只看报告不拦截)`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('[eval] 管线异常:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
