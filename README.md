# llm-eval-harness · 通用 LLM 输出评测管线

用例集 → 批量调用被测系统 → **规则断言(免费先跑)+ LLM-as-judge(收费后跑)** → markdown / 交互式 HTML / JUnit 报告 + CI 退出码 + 运行历史与回归对比。

第一个被测对象是 learning-log-qa(RAG 学习日志问答)的生成端:补上**答案忠实度、拒答纪律、引用一致性**的系统化数字——"LLM 输出不确定,你怎么保障质量?"的实物答案。

## 十秒体验(零 API key)

```bash
npm install
npm run demo       # stub judge + fixture 被测系统,全管线跑通并生成全部报告
```

demo 故意包含一条引用失败用例——报告里能看到失败归因长什么样。

## 快速开始(真实评测)

```bash
npm install
cp .env.example .env        # 填 GLM_API_KEY(智谱)
npm run eval                # 12 条用例真跑(约 1 分钱),门禁不过退出码非 0
npm run eval -- --reuse     # 复用上次回答只重跑规则+judge(迭代期省钱,约 0.8 分)
npm run stability           # judge 幂等性:同回答重评,输出漂移对比
npm run e2e                 # 128 条断言(全程桩、零外部依赖、零成本)
npm run typecheck           # tsc --noEmit
```

## 功能总览

| 能力 | 入口 | 说明 |
|---|---|---|
| 两级评测 | `npm run eval` | 规则断言免费先行,规则全过才进 judge——首轮 12 条只花 10 次 judge 钱 |
| 11 种规则断言 | [docs/cases.md](docs/cases.md) | contains / not_contains / contains_any / contains_all / regex / not_regex / starts_with / ends_with / equals / len_range / json_valid + 引用一致性 |
| LLM-as-judge | `src/rubric.ts` | 5 档 rubric + 校准样例锚定 + temperature=0;实测 20 次复评 0 漂移 |
| judge 多采样 | `--judge-samples N` | 中位数聚合(序数尺度不用均值;偶数取偏低=从严) |
| 答案缓存 | `--reuse` | 按 (case+问题+适配器) 哈希复用真实回答,迭代规则/judge 不重复烧被测系统的钱;默认关闭(缓存感知不到被测系统内部变化) |
| 运行历史与回归对比 | 自动(`history.jsonl`) | 每次运行记一行;报告自动对比上次完整运行:回归/修复/分数变化;趋势表看最近 10 次 |
| 三种报告 | `reports/` | `latest.md`(CI 可读)/ `latest.html`(单文件交互式,过滤搜索点展开,零外链离线可用)/ `junit.xml`(GitLab/GitHub 测试报告集成) |
| 配置 | `eval.config.json` | 阈值/并发/judge/价格一处声明;优先级 CLI > env > 文件 > 默认;未知字段拒绝(typo 保护) |
| 用例子集 | `--only id1,id2` / `--filter regex` | 定点复跑失败 case;`--list` 列用例;`--dry-run` 先看计划再花钱 |
| 门禁控制 | 退出码 / `--no-gate` | 默认门禁拦截(CI 用);本地探索加 `--no-gate` 只看报告 |
| 适配器协议 | [docs/adapters.md](docs/adapters.md) | stdin 进问题 → stdout 出 JSON;零侵入接任意系统;含模板 |

## 评测结论(2026-10-19 评测驱动修复闭环后)

| 指标 | 数字 |
|---|---|
| 规则通过率 | **12/12 = 100%**(阈值 ≥80%;v0.1 首轮为 83.3%) |
| judge 均分 | **5.00 / 5**(阈值 ≥4.0) |
| judge 幂等性 | 20 次复评 0 漂移 |
| 回归对比 | 修复 2(playwright/docker 生成退化)· 示例泄漏 1(judge 抓出后二修)· 回归 0 |

**评测驱动修复闭环(完整故事见 [docs/report-sut-fix.md](docs/report-sut-fix.md))**:v0.1 首轮抓到 playwright/docker 两题「检索全对、生成退化成只吐日期」→ 被测系统加 prompt 规则修复 → 12/12 但 judge 抓出修复引入的示例泄漏(主题词被替换,规则断言看不见)→ 示例抽象化二修 → 满分收官。SUT 侧两个 commit:learning-log-qa `0cca785` + `2282559`。历史存档:[docs/report-final.md](docs/report-final.md)(v0.1 首轮)、[docs/report-v0.2.md](docs/report-v0.2.md)(v0.2 验收)。

## 设计决策(面试防守要点)

| 决策 | 理由 |
|---|---|
| 规则断言先跑,规则全过才进 judge | 成本分层:规则免费、确定、毫秒级;judge 收费、慢、会漂移。首轮真跑 12 条只花 10 次 judge 的钱 |
| judge 配 5 档 rubric + 校准样例 | LLM 打分最大的病是**尺度漂移**。校准样例把 5 分和 1 分钉死(实测 20 次复评 0 漂移);temperature=0 只压采样随机,压不住分布偏移——两者治的是不同的病 |
| judge 多采样用中位数、偶数取偏低 | 分数是 1-5 序数尺度,均值无意义(4.5 不在档位上);中位数抗单次离群;分歧时从严 |
| 通过率 + judge 均分双阈值 → 退出码 | CI 门禁语义。error(基础设施故障)不计入分母——"管线挂了"不该伪装成"质量下滑" |
| 规则失败绝不重跑适配器 | 那是被测系统的真实输出,重跑换好答案等于帮被测对象作弊;重试只包基础设施故障 |
| --reuse 默认关闭 | 缓存感知不到被测系统内部变化(如 RAG 语料重建),正确性优先;提速是显式 opt-in,且开了才写缓存(默认运行零副作用) |
| 部分运行不作为对比基线 | --only 跑 2 条后拿它当全量基线,下次全量跑会误报"新增失败";对比只认完整运行,只比重叠 case |
| HTML 报告零外链 + 构造式 XSS 防御 | CI artifact 双击即看;数据里所有 `<` 转义为 `\u003c`(不可能提前闭合 script),渲染全走 textContent 不碰 innerHTML——安全由构造保证,不靠转义清单 |
| JUnit 里门禁是合成 testcase | CI 报告页以 case 为单位展示;门禁失败若不进 testcase,报告页显示全绿,人会误判 |
| 适配器走进程边界(stdin/stdout) | 被测对象零侵入、语言无关、E2E 可用 fixture 桩顶替。learning-log-qa 适配器直连 tsx 入口而非 `npm run`——Windows 无 shell spawn .cmd 会 EINVAL(CVE-2024-27980) |
| 配置优先级 CLI > env > 文件 > 默认,未知字段拒绝 | 文件承载项目约定,env 撑 CI 变体,旗标撑一次性覆盖;typo 字段直接报错——配置写错比没写更危险 |
| 零运行时依赖 | node:child_process/fetch/crypto 全够;依赖越少供应链面越小,克隆即跑 |

## CI 集成示例

```yaml
# GitLab CI
llm-eval:
  script: npm run eval
  artifacts:
    when: always
    paths: [reports/latest.md, reports/latest.html]
    reports:
      junit: reports/junit.xml      # CI 报告页直接显示失败 case
```

## 已知局限(诚实清单)

- **judge 与被测系统同款模型**(glm-4-flash):裁判和学生同级别,靠 rubric 锚定补;`judgeModel` 配置一项即可换强模型
- 被测系统不回吐 usage,其成本按字数估算(公式在报告脚注);judge 侧是 API 精确值
- 引用一致性检查"不引用期望范围之外的材料"(子集+非空),不校验句子级对应(那是 judge 忠实度档位的活)
- 拒答规则锚定被测系统 system prompt 原话"没有足够信息"——验证的是提示词纪律,想测宽松语义就换 judge 复核
- `--reuse` 的缓存键含问题与适配器命令,但不含被测系统内部状态;语料重建后需全量跑一次刷新

## 仓库结构

```
cases/*.json         用例集(schema 校验,11 种规则)
demo/*.json          demo 用例(零依赖体验全管线)
adapters/            被测系统适配器 + _template.mjs 模板 + fixtures/(E2E 桩)
src/
  config.ts          配置层(默认 < 文件 < env < CLI)
  cases.ts           用例加载 + schema 校验
  adapter.ts         进程协议执行(超时强杀/重试分类/JSON+裸文本双协议)
  assert.ts          11 条规则 + 引用一致性(纯函数)
  judge.ts           GLM judge(real)+ 确定性桩(stub)
  rubric.ts          5 档 rubric + 校准样例 + prompt
  runner.ts          并发/重试/缓存/多采样/成本两本账/门禁
  cache.ts           答案缓存(原子落盘)
  history.ts         运行历史 + 回归 diff
  report.ts          markdown 报告(趋势/对比/失败归因)
  html-report.ts     单文件交互式 HTML(XSS 构造式防御)
  junit.ts           JUnit XML
  stability.ts       judge 幂等性检查
  cli.ts             入口/旗标/退出码
qa/e2e.mjs           128 断言,零外部依赖
reports/             运行产物(gitignore;验收存档在 docs/)
```
