/**
 * 幂等性检查:对最近一次真实报告里保存的回答,同 case 连跑两次 judge,对比分数。
 * 预期:temperature=0 + rubric 锚定后,分数应高度一致;偶发 ±1 抖动要被看见并披露,而不是藏起来。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCases } from './cases.ts';
import { createJudge } from './judge.ts';
import type { RunResult } from './types.ts';

async function main(): Promise<void> {
  const input = resolve(process.argv[process.argv.indexOf('--input') + 1] ?? 'reports/latest.json');
  const run = JSON.parse(readFileSync(input, 'utf-8')) as RunResult;
  if (run.meta.judgeImpl !== 'real') {
    console.error('[stability] 最近一次运行不是 real judge,对比无意义(桩是确定性的)'); process.exitCode = 1; return;
  }
  const cases = new Map(loadCases(run.meta.casesDir).map(c => [c.id, c]));
  const judge = createJudge('real');
  const rows: string[] = [];
  let drift = 0;
  for (const r of run.results) {
    const c = cases.get(r.id);
    if (!c || r.status !== 'pass' || !r.judge) continue;
    const out = { answer: r.answer, hits: r.hits };
    const s1 = (await judge.judge(c, out)).score;
    const s2 = (await judge.judge(c, out)).score;
    const delta = Math.max(Math.abs(s1 - r.judge.score), Math.abs(s2 - r.judge.score));
    if (delta > 0) drift++;
    rows.push(`| ${r.id} | ${r.judge.score} | ${s1} | ${s2} | ${delta} |`);
    console.error(`  ${r.id}: ${r.judge.score} → ${s1}, ${s2}(Δ${delta})`);
  }
  const stable = rows.length > 0 && drift / rows.length <= 0.2; // 允许 ≤20% 的 case 出现 ±1 抖动
  const md = [
    `## judge 稳定性(幂等性检查)`, '',
    `同一份回答各重跑两次 judge(共 ${judge.callCount} 次调用):${rows.length} 条中 ${drift} 条出现分数漂移,`,
    stable ? '**结论:rubric 锚定后打分基本稳定(≤20% 抖动),满足幂等性预期。**' : '**结论:抖动超出 20%,rubric 锚定不足,需加校准样例或收紧分数理由格式。**', '',
    '| case | 原始分 | 复跑1 | 复跑2 | 最大偏差 |', '|---|---|---|---|---|',
    ...rows, '',
  ].join('\n');
  mkdirSync('reports', { recursive: true });
  const path = resolve('reports', `stability-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.md`);
  writeFileSync(path, md, 'utf-8');
  console.log(md);
  console.log(`\n已写入 ${path}`);
  if (!stable) process.exitCode = 1;
}

main().catch(e => { console.error('[stability] 失败:', e instanceof Error ? e.message : e); process.exitCode = 1; });
