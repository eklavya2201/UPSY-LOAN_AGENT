// Which OpenAI-compatible endpoint the non-Claude side of every chain talks to.
//
// The whole repo runs one provider pattern: Claude first when ANTHROPIC_API_KEY
// is set, an OpenAI-compatible endpoint otherwise (and as the mid-call
// fallback). Switching providers is therefore a .env edit and a restart —
// add the Anthropic key and every module prefers Claude; remove it and every
// module runs on this side; nothing in code changes either way.
//
// This module decides what "this side" is. OpenRouter and OpenAI's own API
// speak the same chat-completions dialect, so the only real differences are
// the URL, the key, and whether model names carry the "openai/" vendor prefix
// OpenRouter uses. Resolved in ONE place because ten modules make this call,
// and ten copies of a URL is how one of them ends up pointing somewhere else.
//
// Precedence: OpenRouter wins when both are set, because every model name in
// .env is written in its vendor-prefixed form and OpenRouter can also serve
// non-OpenAI models under the same key.

function usable(key) {
  // .env templates ship placeholder values ("your_openai_key_here"); treating
  // one as a real key would fail every call with a confusing 401.
  return Boolean(key && !/^your_|_here$/i.test(key));
}

/**
 * @returns {null | {
 *   name: "OpenRouter" | "OpenAI",
 *   key: string,
 *   url: string,
 *   model: (m: string) => string,
 * }} null when neither key is set — callers already treat "no OpenAI side"
 *   as "Claude only" or "not configured".
 */
export function openaiSide() {
  if (usable(process.env.OPENROUTER_API_KEY)) {
    return {
      name: "OpenRouter",
      key: process.env.OPENROUTER_API_KEY,
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: (m) => m,
    };
  }
  if (usable(process.env.OPENAI_API_KEY)) {
    return {
      name: "OpenAI",
      key: process.env.OPENAI_API_KEY,
      url: "https://api.openai.com/v1/chat/completions",
      // "openai/gpt-4o-mini" is OpenRouter's spelling; OpenAI's own API wants
      // the bare model id.
      model: (m) => String(m || "").replace(/^openai\//, ""),
    };
  }
  return null;
}
