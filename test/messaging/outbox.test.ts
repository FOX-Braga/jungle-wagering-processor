import { expect, test } from "bun:test";
import { createDependencyLink } from "../helpers/dependency-link";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";

function event(body: string | undefined): { eventId: string; eventType: string; version: number } {
  if (!body) throw new Error("Missing event body");
  return JSON.parse(body) as ReturnType<typeof event>;
}

test("two publishers claim distinct work and recover after a confirmed send", async () => {
  const f = await messagingFixture();
  try {
    await f.app.open();
    const changes = { OUTBOX_BATCH_SIZE: 1 };
    const first = await f.start("outbox", "after-send", changes);
    await first.waitLog("after-send");
    const second = await f.start("outbox", "after-send", changes);
    await second.waitLog("after-send");
    const original = [];
    for (let i = 0; i < 2; i++) {
      const delivery = await waitFor(() => f.receive(f.events), "first physical event");
      original.push(event(delivery.Body));
      await f.delete(f.events, delivery.ReceiptHandle!);
    }
    expect(new Set(original.map((item) => item.eventId)).size).toBe(2);
    expect(first.pid).not.toBe(second.pid);
    for (const item of original) {
      expect(item.version).toBe(1);
      expect(
        (await f.app.manager.execute(({ outbox }) => outbox.findById(item.eventId)))?.publishedAt,
      ).toBeUndefined();
    }
    await Promise.all([first.kill(), second.kill()]);
    const recovered = await f.start("outbox", undefined, changes);
    for (const item of original) {
      await recovered.waitLog("published", (log) => log.eventId === item.eventId);
      expect(
        (await f.app.manager.execute(({ outbox }) => outbox.findById(item.eventId)))?.publishedAt,
      ).toBeInstanceOf(Date);
    }
    const replayed = [];
    for (let i = 0; i < 2; i++) {
      const delivery = await waitFor(() => f.receive(f.events), "replayed physical event");
      replayed.push(event(delivery.Body));
      await f.delete(f.events, delivery.ReceiptHandle!);
    }
    expect(replayed.sort((a, b) => a.eventId.localeCompare(b.eventId))).toEqual(
      original.sort((a, b) => a.eventId.localeCompare(b.eventId)),
    );
  } finally {
    await f.close();
  }
}, 35_000);

test("outbox retries a real SQS outage and parks exhausted events without losing their data", async () => {
  const f = await messagingFixture();
  const proxy = await createDependencyLink(new URL(f.config.SQS_ENDPOINT), 80);
  try {
    proxy.setAvailable(false);
    await f.app.open();
    const worker = await f.start("outbox", undefined, {
      SQS_ENDPOINT: proxy.url.origin,
      OUTBOX_MAX_ATTEMPTS: 2,
    });
    const failed = await worker.waitLog("outbox_retry", (log) => log.attempt === 1);
    const parked = await worker.waitLog("outbox_parked", (log) => log.eventId === failed.eventId);
    const before = await f.app.manager.execute(({ outbox }) => outbox.findById(parked.eventId!));
    expect(before?.parkedAt).toBeInstanceOf(Date);
    expect(before?.publishedAt).toBeUndefined();
    expect(before?.attempts).toBe(2);
    expect(before?.payload.eventId).toBe(parked.eventId);
    expect(await f.receive(f.events)).toBeUndefined();
    await worker.kill();

    await f.app.open();
    const retrying = await f.start("outbox", undefined, { SQS_ENDPOINT: proxy.url.origin });
    const delayed = await retrying.waitLog("outbox_retry");
    proxy.setAvailable(true);
    await retrying.waitLog("published", (log) => log.eventId === delayed.eventId);
    const persisted = await f.app.manager.execute(({ outbox }) =>
      outbox.findById(delayed.eventId!),
    );
    expect(persisted?.publishedAt).toBeInstanceOf(Date);
    expect(persisted?.attempts).toBeGreaterThanOrEqual(1);
    expect(
      (await f.app.manager.execute(({ outbox }) => outbox.findById(parked.eventId!)))?.publishedAt,
    ).toBeUndefined();
  } finally {
    await f.close();
    await proxy.close();
  }
}, 35_000);

test("an abandoned publisher claim is recovered even when the original send never ran", async () => {
  const f = await messagingFixture();
  try {
    await f.app.open();
    const original = await f.start("outbox", "before-send", { OUTBOX_BATCH_SIZE: 1 });
    await original.waitLog("before-send");
    expect(await f.receive(f.events)).toBeUndefined();
    await original.kill();

    const recovered = await f.start("outbox");
    const first = await recovered.waitLog("published");
    const second = await recovered.waitLog("published", (log) => log.eventId !== first.eventId);
    expect(second.eventId).toBeDefined();
    const [row] = await f.database.orm.em
      .getConnection()
      .execute<{ published: number }[]>(
        "select count(*)::int as published from wagering.outbox_messages where published_at is not null",
      );
    expect(row?.published).toBe(2);
  } finally {
    await f.close();
  }
}, 25_000);
