/**
 * LLM-as-judge:GLM chat completions(非流式,temperature=0)。
 * judge 的失效模式和规则断言不同——它贵、慢、会漂移;所以只在规则全过的 case 上跑(省钱原则),
 * 并且输出必须机器可校验(score 是 1-5 整数),格式坏就重试一次,还不行算 judge 故障而不是 case 失败。
 */
import { requireEnv, envOr } from './env.ts';
import { buildJudgePrompt } from './rubric.ts';
import type { AdapterOutput, CaseFile, JudgeLike, JudgeVerdict } from './types.ts';

const CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MAX_ATTEMPTS = 3;
const JUDGE_TIMEOUT_MS = 60_000;

export class JudgeError extends Error {}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function extractJson(text: string): { score: unknown; reasons: unknown } {
  try { return JSON.parse(text); } catch { /* 落到括号截取 */ }
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new JudgeError(`judge 输出里找不到 JSON:${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

function toVerdict(content: string, usage: ChatResponse['usage'], latencyMs: number, impl: string): JudgeVerdict {
  const parsed = extractJson(content);
  const score = parsed.score;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
    throw new JudgeError(`judge 分数不是 1-5 整数:${JSON.stringify(score)}`);
  }
  return {
    score,
    reasons: typeof parsed.reasons === 'string' ? parsed.reasons : '(judge 未给理由)',
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    latencyMs,
    impl,
  };
}

export function createRealJudge(model = envOr('LLME_JUDGE_MODEL', 'glm-4-flash')): JudgeLike {
  const key = requireEnv('GLM_API_KEY'); // 启动时先验证 key 存在,别等跑到一半才发现
  return {
    impl: 'real',
    model,
    callCount: 0,
    async judge(c: CaseFile, out: AdapterOutput): Promise<JudgeVerdict> {
      this.callCount++;
      const body = JSON.stringify({
        model,
        temperature: 0, // 打分要的是稳定,不是 creativity
        messages: [
          { role: 'system', content: '你是严格、克制的评测裁判,只依据给定的 rubric 和材料判断,绝不输出 JSON 之外的文字。' },
          { role: 'user', content: buildJudgePrompt(c, out) },
        ],
      });
      let lastErr: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const t0 = Date.now();
        try {
          const res = await fetch(CHAT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body,
            signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
          });
          if (!res.ok) {
            const text = (await res.text()).slice(0, 300);
            if (res.status === 429 || res.status >= 500) throw new JudgeError(`judge API ${res.status}:${text}`);
            throw new JudgeError(`judge API ${res.status}(不可重试):${text}`);
          }
          const json = (await res.json()) as ChatResponse;
          const content = json.choices?.[0]?.message?.content ?? '';
          return toVerdict(content, json.usage, Date.now() - t0, 'real');
        } catch (err) {
          lastErr = err;
          const transient = err instanceof JudgeError
            ? !err.message.includes('不可重试')
            : err instanceof TypeError || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'));
          const malformed = err instanceof SyntaxError; // extractJson 的 JSON.parse 抛的
          if ((!transient && !malformed) || attempt === MAX_ATTEMPTS - 1) break;
          const delay = 500 * 2 ** attempt + Math.random() * 400;
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastErr instanceof Error ? lastErr : new JudgeError(String(lastErr));
    },
  };
}

/**
 * 确定性桩:不花钱、不抖动,给 E2E 测管线逻辑用。
 * 打分规则刻意简单:拒答句 → 5;编造标记 → 1;否则 4。E2E 依赖这个映射做断言。
 */
export function createStubJudge(): JudgeLike {
  return {
    impl: 'stub',
    model: 'stub-judge',
    callCount: 0,
    async judge(c: CaseFile, out: AdapterOutput): Promise<JudgeVerdict> {
      this.callCount++;
      const fabricated = /Session\s*9\d|凭空捏造|编造/.test(out.answer);
      const refusal = out.answer.includes('没有足够信息');
      const score = fabricated ? 1 : refusal ? 5 : out.answer.trim().length < 10 ? 2 : 4;
      return {
        score,
        reasons: `[stub] 规则化打分:fabricated=${fabricated}, refusal=${refusal}, len=${out.answer.trim().length}`,
        promptTokens: buildJudgePrompt(c, out).length,
        completionTokens: 40,
        latencyMs: 1,
        impl: 'stub',
      };
    },
  };
}

/** impl/model 由配置层显式给;不传时沿用环境变量(向后兼容 v0.1 用法) */
export function createJudge(impl = envOr('LLME_JUDGE', 'real'), model?: string): JudgeLike {
  return impl === 'stub' ? createStubJudge() : createRealJudge(model ?? envOr('LLME_JUDGE_MODEL', 'glm-4-flash'));
}
