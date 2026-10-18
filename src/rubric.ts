/**
 * 默认评分 rubric(5 档)+ judge prompt 构建。
 * 分档锚点 + 校准样例的作用:LLM 打分最大的病是"尺度漂移"——同一个答案今天 4 明天 3。
 * 校准样例把 5 分和 1 分的样子钉死,temperature=0 只能压采样随机,压不住分布偏移。
 */
import type { AdapterOutput, CaseFile } from './types.ts';

export const DEFAULT_RUBRIC = `【评分 rubric(1-5 档,只输出整数)】
5 = 仅依据材料回答;Session 编号/日期等引用与材料一致且准确;无编造、无废话、无明显遗漏;
4 = 基本忠实于材料,引用基本准确,但有明显冗余或小幅含糊;
3 = 部分依据材料,混入了材料之外的推断或记忆性内容,但不构成事实编造;
2 = 大量内容无材料依据,或答非所问,仅少量相关;
1 = 编造事实(虚构 Session 编号/日期/结论,或对材料未覆盖的问题给出编造答案)。
【语料外场景】若问题是参考材料覆盖不了的,干净拒答(明确说材料里没有足够信息、不猜测)= 5 分;拒答但啰嗦纠缠 = 4 分;硬答且编造 = 1 分。`;

const CALIBRATION_EXAMPLES = `【校准样例(锚定打分尺度)】
样例A(问题:"Helm 和 Kustomize 我哪次课学的?" 材料1=Session 12(2026-08-20)…)
回答:"Helm 和 Kustomize 是你在 Session 12(2026-08-20)的 K8s 进阶课学的,当时 Helm 部分练了 Chart 安装和回滚。依据:材料1"
→ 5 分:日期/Session 与材料一致,无编造,无废话。
样例B(同一问题)
回答:"你在 Session 25(2025-03-01)学的 Helm,当时你还在学习 Rust 所有权。依据:材料1"
→ 1 分:Session 25 和日期都是编造,材料1 里根本没有;"Rust 所有权"是凭空捏造。`;

export function buildJudgePrompt(c: CaseFile, out: AdapterOutput): string {
  const materials = out.hits.length > 0
    ? out.hits.map(h => `材料${h.material}(Session ${h.session ?? '?'}):${h.cite}`).join('\n')
    : '(适配器未提供检索命中信息)';
  return [
    '你是严格的 LLM 输出评测裁判。根据 rubric 给下面的回答打 1-5 分,并给出简短理由。',
    DEFAULT_RUBRIC,
    CALIBRATION_EXAMPLES,
    ...(c.judgeRubric ? [`【本场景附加评分指引】${c.judgeRubric}`] : []),
    '【评审记录】',
    `问题:${c.question}`,
    `检索命中(评测时系统实际检索到的材料,注意:这些不是答案的权威,回答超出它们的内容才算编造):\n${materials}`,
    `待评回答:\n"""\n${out.answer}\n"""`,
    '只输出 JSON,不要输出任何其他文字:{"score": <1-5 整数>, "reasons": "<50字内的理由,指出关键证据>"}',
  ].join('\n\n');
}
