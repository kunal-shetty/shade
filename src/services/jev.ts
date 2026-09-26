import { getTypesafeKey } from './secrets';

// ============================================================================
// JEV — TypeSafe AI "System One" decision model
//
// JEV is not an LLM: it never generates text. You send one `state` plus a set of
// typed `questions`, and it returns typed probabilistic answers in ~100ms.
//   noul   -> yes/no probability in [0,1]
//   choice -> one option from `criteria` + probabilities + confidence
//   score  -> position on a described scale + probabilities + confidence
//
// Endpoint: POST https://api.typesafe.ai/v1/systemone
// Docs:     https://typesafe.ai  (console.typesafe.ai for keys)
// ============================================================================

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: Record<string, string>;
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevRequest {
  model: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend?: Record<string, string>;
  probabilities: Record<string, number>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: 'no-key' | 'auth' | 'invalid' | 'rate-limit' | 'overloaded' | 'network' | 'unknown',
  ) {
    super(message);
    this.name = 'JevError';
  }
}

const RETRYABLE = new Set([429, 529]);

/**
 * Calls JEV's `/v1/systemone` endpoint. Retries rate-limit/overload responses
 * with exponential backoff (the documented behaviour, §"Your first call").
 */
export async function runSystemOne(
  request: Omit<JevRequest, 'model'> & { model?: string },
  options: { apiKey?: string; timeoutMs?: number; maxRetries?: number; signal?: AbortSignal } = {},
): Promise<JevResponse> {
  const apiKey = options.apiKey ?? (await getTypesafeKey());
  if (!apiKey) {
    throw new JevError('No TypeSafe API key configured', undefined, 'no-key');
  }

  const body: JevRequest = { model: request.model ?? JEV_MODEL, state: request.state, questions: request.questions };
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxRetries = options.maxRetries ?? 2;

  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort);

    try {
      const res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.ok) {
        return (await res.json()) as JevResponse;
      }

      const detail = await safeText(res);
      if (res.status === 401) throw new JevError(`TypeSafe rejected the API key: ${detail}`, 401, 'auth');
      if (res.status === 422) throw new JevError(`JEV request failed validation: ${detail}`, 422, 'invalid');
      if (RETRYABLE.has(res.status)) {
        if (attempt < maxRetries) {
          await delay(300 * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw new JevError(
          `JEV is ${res.status === 429 ? 'rate limited' : 'overloaded'}: ${detail}`,
          res.status,
          res.status === 429 ? 'rate-limit' : 'overloaded',
        );
      }
      throw new JevError(`JEV request failed (HTTP ${res.status}): ${detail}`, res.status, 'unknown');
    } catch (err) {
      if (err instanceof JevError) throw err;
      if (options.signal?.aborted) throw new JevError('Cancelled', undefined, 'network');
      throw new JevError(`Could not reach JEV: ${(err as Error).message}`, undefined, 'network');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const safeText = async (res: Response): Promise<string> => {
  try {
    const text = await res.text();
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return '';
  }
};

// ---- Small helpers mirroring the official SDK's question builders ----------

export const noul = (instructions: string, criteria?: Record<string, string>): JevNoulQuestion => ({
  type: 'noul',
  instructions,
  ...(criteria ? { criteria } : {}),
});

export const choice = (instructions: string, criteria: Record<string, string>): JevChoiceQuestion => ({
  type: 'choice',
  instructions,
  criteria,
});

export const score = (instructions: string, criteria: string[]): JevScoreQuestion => ({
  type: 'score',
  instructions,
  criteria,
});
