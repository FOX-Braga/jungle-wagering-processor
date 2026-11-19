import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Env = NodeJS.ProcessEnv;
type Child = ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;

class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly exitCode: number,
  ) {
    super(`${step} failed (${exitCode})`);
  }
}

let active: Child | undefined;
let interrupted = false;
const stop = () => {
  interrupted = true;
  active?.kill();
};

async function run(args: string[], env: Env, capture = false) {
  const child = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  active = child;
  const read = async (stream: ReadableStream<Uint8Array>, write: NodeJS.WriteStream) => {
    if (capture) return new Response(stream).text();
    for await (const chunk of stream) write.write(chunk);
    return "";
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      read(child.stdout, process.stdout),
      read(child.stderr, process.stderr),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    active = undefined;
  }
}

function bun(...args: string[]) {
  return [process.execPath, "--no-env-file", ...args];
}

function numberAttribute(tag: string, key: string) {
  const value = new RegExp(`\\b${key}="(\\d+(?:\\.\\d+)?)"`).exec(tag)?.[1];
  if (!value || !Number.isFinite(Number(value))) throw new Error(`Missing JUnit ${key}`);
  return Number(value);
}

function testEvidence(xml: string, output: string) {
  const root = /<testsuites\b[^>]+>/.exec(xml)?.[0];
  if (!root) throw new Error("Bun did not produce a JUnit summary");
  const tests = numberAttribute(root, "tests");
  const failed = numberAttribute(root, "failures");
  const skipped = numberAttribute(root, "skipped");
  const failingFiles = new Set<string>();
  for (const match of xml.matchAll(/<testsuite\b[^>]+>/g)) {
    if (numberAttribute(match[0], "failures") === 0) continue;
    const file = /\bfile="([^"]+)"/.exec(match[0])?.[1]?.replaceAll("\\", "/");
    if (file && /^test\/[\w/.-]+\.test\.ts$/.test(file)) failingFiles.add(file);
  }
  return {
    tests,
    passed: tests - failed - skipped,
    failed,
    skipped,
    runnerErrors: Number(/^\s*(\d+) errors?\r?$/m.exec(output)?.[1] ?? 0),
    seconds: numberAttribute(root, "time"),
    failingFiles: [...failingFiles].sort(),
  };
}

function servicePort(output: string, service: string) {
  const port = /^127\.0\.0\.1:(\d+)$/.exec(output.trim())?.[1];
  if (!port || Number(port) <= 0 || Number(port) > 65535) {
    throw new Error(`Missing loopback port for ${service}`);
  }
  return port;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "verify" && mode !== "demo" && mode !== "soak" && mode !== "load") {
    throw new Error("Use verify, demo, soak or load");
  }
  const directory = process.env.PHASE9_EVIDENCE_DIR;
  const project = `jungle-phase9-${crypto.randomUUID().slice(0, 12)}`;
  const cleanEnv = { ...process.env };
  // Keep the host's Docker context and OS environment. Ignore application and Compose overrides.
  for (const key of Object.keys(cleanEnv)) {
    if (
      /^(COMPOSE_|AWS_|POSTGRES_|DATABASE_|TEST_|SQS_|OUTBOX_|REFERENCE_|METRICS_|HTTP_)/i.test(key)
    ) {
      delete cleanEnv[key];
    }
  }
  const dockerEnv = {
    ...cleanEnv,
    POSTGRES_PORT: "0",
    SQS_PORT: "0",
    POSTGRES_USER: "jungle",
    POSTGRES_PASSWORD: "jungle_dev",
    POSTGRES_DB: "jungle",
    AWS_ACCESS_KEY_ID: "000000000000",
    AWS_REGION: "us-east-1",
  };
  const compose = ["docker", "compose", "-p", project, "--env-file", ".env.example"];
  const started = performance.now();
  const steps: { step: string; exitCode: number; seconds: number }[] = [];
  const versions: Record<string, string> = { bun: Bun.version };
  let currentStep = "revision";
  let commit: string | undefined;
  let tests: ReturnType<typeof testEvidence> | undefined;
  let composeStarted = false;
  let failure: string | undefined;
  let services: string[] | undefined;

  async function step(name: string, args: string[], env = cleanEnv, capture = false) {
    currentStep = name;
    const before = performance.now();
    const result = await run(args, env, capture);
    steps.push({
      step: name,
      exitCode: result.exitCode,
      seconds: (performance.now() - before) / 1000,
    });
    return result;
  }

  async function check(name: string, args: string[], env = cleanEnv, capture = false) {
    const result = await step(name, args, env, capture);
    if (result.exitCode !== 0 || interrupted) {
      if (capture && !process.env.CI) process.stderr.write(result.stderr);
      throw new StepFailure(name, result.exitCode);
    }
    return result.stdout.trim();
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    commit = await check("revision", ["git", "rev-parse", "HEAD"], cleanEnv, true);
    if (mode !== "verify") await check("build", bun("run", "build"));
    versions.compose = await check(
      "compose-version",
      ["docker", "compose", "version", "--short"],
      dockerEnv,
      true,
    );
    versions.docker = await check(
      "docker-engine",
      ["docker", "info", "--format", "{{.ServerVersion}}"],
      dockerEnv,
      true,
    );
    composeStarted = true;
    await check(
      "start-services",
      [...compose, "up", "-d", "--wait", "--wait-timeout", "90", "postgres", "sqs"],
      dockerEnv,
    );
    const postgres = servicePort(
      await check("postgres-port", [...compose, "port", "postgres", "5432"], dockerEnv, true),
      "PostgreSQL",
    );
    const sqs = servicePort(
      await check("sqs-port", [...compose, "port", "sqs", "4566"], dockerEnv, true),
      "MiniStack",
    );
    const endpoint = `http://127.0.0.1:${sqs}`;
    const queue = `${endpoint}/000000000000`;
    const database = `postgresql://jungle:jungle_dev@127.0.0.1:${postgres}/jungle`;
    const env = {
      ...cleanEnv,
      NODE_ENV: "test",
      PORT: "3000",
      LOG_LEVEL: "error",
      DATABASE_URL: database,
      TEST_DATABASE_URL: database,
      SQS_ENDPOINT: endpoint,
      SQS_WAGER_QUEUE_URL: `${queue}/wager-transactions.fifo`,
      SQS_WAGER_DLQ_URL: `${queue}/wager-transactions-dlq.fifo`,
      SQS_EVENT_QUEUE_URL: `${queue}/wager-events`,
    };
    const app = (...args: string[]) => [
      process.execPath,
      "--env-file=.env.example",
      "--env-file=.env.test",
      ...args,
    ];
    await check("provision", app("scripts/bootstrap/infra.ts", "provision"), env);
    await check("doctor", app("scripts/bootstrap/infra.ts", "doctor"), env);

    if (mode === "verify") {
      const temp = await mkdtemp(join(tmpdir(), "jungle-junit-"));
      const junit = join(temp, "bun.xml");
      try {
        const result = await step(
          "build-and-tests",
          bun("run", "test:all", "--reporter=junit", `--reporter-outfile=${junit}`),
          { ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
          true,
        );
        if (!process.env.CI) process.stderr.write(result.stdout + result.stderr);
        if (await Bun.file(junit).exists())
          tests = testEvidence(await Bun.file(junit).text(), result.stdout + result.stderr);
        if (result.exitCode !== 0 || interrupted)
          throw new StepFailure("build-and-tests", result.exitCode);
        if (!tests?.tests || tests.failed || tests.runnerErrors)
          throw new Error("Incomplete test evidence");
      } finally {
        await rm(junit, { force: true });
        await rmdir(temp);
      }
    } else if (mode === "demo") {
      await check("demo-http-and-audit", app("test/demo/complete.ts"), env);
      await check(
        "demo-concurrency",
        app("test", "./test/distributed/http-concurrency.test.ts", "-t", "two 80.00 BETs"),
        env,
      );
      await check("demo-commit-before-ack", app("test", "./test/recovery/inbox-demo.test.ts"), env);
    } else {
      const metrics = await check(mode, app(`test/${mode}/run.ts`), env, true);
      console.log(metrics);
      if (directory) {
        await mkdir(directory, { recursive: true });
        await Bun.write(join(directory, `${mode}-results.json`), metrics + "\n");
      }
    }
  } catch (error) {
    failure = currentStep;
    console.error(error instanceof Error ? error.message : `${currentStep} failed`);
  } finally {
    if (composeStarted) {
      try {
        if (failure) {
          // Only service names, states and health. Container logs can contain payloads.
          const status = await step(
            "service-status",
            [...compose, "ps", "-a", "--format", "{{.Service}} {{.State}} {{.Health}}"],
            dockerEnv,
            true,
          );
          if (status.exitCode === 0) services = status.stdout.trim().split(/\r?\n/).filter(Boolean);
        }
        const cleanup = await step("cleanup", [...compose, "down", "--volumes"], dockerEnv);
        if (cleanup.exitCode !== 0) failure ??= "cleanup";
      } catch {
        failure ??= "cleanup";
      }
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  const status = failure || interrupted ? "FAIL" : "PASS";
  const summary = {
    status,
    mode,
    commit,
    project,
    platform: process.platform,
    versions,
    seconds: (performance.now() - started) / 1000,
    failure,
    services,
    tests,
    steps,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (directory) {
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, `${mode}.json`), JSON.stringify(summary, null, 2) + "\n");
  }
  if (status === "FAIL") process.exitCode = 1;
}

void main().catch(() => {
  console.error("Could not run or write Phase 9 evidence");
  process.exitCode = 1;
});
