import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const MODELS_API = "https://api.digitalocean.com/v2/gen-ai/models?per_page=200";
const CATALOG_API = "https://api.digitalocean.com/v2/gen-ai/models/catalog?limit=200";

export const DigitalOceanModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lifecycle_status: z.string(),
  type: z.string().optional(),
  thinking: z.boolean().optional(),
  reasoning_efforts: z.array(z.string()).optional(),
  context_window: z.union([z.number(), z.string()]).optional(),
  modalities: z.object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional(),
  }).optional(),
  settings: z.array(z.object({
    name: z.string(),
    max: z.number().optional(),
    default_value: z.number().optional(),
  })).optional(),
  created_at: z.string().optional(),
}).passthrough();

const DigitalOceanModelsResponse = z.object({
  models: z.array(DigitalOceanModel),
  links: z.object({
    pages: z.object({
      next: z.string().nullable().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const DigitalOceanCatalogPricing = z.object({
  input_price_per_million: z.number().optional(),
  output_price_per_million: z.number().optional(),
  cache_read_input_price_per_million: z.number().optional(),
  cache_write_5m_input_price_per_million: z.number().optional(),
}).passthrough();

const DigitalOceanCatalogModel = z.object({
  id: z.string().min(1).optional(),
  model_id: z.string().min(1),
  name: z.string().min(1),
  context_window: z.union([z.number(), z.string()]).nullish(),
  max_output_tokens: z.union([z.number(), z.string()]).nullish(),
  availability: z.array(z.string()).optional(),
  modalities: z.object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional(),
  }).nullish(),
  pricing: DigitalOceanCatalogPricing.nullish(),
  pricing_detail: z.object({
    variants: z.array(z.object({
      tier: z.string().optional(),
      mode: z.string().optional(),
      prices: DigitalOceanCatalogPricing.nullish(),
    }).passthrough()),
  }).nullish(),
}).passthrough();

const DigitalOceanCatalogResponse = z.object({
  data: z.array(DigitalOceanCatalogModel),
  links: z.object({
    pages: z.object({
      next: z.string().nullable().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const DigitalOceanCatalogDetailResponse = z.object({
  data: DigitalOceanCatalogModel,
}).passthrough();

const DigitalOceanResponse = z.object({
  models: z.array(DigitalOceanModel),
  catalog: z.array(DigitalOceanCatalogModel),
});

export type DigitalOceanModel = z.infer<typeof DigitalOceanModel>;
type DigitalOceanCatalogModel = z.infer<typeof DigitalOceanCatalogModel>;

interface ModelPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputOver200k?: number;
  outputOver200k?: number;
  cacheReadOver200k?: number;
  cacheWriteOver200k?: number;
}

type ReasoningEffort =
  | null
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "default";

export interface DigitalOceanSourceModel extends DigitalOceanModel {
  max_output_tokens?: string | number | null;
  availability?: string[];
  pricing?: ModelPricing;
}

export const digitalocean = {
  id: "digitalocean",
  name: "DigitalOcean",
  modelsDir: "providers/digitalocean/models",
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} DigitalOcean text models could not be translated because required metadata was unavailable.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local DigitalOcean models were outside the managed text-model catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.DIGITALOCEAN_API_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN;
    if (!key) {
      throw new Error("DigitalOcean sync requires DIGITALOCEAN_API_TOKEN or DIGITALOCEAN_ACCESS_TOKEN");
    }
    return fetchDigitalOceanModels(key);
  },
  parseModels(raw) {
    return parseDigitalOceanModels(raw);
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const contextWindow = number(model.context_window);
    const outputLimit = number(model.max_output_tokens ?? undefined);
    if (model.pricing?.input === undefined || model.pricing.output === undefined) return undefined;
    if (
      existing === undefined
      && (
        contextWindow === undefined
        || contextWindow <= 0
        || outputLimit === undefined
        || outputLimit <= 0
      )
    ) return undefined;
    const baseModel = existing === undefined
      ? resolveDigitalOceanBaseModel(model.id)
      : existing.base_model;
    return {
      id: model.id,
      model: buildDigitalOceanModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<DigitalOceanSourceModel>;

export async function fetchDigitalOceanModels(key: string, fetcher: typeof fetch = fetch) {
  const [models, catalog] = await Promise.all([
    fetchAllDigitalOceanModels(key, fetcher),
    fetchAllDigitalOceanCatalog(fetcher),
  ]);
  return { models, catalog };
}

async function fetchAllDigitalOceanModels(key: string, fetcher: typeof fetch) {
  const models: DigitalOceanModel[] = [];
  const visited = new Set<string>();
  let url: string | undefined = MODELS_API;

  while (url !== undefined) {
    if (visited.has(url)) throw new Error(`DigitalOcean models pagination repeated URL: ${url}`);
    visited.add(url);

    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean models request failed: ${response.status} ${response.statusText}`);
    }

    const page = DigitalOceanModelsResponse.parse(await response.json());
    models.push(...page.models);
    const next = page.links?.pages?.next;
    url = next ? new URL(next, url).toString() : undefined;
  }
  return models;
}

async function fetchAllDigitalOceanCatalog(fetcher: typeof fetch) {
  const catalog: DigitalOceanCatalogModel[] = [];
  const visited = new Set<string>();
  let url: string | undefined = CATALOG_API;

  while (url !== undefined) {
    if (visited.has(url)) throw new Error(`DigitalOcean catalog pagination repeated URL: ${url}`);
    visited.add(url);

    const response = await fetcher(url, {
      headers: { "Content-Type": "application/json", "User-Agent": "models.dev/digitalocean-sync" },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean catalog request failed: ${response.status} ${response.statusText}`);
    }

    const page = DigitalOceanCatalogResponse.parse(await response.json());
    catalog.push(...page.data);
    const next = page.links?.pages?.next;
    url = next ? new URL(next, url).toString() : undefined;
  }

  return Promise.all(catalog.map(async (model) => {
    if (model.id === undefined || model.availability?.includes("serverless") !== true) return model;
    const response = await fetcher(`https://api.digitalocean.com/v2/gen-ai/models/catalog/${model.id}`, {
      headers: { "Content-Type": "application/json", "User-Agent": "models.dev/digitalocean-sync" },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean catalog detail request failed: ${response.status} ${response.statusText}`);
    }
    return DigitalOceanCatalogDetailResponse.parse(await response.json()).data;
  }));
}

export function parseDigitalOceanModels(raw: unknown): DigitalOceanSourceModel[] {
  const response = DigitalOceanResponse.parse(raw);
  const catalog = new Map(response.catalog.map((model) => [model.model_id, model]));
  return response.models
    .map((model) => mergeCatalogModel(model, catalog.get(model.id)))
    .filter(isManagedTextModel);
}

function mergeCatalogModel(
  model: DigitalOceanModel,
  catalog: DigitalOceanCatalogModel | undefined,
): DigitalOceanSourceModel {
  return {
    ...model,
    name: catalog?.name ?? model.name,
    context_window: catalog?.context_window ?? model.context_window,
    max_output_tokens: catalog?.max_output_tokens,
    modalities: catalog?.modalities ?? model.modalities,
    availability: catalog?.availability,
    pricing: catalogPricing(catalog),
  };
}

function isManagedTextModel(model: DigitalOceanSourceModel) {
  const output = normalizeModalities(model.modalities?.output ?? [], []);
  return model.availability?.includes("serverless") === true
    && output.includes("text")
    && model.type !== "embedding"
    && model.type !== "reranking";
}

function catalogPricing(model: DigitalOceanCatalogModel | undefined): ModelPricing | undefined {
  if (model?.pricing == null) return undefined;
  const standard = model.pricing_detail?.variants.find((variant) =>
    variant.mode === "MODEL_BILLING_MODE_INTERACTIVE"
    && variant.tier === "MODEL_PRICING_TIER_STANDARD"
  )?.prices;
  const extended = model.pricing_detail?.variants.find((variant) =>
    variant.mode === "MODEL_BILLING_MODE_INTERACTIVE"
    && variant.tier?.startsWith("MODEL_PRICING_TIER_EXTENDED_") === true
  )?.prices;
  return {
    input: perMillion(model.pricing.input_price_per_million),
    output: perMillion(model.pricing.output_price_per_million),
    cacheRead: perMillion(model.pricing.cache_read_input_price_per_million),
    cacheWrite: perMillion(standard?.cache_write_5m_input_price_per_million),
    inputOver200k: perMillion(extended?.input_price_per_million),
    outputOver200k: perMillion(extended?.output_price_per_million),
    cacheReadOver200k: perMillion(extended?.cache_read_input_price_per_million),
    cacheWriteOver200k: perMillion(extended?.cache_write_5m_input_price_per_million),
  };
}

function perMillion(value: number | undefined) {
  if (value === undefined) return undefined;
  // The live catalog currently returns per-token rates despite the field names.
  const normalized = value < 0.001 ? value * 1_000_000 : value;
  return Math.round(normalized * 10_000) / 10_000;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function normalizeModalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const normalized = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "code" ? "text" : value)
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(normalized.length > 0 ? normalized : fallback)];
}

function number(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function inferFamily(id: string, name: string) {
  const kimi = inferKimiFamily(id, name);
  if (kimi !== undefined) return kimi;
  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => target.includes(family.toLowerCase()));
}

function reasoningOptionsFor(
  model: DigitalOceanSourceModel,
  existing: ExistingModel | undefined,
): ExistingModel["reasoning_options"] {
  if (model.reasoning_efforts === undefined) return existing?.reasoning_options;
  const values = model.reasoning_efforts
    .map((value) => value === "null" ? null : value)
    .filter(isReasoningEffort);
  const preserved = existing?.reasoning_options?.filter((option) => option.type !== "effort") ?? [];
  return values.length > 0 ? [...preserved, { type: "effort", values }] : preserved;
}

function isReasoningEffort(value: string | null): value is ReasoningEffort {
  return value === null
    || value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    || value === "default";
}

function status(
  lifecycleStatus: string,
  existing: ExistingModel["status"],
): ExistingModel["status"] {
  const lifecycle = lifecycleStatus.toLowerCase().replaceAll("_", "-");
  if (lifecycle === "deprecated" || lifecycle === "end-of-life") return "deprecated";
  if (lifecycle === "public-preview") return "beta";
  return existing === "deprecated" || existing === "beta" ? undefined : existing;
}

function cost(model: DigitalOceanSourceModel, existing: ExistingModel | undefined) {
  const input = model.pricing?.input ?? existing?.cost?.input;
  const output = model.pricing?.output ?? existing?.cost?.output;
  if (input === undefined || output === undefined) return existing?.cost;

  const existingTiers = existing?.cost?.tiers ?? [];
  const longContext = existingTiers.find((tier) =>
    (tier.tier.type === undefined || tier.tier.type === "context") && tier.tier.size >= 200_000
  );
  const hasLongContextPricing = model.pricing?.inputOver200k !== undefined
    && model.pricing.outputOver200k !== undefined;
  const tiers = hasLongContextPricing
    ? [
        ...existingTiers.filter((tier) => tier !== longContext),
        {
          tier: { type: "context" as const, size: longContext?.tier.size ?? 200_000 },
          input: model.pricing!.inputOver200k!,
          output: model.pricing!.outputOver200k!,
          reasoning: longContext?.reasoning,
          cache_read: model.pricing?.cacheReadOver200k ?? longContext?.cache_read,
          cache_write: model.pricing?.cacheWriteOver200k ?? longContext?.cache_write,
        },
      ]
    : existingTiers;

  return {
    input,
    output,
    reasoning: existing?.cost?.reasoning,
    cache_read: model.pricing?.cacheRead ?? existing?.cost?.cache_read,
    cache_write: model.pricing?.cacheWrite ?? existing?.cost?.cache_write,
    input_audio: existing?.cost?.input_audio,
    output_audio: existing?.cost?.output_audio,
    tiers: tiers.length > 0 ? tiers : undefined,
  };
}

export function buildDigitalOceanModel(
  model: DigitalOceanSourceModel,
  existing: ExistingModel | undefined,
  baseModel = existing === undefined ? resolveDigitalOceanBaseModel(model.id) : existing.base_model,
): SyncedModel {
  const input = normalizeModalities(
    model.modalities?.input ?? [],
    existing?.modalities?.input ?? ["text"],
  );
  const output = normalizeModalities(
    model.modalities?.output ?? [],
    existing?.modalities?.output ?? ["text"],
  );
  const context = number(model.context_window) ?? existing?.limit?.context ?? 0;
  const maxTokens = number(model.max_output_tokens ?? undefined);
  const limit = {
    context,
    input: existing?.limit?.input,
    output: maxTokens ?? existing?.limit?.output ?? 0,
  };
  const textOutput = output.includes("text") && !output.includes("image") && !output.includes("video");
  const reasoning = existing?.reasoning
    ?? (textOutput && ((model.thinking ?? false) || (model.reasoning_efforts?.length ?? 0) > 0));
  const reasoningOptions = reasoning ? reasoningOptionsFor(model, existing) : undefined;
  const modelStatus = status(model.lifecycle_status, existing?.status);
  const releaseDate = existing?.release_date ?? model.created_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const values: Partial<SyncedFullModel> = {
    name: model.name,
    description: existing?.description ?? describeModel({
      id: model.id,
      name: model.name,
      family: existing?.family ?? inferFamily(model.id, model.name),
      reasoning,
      tool_call: existing?.tool_call ?? textOutput,
      structured_output: existing?.structured_output,
      open_weights: existing?.open_weights ?? false,
      limit,
      modalities: { input, output },
    }),
    family: existing?.family ?? inferFamily(model.id, model.name),
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: existing?.attachment ?? input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature ?? true,
    tool_call: existing?.tool_call ?? textOutput,
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: modelStatus,
    interleaved: existing?.interleaved,
    cost: cost(model, existing),
    limit,
    modalities: { input, output },
    provider: existing?.provider,
    experimental: existing?.experimental,
  };

  if (baseModel !== undefined) {
    return factorBaseModel(baseModel, {
      name: model.name,
      description: existing?.description,
      attachment: input.some((value) => value !== "text"),
      reasoning: model.thinking ?? existing?.reasoning,
      reasoning_options: reasoningOptions,
      temperature: existing?.temperature,
      tool_call: existing?.tool_call,
      structured_output: existing?.structured_output,
      status: modelStatus,
      interleaved: existing?.interleaved,
      cost: cost(model, existing),
      limit,
      modalities: { input, output },
      provider: existing?.provider,
      experimental: existing?.experimental,
    }, limit, existing?.base_model_omit);
  }

  const required = z.object({
    name: z.string(),
    description: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    tool_call: z.boolean(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
    limit: z.object({ context: z.number().nonnegative(), output: z.number().nonnegative() }),
    modalities: z.object({ input: z.array(z.string()).min(1), output: z.array(z.string()).min(1) }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`DigitalOcean model ${model.id} has incomplete metadata required for sync`);
  }
  return values as SyncedFullModel;
}

export function resolveDigitalOceanBaseModel(id: string) {
  const candidates: string[] = [];
  if (id.startsWith("openai-")) candidates.push(`openai/${id.slice("openai-".length)}`);
  if (id.startsWith("deepseek-")) {
    candidates.push(`deepseek/${id}`);
    candidates.push(`deepseek/${id.replace(/^deepseek-4-/, "deepseek-v4-")}`);
  }
  if (id.startsWith("glm-")) candidates.push(`zai/${id}`);
  if (id.startsWith("kimi-")) candidates.push(`moonshotai/${id}`);
  if (id.startsWith("minimax-")) candidates.push(`minimax/${id}`);
  if (id.startsWith("nvidia-")) candidates.push(`nvidia/${id.slice("nvidia-".length)}`);
  if (id.startsWith("alibaba-")) candidates.push(`qwen/${id.slice("alibaba-".length)}`);
  if (id.startsWith("qwen")) candidates.push(`qwen/${id}`);
  if (id.startsWith("llama")) candidates.push(`meta/${id}`);
  if (id.startsWith("mistral") || id.startsWith("ministral")) candidates.push(`mistralai/${id}`);

  const anthropic = id.match(/^anthropic-claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)$/);
  if (anthropic !== null) {
    candidates.push(`anthropic/claude-${anthropic[2]}-${anthropic[1]}`);
  }
  if (id.startsWith("anthropic-")) candidates.push(`anthropic/${id.slice("anthropic-".length)}`);

  for (const candidate of candidates) {
    const resolved = resolveCanonicalBaseModel(candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
