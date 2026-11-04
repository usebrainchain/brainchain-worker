import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SKILL = "examples/openclaw/brainchain-worker";
const read = (file: string) => readFileSync(join(SKILL, file), "utf8");
const skill = read("SKILL.md");
const config = read("openclaw.json");
const scripts = readdirSync(join(SKILL, "scripts"));
const sources = [skill, config, ...scripts.map((name) => read(join("scripts", name)))].join("\n");

interface Metadata {
  requires: { bins: string[]; env: string[] };
  primaryEnv: string;
  os: string[];
  envVars: { name: string; required: boolean; description: string }[];
}

/** The block as clawhub's schema reads it; it must parse as strict JSON for every reader. */
function metadata(): Metadata {
  const front = /^---\n([\s\S]*?)\n---/.exec(skill)![1]!;
  return (JSON.parse(front.slice(front.indexOf("metadata:") + "metadata:".length)) as { openclaw: Metadata }).openclaw;
}

describe("the worker skill's metadata", () => {
  it("declares every variable the skill and its scripts read, and marks only the key required", () => {
    const { envVars, requires, primaryEnv } = metadata();
    const engine = read("scripts/engine.sh");
    const internal = new Set([...engine.matchAll(/^(?:export )?([A-Z_]+)=/gm)].map((match) => match[1]!));
    // `OPENCLAW_WORKER_*` in the text ends at the underscore, and is no variable.
    const used = new Set([...sources.matchAll(/\b(BRAINCHAIN_[A-Z_]*[A-Z]|OPENCLAW_[A-Z_]*[A-Z]|[A-Z]+_API_KEY)\b/g)].map((match) => match[1]!));
    const declared = new Set(envVars.map((v) => v.name));
    expect([...used].filter((name) => !declared.has(name) && !internal.has(name))).toEqual([]);
    expect(envVars.filter((v) => v.required).map((v) => v.name)).toEqual(requires.env);
    expect(primaryEnv).toBe("BRAINCHAIN_WORKER_KEY");
    for (const v of envVars) expect(v.description.length).toBeGreaterThan(0);
  });

  it("declares every program the skill runs", () => {
    const { bins } = metadata().requires;
    for (const program of ["sh", "npx", "openclaw", "docker"]) expect(bins).toContain(program);
  });

  it("leaves the stake and bond to status, read from the contracts", () => {
    expect(skill).not.toMatch(/\d[\d,]*\s*t?BRAIN\b/);
    expect(skill).toMatch(/`status` shows the stake and bond/);
  });

  it("gives the key command OpenClaw accepts, with the operator running it", () => {
    expect(skill).toContain(`openclaw config set skills.entries.brainchain-worker.apiKey '"0x..."'`);
  });
});

describe("running the skill's scripts", () => {
  it("always goes through sh, since ClawHub's zips carry no execute bit", () => {
    const repoReadme = readFileSync("README.md", "utf8");
    for (const text of [skill, repoReadme]) {
      const mentions = [...text.matchAll(/.{0,40}scripts\/(?:setup|engine)\.sh/g)].map((match) => match[0]);
      expect(mentions.length).toBeGreaterThan(0);
      for (const mention of mentions) expect(mention).toMatch(/\bsh '?[^\s']*scripts\/(?:setup|engine)\.sh$/);
    }
  });

  it("are valid for sh", () => {
    for (const name of scripts) expect(spawnSync("sh", ["-n", join(SKILL, "scripts", name)]).status).toBe(0);
  });
});

describe("the sandbox config", () => {
  it("caps what one brief can use and clears what a killed turn leaves", () => {
    expect(config).toMatch(/pidsLimit: 256/);
    expect(config).toMatch(/memory: "1g"/);
    expect(config).toMatch(/cpus: 1/);
    expect(config).toMatch(/prune: \{ idleHours: 1, maxAgeDays: 1 \}/);
  });

  it("names each turn's container and workspace from what engine.sh sets", () => {
    expect(config).toContain('containerPrefix: "openclaw-bc-${OPENCLAW_WORKER_RUN}-"');
    expect(config).toContain('workspaceRoot: "${OPENCLAW_WORKER_SANDBOXES}"');
    expect(read("scripts/engine.sh")).toContain("name=openclaw-bc-$OPENCLAW_WORKER_RUN-");
  });
});

describe("engine.sh", () => {
  /** A copy with no execute bit, as ClawHub installs it, run with stand-ins for openclaw and docker. */
  function engine(openclaw: string, docker = 'echo "docker $*" >> "$LOG"; [ "$1" != ps ] || echo abc123') {
    const root = mkdtempSync(join(tmpdir(), "brainchain-engine-"));
    const copy = join(root, "my skill");
    cpSync(SKILL, copy, { recursive: true });
    for (const name of scripts) chmodSync(join(copy, "scripts", name), 0o644);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "calls.log");
    writeFileSync(log, "");
    for (const [name, body] of [
      ["openclaw", openclaw],
      ["docker", docker],
    ] as const) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const state = join(root, "state");
    const result = spawnSync("sh", [join(copy, "scripts", "engine.sh")], {
      input: "the brief",
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: root, LOG: log, OPENCLAW_WORKER_STATE: state },
    });
    return { ...result, calls: readFileSync(log, "utf8"), root, state };
  }

  const writesWork = 'mkdir -p "$OPENCLAW_WORKER_SANDBOXES/w"; echo "run=$OPENCLAW_WORKER_RUN"; cat >/dev/null';

  it("runs from a copy with no execute bit and a space in its path, and gives back the turn's output", () => {
    const { status, stdout } = engine(writesWork);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^run=\w+\n$/);
  });

  it("removes this turn's container and workspace, and nothing else, when the turn ends", () => {
    const { calls, stdout, state, root } = engine(writesWork);
    const run = /run=(\w+)/.exec(stdout)![1]!;
    expect(calls).toContain(`docker ps -aq --filter label=openclaw.sandbox=1 --filter name=openclaw-bc-${run}-`);
    expect(calls).toContain("docker rm -f abc123");
    expect(existsSync(join(state, "sandboxes", run))).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith("brainchain-task."))).toEqual([]);
  });

  it("keeps a failed turn's exit code and prints nothing, with or without Docker to clean up", () => {
    const failed = engine("cat >/dev/null; exit 3");
    expect(failed.status).toBe(3);
    expect(failed.stdout).toBe("");
    const noDocker = engine("cat >/dev/null; exit 1", 'echo "Cannot connect" >&2; exit 1');
    expect(noDocker.status).toBe(1);
    expect(noDocker.stdout).toBe("");
  });

  it("cleans up when the worker stops it", async () => {
    const root = mkdtempSync(join(tmpdir(), "brainchain-engine-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "calls.log");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "docker $*" >> "${log}"\n[ "$1" != ps ] || echo abc123\n`);
    writeFileSync(join(bin, "openclaw"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "openclaw"), 0o755);
    const child = spawn("sh", [join(SKILL, "scripts", "engine.sh")], {
      detached: true,
      stdio: "ignore",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: root, OPENCLAW_WORKER_STATE: join(root, "state") },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.kill(-child.pid!, "SIGTERM");
    const code = await new Promise((resolve) => child.on("exit", (exit) => resolve(exit)));
    expect(code).toBe(143);
    expect(readFileSync(log, "utf8")).toContain("docker rm -f abc123");
  });
});
