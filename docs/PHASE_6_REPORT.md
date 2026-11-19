# Relatório da Fase 6

## Diagnóstico inicial

O repositório já tinha API HTTP, domínio financeiro, PostgreSQL com migrations, Inbox transacional e gravação de eventos na Outbox. O MiniStack já fornecia as filas FIFO de entrada e DLQ. O caminho HTTP e os testes de concorrência anteriores serviram de base para acrescentar os três processos de mensageria. A primeira execução da regressão teve um timeout de `CREATE DATABASE` em uma base descartável. O cenário voltou a passar nas execuções seguintes.

## Componentes e evidências

| Área               | Implementação e resultado                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infraestrutura SQS | Entrada `wager-transactions.fifo`, DLQ `wager-transactions-dlq.fifo` e saída standard `wager-events`. Conferidos FIFO, redrive, visibilidade, long polling, retenção e leitura via AWS SDK. Um MiniStack isolado preservou fila, redrive e uma mensagem após reinício real do container.                              |
| Consumer e Inbox   | `WagerTransactionRequested` validado com o contrato financeiro compartilhado. A Inbox usa `(consumerName, messageId)`, hash canônico e commit único com os efeitos financeiros. `DeleteMessage` só ocorre após o retorno do commit.                                                                                   |
| HTTP/SQS           | O mesmo comando enviado nas duas ordens e simultaneamente gerou uma única movimentação. Três consumers independentes processaram em paralelo. Cinquenta entregas com IDs de transporte distintos e a mesma identidade financeira resultaram em 50 recibos, um débito e um único conjunto de eventos para esse débito. |
| Outbox             | Dois publishers processaram claims distintos. Workers encerrados antes ou após o envio foram substituídos, preservando payload e `eventId`. Uma indisponibilidade real de conexão manteve o evento no banco, com retry ou estacionamento.                                                                             |
| DLQ                | MiniStack moveu o corpo original de JSON inválido e de uma identidade em conflito após o limite. O reenvio selecionado com o conteúdo correto confirmou replay sem nova movimentação.                                                                                                                                 |
| Referências        | REFUND antes de BET e ROLLBACK antes de WIN foram resolvidos com o mesmo `transactionId`. A referência ausente teve agenda persistida e terminou em `REFERENCE_NOT_FOUND`. Uma referência de outra carteira foi rejeitada com `INVALID_REFERENCE`.                                                                    |
| Recuperação        | Processos foram encerrados em pontos controlados antes do commit, após commit antes do ACK, antes de envio, após envio e durante resolução de referência. A conexão PostgreSQL também foi cortada durante uma transação. A regressão verifica rollback ou redelivery com os registros esperados.                      |
| Shutdown           | A suíte de recuperação exercitou drenagem e renovação de visibilidade. O entrypoint do consumer também iniciou em Linux e encerrou sob SIGTERM real com código 0.                                                                                                                                                     |

O teste de corte de conexão durante o commit expôs uma mensagem de erro do PostgreSQL sem SQLSTATE. A normalização agora a classifica como indisponibilidade transitória. A suíte verifica o retry e confere que Inbox, wager e outbox ficam sem a escrita parcial.

## Verificação

As suítes de integração e recuperação rodaram em Bun 1.4.4 no Windows, com PostgreSQL 16.11 e MiniStack 1.5.38 em containers. O smoke de SIGTERM rodou em um container Linux com Bun. Os comandos usam bancos e filas temporários.

| Comando                    | Aprovados | Reprovados | Duração da suíte |
| -------------------------- | --------: | ---------: | ---------------: |
| `bun run test:unit`        |       124 |          0 |           1,85 s |
| `bun run test:properties`  |        10 |          0 |           0,43 s |
| `bun run test:integration` |        94 |          0 |          26,82 s |
| `bun run test:e2e`         |        14 |          0 |          11,61 s |
| `bun run test:concurrency` |         9 |          0 |           3,30 s |
| `bun run test:messaging`   |        11 |          0 |          57,70 s |
| `bun run test:inbox`       |         1 |          0 |           5,26 s |
| `bun run test:outbox`      |         3 |          0 |          22,86 s |
| `bun run test:dlq`         |         1 |          0 |           4,03 s |
| `bun run test:recovery`    |         5 |          0 |          35,52 s |
| `bun run test:distributed` |        10 |          0 |          20,23 s |
| `bun run demo:resilience`  |         1 |          0 |          14,15 s |

`bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, `bun run format:check` e `bun run build` também terminaram com código 0. Os tempos da tabela são do test runner. Comandos que selecionam cenários podem repetir testes de outras suítes.

## Demonstração e invariante financeira

`bun run demo:resilience` enviou quatro mensagens, registrou quatro ACKs após o reinício e detectou duas entregas repetidas. O banco registrou três recibos lógicos, quatro transações incluindo a abertura, quatro lançamentos e nove eventos com publicação confirmada. A reconciliação reconstruiu `75.00 BRL` pelo ledger, igual ao saldo materializado, com diferença `0.00 BRL`. [Demonstração](RESILIENCE_DEMO.md)

## Operação e Fase 7

O destino de eventos usa entrega at-least-once. Consumidores downstream deduplicam por `eventId`. O limite de falhas da Outbox preserva eventos estacionados no PostgreSQL para reativação seletiva. DLQ, backoff, expiração de referências, diagnóstico e procedimento de recuperação estão documentados. A Fase 7 pode ampliar reconciliação operacional, exportação de métricas, alertas, auditoria e hardening. [Arquitetura de mensageria](MESSAGING_ARCHITECTURE.md) · [Runbook](FAILURE_SCENARIOS.md)
