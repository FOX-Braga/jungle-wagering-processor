# Relatório da Fase 08 — SQS Consumer e Transactional Inbox

Validação local em 18 de novembro de 2026 com Bun 1.4.4 no Windows, PostgreSQL 16.11 e MiniStack 1.5.38 no Docker Compose. A fase partiu da integração HTTP e SQS existente e manteve o caso de uso financeiro compartilhado. [Diagnóstico](PHASE_8_DIAGNOSIS.md)

## Decisões

- O envelope explícito usa `schemaVersion: 1`. Envelopes anteriores sem esse campo continuam válidos. O hash SHA-256 usa os campos financeiros canônicos e permanece estável com a reordenação de propriedades e mudanças em metadados do transporte.
- A Inbox usa chave primária `(consumer_name, message_id)`. Uma nova conclusão registra o ID do wager. A chave idempotente global e a unicidade de `(provider_id, external_transaction_id)` protegem replays entre HTTP e SQS e entre IDs lógicos diferentes. A transação concorrente que perde uma disputa de unicidade sofre rollback e relê o vencedor.
- A carteira é travada no PostgreSQL. Wager, carteira, ledger, Inbox e eventos da Outbox participam da mesma transação quando aplicáveis. O consumer usa o `ReceiptHandle` somente depois do retorno do commit. Uma falha antes do commit permite reaplicar a operação. Após commit, a reentrega confirma o replay persistido.
- Rejeições financeiras e referências pendentes geram resultados duráveis e são confirmadas. Erros transitórios recebem espera crescente até 30 s e ficam sujeitos ao limite do broker. Envelope ou conflito permanente acelera o redrive nativo, que preserva o corpo na DLQ. O polling aplica jitter nas falhas de transporte.
- O worker cancela polling no shutdown, devolve entregas ainda em espera e drena o processamento ativo até `SHUTDOWN_TIMEOUT_MS`. Cada réplica limita o trabalho recebido e mantém a ordem por grupo dentro do lote. [Arquitetura de mensageria](MESSAGING_ARCHITECTURE.md)

## Banco e filas

A migration `Migration20261118000600` adiciona `transaction_id` opcional, `fk_inbox_wager` e `ck_inbox_transaction_completed`. Os testes aplicaram a migration em banco limpo e em banco com recibo legado, verificaram ambas as constraints por SQL e provaram que o rollback recusa descartar vínculos. Os bancos locais configurados nas portas 5432 e 5434 ficaram com sete migrations aplicadas e zero pendentes. O Compose recebeu também `Migration20261118000500`, índice operacional da fase anterior.

O provisionamento com `.env.example` executou duas vezes e convergiu para as mesmas três filas. O segundo ciclo aplicou zero migrations. A inspeção confirmou FIFO na origem e na DLQ, visibilidade de 30 s, long polling de 10 s na origem, redrive para a DLQ após três recebimentos e retenção de 14 dias na DLQ. O `doctor` confirmou acesso às dependências. [Schema](DATABASE_SCHEMA.md) · [Runbook](OPERATIONS_RUNBOOK.md)

## Aceite financeiro

`bun run demo:inbox` criou uma carteira de `100.00 BRL` pela API. Após uma BET de `25.00 BRL`, o teste leu diretamente o recibo processado e, pela API, o wager e seu saldo. Interrompeu o processo antes do primeiro `DeleteMessage`. Um segundo PID confirmou a reentrega, e um novo envio do mesmo envelope passou pelo mesmo replay. Uma mensagem de versão incompatível foi recebida na DLQ com o corpo intacto.

```json
{
  "status": "PASS",
  "scenario": "transactional-inbox",
  "redeliveryAttempt": 2,
  "dlqAttempt": 3,
  "receipts": 1,
  "wagers": 2,
  "debit": 1,
  "credit": 1,
  "events": 4,
  "balance": "75.00",
  "difference": "0.00"
}
```

As duas transações da demo são a abertura e a BET. A auditoria contou duas entradas no ledger. A suíte distribuída também manteve três processos em trabalho simultâneo e confirmou 50 entregas equivalentes com um único débito. Com duas apostas de `80.00 BRL` para uma carteira de `100.00 BRL`, persistiu uma rejeição por saldo insuficiente e o saldo reconciliou em `20.00 BRL`. O conflito simultâneo de ID lógico entre carteiras manteve o wager vencedor, reverteu os efeitos do concorrente e enviou a entrega conflitante à DLQ.

## Verificação

| Comando                                                        | Aprovados | Falhas | Ignorados |    Tempo |
| -------------------------------------------------------------- | --------: | -----: | --------: | -------: |
| `bun --env-file=.env.example --env-file=.env.test test ./test` |       287 |      0 |         0 | 170,52 s |
| `bun run demo:inbox`                                           |         1 |      0 |         0 |   6,39 s |

A regressão cobriu 29 arquivos. A demo repete um caso da suíte completa. Lint, typecheck, build, formatação, configuração do Compose e `git diff --check` foram aprovados.

- Uma execução inicial da auditoria em paralelo com outras suítes excedeu o timeout de uma migration. O fixture usa um orçamento maior para migrations no banco descartável e aplica os timeouts normais aos testes de runtime.

## Arquivos

| Área                           | Arquivos e finalidade                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrato e execução SQS        | `src/infrastructure/messaging/wager-message.ts` valida a versão. `wager-consumer.ts` controla processamento em lotes, visibilidade, classificação e ACK. `worker-loop.ts` implementa jitter e cancelamento.                                                                                                                                                                                                                                                                                                             |
| Caso de uso e Inbox            | `src/application/use-cases/process-wager-transaction.use-case.ts`, `src/domain/messaging/inbox-message.ts`, `src/infrastructure/persistence/entities/financial-entities.ts` e `repositories/messaging-repositories.ts` ligam recibo e wager no commit. `migrations/Migration20261118000600.ts` aplica o vínculo e as constraints.                                                                                                                                                                                       |
| Provisionamento e configuração | `scripts/bootstrap/queues.ts` reconcilia atributos de filas, `infra.ts` provisiona e diagnostica, e `migrate.ts` aplica e lista migrations. `.env.example`, `docker-compose.yml`, `src/infrastructure/config/environment.ts` e `package.json` expõem o lote, o worker e a demo.                                                                                                                                                                                                                                         |
| Evidências automatizadas       | `test/unit/messaging/wager-message.test.ts` cobre envelope e decisões do loop. `test/integration/foundation.test.ts` verifica o broker e a baseline. `test/integration/persistence/migrations.test.ts` cobre compatibilidade e SQL. `test/messaging/consumer-batch.test.ts`, `test/distributed/messaging-concurrency.test.ts` e `test/recovery/inbox-demo.test.ts` exercitam lote, concorrência e crash. `test/helpers/messaging-fixtures.ts` e `test/helpers/test-database.ts` preparam processos e recursos isolados. |
| Operação                       | `README.md`, `docs/DATABASE_SCHEMA.md`, `docs/MESSAGING_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/REQUIREMENTS_MATRIX.md` e `docs/TEST_PLAN.md` documentam contratos, procedimentos e critérios. `docs/PHASE_8_DIAGNOSIS.md` e este relatório registram a evolução e as evidências.                                                                                                                                                                                                                         |

A árvore de trabalho também contém mudanças anteriores de API, auditoria, segurança e observabilidade. [Relatório da Fase 7](PHASE_7_REPORT.md)

### Inventário em relação a `e018296`

A lista inclui as mudanças das duas fases presentes na árvore de trabalho. `M` indica alteração e `A` indica arquivo novo.

<details>
<summary>Arquivos criados e alterados</summary>

```text
M  .env.example
M  .github/workflows/ci.yml
M  ARCHITECTURE.md
M  README.md
M  docker-compose.yml
M  docs/API_CONTRACT.md
M  docs/DATABASE_SCHEMA.md
M  docs/FAILURE_SCENARIOS.md
M  docs/MESSAGING_ARCHITECTURE.md
M  docs/REQUIREMENTS_MATRIX.md
M  docs/TEST_PLAN.md
M  mikro-orm.config.ts
M  package.json
M  scripts/bootstrap/infra.ts
M  scripts/bootstrap/migrate.ts
M  scripts/bootstrap/queues.ts
M  src/app.module.ts
M  src/application/commands/financial-commands.ts
M  src/application/ports/repositories/financial-repositories.ts
M  src/application/ports/transaction-manager.ts
M  src/application/services/financial-events.ts
M  src/application/services/financial-input.ts
M  src/application/use-cases/process-wager-transaction.use-case.ts
M  src/application/use-cases/reconcile-wallet.use-case.ts
M  src/domain/events/integration-event.ts
M  src/domain/messaging/inbox-message.ts
M  src/infrastructure/config/environment.ts
M  src/infrastructure/messaging/outbox-publisher.ts
M  src/infrastructure/messaging/reference-worker.ts
M  src/infrastructure/messaging/sqs-client.ts
M  src/infrastructure/messaging/sqs.service.ts
M  src/infrastructure/messaging/wager-consumer.ts
M  src/infrastructure/messaging/wager-message.ts
M  src/infrastructure/messaging/worker-loop.ts
M  src/infrastructure/observability/logger.ts
M  src/infrastructure/observability/readiness.service.ts
M  src/infrastructure/persistence/entities/financial-entities.ts
M  src/infrastructure/persistence/mappers/financial-mappers.ts
M  src/infrastructure/persistence/repositories/ledger-repository.ts
M  src/infrastructure/persistence/repositories/messaging-repositories.ts
M  src/infrastructure/persistence/repositories/wager-repository.ts
M  src/infrastructure/persistence/repositories/wallet-repository.ts
M  src/infrastructure/persistence/transaction/mikro-transaction-manager.ts
M  src/main.ts
M  src/presentation/http/controllers/wager.controller.ts
M  src/presentation/http/controllers/wallet.controller.ts
M  src/presentation/http/http-application.ts
M  src/presentation/http/http-exception.filter.ts
M  src/presentation/http/request-context.ts
M  src/worker.main.ts
M  test/distributed/messaging-concurrency.test.ts
M  test/helpers/messaging-fixtures.ts
M  test/helpers/test-database.ts
M  test/integration/foundation.test.ts
M  test/integration/persistence/migrations.test.ts
M  test/unit/messaging/wager-message.test.ts
A  docs/OBSERVABILITY.md
A  docs/OPERATIONS_RUNBOOK.md
A  docs/PHASE_7_REPORT.md
A  docs/PHASE_8_DIAGNOSIS.md
A  docs/PHASE_8_REPORT.md
A  docs/RECONCILIATION.md
A  docs/SECURITY.md
A  docs/adr/0004-operational-observation.md
A  scripts/audit/wallets.ts
A  scripts/bootstrap/database-privileges.sql
A  scripts/diagnostics/operations.ts
A  src/infrastructure/observability/backlog.ts
A  src/infrastructure/observability/dependency-probe.ts
A  src/infrastructure/observability/metrics.ts
A  src/infrastructure/observability/wager-observation.ts
A  src/infrastructure/persistence/financial-audit.ts
A  src/infrastructure/persistence/migrations/Migration20261118000500.ts
A  src/infrastructure/persistence/migrations/Migration20261118000600.ts
A  test/audit/financial-audit.test.ts
A  test/messaging/consumer-batch.test.ts
A  test/observability/operations.test.ts
A  test/recovery/inbox-demo.test.ts
A  test/recovery/operations.test.ts
A  test/security/security.test.ts
```

</details>

## Limites da validação

A comprovação de fila e redrive usou MiniStack local. Com lote maior que um, o SQS conta também as entregas que aguardam mensagens anteriores do mesmo grupo. Falhas consecutivas no início do lote podem consumir o limite de recebimentos das seguintes. O valor padrão é uma mensagem por poll. Os failpoints de crash e de ACK fazem parte do processo de testes.

## Checklist de aceite local

- [x] SQS FIFO provisionado
- [x] DLQ provisionada
- [x] Consumer operacional com long polling
- [x] Inbox persistente
- [x] Processamento SQL atômico
- [x] ACK após commit
- [x] Idempotência por `messageId`
- [x] Idempotência financeira entre API e SQS
- [x] Conflitos de payload detectados
- [x] Retries limitados
- [x] Redrive funcional
- [x] Shutdown gracioso
- [x] Três consumidores testados
- [x] Recuperação após crash validada
- [x] Regressão aprovada
- [x] Migrations consistentes
- [x] Typecheck aprovado
- [x] Lint aprovado
- [x] Documentação atualizada
- [x] Demo reproduzível
