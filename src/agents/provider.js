// ============================================================
// OrbitIQ Multi-Model AI Provider Layer
//
// Supports:
//   1. Grok (xAI) via GROK_API_KEY / XAI_API_KEY
//   2. OpenAI-compatible via OPENAI_API_KEY / AI_INTEGRATIONS_OPENAI_API_KEY
//   3. Google Gemini via GEMINI_API_KEY
//   4. Deterministic Aerospace Heuristic Fallback (100% offline, $0, always available)
// ============================================================

export function detectProvider() {
  const xaiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  if (xaiKey) {
    return {
      type: "grok",
      name: "xAI Grok",
      model: process.env.GROK_MODEL || "grok-2",
      baseUrl: "https://api.x.ai/v1",
      apiKey: xaiKey
    };
  }

  const oaiKey = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (oaiKey) {
    const rawUrl = process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1";
    const baseUrl = rawUrl.replace(/\/+$/, "");
    return {
      type: "openai",
      name: "OpenAI-Compatible",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      baseUrl,
      apiKey: oaiKey
    };
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    return {
      type: "gemini",
      name: "Google Gemini",
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      apiKey: geminiKey
    };
  }

  return {
    type: "deterministic",
    name: "Aerospace Heuristic Engine (Offline / Free)",
    model: "orbitiq-sgp4-heuristics-v1"
  };
}

export function providerStatus() {
  const p = detectProvider();
  return {
    provider: p.type,
    name: p.name,
    model: p.model,
    isExternalLLM: p.type !== "deterministic",
    offlineFallbackActive: p.type === "deterministic",
    configuredProviders: {
      grok: !!(process.env.GROK_API_KEY || process.env.XAI_API_KEY),
      openai: !!(process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY),
      gemini: !!process.env.GEMINI_API_KEY
    }
  };
}

/**
 * Execute an LLM query across configured providers with guaranteed graceful fallback.
 */
export async function callAgent({ systemPrompt, userPrompt, temperature = 0.2, maxTokens = 1200, fallbackFn }) {
  const p = detectProvider();

  if (p.type === "deterministic") {
    return typeof fallbackFn === "function" ? fallbackFn() : { output: "Heuristic evaluation complete." };
  }

  const timeoutMs = 8000;

  try {
    if (p.type === "grok" || p.type === "openai") {
      const url = `${p.baseUrl}/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${p.apiKey}`
        },
        body: JSON.stringify({
          model: p.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature,
          max_tokens: maxTokens
        })
      });

      if (!res.ok) {
        throw new Error(`LLM upstream returned HTTP ${res.status}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("Empty completion from LLM upstream");

      return {
        provider: p.type,
        model: p.model,
        output: content.trim(),
        generatedAt: new Date().toISOString()
      };
    }

    if (p.type === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent?key=${p.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${systemPrompt}\n\nTask:\n${userPrompt}` }]
            }
          ],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
          }
        })
      });

      if (!res.ok) throw new Error(`Gemini upstream returned HTTP ${res.status}`);
      const data = await res.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error("Empty response from Gemini API");

      return {
        provider: p.type,
        model: p.model,
        output: content.trim(),
        generatedAt: new Date().toISOString()
      };
    }
  } catch (err) {
    // Upstream failed, rate-limited, or timed out.
    // Seamlessly invoke the deterministic aerospace fallback so operations never stop.
    if (typeof fallbackFn === "function") {
      const fallbackResult = fallbackFn();
      return {
        ...fallbackResult,
        provider: "deterministic-fallback",
        model: "orbitiq-sgp4-heuristics-v1",
        fallbackReason: err.message,
        generatedAt: new Date().toISOString()
      };
    }
    throw err;
  }

  return typeof fallbackFn === "function" ? fallbackFn() : { output: "Evaluation complete." };
}
