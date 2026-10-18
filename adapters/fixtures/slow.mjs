#!/usr/bin/env node
// fixture:延迟 LLME_SLOW_MS(默认 400ms)后输出好答案,给并发度测试用
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.stdin.resume();
await sleep(Number(process.env.LLME_SLOW_MS ?? '400'));
process.stdout.write(JSON.stringify({
  answer: '这是第 4 分档的标准回答,内容完整、引用清楚。\n依据:材料1',
  hits: [{ material: 1, score: 0.9, session: 6, cite: 'Session 6(2026-09-15) data-persistence · 乐观锁' }],
}));
