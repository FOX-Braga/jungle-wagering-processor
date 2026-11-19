# Relatório da Fase 7

## A. Diagnóstico inicial

O repositório começou com a árvore de trabalho limpa. As Fases 1 a 6 já entregavam o motor financeiro compartilhado por HTTP e SQS, as duas rotas de saúde, o ledger imutável, a reconciliação com um único SELECT e recuperação por inbox, outbox e referências persistentes. A API registrava alguns campos de correlação, e a divergência tinha contagem local sem exportação. Faltavam métricas por processo, coleta de estados compartilhados e auditoria em lote.

A instalação congelada, lint, typecheck e build de baseline passaram. A linha de base unitária aprovou 124 testes e a de propriedades aprovou 10. Os primeiros testes dependentes de infraestrutura encontraram PostgreSQL indisponível na porta esperada e MiniStack inacessível. A regressão usou Bun 1.4.4, PostgreSQL 18.3 e MiniStack 1.5.38 nativos, em loopback, com bancos e filas descartáveis. O Docker Compose v5.7.0 validou a configuração. O daemon Linux do Docker Desktop permaneceu indisponível.

## B. Arquitetura de observabilidade

Os adaptadores emitem logs e registram métricas após a conclusão dos respectivos estágios. O caso de uso continua responsável pelas regras financeiras e pelo commit. Cada processo exporta suas métricas em loopback, e um coletor designado lê backlog do banco e do SQS. [ADR 0004](adr/0004-operational-observation.md)

## C. Logs

O logger emite JSON com identificação de instância, evento, campos de correlação e códigos de erro. A saída usa uma lista explícita de campos e omite segredos, payloads, queries e stack traces. Trechos de duas linhas reais em fixtures descartáveis:

```json
{"timestamp":"2026-11-19T02:48:47.887Z","level":"info","instanceId":"phase7-smoke-api","event":"wager.processing.completed","outcome":"PROCESSED","correlationId":"phase7-smoke-correlation","transactionId":"190329b7-4c95-4758-813e-602b1e8e73c5","walletId":"03303202-11fd-4cb8-8db6-2148beb68cf9","providerId":"phase7-smoke"}
{"timestamp":"2026-11-19T02:48:20.454Z","level":"warn","instanceId":"audit-api","event":"reconciliation.divergence","outcome":"divergent","correlationId":"0216eac1-6e37-46f6-be9a-bb5d74266833","walletId":"06c679ed-98f6-40f5-a245-1f1b38f8c143","checkedEntries":1}
```

## D. Métricas

Counters registram status, replay, conflitos, retries, locks, ACKs, resolução de referências, publicação e reconciliação. Histograms registram latência HTTP, do caso de uso, de lock, do SQS, da publicação e da reconciliação. Gauges mostram saúde, heartbeat e backlog persistente. A API compilada apresentou uma transição `PROCESSED` e uma duplicata de replay no smoke. O publisher compilado confirmou os oito eventos pendentes das duas carteiras de smoke. A coleta seguinte mostrou zero eventos pendentes, lag zero e oito eventos visíveis na fila de saída. [Catálogo, labels, coleta e alertas](OBSERVABILITY.md)

## E. Correlação

A correlação passa pelo header HTTP ou pelo envelope SQS e segue até a outbox no commit. Os logs distinguem o ID lógico de entrada, o ID de transporte e o ID estável do evento. O teste de recuperação verificou `correlationId`, `causationId` e `sourceMessageId` no evento terminal emitido pelo worker de referências. Identidades de transporte permanecem fora do hash financeiro.

## F. Saúde

O `doctor` confirmou PostgreSQL, filas SQS, inventário das seis migrations, backlog e dependências de readiness. Os testes cortaram cada conexão TCP isoladamente. Readiness retornou HTTP 503 e liveness permaneceu em 200. A restauração das conexões recuperou readiness, e a API aplicou a operação com a identidade original.

## G. Reconciliação

Saldo, soma e contagem usam o snapshot de um único SELECT em transação somente leitura. Conexões PostgreSQL independentes reconciliaram durante BET, WIN, REFUND, ROLLBACK e LOSS. A projeção de leitura divergente em um banco descartável produziu diferença de `10.00 BRL`, log e métrica, mantendo os dados originais protegidos por constraints e triggers. No smoke normal, saldo materializado e ledger corresponderam a `75.00 BRL`, com diferença de `0.00 BRL`. [Reconciliação](RECONCILIATION.md)

## H. Auditoria

`bun run audit:wallets --batch-size 1` verificou duas carteiras e quatro lançamentos no ambiente de smoke e retornou 0, com zero divergências. Testes do CLI confirmaram exit 1 para divergência e exit 2 para carteira solicitada ausente. A auditoria percorre páginas por ID e usa um snapshot `REPEATABLE READ READ ONLY`.

## I. Segurança

O teste de grants usou logins PostgreSQL restritos para runtime e auditoria. O runtime aplicou um movimento válido e recebeu `42501` em DDL e escrita indevida. O auditor conseguiu consultar o saldo e o ledger com um papel de leitura. A API reduz a superfície com validação estrita, limite de corpo e de admissão, erros sanitizados e Swagger restrito por ambiente. A API financeira de avaliação permanece sem autenticação efetiva. O perfil de produção valida TLS do PostgreSQL e origem HTTPS do SQS. [Política e riscos residuais](SECURITY.md)

## J. Resiliência

Foram exercitados limites de admissão, lock timeout, deadlock, indisponibilidade PostgreSQL e SQS, retry, falha de ACK, redrive, backlog da outbox, recuperação de claims, reinício de workers e resolução de referências. As suítes distribuídas executaram três instâncias simultâneas. A demonstração confirmou quatro entregas, detectou duas duplicatas e recuperou a publicação após reinício. O saldo final foi `75.00 BRL` em quatro entradas, com diferença zero. [Procedimentos](OPERATIONS_RUNBOOK.md)

## K. Testes

Resultados finais em Bun 1.4.4. Os seletores de mensageria repetem casos das suítes completas.

| Comando                      | Aprovados | Reprovados |
| ---------------------------- | --------: | ---------: |
| `bun run test:unit`          |       124 |          0 |
| `bun run test:properties`    |        10 |          0 |
| `bun run test:integration`   |        94 |          0 |
| `bun run test:e2e`           |        14 |          0 |
| `bun run test:concurrency`   |         9 |          0 |
| `bun run test:distributed`   |        10 |          0 |
| `bun run test:messaging`     |        11 |          0 |
| `bun run test:inbox`         |         1 |          0 |
| `bun run test:outbox`        |         3 |          0 |
| `bun run test:dlq`           |         1 |          0 |
| `bun run test:recovery`      |         7 |          0 |
| `bun run test:observability` |         5 |          0 |
| `bun run test:audit`         |         2 |          0 |
| `bun run test:security`      |         2 |          0 |
| `bun run demo:resilience`    |         1 |          0 |

`bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run format:check` e `docker compose --env-file .env.example config --quiet` retornaram 0. Durante a regressão, ajustamos o orçamento de queries de manutenção em testes e migrations, e a leitura de timestamps de referência para usar epoch numérico. Uma rodada unitária concorrente teve timeout de liveness no transporte local. A reexecução isolada aprovou os 124 testes.

## L. Limitações

A validação com as imagens Docker do Compose fica pendente. O ambiente desta execução usou o mesmo MiniStack fixado e uma versão nativa mais recente do PostgreSQL. O workflow GitHub Actions foi atualizado para executar as novas suítes junto com os containers. O workflow hospedado permanece sem execução verificada. A coleta SQS é aproximada, os counters são locais a cada processo e os alertas são limiares operacionais documentados. Prometheus, Grafana e OpenTelemetry permanecem extensões opcionais.

## M. Preparação para a Fase 8

A próxima validação consolida a execução da CI em containers, mede carga com p50/p95/p99 e taxa de erros, reproduz falhas durante carga e revisa arquitetura, requisitos eliminatórios e demonstração técnica com a trilha de auditoria preservada.
