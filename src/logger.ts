import type { Pricing, ProviderConfig } from "./config";

export interface RequestLog {
  method: string;
  path: string;
  tier?: string;
  provider?: string;
  model?: string;
  reason?: string;
  status?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estCostUsd?: number;
}

export function costWithPricing(
  pricing: Pricing | undefined,
  inputTokens?: number,
  outputTokens?: number,
): number | undefined {
  if (!pricing || inputTokens === undefined || outputTokens === undefined) return undefined;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMtok +
    (outputTokens / 1_000_000) * pricing.outputPerMtok
  );
}

export function estimateCost(
  provider: ProviderConfig | undefined,
  inputTokens?: number,
  outputTokens?: number,
): number | undefined {
  return costWithPricing(provider?.pricing, inputTokens, outputTokens);
}

/** Best-effort token usage extraction from a captured (SSE or JSON) response. */
export function extractUsage(responseText: string): { input?: number; output?: number } {
  const inputs = [...responseText.matchAll(/"input_tokens":\s*(\d+)/g)];
  const outputs = [...responseText.matchAll(/"output_tokens":\s*(\d+)/g)];
  const lastInput = inputs.at(-1);
  const lastOutput = outputs.at(-1);
  return {
    input: lastInput ? Number(lastInput[1]) : undefined,
    output: lastOutput ? Number(lastOutput[1]) : undefined,
  };
}

export function logRequest(entry: RequestLog): void {
  const parts = [new Date().toISOString(), `${entry.method} ${entry.path}`];
  if (entry.status !== undefined) parts.push(String(entry.status));
  if (entry.provider) parts.push(`-> ${entry.provider} (${entry.model})`);
  if (entry.reason) parts.push(`[${entry.reason}]`);
  if (entry.latencyMs !== undefined) parts.push(`${entry.latencyMs}ms`);
  if (entry.inputTokens !== undefined || entry.outputTokens !== undefined)
    parts.push(`tok ${entry.inputTokens ?? "?"}/${entry.outputTokens ?? "?"}`);
  if (entry.estCostUsd !== undefined) parts.push(`~$${entry.estCostUsd.toFixed(5)}`);
  console.log(parts.join(" "));
}
