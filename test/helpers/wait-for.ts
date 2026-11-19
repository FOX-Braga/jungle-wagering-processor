export async function waitFor<T>(
  poll: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeout = 10_000,
): Promise<T> {
  const deadline = performance.now() + timeout;
  do {
    const result = await poll();
    if (result !== undefined) return result;
    await Bun.sleep(100);
  } while (performance.now() < deadline);
  throw new Error(`Tempo esgotado aguardando ${description}`);
}
