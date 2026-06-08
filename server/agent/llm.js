// LLM provider chain — cheapest-first with automatic fallback.
//
// Order: Gemini (free tier) → OpenAI (gpt-4o-mini) → Claude (Haiku).
// Each provider is only added if its API key is present. LangChain's
// .withFallbacks() transparently moves to the next provider when one errors
// (quota / rate-limit / auth / outage). If no keys are set at all, callers
// get null and the pipeline switches to mock mode.

let _chain = null;
let _providersLoaded = false;
let _activeProviders = [];

async function buildChain() {
  const providers = [];

  // 1. Gemini — the only one with a real free tier, so it leads.
  // Free quota is PER MODEL per day, so we chain several Gemini models: when one
  // model's daily limit is exhausted, the chain fails over to the next — still free.
  if (process.env.GOOGLE_API_KEY) {
    try {
      const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
      const geminiModels = [
        ...new Set([
          process.env.GEMINI_MODEL || 'gemini-2.5-flash',
          'gemini-2.5-flash-lite',
          'gemini-flash-latest',
          'gemini-flash-lite-latest',
        ]),
      ];
      for (const model of geminiModels) {
        providers.push({
          name: `gemini:${model}`,
          model: new ChatGoogleGenerativeAI({
            apiKey: process.env.GOOGLE_API_KEY,
            model,
            temperature: 0.4,
            maxOutputTokens: 16384, // room for long-form, multi-page reports
            thinkingConfig: { thinkingBudget: 0 }, // disable "thinking" for speed
            maxRetries: 1,
          }),
        });
      }
    } catch (err) {
      console.warn('[llm] Gemini unavailable:', err.message);
    }
  }

  // 2. OpenAI — cheap pay-as-you-go.
  if (process.env.OPENAI_API_KEY) {
    try {
      const { ChatOpenAI } = await import('@langchain/openai');
      providers.push({
        name: `openai:${process.env.OPENAI_MODEL || 'gpt-4o-mini'}`,
        model: new ChatOpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          temperature: 0.4,
          maxRetries: 1,
        }),
      });
    } catch (err) {
      console.warn('[llm] OpenAI unavailable:', err.message);
    }
  }

  // 3. Claude — strongest reasoning, last because it has no free tier.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      providers.push({
        name: `anthropic:${process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'}`,
        model: new ChatAnthropic({
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
          temperature: 0.4,
          maxRetries: 1,
        }),
      });
    } catch (err) {
      console.warn('[llm] Anthropic unavailable:', err.message);
    }
  }

  _activeProviders = providers.map((p) => p.name);
  if (providers.length === 0) return null;

  const [primary, ...rest] = providers.map((p) => p.model);
  return rest.length ? primary.withFallbacks(rest) : primary;
}

export async function getLLM() {
  if (!_providersLoaded) {
    _chain = await buildChain();
    _providersLoaded = true;
  }
  return _chain;
}

export function activeProviders() {
  return _activeProviders;
}

export function llmEnabled() {
  return _activeProviders.length > 0;
}

// Convenience: invoke the chain and return plain text.
export async function complete(messages) {
  const llm = await getLLM();
  if (!llm) throw new Error('No LLM provider configured');
  const res = await llm.invoke(messages);
  return typeof res.content === 'string'
    ? res.content
    : (res.content || []).map((c) => (typeof c === 'string' ? c : c.text || '')).join('');
}
