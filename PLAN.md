# PLAN: `models.dev` npm package

Official typed client for the models.dev API, published as `models.dev` on npm.

## Context & research findings

**The API.** models.dev is effectively a static, read-only data API served by a Cloudflare Worker
(`packages/function/src/worker.ts`) in front of assets generated at deploy time by
`packages/web/script/build.ts`:

| Endpoint | Content | Size (raw / gzip) |
|---|---|---|
| `GET /api.json` | `Record<providerID, Provider>` — providers with their models | ~2.9 MB / ~271 KB |
| `GET /models.json` | `Record<modelID, ModelMetadata>` — provider-agnostic lab metadata | ~160 KB |
| `GET /catalog.json` | `{ providers, models }` — both of the above | ~3.1 MB |
| `GET /model-schema.json` | JSON Schema of valid `provider/model` IDs | small |

No auth, no pagination, no mutations, no streaming. One conceptual operation: "give me the database."
Data changes hourly (`sync-models.yml` cron). Source of truth for the shape is the Zod schemas in
`packages/core/src/schema.ts`.

**The npm name.** `models.dev@0.0.0` is already published and owned by thdxr (placeholder from the
current `packages/core` package.json). The name is secured; we repurpose it for the SDK.

**OpenCode V2 SDK architecture** (`anomalyco/opencode` → `packages/client`, unreleased). Key takeaways:

- Two entrypoints: `.` (zero-Effect Promise client over `fetch`) and `./effect` (Effect-native client
  over an environment-provided `HttpClient`).
- **The Promise root does NOT use Effect internally.** It is a hand-rolled fetch wrapper with zero
  *runtime* dependencies: its module graph is three local files, all HTTP helpers inlined, and
  import-boundary tests bundle each entrypoint (`bun build --packages=bundle` + metafile) asserting
  the root contains zero code from effect/schema/protocol/core/server. `effect` is an *optional peer
  dependency*, only needed for `./effect`. Caveat: not literally dependency-free at the *package*
  level — `types.ts` has a type-only import from `@opencode-ai/protocol`, and the package declares
  `@opencode-ai/schema` + `@opencode-ai/protocol` as real `dependencies` (value-level for `/effect`).
  Our package can be strictly stronger: hand-written types → literally zero `dependencies`.
- Promise client: `make({ baseUrl, fetch?, headers? })`, per-request `{ signal?, headers? }`, a single
  `ClientError` with `reason: "Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse"`.
- Effect client: built on `HttpApiClient` from `effect/unstable/httpapi` (Effect v4 beta), errors
  mapped to a `Schema.TaggedErrorClass` `ClientError`. Transport injected via layers
  (`FetchHttpClient.layer`, `NodeHttpClient.layer`, or a custom `fetch` via the
  `FetchHttpClient.Fetch` service — this is how `sdk-next` runs the client against an in-memory
  handler with no network).
- Publishing (`packages/sdk/js/script/publish.ts`): exports point at `./src/*.ts` for workspace dev;
  a publish script rewrites them to `./dist/*.js` + `.d.ts`, `tsc` builds, `npm publish --tag <channel>`,
  skips if the version already exists.

**How modern SDKs handle fetch.** Stainless-generated SDKs (openai, anthropic), ky, hey-api,
openapi-fetch: zero dependencies, use global `fetch` (Node ≥ 18 baseline, Bun, Deno, browsers, CF
Workers, Vercel Edge), and accept a `fetch` override option for proxies/polyfills/testing. Nobody
ships an HTTP library anymore. Effect solves the same problem one level up: transport is a service
(`HttpClient`) provided by a Layer, so the Effect entrypoint never touches `fetch` directly.

---

## Decision 1 — Effect internally: no. Effect at the edge: yes.

**Recommendation: mirror OpenCode V2 exactly — a dependency-free Promise core at the root, a thin
Effect-native client at `/effect`, `effect` as an optional peer dependency.**

Considered:

| Option | Verdict |
|---|---|
| A. Effect internally everywhere, Promise API is a `runPromise` wrapper | Rejected |
| B. Zero-dep Promise core; `/effect` is a separate Effect-native client | **Chosen** |
| C. No Effect at all | Rejected (weaker DX for the opencode ecosystem, which is Effect-native) |

Why A is rejected — this is the "maybe Effect is a bad idea" analysis:

- **It buys nothing here.** Effect's HttpClient value is retries, tracing, interruption, SSE,
  middleware composition. This API is a single cacheable GET of a static JSON file. The entire
  Promise client is ~100 lines.
- **Bundle & dependency cost.** Wrapping Effect for Promise users drags the fiber runtime
  (~30–50 KB gzip after tree-shaking, plus Schema if used) into every consumer for a client whose
  own logic is ~1 KB. Stainless-class SDKs are zero-dep for a reason.
- **Version hazard.** Effect v4 is still in beta (`effect@4.0.0-beta.x`; opencode pins beta.83).
  A hard dependency pins every consumer to our Effect version and invites duplicate-Effect bugs
  (Context tags are identity-sensitive across copies). As an *optional peer*, the consumer controls
  the Effect version and only pays for it if they import `/effect`.
- **Precedent.** The OpenCode V2 SDK team already made this exact call and enforces it with
  import-boundary tests. "Architected like the V2 SDK" means Effect-free root, not Effect-inside.

Why C is rejected: `/effect` is cheap to build (thin wrapper), and it's the idiomatic surface for
opencode itself and other Effect codebases — typed errors in the error channel, `Layer`-injected
transport (which is also the cleanest answer to "fetch doesn't work everywhere"), scoping, retry
policies composable by the caller.

**Effect version target: same as opencode.** Exact-pinned optional peer, matching opencode's
current pin (`"peerDependencies": { "effect": "4.0.0-beta.83" }`, `peerDependenciesMeta` optional) —
bump in lockstep with opencode's catalog, relax to `^4.0.0` when v4 goes stable. Imports only from
`effect` and `effect/unstable/http` (`HttpClient`, `FetchHttpClient`). Keep the `/effect` surface
tiny so beta churn stays absorbable. (Alternative considered: Effect v3 + `@effect/platform` —
rejected: the flagship consumer is on v4, and shipping v3 today means a breaking migration soon.)

## Decision 2 — Import surface

Package `models.dev`, ESM-only (`"type": "module"`), three subpath exports:

```jsonc
// package.json (dev state; publish script rewrites src → dist, see Decision 7)
{
  "name": "models.dev",
  "sideEffects": false,                // snapshot & effect are tree-shaken unless imported
  "exports": {
    ".":          "./src/index.ts",    // Promise client + all types. Zero deps.
    "./effect":   "./src/effect.ts",   // Effect client. Requires optional peer `effect`.
    "./snapshot": "./src/snapshot.js"  // Bundled data snapshot. Zero deps, no network.
  }
}
```

```ts
import { Models, type Provider, type Model } from "models.dev"
import { Models } from "models.dev/effect"
import snapshot from "models.dev/snapshot"
```

Namespace is `Models` — product-named like opencode's `export * as OpenCode from "./client"`, without
the `models.dev`/`ModelsDev` redundancy in the same import line.

Notes:

- All types (`Provider`, `Model`, `ModelMetadata`, `Catalog`, `ProviderID`, …) are exported from the
  root; `/effect` re-exports them so Effect users import from one place.
- ESM-only matches opencode and the ecosystem direction. CJS consumers on Node ≥ 20.19 / ≥ 22.12 can
  `require()` ESM natively. We can add a CJS build later without breaking anything if demand shows up.
- No `./zod` entrypoint: the core Zod schemas validate *authoring* concerns (strictness,
  cross-field rules) and would couple consumers to our zod version. Deferred until someone asks.
- Deliberately **no default export** and no top-level convenience functions (`fetchProviders()`),
  one way to do things: construct a client.

## Decision 3 — API shape

Guiding decision: **the client is a stateless fetcher, and the snapshot is plain data. The two are
separate concepts that never blend.** This follows the data-catalog precedent rather than the
smart-client one:

| Prior art | Pattern |
|---|---|
| caniuse-lite, mime-db, tzdata | Pure data packages: import and use, no client, no cache. Freshness = automated npm publishes. |
| @maxmind/geoip2-node | `WebServiceClient` (network, per-query, stateless) vs `Reader` (local data) — explicitly separate, never mixed. |
| openai / octokit / ky | HTTP clients do **zero response caching**; caching belongs to the caller. |

An earlier draft had a TTL cache, a `fallback` option, and async lookup helpers on the client. All
dropped: they exist only to hide *when the fetch happens*, which is exactly what makes an SDK hard
to explain. Since every payload is a `Record`, **lookup is plain object access** — no helper methods
needed, so there is nothing to cache and no hidden state anywhere.

### Root (`models.dev`) — Promise client

```ts
import { Models } from "models.dev"

const client = Models.make() // zero-config works

interface ClientOptions {
  baseUrl?: string                       // default "https://models.dev"
  fetch?: typeof globalThis.fetch        // default globalThis.fetch
  headers?: HeadersInit                  // extra headers on every request
}

interface RequestOptions {
  signal?: AbortSignal
  headers?: HeadersInit
}

// one method per endpoint; every call performs exactly one GET, nothing is cached
const providers = await client.providers()   // ProviderMap                    (api.json)
const models = await client.models()         // Record<string, ModelMetadata>  (models.json)
const catalog = await client.catalog()       // Catalog                        (catalog.json)

// lookups are plain object access on typed data
providers["anthropic"]?.models["claude-opus-4-6"]?.cost
```

Design points:

- **Stateless**: calling `providers()` twice fetches twice. Trivial to explain, impossible to be
  surprised by. Consumers who want caching write it in one line where they control the policy
  (module-level `const`, their own TTL, disk cache like opencode's).
- **Offline fallback is userland, not an SDK feature** (~3 lines, explicit):

  ```ts
  import { Models } from "models.dev"
  const client = Models.make()
  const providers = await client.providers().catch(async () => (await import("models.dev/snapshot")).providers)
  ```
- **Type names mirror the data**: `ProviderMap = Record<string, Provider>`,
  `Catalog = { providers: ProviderMap; models: Record<string, ModelMetadata> }`.
- **Errors**: one class, opencode-style — `ModelsDevError extends Error` with
  `reason: "Transport" | "UnexpectedStatus" | "MalformedResponse"` and `cause`. No response
  validation at runtime (see Decision 5).
- **Client identification via `User-Agent: models.dev/<version>`**, not a custom `x-` header.
  Rationale: the worker's analytics are already UA-based (it sniffs `opencode`/`bun` UAs for
  PostHog/data-lake events), UA never triggers a CORS preflight so nothing can get blocked, and
  server-side runtimes (Node/Bun/Deno/workers — the dominant consumers) all honor it. Browsers
  (Firefox/Safari) silently drop UA overrides — graceful degradation, never a failure. Overridable
  through the `headers` option.
- Export the client interface as a named type (v2-branch parity with `OpenCodeClient`):

  ```ts
  export type ModelsClient = ReturnType<typeof Models.make>
  ```

### `models.dev/effect` — Effect client

```ts
import { Models, ModelsDevError } from "models.dev/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const client = yield* Models.make({ baseUrl: "https://models.dev" })
  const providers = yield* client.providers()          // Effect<ProviderMap, ModelsDevError>
  providers["anthropic"]?.models["claude-opus-4-6"]
})

program.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise)
```

- `Models.make(options?)` is `Effect<ModelsClient, never, HttpClient>` — transport comes from the
  environment, exactly like `OpenCode.make`. Also provide the DI conveniences from `sdk-next`:
  `Models.Service` (a `Context.Service` tag) and `Models.layer(options?)`.
- Same method names and statelessness as the Promise client. Consumers who want caching compose it
  idiomatically — `Effect.cached(client.providers())` / `Effect.cachedWithTTL` — instead of the SDK
  inventing cache options.
- `ModelsDevError` is a `Schema.TaggedErrorClass` wrapping the underlying `HttpClientError`/defect.
- Implementation detail: hand-written on `HttpClient` directly. **Do not** model this with
  `HttpApi`/`HttpApiClient` — that machinery earns its complexity for opencode's 18 endpoint groups,
  not for 3 GETs of static JSON. No codegen either, for the same reason.

### `models.dev/snapshot` — bundled data, no network

```ts
import snapshot, { providers, models, generatedAt } from "models.dev/snapshot"

providers["anthropic"].models["claude-opus-4-6"].cost.input
generatedAt // ISO date string baked at publish time
```

- Generated at publish time from this repo's TOMLs via `generate()`/`generateCatalog()` from
  `packages/core` — not fetched from the live site, so a snapshot always corresponds to the git tree
  it was published from.
- Shipped as a generated `.js` file exporting `JSON.parse("<literal>")` plus a hand-rolled `.d.ts`:
  - avoids JSON-module import attributes (`with { type: "json" }`) which still vary across
    node/bundler/TS configs;
  - `JSON.parse` of a string literal parses measurably faster than a 3 MB object literal in V8;
  - lives inside the main tarball (~700 KB gzipped) as a **separate, tree-shakable subpath export**
    (`sideEffects: false` + own entrypoint): consumers who never import `/snapshot` never load or
    bundle a byte of it. No separate `@models.dev/snapshot` package to version-sync.
- This is the answer for: no-fetch runtimes, air-gapped/offline use, cold-start-sensitive paths, and
  tests.

## Decision 4 — The fetch problem

Layered strategy, no polyfills, no HTTP library:

1. **Default: global `fetch`.** Baseline Node ≥ 18 (`engines.node: ">=18"`), works in Bun, Deno,
   browsers, CF Workers, Vercel Edge, React Native. This is the industry standard (Stainless, ky, hey-api).
2. **Escape hatch: `fetch` option** on the Promise client for proxies (undici `ProxyAgent`),
   polyfills on exotic runtimes, and test doubles. Resolved lazily (`options.fetch ?? globalThis.fetch`
   at call time) so late polyfills work.
3. **Effect: transport is a Layer.** `/effect` depends on the `HttpClient` service only. Node users
   without global fetch use `NodeHttpClient.layer`; custom fetch injects via
   `FetchHttpClient.Fetch`; in-memory handlers work like opencode's `sdk-next`. The SDK itself never
   references `fetch`.
4. **No network at all: `/snapshot`** — a separate import, never wired into the client.

## Decision 5 — Types & validation

- **Source of truth stays the Zod schemas in `packages/core`.** The SDK ships **hand-written plain
  interfaces** (`Provider`, `Model`, `Cost`, `Limit`, `ReasoningOption`, `ModelMetadata`, …) — clean,
  readable, zod-free `.d.ts` output. Re-exporting `z.infer` types would drag zod into consumers' type
  graphs and produce unreadable hover types.
- **Drift protection instead of duplication risk**: a test in the SDK package (dev-dependency on
  `@models.dev/core`) asserts mutual assignability:

  ```ts
  type Expect<T extends true> = T
  type _provider = Expect<Equal<z.infer<typeof CoreSchema.Provider>, Provider>>
  ```

  plus a runtime test that the freshly generated snapshot satisfies the published types. Schema
  changes in core that would break the SDK types fail CI in this repo, where they're fixed in the
  same PR.
- **No runtime validation of responses, in either client.** The data is machine-generated by this
  repo's own validated pipeline; re-validating 3 MB per fetch costs tens of ms for nothing. More
  importantly, strict decoding makes old SDK versions *break when the API adds fields* — the opposite
  of robust for an hourly-updated dataset. Types are declared `readonly`, additive API changes are
  invisible to old clients. (`/effect` casts the parsed JSON rather than `Schema.decodeUnknown` for
  the same reason.)
- **Literal ID unions as a DX bonus**: generate `KnownProviderID` ("anthropic" | "openai" | … ~147
  entries) at build time; helpers accept `KnownProviderID | (string & {})` so unknown-but-newer IDs
  still type-check. Model-level unions (~10k IDs) deferred — d.ts bloat; revisit if asked for.

## Decision 6 — Repo integration

**Rename core to `@models.dev/core` (private), create a clean `packages/sdk` named `models.dev`.**
Both can't be named `models.dev` — bun hard-errors on duplicate workspace names — and core is not a
published package (only the 0.0.0 placeholder was ever pushed from it), so its rename is free and
follows the existing internal convention: `@models.dev/function`, `@models.dev/web`. The
alternative (folding the SDK into core) was considered and dropped: it forces publish-time exports
curation, moving zod/remeda to devDeps, and mixes internal tooling with the public surface — more
moving parts than a 3-line rename.

Rename fallout, all of it: core's `package.json` name, web's dependency entry
(`packages/web/package.json:11`), and web's two imports (`packages/web/src/render.tsx:4-5`).

```
packages/
  core/       → "@models.dev/core", private: true (tooling, unchanged otherwise)
  sdk/        → NEW, name "models.dev"
    src/
      index.ts        // Promise client + types
      types.ts        // hand-written interfaces + generated KnownProviderID
      error.ts
      effect.ts       // Effect client (only file importing effect)
      snapshot.js     // generated at publish, gitignored
      snapshot.d.ts
    script/
      generate-snapshot.ts   // uses @models.dev/core generateCatalog()
      build.ts               // snapshot + tsc → dist
      publish.ts             // opencode-style: rewrite exports src→dist, pack, publish
    test/
      client.test.ts         // bun test, mocked fetch
      effect.test.ts
      import-boundaries.test.ts  // root & /snapshot bundles contain zero effect code
      types.test.ts          // zod ⇄ interface drift + snapshot satisfies types
```

- SDK `dependencies`: **none**. devDependencies: `@models.dev/core` (snapshot generation + drift
  tests), `effect` (also exact-pinned optional peer, per Decision 1).
- Build = `tsc` emitting `dist/` (js + d.ts + sourcemaps). No bundler needed for a package this
  size; revisit (tsdown) only if we ever ship CJS.
- Root `bun validate` untouched; add `bun run --filter models.dev test` to PR validation workflow.

## Decision 7 — npm releases

**Versioning policy** (caniuse-lite model — the package is mostly data):

- **patch** — snapshot refresh, no code change. Automated.
- **minor** — new SDK features / new exported types. Manual.
- **major** — breaking changes to client API or type shapes. Manual, rare.

**Publish flow** — new workflow `.github/workflows/publish-sdk.yml`:

- Triggers: `workflow_dispatch` (input: `bump: patch|minor|major`) + `schedule` (daily, after the
  hourly syncs have merged).
- Steps:
  1. checkout `dev`, `bun install`, `bun validate`
  2. `bun run generate-snapshot` from the repo TOMLs
  3. scheduled runs: diff generated snapshot against `models.dev@latest` on npm → exit 0 if unchanged
  4. version = `npm view models.dev version` + semver bump computed in-workflow — **the version is
     not stored in git** (package.json keeps `0.0.0`), so daily data publishes create zero commit
     noise and no tag spam; manual dispatch tags `sdk-vX.Y.Z` for code releases only
  5. build, test, typecheck
  6. `npm publish --access public --provenance` via **npm Trusted Publishing (OIDC)** — no long-lived
     token; one-time configuration on npmjs.com linking the package to this repo+workflow (owner
     will set this up). Fallback: `NPM_TOKEN` secret with the same script.
- Idempotency: skip if computed version already published (opencode's `publish.ts` pattern).
- Dist-tags: `latest` only; `next` reserved for prereleases of majors.

**Snapshot freshness expectation** documented in the README: `latest` snapshot is ≤ 24h behind the
live API; the client (not the snapshot) is the freshness path.

## What v1 ships

1. Rename core → `@models.dev/core`, scaffold `packages/sdk` as `models.dev`
2. Promise client (`providers`/`models`/`catalog`, stateless, fetch injection, UA identification)
3. Hand-written types + `KnownProviderID` generation + drift tests
4. Snapshot generation + `/snapshot` entrypoint
5. `/effect` client (make/Service/layer), effect pinned like opencode
6. Import-boundary, unit, and type tests wired into PR validation
7. `publish-sdk.yml` with scheduled data releases + trusted publishing

Suggested sequencing: 1→2→3→4 (usable, zero-dep package) then 5 (effect) then 7 (automation).

## Resolved

- **Namespace**: `Models` (product-named like opencode's `OpenCode`, avoids `ModelsDev` redundancy);
  `Models.make()`, exported `ModelsClient` type.
- **Caching**: none — stateless client, snapshot fully separate, lookups are plain object access.
- **Repo layout**: rename core → `@models.dev/core` (private, matches sibling convention); SDK is a
  new clean `packages/sdk` named `models.dev`.
- **Effect versioning**: same as opencode — exact-pinned optional peer (`4.0.0-beta.x`), bumped in
  lockstep, relaxed at v4 stable.
- **Endpoint surface**: all three in v1 — `providers()` (api.json), `models()` (models.json),
  `catalog()` (both in one request).
- **Snapshot packaging**: inside the main tarball as a separate tree-shakable subpath export.
- **Client identification**: default `User-Agent: models.dev/<version>` — no custom header, no CORS
  preflight, feeds the worker's existing UA-based analytics; browsers degrade silently.
- **`models.dev/zod`**: deferred until someone asks.
- **Trusted publishing**: configured by the owner on npmjs.com (user handles it).

## Deferred

- `models.dev/zod` runtime-validation entrypoint
- Model-level literal ID unions (~10k IDs, d.ts bloat)
- CJS build (only if `require(esm)`-incapable consumers materialize)
