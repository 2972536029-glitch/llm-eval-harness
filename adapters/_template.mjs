#!/usr/bin/env node
// 最小适配器模板:stdin 进问题 → stdout 出 JSON。复制本文件、改 TODO 部分,即可接入你自己的系统。
// 协议详见 docs/adapters.md;hits 可为空数组(引用一致性检查会自动跳过)。
let q = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', d => { q += d; });
process.stdin.on('end', async () => {
  const question = q.trim();
  if (!question) { process.stderr.write('没收到问题'); process.exit(1); }

  // TODO: 调你的系统拿回答。这里是演示用的回显实现。
  const answer = `你说的是:"${question}"。替换 adapters/_template.mjs 里的 TODO 接入真实系统。`;

  // 可选:检索命中信息(有就给,引用一致性检查会用;没有给空数组)
  const hits = [
    // { material: 1, score: 0.91, session: 12, cite: 'Session 12(2026-08-20) K8s 进阶 · Helm' },
  ];

  process.stdout.write(JSON.stringify({ answer, hits }));
});
