import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { makeClassifier } from "./classifier";
import type { Config } from "./config";
import { dashboardHtml } from "./dashboard";
import { costWithPricing, estimateCost, extractUsage, logRequest } from "./logger";
import { forward, stringStream } from "./providers";
import { decideRoute } from "./router";
import { recordRequest, snapshot } from "./stats";
import {
  anthropicResponseToOpenAI,
  anthropicStreamToOpenAI,
  openaiRequestToAnthropic,
  safeParse,
} from "./translate";
import type { MessagesRequest } from "./types";

const MAX_CAPTURE_BYTES = 200_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorBody(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(", ");
  }
  return out;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

export function createRouterServer(config: Config) {
  const classify = makeClassifier(config);

  return createServer((req, res) => {
    handle(req, res, config, classify).catch((err) => {
      console.error("router error:", err);
      if (!res.headersSent) sendJson(res, 502, errorBody("router_error", String(err)));
      else res.end();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  classify: ReturnType<typeof makeClassifier>,
): Promise<void> {
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(dashboardHtml());
    return;
  }
  if (req.method === "GET" && url === "/health") {
    sendJson(res, 200, { status: "ok", providers: Object.keys(config.providers) });
    return;
  }
  if (req.method === "GET" && url === "/stats") {
    sendJson(res, 200, snapshot());
    return;
  }

  const isMessages = req.method === "POST" && url.startsWith("/v1/messages");
  const isChat = req.method === "POST" && url.startsWith("/v1/chat/completions");
  if (!isMessages && !isChat) {
    sendJson(res, 404, errorBody("not_found", `no route for ${req.method} ${url}`));
    return;
  }

  const started = Date.now();
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, errorBody("invalid_request_error", "request body is not valid JSON"));
    return;
  }

  // OpenAI clients (e.g. the Codex CLI) hit /v1/chat/completions; their request
  // is translated into the Anthropic shape the router works in.
  const body: MessagesRequest = isChat
    ? openaiRequestToAnthropic(parsed)
    : (parsed as MessagesRequest);

  const decision = await decideRoute(body, config, { classify });
  const provider = config.providers[decision.providerName];
  const upstream = await forward(provider, body, lowerHeaders(req));

  const log = {
    method: "POST",
    path: isChat ? "/v1/chat/completions" : "/v1/messages",
    tier: decision.tier,
    provider: decision.providerName,
    model: provider.model,
    reason: decision.reason,
    status: upstream.status,
  };

  // For OpenAI clients the Anthropic-format upstream is translated back to
  // OpenAI; error responses (status >= 400) pass through untranslated.
  let outBody = upstream.body;
  let outContentType = upstream.contentType;
  if (isChat && upstream.body && upstream.status < 400) {
    if (body.stream) {
      outBody = anthropicStreamToOpenAI(upstream.body, body.model);
      outContentType = "text/event-stream; charset=utf-8";
    } else {
      const anthropicText = await readStream(upstream.body);
      const translated = anthropicResponseToOpenAI(
        safeParse(anthropicText) as Record<string, unknown>,
        body.model,
      );
      outBody = stringStream(JSON.stringify(translated));
      outContentType = "application/json";
    }
  }

  res.writeHead(upstream.status, { "content-type": outContentType });

  if (!outBody) {
    res.end();
    logRequest({ ...log, latencyMs: Date.now() - started });
    recordRequest({ provider: decision.providerName });
    return;
  }

  // Stream the response -> client, tapping the bytes to extract token usage.
  let captured = "";
  const decoder = new TextDecoder();
  const reader = outBody.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
    if (captured.length < MAX_CAPTURE_BYTES) captured += decoder.decode(value, { stream: true });
  }
  res.end();

  const usage = extractUsage(captured);
  const cost = estimateCost(provider, usage.input, usage.output);
  recordRequest({
    provider: decision.providerName,
    inputTokens: usage.input,
    outputTokens: usage.output,
    costUsd: cost,
    baselineCostUsd: costWithPricing(config.baselinePricing, usage.input, usage.output),
  });
  logRequest({
    ...log,
    latencyMs: Date.now() - started,
    inputTokens: usage.input,
    outputTokens: usage.output,
    estCostUsd: cost,
  });
}
