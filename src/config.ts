import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AuthScheme = "bearer" | "x-api-key" | "none";
export type ProviderFormat = "anthropic" | "openai";
export type Tier = "background" | "haiku" | "sonnet" | "opus";

export interface Pricing {
  inputPerMtok: number;
  outputPerMtok: number;
}

export interface ProviderConfig {
  baseUrl: string;
  auth: AuthScheme;
  model: string;
  apiKeyEnv?: string;
  format?: ProviderFormat;
  anthropicVersion?: string;
  pricing?: Pricing;
}

export interface RoutingConfig {
  tiers: Record<Tier, string>;
  planModeToOpus: boolean;
  classifier: { enabled: boolean; provider: string };
}

export interface Config {
  port: number;
  providers: Record<string, ProviderConfig>;
  routing: RoutingConfig;
  /** Reference rates (e.g. Sonnet) used to estimate savings on the dashboard. */
  baselinePricing?: Pricing;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Loads KEY=VALUE pairs from a .env file without overriding existing env vars. */
export function loadEnv(): void {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(path = resolve(ROOT, "config.json")): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  validateConfig(config);
  return config;
}

function validateConfig(config: Config): void {
  if (!config.providers || Object.keys(config.providers).length === 0)
    throw new Error("config: no providers defined");
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.auth !== "none" && !provider.apiKeyEnv)
      throw new Error(`config: provider "${name}" needs apiKeyEnv (auth is "${provider.auth}")`);
  }
  for (const [tier, providerName] of Object.entries(config.routing.tiers)) {
    if (!config.providers[providerName])
      throw new Error(`config: tier "${tier}" points to unknown provider "${providerName}"`);
  }
  const classifier = config.routing.classifier;
  if (classifier.enabled && !config.providers[classifier.provider])
    throw new Error(`config: classifier points to unknown provider "${classifier.provider}"`);
}

export function resolveApiKey(provider: ProviderConfig): string {
  if (!provider.apiKeyEnv) throw new Error("provider has no apiKeyEnv configured");
  const key = process.env[provider.apiKeyEnv];
  if (!key)
    throw new Error(`missing API key: set ${provider.apiKeyEnv} in the environment or .env`);
  return key;
}
