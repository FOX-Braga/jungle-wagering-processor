import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

export async function drainHttpApplication(
  app: INestApplication,
  timeoutMs: number,
): Promise<void> {
  const server = app.getHttpServer() as Server;
  const drained = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        server.closeAllConnections();
        reject(new Error("HTTP shutdown timed out"));
      }, timeoutMs);
      timeout.unref();
    });
    await Promise.race([drained.then(() => app.close()), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}
