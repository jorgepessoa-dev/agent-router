import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { makeClassifier } from "./classifier";
import type { Config } from "./config";
import { estimateCost, extractUsage, logRequest } from "./logger";
import { forward } from "./providers";
import { decideRoute } from "./router";
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

export function createRouterServer(config: Config) {
  const classify = makeClassifier(config);

  return createServer((req, res) => {
    handle(req, res, config, classify).catch((err) => {
      console.error("router error:", err);
      if (!res.headersSent)
        sendJson(res, 502, errorBody("router_error", String(err)));
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
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/health" || url === "/")) {
    sendJson(res, 200, { status: "ok", providers: Object.keys(config.providers) });
    return;
  }

  if (req.method !== "POST" || !url.startsWith("/v1/messages")) {
    sendJson(res, 404, errorBody("not_found", `no route for ${req.method} ${url}`));
    return;
  }

  const started = Date.now();
  const raw = await readBody(req);
  let body: MessagesRequest;
  try {
    body = JSON.parse(raw) as MessagesRequest;
  } catch {
    sendJson(res, 400, errorBody("invalid_request_error", "request body is not valid JSON"));
    return;
  }

  const decision = await decideRoute(body, config, { classify });
  const provider = config.providers[decision.providerName];

  const upstream = await forward(
    provider,
    body as Record<string, unknown>,
    lowerHeaders(req),
  );

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });

  const log = {
    method: "POST",
    path: "/v1/messages",
    tier: decision.tier,
    provider: decision.providerName,
    model: provider.model,
    reason: decision.reason,
    status: upstream.status,
  };

  if (!upstream.body) {
    res.end();
    logRequest({ ...log, latencyMs: Date.now() - started });
    return;
  }

  // Stream upstream -> client, tapping the bytes to extract token usage.
  let captured = "";
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
    if (captured.length < MAX_CAPTURE_BYTES)
      captured += decoder.decode(value, { stream: true });
  }
  res.end();

  const usage = extractUsage(captured);
  logRequest({
    ...log,
    latencyMs: Date.now() - started,
    inputTokens: usage.input,
    outputTokens: usage.output,
    estCostUsd: estimateCost(provider, usage.input, usage.output),
  });
}
