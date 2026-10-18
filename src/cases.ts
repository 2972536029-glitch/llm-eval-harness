/** cases/*.json 加载与 schema 校验:配置错误在跑之前就报清楚,不带着坏数据烧钱 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseFile, RuleAssertion } from './types.ts';

const RULE_TYPES = ['contains', 'not_contains', 'regex', 'len_range', 'json_valid'] as const;

function validateAssertion(a: unknown, file: string, idx: number): RuleAssertion {
  if (typeof a !== 'object' || a === null) throw bad(file, `第 ${idx} 条断言不是对象`);
  const r = a as Record<string, unknown>;
  if (typeof r.type !== 'string' || !(RULE_TYPES as readonly string[]).includes(r.type)) {
    throw bad(file, `第 ${idx} 条断言 type 非法:${String(r.type)},合法值 ${RULE_TYPES.join('/')}`);
  }
  if (r.type === 'contains' || r.type === 'not_contains') {
    if (typeof r.value !== 'string' || r.value.length === 0) throw bad(file, `第 ${idx} 条(${r.type})缺少非空 value`);
  }
  if (r.type === 'regex') {
    if (typeof r.pattern !== 'string' || r.pattern.length === 0) throw bad(file, `第 ${idx} 条(regex)缺少 pattern`);
    try { void new RegExp(r.pattern, typeof r.flags === 'string' ? r.flags : ''); }
    catch (e) { throw bad(file, `第 ${idx} 条(regex)pattern 编译失败:${e instanceof Error ? e.message : e}`); }
  }
  if (r.type === 'len_range') {
    const { min, max } = r as { min?: unknown; max?: unknown };
    if (min === undefined && max === undefined) throw bad(file, `第 ${idx} 条(len_range)min/max 至少给一个`);
    if (min !== undefined && (typeof min !== 'number' || min < 0)) throw bad(file, `第 ${idx} 条(len_range)min 应为非负数`);
    if (max !== undefined && (typeof max !== 'number' || max <= 0)) throw bad(file, `第 ${idx} 条(len_range)max 应为正数`);
    if (typeof min === 'number' && typeof max === 'number' && min > max) throw bad(file, `第 ${idx} 条(len_range)min > max`);
  }
  return r as unknown as RuleAssertion;
}

function bad(file: string, msg: string): Error {
  return new Error(`用例文件 ${file} 不合法:${msg}`);
}

export function parseCaseFile(file: string, text: string): CaseFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw bad(file, `JSON 解析失败:${e instanceof Error ? e.message : e}`); }
  if (typeof raw !== 'object' || raw === null) throw bad(file, '顶层不是 JSON 对象');
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !c.id.trim()) throw bad(file, '缺少非空 id');
  if (typeof c.question !== 'string' || !c.question.trim()) throw bad(file, '缺少非空 question');
  if (c.expectSessions !== null && c.expectSessions !== undefined) {
    if (!Array.isArray(c.expectSessions) || c.expectSessions.length === 0 ||
        !c.expectSessions.every(n => Number.isInteger(n) && (n as number) > 0)) {
      throw bad(file, 'expectSessions 应为非空正整数数组,语料外场景请显式写 null');
    }
  }
  if (!Array.isArray(c.ruleAssertions) || c.ruleAssertions.length === 0) {
    throw bad(file, 'ruleAssertions 应为非空数组(至少一条断言,否则这条用例什么也证明不了)');
  }
  if (c.judgeRubric !== undefined && typeof c.judgeRubric !== 'string') throw bad(file, 'judgeRubric 应为字符串');
  return {
    id: c.id.trim(),
    question: c.question.trim(),
    expectSessions: (c.expectSessions as number[] | null | undefined) ?? null,
    ruleAssertions: c.ruleAssertions.map((a, i) => validateAssertion(a, file, i)),
    ...(typeof c.judgeRubric === 'string' ? { judgeRubric: c.judgeRubric } : {}),
  };
}

/** 目录下所有 *.json 按文件名排序加载;id 重复立即报错(报告会按 id 归因,不能撞) */
export function loadCases(dir: string): CaseFile[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`用例目录 ${dir} 下没有 *.json`);
  const seen = new Set<string>();
  return files.map(f => {
    const c = parseCaseFile(f, readFileSync(join(dir, f), 'utf-8'));
    if (seen.has(c.id)) throw bad(f, `id 重复:${c.id}`);
    seen.add(c.id);
    return c;
  });
}
