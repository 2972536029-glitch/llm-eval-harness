#!/usr/bin/env node
// fixture:固定输出一份好答案(CLI 冒烟用,验证退出码 0 与报告落盘)
process.stdin.resume();
process.stdout.write(JSON.stringify({
  answer: '乐观锁是你在 Session 6 学的,UPDATE ... WHERE stock>=? 就是乐观锁写法。\n依据:材料1',
  hits: [{ material: 1, score: 0.93, session: 6, cite: 'Session 6(2026-09-15) data-persistence · 乐观锁' }],
}));
