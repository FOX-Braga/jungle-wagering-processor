import { createConnection, createServer, type Socket } from "node:net";

export async function createDependencyLink(target: URL, port: number) {
  const sockets = new Set<Socket>();
  let enabled = true;
  const server = createServer((client) => {
    if (!enabled) {
      client.destroy();
      return;
    }

    const upstream = createConnection({ host: target.hostname, port: Number(target.port || port) });
    sockets.add(client);
    sockets.add(upstream);

    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });

    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy TCP sem porta");

  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);

  function setAvailable(available: boolean): void {
    enabled = available;
    if (!enabled) {
      for (const socket of sockets) socket.destroy();
    }
  }

  return {
    url,
    setAvailable,
    async close(): Promise<void> {
      setAvailable(false);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
