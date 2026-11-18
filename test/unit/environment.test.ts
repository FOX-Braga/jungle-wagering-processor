import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadEnvironment } from "../../src/infrastructure/config/environment";
import { validEnvironment } from "../helpers/test-environment";

describe("configuração do ambiente", () => {
  test("carrega configuração tipada e imutável", () => {
    const config = loadEnvironment({ ...validEnvironment, UNRELATED: "ignored" });
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("test");
    expect(config).not.toHaveProperty("UNRELATED");
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("identifica variáveis obrigatórias ausentes", () => {
    expect(() => loadEnvironment({})).toThrow(ConfigurationError);
    expect(() => loadEnvironment({})).toThrow(/DATABASE_URL/);
    expect(() => loadEnvironment({})).toThrow(/SQS_WAGER_DLQ_URL/);
  });

  test.each(["0", "65536", "3000bad", "1e3"])("rejeita a porta %s", (PORT) => {
    expect(() => loadEnvironment({ ...validEnvironment, PORT })).toThrow(/PORT/);
  });

  test("valida a URL do PostgreSQL e mantém credenciais fora do erro", () => {
    const invalid = { ...validEnvironment, DATABASE_URL: "https://user:secret@localhost/jungle" };
    expect(() => loadEnvironment(invalid)).toThrow(/DATABASE_URL/);
    expect(() => loadEnvironment(invalid)).not.toThrow(/secret/);
    expect(() =>
      loadEnvironment({ ...validEnvironment, DATABASE_URL: "postgres://localhost/jungle" }),
    ).toThrow(/DATABASE_URL/);
  });

  test("rejeita fila com origem, conta ou nome incompatível", () => {
    const invalidUrls = [
      "http://127.0.0.1:4568/000000000000/wager-transactions.fifo",
      "http://127.0.0.1:4567/123456789012/wager-transactions.fifo",
      validEnvironment.SQS_WAGER_DLQ_URL,
    ];
    for (const SQS_WAGER_QUEUE_URL of invalidUrls) {
      expect(() => loadEnvironment({ ...validEnvironment, SQS_WAGER_QUEUE_URL })).toThrow(
        /SQS_WAGER_QUEUE_URL/,
      );
    }
  });

  test("rejeita endpoint SQS com caminho ou credenciais", () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        SQS_ENDPOINT: `${validEnvironment.SQS_ENDPOINT}/bad`,
      }),
    ).toThrow(/SQS_ENDPOINT/);
    expect(() =>
      loadEnvironment({ ...validEnvironment, SQS_ENDPOINT: "http://user:secret@127.0.0.1:4567" }),
    ).toThrow(/SQS_ENDPOINT/);
  });

  test("rejeita nível de log e ambiente desconhecidos", () => {
    expect(() => loadEnvironment({ ...validEnvironment, LOG_LEVEL: "verbose" })).toThrow(
      /LOG_LEVEL/,
    );
    expect(() => loadEnvironment({ ...validEnvironment, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
