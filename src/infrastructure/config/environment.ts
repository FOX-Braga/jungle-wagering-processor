import { z } from "zod";

export const WAGER_QUEUE_NAME = "wager-transactions.fifo";
export const WAGER_DLQ_NAME = "wager-transactions-dlq.fifo";
export const EVENT_QUEUE_NAME = "wager-events";

const integer = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(fallback);

const databaseUrl = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    Boolean(url.hostname && url.username && url.password) &&
    url.pathname.length > 1 &&
    !url.hash
  );
});

const httpUrl = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
});

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)),
    SHUTDOWN_TIMEOUT_MS: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(100).max(60_000))
      .default(10_000),
    INSTANCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .optional(),
    DATABASE_URL: databaseUrl,
    AWS_REGION: z.string().regex(/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/),
    AWS_ACCESS_KEY_ID: z.string().regex(/^\d{12}$/),
    AWS_SECRET_ACCESS_KEY: z.string().trim().min(1),
    SQS_ENDPOINT: httpUrl,
    SQS_WAGER_QUEUE_URL: httpUrl,
    SQS_WAGER_DLQ_URL: httpUrl,
    SQS_EVENT_QUEUE_URL: httpUrl,
    SQS_POLL_WAIT_SECONDS: integer(1, 20, 10),
    SQS_VISIBILITY_TIMEOUT_SECONDS: integer(2, 300, 30),
    SQS_MAX_RECEIVE_COUNT: integer(1, 100, 3),
    SQS_CONSUMER_CONCURRENCY: integer(1, 32, 4),
    SQS_CONSUMER_NAME: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
      .default("wager-processor"),
    OUTBOX_BATCH_SIZE: integer(1, 100, 25),
    OUTBOX_POLL_INTERVAL_MS: integer(50, 60_000, 1_000),
    OUTBOX_MAX_ATTEMPTS: integer(1, 100, 10),
    OUTBOX_LEASE_SECONDS: integer(5, 300, 30),
    REFERENCE_WORKER_BATCH_SIZE: integer(1, 100, 25),
    REFERENCE_WORKER_INTERVAL_MS: integer(50, 60_000, 1_000),
    REFERENCE_MAX_ATTEMPTS: integer(1, 100, 10),
    LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]),
  })
  .superRefine((config, ctx) => {
    if (!URL.canParse(config.SQS_ENDPOINT)) return;

    const endpoint = new URL(config.SQS_ENDPOINT);
    if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
      ctx.addIssue({ code: "custom", path: ["SQS_ENDPOINT"], message: "Informe apenas a origem" });
    }

    const queues = [
      ["SQS_WAGER_QUEUE_URL", WAGER_QUEUE_NAME],
      ["SQS_WAGER_DLQ_URL", WAGER_DLQ_NAME],
      ["SQS_EVENT_QUEUE_URL", EVENT_QUEUE_NAME],
    ] as const;

    for (const [key, name] of queues) {
      if (!URL.canParse(config[key])) continue;
      const url = new URL(config[key]);
      if (
        url.origin !== endpoint.origin ||
        (key === "SQS_EVENT_QUEUE_URL"
          ? !url.pathname.startsWith(`/${config.AWS_ACCESS_KEY_ID}/`) ||
            !/^\/[0-9]{12}\/[A-Za-z0-9_-]{1,80}$/.test(url.pathname)
          : url.pathname !== `/${config.AWS_ACCESS_KEY_ID}/${name}`) ||
        url.search ||
        url.hash
      ) {
        ctx.addIssue({ code: "custom", path: [key], message: "URL da fila incompatível" });
      }
    }
  });

export type AppConfig = Readonly<z.infer<typeof schema>>;
export const APP_CONFIG = Symbol("APP_CONFIG");

export class ConfigurationError extends Error {
  constructor(keys: readonly string[]) {
    super(`Configuração inválida nas variáveis ${keys.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

export function loadEnvironment(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse({
    ...input,
    SQS_EVENT_QUEUE_URL:
      input.SQS_EVENT_QUEUE_URL ??
      (input.SQS_ENDPOINT &&
        `${input.SQS_ENDPOINT.replace(/\/$/, "")}/${input.AWS_ACCESS_KEY_ID}/${EVENT_QUEUE_NAME}`),
  });
  if (!result.success) {
    const keys = result.error.issues.map((issue) => issue.path.join("."));
    throw new ConfigurationError([...new Set(keys)]);
  }
  return Object.freeze(result.data);
}
