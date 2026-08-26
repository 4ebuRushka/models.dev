import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { cloudflareWorkersAi } from "../src/sync/providers/cloudflare-workers-ai.js";

// Synthetic metadata exercises the sync contract, not a real model's controls.
const model = {
  id: "@cf/example/reasoner",
  name: "Example Reasoner",
  created: 1_787_702_400,
  hugging_face_id: null,
  knowledge_cutoff: null,
  context_length: 128_000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002" },
  top_provider: { context_length: 128_000, max_completion_tokens: 16_000 },
  supported_parameters: ["reasoning", "tools", "temperature"],
};

function translate(raw: unknown, existing?: ExistingModel) {
  const [parsed] = cloudflareWorkersAi.parseModels(raw);
  return cloudflareWorkersAi.translateModel(parsed!, {
    existing: () => existing,
    authored: () => existing,
  }).model;
}

test.each([
  ["direct", (value: unknown) => ({ data: [value] })],
  ["wrapped", (value: unknown) => ({ result: { data: [value] } })],
  ["wrapped array", (value: unknown) => ({ result: [value] })],
] as const)("imports explicit Workers AI reasoning metadata from %s responses", (_, wrap) => {
  const synced = translate(wrap({
    ...model,
    reasoning: { mandatory: true, supported_efforts: ["low", "high", "max"] },
  }));

  expect(synced.reasoning_options).toEqual([
    { type: "effort", values: ["low", "high", "max"] },
  ]);
});

test.each([
  { name: "empty", options: [] },
  { name: "stale", options: [{ type: "effort", values: ["low", "medium", "high"] }] },
] satisfies { name: string; options: ExistingModel["reasoning_options"] }[])("refreshes $name Workers AI options from API metadata", ({ options }) => {
  const synced = translate({ data: [{
    ...model,
    reasoning: { mandatory: true, supported_efforts: ["high", "max"] },
  }] }, {
    reasoning_options: options,
    name: "Curated name",
    limit: { context: 128_000, output: 8_000 },
  });

  expect(synced.reasoning_options).toEqual([{ type: "effort", values: ["high", "max"] }]);
  expect(synced.name).toBe("Curated name");
  expect(synced.limit?.output).toBe(8_000);
});

test("preserves curated Workers AI options when API metadata is absent", () => {
  const options = [{ type: "toggle" }, { type: "budget_tokens", min: 1_024 }] satisfies ExistingModel["reasoning_options"];
  const synced = translate({ data: [model] }, { reasoning_options: options });

  expect(synced.reasoning_options).toEqual(options);
  expect(translate({ data: [model] }).reasoning_options).toBeUndefined();
});

test("imports explicit toggle and budget support without treating completion limits as budgets", () => {
  const synced = translate({ data: [{
    ...model,
    reasoning: {
      mandatory: false,
      supported_efforts: ["low", "high"],
      supports_max_tokens: true,
    },
  }] });

  expect(synced.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "high"] },
    { type: "budget_tokens" },
  ]);
});

test("retains reasoning metadata when normalizing the native Cloudflare response", () => {
  const synced = translate({ data: [{
    id: model.id,
    name: model.name,
    created: model.created,
    context_length: model.context_length,
    max_output_length: 16_000,
    pricing: model.pricing,
    supported_features: ["reasoning", "tools"],
    supported_sampling_parameters: ["temperature"],
    reasoning: { mandatory: false, supported_efforts: ["none", "low", "high"] },
  }] });

  expect(synced.reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "high"] },
  ]);
});

test("does not expand null Cloudflare efforts into OpenRouter's full effort enum", () => {
  const raw = { result: { data: [{
    ...model,
    reasoning: { mandatory: true, supported_efforts: null },
  }] } };
  const options = [{ type: "effort", values: ["low", "high"] }] satisfies ExistingModel["reasoning_options"];

  expect(translate(raw, { reasoning_options: options }).reasoning_options).toEqual(options);
  expect(translate(raw).reasoning_options).toBeUndefined();
});

test.each([
  { reasoning: null },
  { reasoning: { supported_efforts: ["low", "high"] } },
])("preserves curated options for unusable native reasoning metadata: %j", ({ reasoning }) => {
  const options = [{ type: "toggle" }] satisfies ExistingModel["reasoning_options"];
  const synced = translate({ data: [{
    id: model.id,
    name: model.name,
    created: model.created,
    context_length: model.context_length,
    max_output_length: 16_000,
    pricing: model.pricing,
    supported_features: ["reasoning"],
    reasoning,
  }] }, { reasoning_options: options });

  expect(synced.reasoning_options).toEqual(options);
});
