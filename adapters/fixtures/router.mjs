#!/usr/bin/env node
// fixture 适配器:按问题前缀路由到不同行为,供 E2E 测管线各种分支(桩,永不花钱)
//   ok:*      正常好答案(引用 Session 12/19,依据行齐全)
//   wrong:*   引用了期望范围外的 Session 7 → 引用一致性失败(judge 不该被调用)
//   fab:*     引用合法但正文编造 Session 99 → 规则过、stub judge 打 1 分
//   refuse:*  语料外拒答(裸文本协议,非 JSON)→ 顺带测裸文本兜底
//   slow:*    800ms 后才出答案(测并发)
//   hang:*    5000ms 才出答案(配合小的 adapterTimeoutMs 测超时强杀)
//   flaky:*   第一次崩溃、第二次成功(测重试;状态标记在 os.tmpdir)
//   crash:*   永远崩溃(测重试耗尽)
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GOOD = {
  answer: 'Helm 和 Kustomize 是你在 Session 12(2026-08-20)的 K8s 进阶课学的,当时还练了 Chart 安装与回滚。\n依据:材料1、材料2',
  hits: [
    { material: 1, score: 0.91, session: 12, cite: 'Session 12(2026-08-20) K8s 进阶 · Helm 与 Kustomize' },
    { material: 2, score: 0.85, session: 19, cite: 'Session 19(2026-09-01) 可观测性 · Datadog' },
  ],
};

function emit(obj) { process.stdout.write(JSON.stringify(obj)); }

let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  const q = buf.trim();
  const kind = q.split(':')[0];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  (async () => {
    switch (kind) {
      case 'ok': emit(GOOD); break;
      case 'wrong':
        emit({ ...GOOD, hits: GOOD.hits.map(h => h.material === 1 ? { ...h, session: 7, cite: 'Session 7(2026-08-05) 前端课 · Hooks' } : h) });
        break;
      case 'fab':
        emit({ ...GOOD, answer: GOOD.answer + ' 另外你在 Session 99 还深入对比过两者的差异。' });
        break;
      case 'refuse':
        process.stdout.write('日志里没有足够信息回答这个问题。'); // 裸文本,非 JSON
        break;
      case 'slow': await sleep(Number(process.env.LLME_SLOW_MS ?? '800')); emit(GOOD); break;
      case 'hang': await sleep(5000); emit(GOOD); break;
      case 'flaky': {
        const flag = join(tmpdir(), 'llme-e2e-flaky.flag');
        if (existsSync(flag)) { rmSync(flag); emit(GOOD); }
        else { writeFileSync(flag, '1'); process.stderr.write('flaky: 第一遍故意失败'); process.exit(1); }
        break;
      }
      case 'crash': process.stderr.write('crash: 故意崩'); process.exit(3); break;
      default: process.stderr.write(`router: 未知问题前缀(${q.slice(0, 20)})`); process.exit(2);
    }
  })().catch(e => { process.stderr.write(String(e)); process.exit(1); });
});
