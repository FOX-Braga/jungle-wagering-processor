import { z } from "zod";

export const WAGER_QUEUE_NAME = "wager-transactions.fifo";
export const WAGER_DLQ_NAME = "wager-transactions-dlq.fifo";

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
    DATABASE_URL: databaseUrl,
    AWS_REGION: z.string().regex(/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/),
    AWS_ACCESS_KEY_ID: z.string().regex(/^\d{12}$/),
    AWS_SECRET_ACCESS_KEY: z.string().trim().min(1),
    SQS_ENDPOINT: httpUrl,
    SQS_WAGER_QUEUE_URL: httpUrl,
    SQS_WAGER_DLQ_URL: httpUrl,
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
    ] as const;

    for (const [key, name] of queues) {
      if (!URL.canParse(config[key])) continue;
      const url = new URL(config[key]);
      if (
        url.origin !== endpoint.origin ||
        url.pathname !== `/${config.AWS_ACCESS_KEY_ID}/${name}` ||
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
  const result = schema.safeParse(input);
  if (!result.success) {
    const keys = result.error.issues.map((issue) => issue.path.join("."));
    throw new ConfigurationError([...new Set(keys)]);
  }
  return Object.freeze(result.data);
}
