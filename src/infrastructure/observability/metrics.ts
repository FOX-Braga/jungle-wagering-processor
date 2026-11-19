import { AsyncLocalStorage } from "node:async_hooks";

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30];
const sources = ["http", "sqs", "references"] as const;
export type WagerSource = (typeof sources)[number];
const registry = {
  wager_transactions_total: [
    "counter",
    "source",
    sources,
    "status",
    ["PROCESSED", "REJECTED", "PENDING_REFERENCE"],
  ],
  wager_idempotency_duplicates_total: ["counter", "source", sources],
  wager_idempotency_conflicts_total: ["counter", "source", sources],
  wager_processing_retries_total: ["counter", "source", sources],
  wager_wallet_lock_conflicts_total: [
    "counter",
    "reason",
    ["LOCK_TIMEOUT", "DEADLOCK", "SERIALIZATION_FAILURE"],
  ],
  wager_processing_duration_seconds: ["histogram", "source", sources],
  wager_wallet_lock_wait_seconds: ["histogram"],
  wager_http_duration_seconds: ["histogram", "status_class", ["2xx", "3xx", "4xx", "5xx"]],
  wager_sqs_processing_duration_seconds: ["histogram"],
  wager_sqs_poll_duration_seconds: ["histogram"],
  wager_sqs_in_flight: ["gauge"],
  wager_sqs_events_total: [
    "counter",
    "result",
    [
      "received",
      "processed",
      "rejected",
      "failed",
      "deferred",
      "duplicate",
      "acknowledged",
      "ack_failed",
      "retry",
      "awaiting_dlq",
      "permanent_failure",
      "poll_failed",
      "visibility_change_failed",
      "visibility_extension_failed",
      "missing_receipt",
    ],
  ],
  wager_outbox_events_total: [
    "counter",
    "result",
    [
      "claimed",
      "claim_recovered",
      "published",
      "outbox_retry",
      "outbox_parked",
      "outbox_lease_lost",
      "outbox_lease_too_short",
      "outbox_poll_failed",
    ],
  ],
  wager_outbox_publish_duration_seconds: ["histogram"],
  wager_reference_events_total: [
    "counter",
    "result",
    [
      "reference_rescheduled",
      "reference_expired",
      "reference_finalized",
      "reference_lock_conflict",
      "reference_poll_failed",
    ],
  ],
  wager_reference_resolution_duration_seconds: ["histogram"],
  wager_reconciliation_total: ["counter", "result", ["consistent", "divergent", "error"]],
  wager_reconciliation_duration_seconds: ["histogram"],
  wager_worker_last_success_timestamp_seconds: ["gauge"],
  wager_readiness: ["gauge", "dependency", ["postgres", "sqs", "process"]],
  wager_outbox_messages: [
    "gauge",
    "state",
    [
      "unpublished",
      "eligible",
      "retry",
      "active_claim",
      "expired_claim",
      "parked",
      "high_attempts",
    ],
  ],
  wager_outbox_lag_seconds: ["gauge"],
  wager_pending_references: ["gauge", "state", ["pending", "due", "retried"]],
  wager_pending_reference_oldest_age_seconds: ["gauge"],
  wager_inbox_unprocessed: ["gauge"],
  wager_dlq_messages: ["gauge"],
  wager_sqs_queue_messages: [
    "gauge",
    "queue",
    ["wager", "dlq", "events"],
    "state",
    ["visible", "in_flight", "delayed"],
  ],
  wager_shared_collection_available: ["gauge", "dependency", ["postgres", "sqs"]],
  wager_shared_collection_timestamp_seconds: ["gauge", "dependency", ["postgres", "sqs"]],
} as const;

type Name = keyof typeof registry;
type Definition = readonly [
  "counter" | "gauge" | "histogram",
  ...([] | [string, readonly string[]] | [string, readonly string[], string, readonly string[]]),
];
type Series =
  | { type: "counter" | "gauge"; labels: Record<string, string>; value: number }
  | {
      type: "histogram";
      labels: Record<string, string>;
      count: number;
      sum: number;
      buckets: number[];
    };

export class Metrics {
  private readonly series = new Map<Name, Map<string, Series>>();

  constructor(
    readonly instanceId: string,
    readonly role: "api" | "consumer" | "outbox" | "references" = "api",
  ) {}

  record(name: Name, value: number, label?: string, secondary?: string): void {
    const [type, key, choices, secondKey, secondChoices] = registry[name] as Definition;
    if (!Number.isFinite(value) || value < 0) return;
    if (choices ? label === undefined || !choices.includes(label) : label !== undefined) return;
    if (
      secondChoices
        ? secondary === undefined || !secondChoices.includes(secondary)
        : secondary !== undefined
    )
      return;
    const labels = {
      ...(key && label ? { [key]: label } : {}),
      ...(secondKey && secondary ? { [secondKey]: secondary } : {}),
    };
    const identity = JSON.stringify(labels);
    let family = this.series.get(name);
    if (!family) this.series.set(name, (family = new Map<string, Series>()));
    let series = family.get(identity);
    if (!series) {
      series =
        type === "histogram"
          ? { type, labels, count: 0, sum: 0, buckets: buckets.map(() => 0) }
          : { type, labels, value: 0 };
      family.set(identity, series);
    }
    if (series.type === "histogram") {
      series.count++;
      series.sum += value;
      buckets.forEach((bound, index) => {
        if (value <= bound) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      });
    } else {
      series.value = type === "counter" ? series.value + value : value;
    }
  }

  snapshot() {
    return {
      instanceId: this.instanceId,
      role: this.role,
      histogramBoundsSeconds: buckets,
      metrics: Object.fromEntries(
        [...this.series].map(([name, family]) => [name, [...family.values()]]),
      ),
    };
  }

  serve(port: number) {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request) =>
        request.method === "GET" && new URL(request.url).pathname === "/metrics"
          ? Response.json(this.snapshot(), { headers: { "cache-control": "no-store" } })
          : new Response(null, { status: 404 }),
    });
  }
}

export const METRICS = Symbol("METRICS");
export const operationMetrics = new AsyncLocalStorage<{ metrics: Metrics; source: WagerSource }>();
