import type { ProviderConfig } from "./config";
import { resolveApiKey } from "./config";
import {
  anthropicToOpenAI,
  estimateTokens,
  openaiResponseToAnthropic,
  openaiStreamToAnthropic,
} from "./translate";
import type { MessagesRequest } from "./types";

export interface ForwardResult {
  status: number;
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
}

/** Auth header for the provider's scheme (empty for keyless providers). */
export function authHeaders(provider: ProviderConfig): Record<string, string> {
  if (provider.auth === "none") return {};
  const key = resolveApiKey(provider);
  return provider.auth === "bearer"
    ? { authorization: `Bearer ${key}` }
    : { "x-api-key": key };
}

function stringStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/**
 * Forwards a Messages API request to the chosen provider and always returns an
 * Anthropic-format response: anthropic providers are passed through untouched,
 * openai providers are translated in both directions.
 */
export async function forward(
  provider: ProviderConfig,
  req: MessagesRequest,
  incomingHeaders: Record<string, string>,
): Promise<ForwardResult> {
  return provider.format === "openai"
    ? forwardOpenAI(provider, req)
    : forwardAnthropic(provider, req, incomingHeaders);
}

async function forwardAnthropic(
  provider: ProviderConfig,
  req: MessagesRequest,
  incomingHeaders: Record<string, string>,
): Promise<ForwardResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": provider.anthropicVersion ?? "2023-06-01",
    ...authHeaders(provider),
  };
  const beta = incomingHeaders["anthropic-beta"];
  if (beta && provider.baseUrl.includes("anthropic.com")) headers["anthropic-beta"] = beta;

  const res = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...req, model: provider.model }),
  });

  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "application/json",
    body: res.body,
  };
}

async function forwardOpenAI(
  provider: ProviderConfig,
  req: MessagesRequest,
): Promise<ForwardResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(provider),
  };

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(anthropicToOpenAI(req, provider.model)),
  });

  if (!res.ok) {
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/json",
      body: stringStream(await res.text()),
    };
  }

  if (req.stream === true && res.body) {
    return {
      status: res.status,
      contentType: "text/event-stream",
      body: openaiStreamToAnthropic(res.body, provider.model, estimateTokens(req)),
    };
  }

  const json = (await res.json()) as Parameters<typeof openaiResponseToAnthropic>[0];
  return {
    status: res.status,
    contentType: "application/json",
    body: stringStream(JSON.stringify(openaiResponseToAnthropic(json, provider.model))),
  };
}
