# 适配器协议规范

适配器是 harness 与被测系统之间的全部耦合:一个可执行脚本,**stdin 读问题 → stdout 写结果**。进程边界换来三个性质:被测系统零侵入、语言无关、E2E 可用 fixture 桩顶替。

## 协议

```
问题(UTF-8 文本)──stdin──▶ 适配器脚本 ──stdout──▶ 结果
```

stdout 支持两种形式:

**JSON(推荐,可携带检索命中):**

```json
{
  "answer": "回答正文……\n依据:材料1、材料2",
  "hits": [
    { "material": 1, "score": 0.9178, "session": 12, "cite": "Session 12(2026-08-20) K8s 进阶 · Helm" }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `answer` | string | 必填;为空按可重试错误处理 |
| `hits[].material` | number | 材料号(从 1 起);缺省按数组序补 |
| `hits[].score` | number? | 检索得分(展示用);可为 null |
| `hits[].session` | number? | 命中块归属的 Session 号;**引用一致性检查靠它**,解析不出会判负 |
| `hits[].cite` | string | 引用行原文(报告展示) |

**裸文本(兜底):** stdout 不是 JSON 时,整体当作 `answer`,`hits` 为空——最简接入只要 `process.stdout.write(answer)`,但引用一致性检查不可用(会因「缺依据行」判负,除非用例是 `expectSessions: null`)。

**退出码:** 0 = 成功;非 0 = 适配器失败(harness 会带着 stderr 重试一次)。**stderr 只用于诊断输出,不参与解析。**

## 最小模板

复制 `adapters/_template.mjs` 改 TODO 部分:

```js
let q = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', d => { q += d; });
process.stdin.on('end', async () => {
  const question = q.trim();
  if (!question) { process.exit(1); }
  const answer = await yourSystem.ask(question);        // TODO: 接你的系统
  const hits = [];                                       // 可选:见上表
  process.stdout.write(JSON.stringify({ answer, hits }));
});
```

## 参考实现:learning-log-qa

`adapters/learning-log-qa.mjs` 直连被测仓库的 `src/ask.ts`(tsx 入口)而非 `npm run ask`:

- **为什么不 spawn npm**:Windows 上 Node ≥ 20.12 出于 CVE-2024-27980 禁止无 shell 直接 spawn `.cmd`(npm 是 npm.cmd);加 shell 又引入命令行转义问题。`node + tsx/cli.mjs` 全程是 exe + 参数数组,零 shell、零转义。
- 用 `createRequire(被测仓库 package.json).resolve('tsx/cli')` 借用被测仓库自己的依赖,不在本仓库重复装。
- 解析 ask 的输出:答案正文 + 「── 检索命中 ──」段每行 `材料N  分数  Session N(日期)…`,`session` 从中正则提取。

超时:适配器整体超时由 harness 控制(`adapterTimeoutMs`,默认 150s,配置可改);适配器内部也应有自己的上游超时(learning-log-qa 的 ask 是 120s)。

## 常见坑

- **stdout 别混入日志**:诊断信息一律走 stderr,stdout 只写最终 JSON/文本;
- **问题从 stdin 读**,不是 argv——长问题与特殊字符经 argv 传会有长度限制与转义问题;
- 适配器找不到依赖时给出可行动的报错(如 "先在被测仓库 npm install"),harness 会原样透传到 error 归因。
