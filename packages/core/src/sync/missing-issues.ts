export interface MissingModelIssueTarget {
  id: string;
  name: string;
  modelsDir: string;
}

export interface OpenMissingModelIssuesOptions {
  dryRun?: boolean;
  run?: typeof runGh;
}

export function missingModelIssueMarker(providerId: string, modelId: string) {
  return `<!-- models.dev/sync-missing provider=${JSON.stringify(providerId)} model=${JSON.stringify(modelId)} -->`;
}

export function missingModelIssueTitle(providerId: string, modelId: string) {
  return `[missing-model] ${providerId}: ${modelId}`;
}

export function missingModelIssueBody(provider: MissingModelIssueTarget, modelId: string) {
  const expectedPath = `${provider.modelsDir}/${modelId}.toml`;
  return [
    missingModelIssueMarker(provider.id, modelId),
    "",
    "## Missing model",
    "",
    `The **${provider.name}** catalog sync found a remote model that is not in the local catalog.`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Provider | \`${provider.id}\` |`,
    `| Model ID | \`${modelId}\` |`,
    `| Expected path | \`${expectedPath}\` |`,
    "",
    "This provider does not auto-create new model TOMLs because the remote source is not authoritative enough for a full catalog entry.",
    "Please add the model (use `base_model` when matching `models/` metadata exists).",
    "",
    "### Automation",
    "",
    "- Marker above is stable for dedupe across sync runs.",
    "- Issue fixer should treat this as an actionable catalog add.",
    "",
  ].join("\n");
}

export function parseMissingModelIssueMarker(text: string) {
  const match = text.match(
    /<!--\s*models\.dev\/sync-missing\s+provider=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s+model=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*-->/,
  );
  if (match === undefined) return undefined;
  return {
    providerId: JSON.parse(match[1]!) as string,
    modelId: JSON.parse(match[2]!) as string,
  };
}

export async function openMissingModelIssues(
  provider: MissingModelIssueTarget,
  modelIds: string[],
  options: OpenMissingModelIssuesOptions = {},
): Promise<string[]> {
  const uniqueIds = [...new Set(modelIds)].filter((id) => id.length > 0).sort();
  if (uniqueIds.length === 0) return [];

  const run = options.run ?? runGh;
  const notices: string[] = [];
  const labels = ["automation", "model-sync", "missing-model", `provider:${provider.id}`];

  if (options.dryRun) {
    for (const modelId of uniqueIds) {
      const title = missingModelIssueTitle(provider.id, modelId);
      const notice = `Would open GitHub issue for missing model \`${modelId}\` (\`${title}\`)`;
      notices.push(notice);
      console.log(notice);
    }
    return notices;
  }

  for (const label of labels) {
    await ensureLabel(run, label);
  }

  for (const modelId of uniqueIds) {
    const title = missingModelIssueTitle(provider.id, modelId);
    const marker = missingModelIssueMarker(provider.id, modelId);
    const existing = await findOpenMissingModelIssue(run, provider.id, modelId, title);

    if (existing !== undefined) {
      const notice = `Missing model \`${modelId}\` already tracked by #${existing}`;
      notices.push(notice);
      console.log(notice);
      continue;
    }

    const body = missingModelIssueBody(provider, modelId);
    const created = await createIssue(run, title, body, labels);
    const notice = `Opened GitHub issue #${created} for missing model \`${modelId}\``;
    notices.push(notice);
    console.log(notice);
    console.log(`  marker: ${marker}`);
  }

  return notices;
}

async function findOpenMissingModelIssue(
  run: typeof runGh,
  providerId: string,
  modelId: string,
  title: string,
) {
  const marker = missingModelIssueMarker(providerId, modelId);
  const searches = [
    `is:issue is:open in:title "${title.replaceAll('"', "")}"`,
    `is:issue is:open in:body ${JSON.stringify(marker).slice(1, -1)}`,
    `is:issue is:open label:missing-model label:provider:${providerId} ${modelId}`,
  ];

  for (const query of searches) {
    const result = await run(["issue", "list", "--state", "open", "--limit", "20", "--json", "number,title,body", "--search", query]);
    if (result.code !== 0) continue;
    const issues = JSON.parse(result.stdout || "[]") as Array<{ number: number; title: string; body?: string }>;
    const match = issues.find((issue) => {
      if (issue.title === title) return true;
      const parsed = parseMissingModelIssueMarker(issue.body ?? "");
      return parsed?.providerId === providerId && parsed.modelId === modelId;
    });
    if (match !== undefined) return match.number;
  }

  return undefined;
}

async function createIssue(
  run: typeof runGh,
  title: string,
  body: string,
  labels: string[],
) {
  const args = ["issue", "create", "--title", title, "--body", body];
  for (const label of labels) args.push("--label", label);
  const result = await run(args);
  if (result.code !== 0) {
    throw new Error(`gh issue create failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }

  const url = result.stdout.trim();
  const number = url.match(/\/issues\/(\d+)\s*$/)?.[1] ?? url.match(/#(\d+)\s*$/)?.[1];
  if (number === undefined) {
    throw new Error(`gh issue create succeeded but returned no issue number: ${url}`);
  }
  return Number(number);
}

async function ensureLabel(run: typeof runGh, label: string) {
  await run([
    "label",
    "create",
    label,
    "--color",
    "0E8A16",
    "--description",
    "Automated model catalog sync",
    "--force",
  ]);
}

export async function runGh(args: string[]) {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
