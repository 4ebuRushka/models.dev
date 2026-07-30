/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "models-dev",
      home: "cloudflare",
    };
  },
  async run() {
    const { spawnSync } = await import("child_process");

    const ret = spawnSync("./script/build.ts", [], {
      cwd: "./packages/web",
      stdio: "inherit",
    });
    if (ret.status !== 0) throw new Error("Build failed");

    const worker = new sst.cloudflare.Worker("Server", {
      url: true,
      // SST 3.17.x only accepts domain as a string (object/aliases need a newer SST).
      domain: $app.stage === "dev" ? "models.dev" : undefined,
      link: [
        new sst.Secret("PosthogToken"),
        new sst.Secret("LakeUrl"),
        new sst.Secret("LakeSecret"),
      ],
      handler: "./packages/function/src/worker.ts",
      assets: {
        directory: "./packages/web/dist",
      },
      transform: {
        worker: {
          observability: { enabled: true },
        },
      },
    });

    // Alias hostname on a different zone; use zoneName so CF provider 6 does not
    // require a separate getZone lookup (filter-based zoneId was undefined).
    if ($app.stage === "dev") {
      new cloudflare.WorkersCustomDomain("OpenCodeDomain", {
        accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID!,
        environment: "production",
        hostname: "models.opencode.ai",
        service: worker.nodes.worker.scriptName,
        zoneName: "opencode.ai",
      });
    }

    return {
      url: worker.url,
    };
  },
});
