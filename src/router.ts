import type { Config, Tier } from "./config";
import type { MessagesRequest } from "./types";

/**
 * Maps the request's `model` field to a routing tier. Claude Code tags every
 * request via the ANTHROPIC_DEFAULT_*_MODEL / ANTHROPIC_SMALL_FAST_MODEL env
 * vars (set to the `route-*` sentinels by scripts/cc.sh). Real Claude model
 * names are also recognised as a fallback.
 */
export function tierFromModel(model: string): Tier {
  const m = (model ?? "").toLowerCase();
  if (m.includes("background")) return "background";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  return "sonnet";
}

/** Plan mode is active when Claude Code exposes the ExitPlanMode tool. */
export function isPlanMode(req: MessagesRequest): boolean {
  return Array.isArray(req.tools) && req.tools.some((t) => t?.name === "ExitPlanMode");
}

export interface RouteDecision {
  tier: Tier;
  providerName: string;
  reason: string;
}

export interface RouterDeps {
  classify(req: MessagesRequest): Promise<"simple" | "complex">;
}

export async function decideRoute(
  req: MessagesRequest,
  config: Config,
  deps: RouterDeps,
): Promise<RouteDecision> {
  const tier = tierFromModel(req.model);
  const tiers = config.routing.tiers;

  if (tier === "background" || tier === "haiku")
    return { tier, providerName: tiers[tier], reason: `tier:${tier}` };

  if (tier === "opus") return { tier, providerName: tiers.opus, reason: "tier:opus" };

  // tier === "sonnet": the default execution tier.
  if (config.routing.planModeToOpus && isPlanMode(req))
    return { tier, providerName: tiers.opus, reason: "plan-mode" };

  if (config.routing.classifier.enabled) {
    const decision = await deps.classify(req);
    if (decision === "complex")
      return { tier, providerName: tiers.opus, reason: "classifier:complex" };
    return { tier, providerName: tiers.sonnet, reason: "classifier:simple" };
  }

  return { tier, providerName: tiers.sonnet, reason: "tier:sonnet" };
}
