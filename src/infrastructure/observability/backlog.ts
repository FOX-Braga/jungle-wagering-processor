import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { AppConfig } from "../config/environment";
import type { Metrics } from "./metrics";

interface DatabaseBacklog {
  outbox: Record<
    | "unpublished"
    | "eligible"
    | "retry"
    | "active_claim"
    | "expired_claim"
    | "parked"
    | "high_attempts",
    number
  >;
  references: Record<"pending" | "due" | "retried", number>;
  oldestOutboxSeconds: number;
  oldestReferenceSeconds: number;
  unprocessedInbox: number;
}

export async function readDatabaseBacklog(
  orm: MikroORM,
  maxAttempts: number,
): Promise<DatabaseBacklog> {
  const [row] = await orm.em.getConnection().execute<DatabaseBacklog[]>(
    `
    select (
      select json_build_object(
        'unpublished', count(*),
        'eligible', count(*) filter (where parked_at is null and
          coalesce(next_attempt_at, occurred_at) <= now() and (claim_until is null or claim_until <= now())),
        'retry', count(*) filter (where parked_at is null and attempts > 0),
        'active_claim', count(*) filter (where claim_until > now()),
        'expired_claim', count(*) filter (where claim_until <= now()),
        'parked', count(*) filter (where parked_at is not null),
        'high_attempts', count(*) filter (where attempts >= ?)
      )
      from wagering.outbox_messages where published_at is null
    ) as outbox, (
      select greatest(0, extract(epoch from now() - min(occurred_at)))::double precision
      from wagering.outbox_messages where published_at is null
    ) as "oldestOutboxSeconds", (
      select json_build_object(
        'pending', count(*),
        'due', count(*) filter (where coalesce(reference_next_attempt_at, created_at) <= now()),
        'retried', count(*) filter (where reference_attempts > 0)
      )
      from wagering.wager_transactions where status = 'PENDING_REFERENCE'
    ) as references, (
      select greatest(0, extract(epoch from now() - min(created_at)))::double precision
      from wagering.wager_transactions where status = 'PENDING_REFERENCE'
    ) as "oldestReferenceSeconds", (
      select count(*)::double precision from wagering.inbox_messages where processed_at is null
    ) as "unprocessedInbox"
  `,
    [Math.max(1, maxAttempts - 1)],
  );
  if (!row) throw new Error("No database backlog snapshot");
  return row;
}

export async function readQueueBacklog(client: SQSClient, config: AppConfig) {
  const queues = [
    ["wager", config.SQS_WAGER_QUEUE_URL],
    ["dlq", config.SQS_WAGER_DLQ_URL],
    ["events", config.SQS_EVENT_QUEUE_URL],
  ] as const;
  const signal = AbortSignal.timeout(2_000);
  return Promise.all(
    queues.map(async ([queue, QueueUrl]) => {
      const { Attributes } = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
            "ApproximateNumberOfMessagesDelayed",
          ],
        }),
        { abortSignal: signal },
      );
      const values = {
        visible: Number(Attributes?.ApproximateNumberOfMessages),
        in_flight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible),
        delayed: Number(Attributes?.ApproximateNumberOfMessagesDelayed),
      };
      if (!Object.values(values).every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Incomplete SQS queue backlog");
      }
      return { queue, values };
    }),
  );
}

export async function collectBacklog(
  orm: MikroORM,
  client: SQSClient,
  config: AppConfig,
  metrics: Metrics,
) {
  const [database, sqs] = await Promise.allSettled([
    readDatabaseBacklog(orm, config.OUTBOX_MAX_ATTEMPTS),
    readQueueBacklog(client, config),
  ]);
  for (const [name, snapshot] of [
    ["postgres", database],
    ["sqs", sqs],
  ] as const) {
    const available = snapshot.status === "fulfilled";
    metrics.record("wager_shared_collection_available", available ? 1 : 0, name);
    if (available)
      metrics.record("wager_shared_collection_timestamp_seconds", Date.now() / 1000, name);
  }
  if (database.status === "fulfilled") {
    const state = database.value;
    for (const [label, count] of Object.entries(state.outbox)) {
      metrics.record("wager_outbox_messages", count, label);
    }
    for (const [label, count] of Object.entries(state.references)) {
      metrics.record("wager_pending_references", count, label);
    }
    metrics.record("wager_outbox_lag_seconds", state.oldestOutboxSeconds);
    metrics.record("wager_pending_reference_oldest_age_seconds", state.oldestReferenceSeconds);
    metrics.record("wager_inbox_unprocessed", state.unprocessedInbox);
  }
  if (sqs.status === "fulfilled") {
    for (const { queue, values } of sqs.value) {
      for (const [label, count] of Object.entries(values)) {
        metrics.record("wager_sqs_queue_messages", count, queue, label);
      }
      if (queue === "dlq")
        metrics.record("wager_dlq_messages", values.visible + values.in_flight + values.delayed);
    }
  }
  return database.status === "fulfilled" && sqs.status === "fulfilled";
}
