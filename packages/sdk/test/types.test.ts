// Drift protection between @models.dev/core's Zod schemas (the source of
// truth) and this package's hand-written interfaces. The type-level
// assertions fail `tsc --noEmit` (part of the test script) whenever the
// schemas and the published types stop being exactly mutually assignable.

import { expect, test } from "bun:test"
import type { z } from "zod"
import * as Core from "@models.dev/core"
import type { Catalog, Model, ModelFamily, ModelMetadata, Provider } from "../src/index.js"
import { KNOWN_PROVIDER_IDS } from "../src/index.js"
import { loadCatalog } from "../script/generate.ts"

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

// If one of these lines errors, a schema in packages/core changed shape:
// update src/types.ts (or src/generated.ts via `bun run generate`) to match.
type _provider = Expect<Equal<z.infer<typeof Core.Provider>, Provider>>
type _model = Expect<Equal<z.infer<typeof Core.Model>, Model>>
type _metadata = Expect<Equal<z.infer<typeof Core.ModelMetadata>, ModelMetadata>>
type _family = Expect<Equal<Core.ModelFamily, ModelFamily>>
type _catalog = Expect<Equal<Awaited<ReturnType<typeof Core.generateCatalog>>, Catalog>>

test("generated provider IDs match the providers directory", async () => {
  const catalog = await loadCatalog()
  expect(Object.keys(catalog.providers)).toEqual([...KNOWN_PROVIDER_IDS])
})

test("a freshly generated catalog satisfies the published types", async () => {
  // The annotation is the assertion: core's inferred output must be assignable
  // to the published Catalog type.
  const catalog: Catalog = await loadCatalog()
  expect(Object.keys(catalog.providers).length).toBeGreaterThan(100)
  expect(Object.keys(catalog.models).length).toBeGreaterThan(100)
  const anthropic = catalog.providers["anthropic"]
  expect(anthropic).toBeDefined()
  expect(Object.keys(anthropic!.models).length).toBeGreaterThan(0)
})
