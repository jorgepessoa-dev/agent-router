import type { ProviderConfig } from "./config";
import { resolveApiKey } from "./config";

export function buildAuthHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = resolveApiKey(provider);
  if (provider.auth === "bearer") {
    headers["authorization"] = `Bearer ${key}`;
  } else {
    headers["x-api-key"] = key;
  }
  headers["anthropic-version"] = provider.anthropicVersion ?? "2023-06-01";
  return headers;
}

export interface ForwardResult {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Forwards a Messages API request to the chosen provider. Rewrites the model,
 * injects the provider's auth (dropping Claude Code's), and returns the raw
 * upstream response for streaming pass-through.
 */
export async function forward(
  provider: ProviderConfig,
  requestBody: Record<string, unknown>,
  incomingHeaders: Record<string, string>,
): Promise<ForwardResult> {
  const body = { ...requestBody, model: provider.model };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...buildAuthHeaders(provider),
  };

  // anthropic-beta headers are only meaningful to Anthropic-hosted providers.
  const beta = incomingHeaders["anthropic-beta"];
  if (beta && provider.baseUrl.includes("anthropic.com")) {
    headers["anthropic-beta"] = beta;
  }

  const res = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return { status: res.status, headers: res.headers, body: res.body };
}
