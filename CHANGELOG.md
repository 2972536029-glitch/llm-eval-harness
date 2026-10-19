# Changelog

## 0.2.0(2026-10-19)

产品化:从"能用的评测脚本"到"完善的评测工具"。

**新增**
- 配置文件 `eval.config.json`:阈值/并发/judge/价格一处声明;优先级 CLI 旗标 > 环境变量 > 文件 > 默认;未知字段拒绝(typo 保护);阈值支持部分覆盖
- 6 条新规则断言:`contains_any` / `contains_all` / `not_regex` / `starts_with` / `ends_with` / `equals`(共 11 种)
- 答案缓存与增量运行 `--reuse`:按 (case id + 问题 + 适配器命令) 哈希复用真实回答,迭代规则/judge 只花 judge 的钱;默认关闭、开了才写(默认运行零副作用);原子落盘
- 运行历史 `history.jsonl` + 趋势表(最近 10 次)+ 自动回归对比(与上次完整运行比:回归/修复/分数变化;部分运行不作基线)
- 单文件交互式 HTML 报告:内联数据、零外链(CI artifact 离线可看),过滤/搜索/点击展开;XSS 构造式防御(数据段 `<` 全转义 + 渲染只走 textContent)
- JUnit XML 输出:CI 测试报告集成;门禁不达标作为合成 testcase `gate` 呈现
- judge 多采样 `--judge-samples N`:中位数聚合(序数尺度不用均值,偶数取偏低=从严)
- CLI:`--only` / `--filter` / `--list` / `--dry-run` / `--no-gate` / `--config` / `--help`
- demo 模式 `npm run demo`:零 API key 十秒体验全管线(含故意的失败用例,--no-gate 演示)
- 适配器模板 `adapters/_template.mjs` 与协议文档、用例编写指南

**修复**
- v0.1 遗留:无

**内部**
- E2E 62 → 128 断言(新增:6 规则正反例、配置优先级、缓存读写与 runner 集成、中位数聚合、历史/diff、CLI 全旗标、JUnit 结构、HTML 注入防御、demo)
- README 重写为产品文档;新增 docs/cases.md、docs/adapters.md

## 0.1.0(2026-10-18)

初版:规则断言(contains/not_contains/regex/len_range/json_valid)+ 引用一致性 + LLM-as-judge(rubric 校准样例、temperature=0)+ markdown 报告 + CI 退出码;learning-log-qa 适配器;E2E 62 断言全程用桩。
