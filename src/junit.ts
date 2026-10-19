/**
 * JUnit XML 输出:CI 世界的事实标准(GitLab/GitHub 的测试报告页都吃这个格式)。
 * 映射:case → testcase;规则失败 → <failure>;适配器故障 → <error>;
 * 门禁不达标时追加一个合成 testcase "gate"——门禁失败是最重要的一条"失败",
 * 不进 testcase 的话 CI 报告页会显示全绿,人会误判。
 */
import type { RunResult } from './types.ts';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function renderJunit(run: RunResult, tag = ''): string {
  const { results, summary, gate } = run;
  const failCount = results.filter(r => r.status === 'fail').length;
  const errorCount = results.filter(r => r.status === 'error').length;
  const gateFailed = gate.passed ? 0 : 1;

  const testcases: string[] = results.map(r => {
    const attrs = `name="${esc(r.id)}" classname="llm-eval" time="${(r.adapterLatencyMs / 1000).toFixed(2)}"`;
    if (r.status === 'fail') {
      const failed = r.rules.filter(x => !x.pass);
      const msg = failed.map(f => f.name).join(', ');
      const body = failed.map(f => `${f.name}: ${f.detail}`).join('\n');
      return `    <testcase ${attrs}><failure message="${esc(msg)}" type="rule">${esc(body)}</failure></testcase>`;
    }
    if (r.status === 'error') {
      return `    <testcase ${attrs}><error message="${esc(r.adapterError ?? '适配器故障')}" type="adapter"/></testcase>`;
    }
    const samples = r.judge?.samples;
    const judgeStr = r.judge
      ? `judge ${r.judge.score}/5${samples && samples.length > 1 ? `(采样 ${samples.join(',')})` : ''}`
      : 'judge 跳过(规则未全过)';
    return `    <testcase ${attrs}><system-out>${esc(judgeStr)}${r.reused ? ';answer 复用自缓存' : ''}</system-out></testcase>`;
  });
  if (!gate.passed) {
    testcases.push(`    <testcase name="gate" classname="llm-eval"><failure message="${esc(gate.reasons.join('; '))}" type="gate">门禁阈值未达标</failure></testcase>`);
  }

  const total = results.length + gateFailed;
  const suiteAttrs = `tests="${total}" failures="${failCount + gateFailed}" errors="${errorCount}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="llm-eval-harness" ${suiteAttrs} time="${(run.meta.durationMs / 1000).toFixed(1)}">`,
    `  <testsuite name="${esc(tag || 'eval')}" ${suiteAttrs}>`,
    ...testcases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}
