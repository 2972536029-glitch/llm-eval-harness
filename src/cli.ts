/** CLI 入口:npm run eval [-- --judge stub --cases cases --adapter adapters/xxx.mjs]
 * 退出码即 CI 信号:门禁不过 = 非 0,人不用盯报告,红了再看。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCases } from './cases.ts';
import { createJudge } from './judge.ts';
import { runPipeline } from './runner.ts';
import { renderReport } from './report.ts';
import { envOr } from './env.ts';

interface Args {
  cases: string; adapter: string; judge: string; out: string; tag: string;
  concurrency: number; adapterTimeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, dflt: string): string => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  return {
    cases: get('cases', 'cases'),
    adapter: get('adapter', 'adapters/learning-log-qa.mjs'),
    judge: get('judge', envOr('LLME_JUDGE', 'real')),
    out: get('out', 'reports'),
    tag: get('tag', ''),
    concurrency: Number(get('concurrency', '2')),
    adapterTimeoutMs: Number(get('adapter-timeout', '150000')),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const casesDir = resolve(args.cases);
  const cases = loadCases(casesDir);
  const judge = createJudge(args.judge);
  const adapterCmd = ['node', resolve(args.adapter)];

  console.error(`[eval] ${cases.length} 条用例 · judge=${judge.impl} · 适配器=${adapterCmd[1]}`);
  const run = await runPipeline({
    cases, adapterCmd, judge,
    concurrency: args.concurrency,
    adapterTimeoutMs: args.adapterTimeoutMs,
    onProgress: r => {
      const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '!';
      const judgeStr = r.judge ? ` judge=${r.judge.score}` : '';
      console.error(`  ${mark} ${r.id}(${r.status}${judgeStr})`);
    },
  });
  run.meta.casesDir = casesDir;

  const md = renderReport(run, args.tag);
  mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const mdPath = resolve(args.out, `report-${stamp}.md`);
  writeFileSync(mdPath, md, 'utf-8');
  writeFileSync(resolve(args.out, 'latest.md'), md, 'utf-8');
  writeFileSync(resolve(args.out, 'latest.json'), JSON.stringify(run, null, 2), 'utf-8');

  const s = run.summary;
  console.log(`\n通过 ${s.pass}/${s.total}(规则通过率 ${(s.rulePassRate * 100).toFixed(1)}%)` +
    (s.judgeAvg !== null ? `,judge 均分 ${s.judgeAvg.toFixed(2)}/5` : '') +
    `,估算成本 ${s.cost.totalEstCostYuan.toFixed(4)} 元`);
  console.log(`报告:${mdPath}`);
  if (!run.gate.passed) {
    console.error(`门禁未过:${run.gate.reasons.join(';')}`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('[eval] 管线异常:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
