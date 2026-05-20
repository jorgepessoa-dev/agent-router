import type { Config } from "./config";
import { buildAuthHeaders } from "./providers";
import type { ContentBlock, Message, MessagesRequest } from "./types";
import { createPinCache, isNewUserTurn, turnKey } from "./turn";

const pinCache = createPinCache();

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function latestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      const text = extractText(message.content).trim();
      if (text) return text;
    }
  }
  return "";
}

const SYSTEM_PROMPT =
  "You are a routing classifier for a coding agent. Given the user's latest " +
  "request, decide whether it needs deep multi-step reasoning or architectural " +
  'thinking (answer "complex") or is routine execution such as edits, small ' +
  'fixes, or lookups (answer "simple"). Reply with exactly one word: ' +
  '"simple" or "complex".';

/**
 * Builds the per-turn escalation classifier. It calls the Haiku-class provider
 * once per new user turn and pins the verdict for all the turn's tool
 * round-trips, so caching is preserved and Haiku is not called per request.
 */
export function makeClassifier(config: Config) {
  return async function classify(req: MessagesRequest): Promise<"simple" | "complex"> {
    const key = turnKey(req);

    // Continuation of a turn: reuse the pinned verdict (default to cheap).
    if (!isNewUserTurn(req)) return pinCache.get(key) ?? "simple";

    const cached = pinCache.get(key);
    if (cached) return cached;

    const decision = await runClassification(config, req);
    pinCache.set(key, decision);
    return decision;
  };
}

async function runClassification(
  config: Config,
  req: MessagesRequest,
): Promise<"simple" | "complex"> {
  const provider = config.providers[config.routing.classifier.provider];
  const userText = latestUserText(req.messages ?? []).slice(0, 4000);
  if (!userText) return "simple";

  try {
    const res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...buildAuthHeaders(provider) },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 8,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!res.ok) return "simple";
    const data = (await res.json()) as { content?: ContentBlock[] };
    const text = (data.content ?? [])
      .map((block) => block.text ?? "")
      .join(" ")
      .toLowerCase();
    return text.includes("complex") ? "complex" : "simple";
  } catch {
    // Fail safe: on any classifier error, prefer the cheaper model.
    return "simple";
  }
}
