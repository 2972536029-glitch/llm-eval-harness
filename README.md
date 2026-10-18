# llm-eval-harness · 通用 LLM 输出评测管线

用例集 → 批量调用被测系统 → **规则断言(免费先跑)+ LLM-as-judge(收费后跑)** → markdown 报告 + CI 友好退出码。

第一个被测对象是 [learning-log-qa](https://github.com/2972536029-glitch/learning-log-qa)(私有仓)的生成端:它的检索质量已有评测(10 题 Top-1 10/10),本项目补上**答案忠实度、拒答纪律、引用一致性**的数字——回答"LLM 输出不确定,你怎么保障质量?"的实物答案。

## 快速开始

```bash
npm install
cp .env.example .env        # 填 GLM_API_KEY(智谱),被测系统位置默认 D:\learning-log-qa
npm run eval                # 真跑 12 条用例(10 题 + 2 拒答),约 1 分钱
npm run stability           # judge 幂等性:同回答重评两次,输出漂移对比
npm run e2e                 # 62 条断言,E2E 永远用桩、零外部依赖、零成本
npm run typecheck           # tsc --noEmit
```

换被测系统:写一个新适配器脚本(**stdin 进问题 → stdout 出 JSON `{answer, hits[]}`,裸文本也认**),`npm run eval -- --adapter path/to/adapter.mjs` 即可,管线其余部分零改动。

## 评测结论(2026-10-18 首轮真跑)

| 指标 | 数字 |
|---|---|
| 规则通过率 | 10/12 = 83.3%(阈值 ≥80%) |
| judge 均分 | 5.00 / 5(阈值 ≥4.0,10 条进 judge) |
| 拒答纪律 | 2/2 干净拒答("没有足够信息") |
| judge 幂等性 | 20 次复评 0 漂移 |
| 总成本 | ≈ 0.02 元(评测 + 幂等性检查全程) |

**评测抓到的真缺陷**:playwright / docker 两题,检索全对(Session 14/10,引用一致),但生成端退化成只吐一个日期(18~26 字符,无主题复述)——被 `mentions_topic` + `len_range` 两条免费规则抓住。这正是分层评测的价值:分环节归因(检索的病 vs 生成的病),且抓它一分钱没花。完整明细见 [docs/report-final.md](docs/report-final.md)。

## 设计决策(面试防守要点)

| 决策 | 理由 |
|---|---|
| 规则断言先跑,规则全过才进 judge | 成本分层:规则免费、确定、毫秒级;judge 收费、慢、会漂移。规则失败直接 fail 不浪费 judge 调用——首轮真跑 12 条只花了 10 次 judge 钱 |
| judge 配 5 档 rubric + 2 个校准样例 | LLM 打分最大的病是**尺度漂移**(同一答案今天 4 明天 3)。校准样例把 5 分和 1 分的样子钉死;实测 20 次复评 0 漂移。temperature=0 只能压采样随机,压不住分布偏移——锚定和调零解决的是两个不同的病 |
| judge temperature=0 | 打分要的是稳定不是创造力;采样随机是评测里纯粹的噪声 |
| 通过率 + judge 均分双阈值 → 退出码 | CI 门禁语义:评测不过就红,人不用盯报告。error(基础设施故障)不计入通过率分母——它不是质量信号,混进分母会让"管线挂了"伪装成"质量下滑" |
| 规则失败绝不重跑适配器 | 那是被测系统的真实输出,重跑换一个好答案等于帮被测对象作弊。重试只包基础设施故障(超时/崩溃/空输出) |
| 适配器走进程边界(stdin/stdout) | 被测对象零侵入(不用改 learning-log-qa 一行代码)、语言无关、E2E 可用 fixture 桩顶替。learning-log-qa 适配器直连 tsx 入口而非 `npm run`——Windows 上无 shell spawn .cmd 会 EINVAL(CVE-2024-27980),全程 exe+参数数组零转义 |
| 幂等性检查是独立命令 | "judge 结果允许抖动但 rubric 锚定后应稳定"要拿数据说话:同一份回答各重评两次,漂移超标退出码非 0 |
| 单 case 最坏延迟 = 适配器超时 × 2 | 重试一次的设计后果,明确写出来而不是藏着;E2E 有断言保证超时被强杀、不拖死整趟 |
| 零运行时依赖 | node:child_process/fetch 全够用;评测工具自身依赖越少,被供应链投毒的面越小,克隆即跑 |

## 已知局限(诚实清单)

- **judge 与被测系统同款模型**(都是 glm-4-flash):裁判和学生同级别,靠 rubric 锚定补;更严肃的做法是换更强模型当 judge,`LLME_JUDGE_MODEL` 一个环境变量就能换
- 被测系统不回吐 usage,其成本按字数估算(公式在报告脚注);judge 侧是 API 精确值
- 引用一致性的"期望"沿用检索评测的 any-of 语义,检查的是"不引用期望范围之外的材料",不校验材料内容与答案句子的对应(那是 judge 忠实度档位的活)
- 拒答规则锚定了 system prompt 的原话"没有足够信息"——这是**特性**:它验证的是提示词纪律有没有被执行;若想测更宽松的拒答语义,把规则换成 judge 复核即可

## 仓库结构

```
cases/*.json     用例集(question / expectSessions / ruleAssertions / judgeRubric)
adapters/        被测系统适配器 + fixtures(E2E 桩)
src/
  cases.ts       加载 + schema 校验(配置错误在烧钱前报清楚)
  adapter.ts     进程协议执行(超时强杀/重试分类/JSON+裸文本双协议)
  assert.ts      五条规则 + 引用一致性(纯函数)
  judge.ts       GLM judge(real)+ 确定性桩(stub)
  rubric.ts      5 档 rubric + 校准样例 + prompt 构建
  runner.ts      并发 2 / 重试 / 成本两本账 / 门禁
  report.ts      markdown 报告(结论前置、失败归因到单条断言)
  stability.ts   judge 幂等性检查
  cli.ts         入口与退出码
qa/e2e.mjs       62 断言,零外部依赖
reports/         运行产物(gitignore;验收报告特意存 docs/report-final.md)
```
