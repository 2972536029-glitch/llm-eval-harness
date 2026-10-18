/** 规则断言器:五条通用规则 + 引用一致性检查。全部纯函数,方便单测 */
import type { AdapterOutput, CaseFile, RuleAssertion, RuleResult } from './types.ts';

function result(name: string, type: RuleResult['type'], pass: boolean, detail: string): RuleResult {
  return { name, type, pass, detail };
}

/** 单条规则判定。坏配置(regex 编译失败等)按"该条不通过"处理并说明原因,不让整趟跑崩 */
export function runRule(rule: RuleAssertion, answer: string): RuleResult {
  const name = rule.name ?? rule.type;
  switch (rule.type) {
    case 'contains':
      return result(name, rule.type, answer.includes(rule.value),
        answer.includes(rule.value) ? `包含 "${rule.value}"` : `未包含 "${rule.value}"`);
    case 'not_contains':
      return result(name, rule.type, !answer.includes(rule.value),
        !answer.includes(rule.value) ? `未出现 "${rule.value}"` : `出现了禁止词 "${rule.value}"`);
    case 'regex': {
      let re: RegExp;
      try { re = new RegExp(rule.pattern, rule.flags ?? ''); }
      catch (e) { return result(name, rule.type, false, `regex 配置错误:${e instanceof Error ? e.message : e}`); }
      return result(name, rule.type, re.test(answer), re.test(answer) ? `匹配 /${rule.pattern}/` : `不匹配 /${rule.pattern}/`);
    }
    case 'len_range': {
      const len = answer.trim().length;
      const min = rule.min ?? 0;
      const max = rule.max ?? Infinity;
      const pass = len >= min && len <= max;
      return result(name, rule.type, pass, `长度 ${len}(要求 ${min === 0 ? '' : min}..${max === Infinity ? '∞' : max})`);
    }
    case 'json_valid': {
      const text = stripJsonFence(answer);
      try { void JSON.parse(text); return result(name, rule.type, true, '可解析为 JSON'); }
      catch (e) { return result(name, rule.type, false, `不是合法 JSON:${e instanceof Error ? e.message : e}(已尝试剥离代码围栏)`); }
    }
  }
}

/** 回答若被 ```json 围栏包裹则剥掉再解析(json_valid 的常见形态) */
export function stripJsonFence(text: string): string {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return m ? m[1] : text.trim();
}

/** "依据:材料1、材料3" → [1, 3]。取最后一个匹配行,材料号按出现顺序去重 */
export function parseCitedMaterials(answer: string): number[] {
  const lines = answer.split(/\r?\n/).filter(l => /依据[:：]/.test(l));
  if (lines.length === 0) return [];
  const refs: number[] = [];
  for (const m of lines[lines.length - 1].matchAll(/材料\s*(\d+)/g)) {
    const n = Number(m[1]);
    if (!refs.includes(n)) refs.push(n);
  }
  return refs;
}

/**
 * 引用一致性:回答声称的 材料N 必须真实存在于检索命中,且其 Session 落在 expectSessions 内。
 * - 无"依据"行、材料号越界(幽灵引用)、Session 超出期望 → fail;
 * - expectSessions 为 null(语料外拒答场景)→ 不适用,返回 null;
 * 语义是"不许引用期望范围之外的材料"而非"集合相等":期望数组本身是 any-of 语义(eval.ts 同款)。
 */
export function checkCitations(c: CaseFile, out: AdapterOutput): RuleResult | null {
  if (c.expectSessions === null) return null;
  const cited = parseCitedMaterials(out.answer);
  if (cited.length === 0) {
    return result('citation_consistency', 'citation_consistency', false,
      `回答没有"依据:材料N"行(期望 Session:${c.expectSessions.join('/')})`);
  }
  const sessionOf = new Map<number, number | null>();
  for (const h of out.hits) sessionOf.set(h.material, h.session);
  const citedSessions: number[] = [];
  const problems: string[] = [];
  for (const m of cited) {
    if (!sessionOf.has(m)) { problems.push(`材料${m} 不在检索命中里(幽灵引用)`); continue; }
    const s = sessionOf.get(m) ?? null;
    if (s === null) { problems.push(`材料${m} 的 Session 号解析不出`); continue; }
    citedSessions.push(s);
    if (!c.expectSessions.includes(s)) problems.push(`材料${m} → Session ${s} 超出期望 {${c.expectSessions.join(',')}}`);
  }
  if (citedSessions.length === 0 && problems.length === 0) {
    problems.push('引用的材料都解析不出 Session 号');
  }
  const pass = problems.length === 0;
  return result('citation_consistency', 'citation_consistency', pass,
    pass
      ? `引用 ${cited.map(m => `材料${m}`).join('、')} → Session {${citedSessions.join(',')}} ⊆ 期望 {${c.expectSessions.join(',')}}`
      : problems.join(';'));
}

export function runRules(rules: RuleAssertion[], answer: string): RuleResult[] {
  return rules.map(r => runRule(r, answer));
}
