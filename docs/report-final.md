# LLM 输出评测报告

| 项 | 值 |
|---|---|
| 时间 | 2026-10-18T16:24:54.141Z(耗时 37.1s) |
| 用例目录 | D:\llm-eval-harness\cases |
| 适配器 | `node D:\llm-eval-harness\adapters\learning-log-qa.mjs`(调用 12 次) |
| judge | real · glm-4-flash(调用 10 次) |
| 门禁阈值 | 规则通过率 ≥ 0.8 且 judge 均分 ≥ 4 |

## 总览

- 门禁判定:✅ **PASS**
- 用例:12 条 = 通过 10 + 规则失败 2 + 基础设施错误 0
- 规则通过率:**83.3%**(error 不计入分母)
- judge 均分:**5.00 / 5**(10 条进 judge);分布:5 分:■■■■■■■■■■ 10 个

## 逐 case 明细

| 结果 | case | 问题 | 规则 | judge | 适配耗时 |
|---|---|---|---|---|---|
| ✅ optimistic-lock | 乐观锁我什么时候学的?当时怎么理解的? | 规则 5/5 | judge 5/5 | 7103ms |
| ✅ helm-kustomize | Helm 和 Kustomize 我哪次课学… | 规则 5/5 | judge 5/5 | 2951ms |
| ✅ react-hooks | React Hooks 的作业我哪次做的? | 规则 5/5 | judge 5/5 | 1959ms |
| ❌ playwright-acceptance | Playwright 像素级验收我哪次学的? | 规则 3/5 | (规则未过,跳过 judge) | 2283ms |
| ✅ rabbitmq | RabbitMQ 消息队列哪次学的? | 规则 5/5 | judge 5/5 | 3352ms |
| ✅ datadog-observability | Datadog 可观测性我接触过哪几次? | 规则 5/5 | judge 5/5 | 3079ms |
| ❌ docker | Docker 容器化我哪次学的? | 规则 3/5 | (规则未过,跳过 judge) | 4195ms |
| ✅ k8s-first-touch | Kubernetes 我第一次上手是哪次? | 规则 5/5 | judge 5/5 | 3805ms |
| ✅ css-theming | CSS 一键换肤是怎么学的? | 规则 5/5 | judge 5/5 | 14410ms |
| ✅ own-words | own words 的教训是哪次 revie… | 规则 5/5 | judge 5/5 | 2554ms |
| ✅ refusal-kaoyan | 我考研成绩如何? | 规则 2/2 | judge 5/5 | 1151ms |
| ✅ refusal-rust | 帮我讲讲 Rust 的所有权机制? | 规则 2/2 | judge 5/5 | 1385ms |

## 成本(两本账)

| 侧 | 计量 | 数值 | 费用 |
|---|---|---|---|
| judge | API usage 精确值 | in 8078 + out 318 tokens | 0.0084 元 |
| 被测系统(learning-log-qa) | 估算(ask 不回吐 usage) | 12 次调用,回答 1047 字 ≈ 1985 tokens | 0.0020 元 |
| **合计** | — | — | **≈ 0.0104 元** |

> 估算公式:中文按 ≈0.6 token/字折算,每次调用另计 20 token 查询开销;价目按 glm-4-flash 档 0.001 元/千 tokens(`LLME_PRICE_PER_K` 可覆盖,以智谱官网为准)。评测本身也要算钱——这是评测管线的第一性约束,规则断言免费、judge 收费,所以分层执行。

## 失败与错误明细

### playwright-acceptance(规则失败)

**问题**:Playwright 像素级验收我哪次学的?

**未通过的断言**:
- ✗ **mentions_topic**:未包含 "Playwright"
- ✗ **len_range**:长度 26(要求 30..1500)
- (通过的:has_citation_line、no_meta_disclaimer、citation_consistency)

**检索命中 Session**:14, 14, 14, 14;**回答引用的 Session**:1

**回答原文**:

> 2026-08-25 ~ 08-27
> 
> 依据:材料1
### docker(规则失败)

**问题**:Docker 容器化我哪次学的?

**未通过的断言**:
- ✗ **mentions_topic**:未包含 "Docker"
- ✗ **len_range**:长度 18(要求 30..1500)
- (通过的:has_citation_line、no_meta_disclaimer、citation_consistency)

**检索命中 Session**:10, 10, 10, 10;**回答引用的 Session**:1

**回答原文**:

> 2026-08-11
> 
> 依据:材料1

## 附录:全部回答原文

### optimistic-lock

> 乐观锁我是在2026年8月8日的Session 6中学习的。当时我理解乐观锁是通过在执行UPDATE操作时，只在执行瞬间持有锁，执行完立刻释放，不持有自己的同时等待别人的，因此不会形成循环等待。乐观锁通过一条特定的UPDATE语句来防止超卖，例如`UPDATE goods SET stock = stock - ? WHERE id = ? AND stock >= ?`，通过RowsAffected来判断库存是否足够（0表示库存不足）。我还了解到乐观锁在高冲突场景下失败率较高，需要应用层重试。
> 
> 依据:材料1、材料2
### helm-kustomize

> Helm 和 Kustomize 是在 2026年8月18日至19日的 Session 12 中学习的。依据:材料1、材料2、材料3、材料4。
### react-hooks

> React Hooks 的作业是在 Session 7 做的。
> 
> 依据:材料1、材料2
### playwright-acceptance

> 2026-08-25 ~ 08-27
> 
> 依据:材料1
### rabbitmq

> RabbitMQ 消息队列是在 2026 年 9 月 2 日至 9 月 7 日期间学习的。依据:材料1、材料2、材料3、材料4。
### datadog-observability

> 我接触过Datadog可观测性四次。
> 
> 依据：材料1、材料2、材料3、材料4。
### docker

> 2026-08-11
> 
> 依据:材料1
### k8s-first-touch

> Kubernetes我第一次上手是在2026年8月12日至8月13日的Session 11。
> 
> 依据:材料1
### css-theming

> CSS 一键换肤是通过以下步骤学习的：
> 
> 1. 学习了Token的两层架构，包括基础层和语义层，以及如何通过换排班表来换肤而不动花名册。
> 2. 理解了使用`data-theme`属性进行换肤的方法，包括属性选择器和CSS的自带降级链。
> 3. 学习了ThemeProvider的解剖，包括useState和useEffect的使用，以及Context的广播机制。
> 4. 掌握了工程取舍，如localStorage的使用、读写包的异常处理和持久化数据的校验。
> 5. 学习了复用与CSS Modules，包括内联样式的三宗罪和CSS Modules的作用域。
> 6. 理解了层叠三步仲裁的规则，包括匹配、比分和比先后的顺序。
> 7. 通过实践项目，如重构支付收据页并实现一键换肤，以及完成基础任务和选做任务。
> 
> 依据:材料1、材料2、材料3、材料4
### own-words

> own words 的教训是在 Session 18 补充(2026-09-14) 的 AI Coding 作业 Review 中提出的。
> 
> 依据:材料1、材料2
### refusal-kaoyan

> 日志里没有足够信息。
### refusal-rust

> 日志里没有足够信息。

## judge 稳定性(幂等性检查)

同一份回答各重跑两次 judge(共 20 次调用):10 条中 0 条出现分数漂移,
**结论:rubric 锚定后打分基本稳定(≤20% 抖动),满足幂等性预期。**

| case | 原始分 | 复跑1 | 复跑2 | 最大偏差 |
|---|---|---|---|---|
| optimistic-lock | 5 | 5 | 5 | 0 |
| helm-kustomize | 5 | 5 | 5 | 0 |
| react-hooks | 5 | 5 | 5 | 0 |
| rabbitmq | 5 | 5 | 5 | 0 |
| datadog-observability | 5 | 5 | 5 | 0 |
| k8s-first-touch | 5 | 5 | 5 | 0 |
| css-theming | 5 | 5 | 5 | 0 |
| own-words | 5 | 5 | 5 | 0 |
| refusal-kaoyan | 5 | 5 | 5 | 0 |
| refusal-rust | 5 | 5 | 5 | 0 |

---
本报告由 `npm run eval` + `npm run stability` 于 2026-10-18 生成,为验收存档副本;最新运行产物在 reports/latest.md(不入库)。
