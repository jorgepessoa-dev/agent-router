/** In-memory aggregation of routed requests for the cost dashboard. */

interface ProviderAgg {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface StatsSnapshot {
  uptimeSec: number;
  totalRequests: number;
  providers: Array<{ name: string } & ProviderAgg>;
  totals: {
    costUsd: number;
    baselineCostUsd: number;
    savingsUsd: number;
    savingsPct: number;
  };
}

const startedAt = Date.now();
let totalRequests = 0;
let totalCost = 0;
let totalBaseline = 0;
const byProvider = new Map<string, ProviderAgg>();

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function recordRequest(entry: {
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  baselineCostUsd?: number;
}): void {
  totalRequests += 1;
  totalCost += entry.costUsd ?? 0;
  totalBaseline += entry.baselineCostUsd ?? 0;

  const agg = byProvider.get(entry.provider) ?? {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  agg.requests += 1;
  agg.inputTokens += entry.inputTokens ?? 0;
  agg.outputTokens += entry.outputTokens ?? 0;
  agg.costUsd += entry.costUsd ?? 0;
  byProvider.set(entry.provider, agg);
}

export function snapshot(): StatsSnapshot {
  const savings = totalBaseline - totalCost;
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    totalRequests,
    providers: [...byProvider.entries()]
      .map(([name, agg]) => ({
        name,
        ...agg,
        costUsd: round(agg.costUsd),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    totals: {
      costUsd: round(totalCost),
      baselineCostUsd: round(totalBaseline),
      savingsUsd: round(savings),
      savingsPct: totalBaseline > 0 ? round((savings / totalBaseline) * 100) : 0,
    },
  };
}
