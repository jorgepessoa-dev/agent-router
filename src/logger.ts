import type { ProviderConfig } from "./config";

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

export function estimateCost(
  provider: ProviderConfig | undefined,
  inputTokens?: number,
  outputTokens?: number,
): number | undefined {
  if (!provider?.pricing || inputTokens === undefined || outputTokens === undefined)
    return undefined;
  return (
    (inputTokens / 1_000_000) * provider.pricing.inputPerMtok +
    (outputTokens / 1_000_000) * provider.pricing.outputPerMtok
  );
}

/** Best-effort token usage extraction from a captured (SSE or JSON) response. */
export function extractUsage(responseText: string): { input?: number; output?: number } {
  const input = /"input_tokens":\s*(\d+)/.exec(responseText);
  const outputs = [...responseText.matchAll(/"output_tokens":\s*(\d+)/g)];
  const lastOutput = outputs.at(-1);
  return {
    input: input ? Number(input[1]) : undefined,
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
