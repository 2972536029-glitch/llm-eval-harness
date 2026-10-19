# 用例编写指南

用例是 `cases/*.json`(目录可用 `--cases` 或配置文件改),按文件名排序加载,id 全局唯一。目录下没有 `*.json` 直接报错——不带用例的评测没有意义。

## 字段一览

```jsonc
{
  "id": "helm-kustomize",              // 必填,唯一,报告与 --only 都按它寻址
  "question": "Helm 和 Kustomize 我哪次课学的?",  // 必填,原样发给适配器
  "expectSessions": [12],              // 期望的 Session 号;null = 语料外拒答场景(跳过引用一致性)
  "ruleAssertions": [ /* 必填,至少 1 条 */ ],
  "judgeRubric": "附加评分指引"          // 可选,追加到默认 rubric 之后(场景化打分重点)
}
```

`expectSessions` 是 **any-of 语义**(数组里任一命中都算对,容忍同主题多 Session);引用一致性检查的是"回答声称引用的材料,其 Session 落在期望集合内"(子集+非空),不要求把期望全引一遍。

## 11 种规则断言

| type | 参数 | 判定 |
|---|---|---|
| `contains` | `value` | 回答包含子串 |
| `not_contains` | `value` | 回答不包含禁止子串 |
| `contains_any` | `values: []` | 任一子串出现即过 |
| `contains_all` | `values: []` | 全部子串都出现才过 |
| `regex` | `pattern`, `flags?` | 匹配正则 |
| `not_regex` | `pattern`, `flags?` | 不匹配正则(禁止模式) |
| `starts_with` | `value` | trim 后以指定文本开头 |
| `ends_with` | `value` | trim 后以指定文本结尾 |
| `equals` | `value` | trim 后完全相等 |
| `len_range` | `min?`, `max?` | trim 后长度在区间(至少给一个) |
| `json_valid` | — | 是合法 JSON(自动剥 \`\`\`json 围栏) |

每条规则可加 `name`(报告里显示,如 `"name": "explicit_refusal"`),不加就用 type 名。

```json
"ruleAssertions": [
  { "type": "regex", "pattern": "依据[:：]", "name": "has_citation_line" },
  { "type": "len_range", "min": 30, "max": 1500 },
  { "type": "not_contains", "value": "作为AI", "name": "no_meta_disclaimer" }
]
```

## 引用一致性(自动追加)

只要 `expectSessions` 非 null,无需声明,管线自动检查:

1. 回答末尾须有「依据:材料N」行(没有 → fail);
2. 引用的材料号必须真实存在于检索命中(越界 = 幽灵引用 → fail);
3. 材料对应的 Session 必须落在 `expectSessions` 内(超出 → fail)。

前提:适配器 stdout 的 `hits[]` 带 `session` 字段(见 [adapters.md](adapters.md));`hits` 为空时该检查会把「缺依据行」判负,语料外场景请显式写 `"expectSessions": null`。

## judge 维度

规则全过的 case 才进 judge(省钱原则)。默认 rubric 五档(1=编造 … 5=仅依据材料、引用准确、无废话)+ 两个校准样例锚定尺度;`judgeRubric` 字段追加场景化指引,例如拒答场景:

```json
"judgeRubric": "语料外拒答场景:明确说没有足够信息、不编造 = 5 分;硬答且编造 = 1 分。"
```

## 执行语义

- 规则失败 → case 记 fail,**不进 judge**;
- 适配器崩溃/超时/空输出 → 重试一次 → 仍失败记 error(基础设施错误,不计入通过率分母);
- 规则失败**绝不重跑被测系统**——重跑换好答案等于帮被测对象作弊;
- `--judge-samples N` → 同一回答评 N 次、中位数聚合(成本 ×N)。

## 编写建议

- 规则锚"便宜且确定"的信号(格式、关键词、长度、拒答话术),语义质量交给 judge;
- 断言要对着**被测系统的承诺**写(如 system prompt 里的拒答话术),不是对着某次恰好通过的输出写——那是把答案背下来;
- 用例文件名带序号(`01-xxx.json`)控制报告顺序,id 保持稳定(历史对比按 id 追踪)。
