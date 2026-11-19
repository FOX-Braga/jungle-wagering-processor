import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { httpClient } from "./http-client";
import { waitFor } from "./wait-for";

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a localhost port");
  return address.port;
}

export async function launchApi(
  databaseUrl: URL,
  instanceId: string,
  port?: number,
  logLevel: "info" | "warn" = "info",
) {
  const entrypoint = "dist/src/main.js";
  if (!existsSync(entrypoint)) throw new Error("Run bun run build first");
  const assignedPort = port ?? (await availablePort());
  const url = `http://127.0.0.1:${assignedPort}`;
  const child = Bun.spawn([process.execPath, "--no-env-file", entrypoint], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(assignedPort),
      DATABASE_URL: databaseUrl.href,
      INSTANCE_ID: instanceId,
      LOG_LEVEL: logLevel,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  async function stop(): Promise<void> {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await Promise.all([stdout, stderr]);
  }

  try {
    await waitFor(
      async () => {
        if (child.exitCode !== null)
          throw new Error(`API process ${instanceId} exited before readiness`);
        try {
          const response = await fetch(`${url}/health/ready`, {
            signal: AbortSignal.timeout(1000),
          });
          await response.body?.cancel();
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      `readiness for ${instanceId}`,
      12_000,
    );
    return {
      id: instanceId,
      pid: child.pid,
      port: assignedPort,
      url,
      client: httpClient(url),
      stop,
      stdout,
      stderr,
    };
  } catch (error) {
    await stop();
    const diagnostic = (await stderr).slice(-2000);
    throw new Error(`Cannot start ${instanceId} on port ${assignedPort}. ${diagnostic}`, {
      cause: error,
    });
  }
}
