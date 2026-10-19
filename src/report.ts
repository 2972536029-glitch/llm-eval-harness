/** markdown 报告渲染:结论前置、失败可归因到单条 case、成本两本账分列、趋势与回归对比 */
import type { CaseResult, RunResult } from './types.ts';
import type { HistoryEntry, RunDiff } from './history.ts';

function fmtRate(n: number): string { return (n * 100).toFixed(1) + '%'; }
function fmtYuan(v: number): string { return v.toFixed(4) + ' 元'; }

export interface ReportExtras {
  diff?: { prevTs: string; diff: RunDiff };
  history?: HistoryEntry[];
}

function scoreHistogram(scores: Record<number, number>): string {
  if (Object.keys(scores).length === 0) return '(无 judge 结果)';
  return [5, 4, 3, 2, 1]
    .filter(s => scores[s] !== undefined)
    .map(s => `${s} 分:${'■'.repeat(scores[s])} ${scores[s]} 个`)
    .join('<br>');
}

function caseLine(r: CaseResult): string {
  const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '💥';
  const ruleStr = r.status === 'error'
    ? `适配器失败×${r.attempts}`
    : `规则 ${r.rules.filter(x => x.pass).length}/${r.rules.length}`;
  const samples = r.judge?.samples;
  const judgeStr = r.judge !== null
    ? `judge ${r.judge.score}/5${samples && samples.length > 1 ? `(采样 ${samples.join(',')})` : ''}`
    : r.judgeError !== null ? 'judge 故障' : r.rulesPassed ? '—' : '(规则未过,跳过 judge)';
  const q = r.question.length > 22 ? r.question.slice(0, 22) + '…' : r.question;
  const reused = r.reused ? ' ♻' : '';
  return `| ${icon} ${r.id}${reused} | ${q} | ${ruleStr} | ${judgeStr} | ${r.adapterLatencyMs}ms |`;
}

function failureDetail(r: CaseResult): string {
  const lines: string[] = [`### ${r.id}(${r.status === 'error' ? '基础设施错误' : '规则失败'})${r.reused ? ' · 复用自缓存' : ''}`, '', `**问题**:${r.question}`];
  if (r.adapterError) lines.push('', `**适配器错误(重试 ${r.attempts} 次后)**:\n\n> ${r.adapterError.replaceAll('\n', '\n> ')}`);
  const failed = r.rules.filter(x => !x.pass);
  if (failed.length > 0) {
    lines.push('', '**未通过的断言**:');
    for (const f of failed) lines.push(`- ✗ **${f.name}**:${f.detail}`);
    const passed = r.rules.filter(x => x.pass);
    if (passed.length > 0) lines.push(`- (通过的:${passed.map(p => p.name).join('、')})`);
  }
  if (r.hitSessions.length > 0) lines.push('', `**检索命中 Session**:${r.hitSessions.join(', ')};**回答引用的 Session**:${r.citedSessions.length > 0 ? r.citedSessions.join(', ') : '(无依据行)'}`);
  if (r.judge) lines.push('', `**judge ${r.judge.score}/5**:${r.judge.reasons}`);
  if (r.judgeError) lines.push('', `**judge 故障**:${r.judgeError}`);
  lines.push('', `**回答原文**:\n\n> ${r.answer.slice(0, 400).replaceAll('\n', '\n> ')}${r.answer.length > 400 ? ' …(截断,全文见 latest.json / latest.html)' : ''}`);
  return lines.join('\n');
}

function diffSection(extras: ReportExtras): string {
  if (!extras.diff) return '';
  const { prevTs, diff } = extras.diff;
  const lines = ['## 与上次完整运行对比', '',
    `基线:${prevTs.replace('T', ' ').slice(0, 19)};本次与其重叠 **${diff.overlap}** 条 case。`, ''];
  if (diff.regressions.length === 0 && diff.fixes.length === 0 && diff.scoreChanges.length === 0) {
    lines.push('全部持平:无回归、无修复、无分数变化。', '');
    return lines.join('\n');
  }
  for (const r of diff.regressions) lines.push(`- 🔻 **回归**:${r.id}(${r.was} → ${r.now})`);
  for (const f of diff.fixes) lines.push(`- 🔺 **修复**:${f.id}(${f.was} → pass)`);
  for (const s of diff.scoreChanges) lines.push(`- 〰 分数变化:${s.id} judge ${s.from} → ${s.to}`);
  lines.push('');
  return lines.join('\n');
}

function trendSection(history: HistoryEntry[]): string {
  const rows = history.slice(-10).reverse();
  if (rows.length < 2) return '';
  const lines = ['## 运行趋势(最近 ' + rows.length + ' 次)', '',
    '| 门禁 | 时间 | tag | 通过 | 通过率 | judge | 成本(元) |', '|---|---|---|---|---|---|---|'];
  for (const h of rows) {
    lines.push(`| ${h.gatePassed ? '✅' : '❌'} | ${h.ts.replace('T', ' ').slice(0, 19)} | ${h.tag || '—'} | ${h.pass}/${h.total}${h.complete ? '' : '(部分)'} | ${fmtRate(h.rulePassRate)} | ${h.judgeAvg === null ? '—' : h.judgeAvg.toFixed(2)} | ${h.costYuan.toFixed(4)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderReport(run: RunResult, tag = '', extras: ReportExtras = {}): string {
  const { meta, summary, gate, results } = run;
  const failures = results.filter(r => r.status !== 'pass');
  const title = `# LLM 输出评测报告${tag ? ` · ${tag}` : ''}`;
  const verdict = gate.passed ? '✅ **PASS**' : `❌ **FAIL**(${gate.reasons.join(';')})`;

  const head = [
    title, '',
    `| 项 | 值 |`, `|---|---|`,
    `| 时间 | ${meta.startedAt}(耗时 ${(meta.durationMs / 1000).toFixed(1)}s) |`,
    `| 用例目录 | ${meta.casesDir} |`,
    `| 适配器 | \`${meta.adapterCmd}\`(真实调用 ${meta.adapterCalls} 次) |`,
    `| judge | ${meta.judgeImpl} · ${meta.judgeModel} × ${meta.judgeSamples} 采样(调用 ${meta.judgeCalls} 次) |`,
    `| 门禁阈值 | 规则通过率 ≥ ${meta.thresholds.rulePassRate} 且 judge 均分 ≥ ${meta.thresholds.judgeAvg} |`,
    ...(meta.reusedCount > 0 ? [`| 缓存 | ♻ 复用 ${meta.reusedCount} 条回答(--reuse) |`] : []),
    '', '## 总览', '',
    `- 门禁判定:${verdict}${meta.partial ? ' ⚠ **本次为部分运行,门禁只反映子集**' : ''}`,
    `- 用例:${summary.total} 条 = 通过 ${summary.pass} + 规则失败 ${summary.fail} + 基础设施错误 ${summary.error}`,
    `- 规则通过率:**${fmtRate(summary.rulePassRate)}**(error 不计入分母)`,
    `- judge 均分:${summary.judgeAvg !== null ? `**${summary.judgeAvg.toFixed(2)} / 5**(${judged(results)} 条进 judge)` : '(无)'};分布:${scoreHistogram(summary.judgeScores)}`,
    '', diffSection(extras), trendSection(extras.history ?? []),
    '## 逐 case 明细', '',
    '| 结果 | case | 问题 | 规则 | judge | 适配耗时 |', '|---|---|---|---|---|---|',
    ...results.map(caseLine), '',
  ];

  const cost = [
    '## 成本(两本账)', '',
    '| 侧 | 计量 | 数值 | 费用 |', '|---|---|---|---|',
    `| judge | API usage 精确值 | in ${summary.cost.judgePromptTokens} + out ${summary.cost.judgeCompletionTokens} tokens | ${fmtYuan(summary.cost.judgeCostYuan)} |`,
    `| 被测系统(learning-log-qa) | 估算(ask 不回吐 usage) | ${summary.cost.sutCalls} 次调用,回答 ${summary.cost.sutAnswerChars} 字 ≈ ${summary.cost.sutEstTokens} tokens | ${fmtYuan(summary.cost.sutEstCostYuan)} |`,
    `| **合计** | — | — | **≈ ${fmtYuan(summary.cost.totalEstCostYuan)}** |`,
    '', '> 估算公式:中文按 ≈0.6 token/字折算,每次调用另计 20 token 查询开销;价目由 `priceYuanPerKTokens` 配置(glm-4-flash 档默认 0.001 元/千 tokens)。评测本身也要算钱——这是评测管线的第一性约束,规则断言免费、judge 收费,所以分层执行;迭代规则/judge 时用 `--reuse` 复用回答,只花 judge 的钱。', '',
  ];

  const failSection = failures.length > 0
    ? ['## 失败与错误明细', '', ...failures.map(failureDetail), ''].join('\n')
    : '## 失败与错误明细\n\n(无)全部用例通过。\n';

  const fullAnswers = ['## 附录:全部回答原文', '', ...results.map(r => `### ${r.id}\n\n> ${r.answer.replaceAll('\n', '\n> ') || '(空)'}`), ''].join('\n');

  return [...head, cost.join('\n'), failSection, fullAnswers].join('\n');
}

function judged(results: CaseResult[]): number { return results.filter(r => r.judge !== null).length; }
