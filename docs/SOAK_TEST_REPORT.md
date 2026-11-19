# Ensaio de estabilidade

`bun run test:soak` usa PostgreSQL 16.11 e MiniStack 1.5.38 em Compose descartável. A rodada curta foi executada em Windows 10 Home x64, Bun 1.4.4, Docker 29.9.3 e Compose 5.7.0. `SOAK_SECONDS` aceita de 4 a 120 segundos, com 12 por padrão. Em PowerShell, use `$env:SOAK_SECONDS = '60'` antes do comando para a janela de um minuto. [Código](../test/soak/run.ts)

Três APIs recebem dois débitos concorrentes de 80.00 BRL sobre uma carteira de 100.00 BRL a cada lote, mais um débito em carteira independente. Cada resposta da disputa é reenviada ao terceiro processo, e os snapshots históricos são comparados. O gerador agenda até dois lotes por segundo. As contagens HTTP registram apenas submissões de wagers, incluindo replays e a operação extra durante a parada. As aberturas e reconciliações ficam fora dos percentis.

No meio do ensaio, um consumer para depois do commit e antes do ACK. Consumer e publisher são encerrados. Uma BET independente via HTTP confirma enquanto eles estão offline, e uma segunda mensagem entra no SQS. Os workers novos usam a mesma base e filas. O teste verifica o ID da BET original na reentrega, drena a Outbox, confere Inbox e DLQ e reconcilia cada carteira. O auditor existente executa a checagem global ao final. [Recuperação](CHAOS_EVIDENCE.md)

## Rodada de 12 segundos

| Medida                                                              |                         Observado |
| ------------------------------------------------------------------- | --------------------------------: |
| Duração da janela HTTP medida até a última resposta                 |                           11,59 s |
| Submissões HTTP                                                     |                               121 |
| Vazão HTTP                                                          |                           10,44/s |
| Latência HTTP p50 / p95 / p99                                       |         36,88 / 70,66 / 151,03 ms |
| Rejeições originais por saldo / replays                             |                           24 / 48 |
| Entregas lógicas SQS verificadas / reentregas da mensagem bloqueada |                             2 / 1 |
| Latência SQS p50 / p95 / p99                                        | 3.026,67 / 3.237,46 / 3.237,46 ms |
| Eventos pendentes no reinício / após drenagem                       |                             4 / 0 |
| Carteiras e lançamentos auditados                                   |                           26 / 77 |
| Divergências / erros inesperados                                    |                             0 / 0 |

A carteira SQS encerrou com dois débitos, saldo 80.00 BRL e dois recibos. Cada carteira disputada encerrou com 20.00 BRL e um débito. A Inbox e as referências ficaram sem pendências. A janela medida termina na última resposta, e os percentis SQS usam duas amostras e incluem a janela de reentrega. A intensidade é controlada pela agenda do gerador. [JSON de 12 segundos](evidence/phase9/soak-12s.json)

## Rodada de 60 segundos

| Medida                                                              |                         Observado |
| ------------------------------------------------------------------- | --------------------------------: |
| Duração da janela HTTP medida até a última resposta                 |                           59,65 s |
| Submissões HTTP                                                     |                               601 |
| Vazão HTTP                                                          |                           10,08/s |
| Latência HTTP p50 / p95 / p99                                       |        36,68 / 170,61 / 358,84 ms |
| Rejeições originais por saldo / replays                             |                         120 / 240 |
| Entregas lógicas SQS verificadas / reentregas da mensagem bloqueada |                             2 / 1 |
| Latência SQS p50 / p95 / p99                                        | 3.015,31 / 3.263,64 / 3.263,64 ms |
| Eventos pendentes no reinício / após drenagem                       |                             2 / 0 |
| Carteiras e lançamentos auditados                                   |                         122 / 365 |
| Divergências / erros inesperados                                    |                             0 / 0 |

O ensaio repetiu as verificações financeiras da rodada curta. Uma BET HTTP adicional confirmou durante a parada dos workers. O consumer recuperado confirmou a reentrega e a mensagem nova, e Inbox, referências e Outbox terminaram sem trabalho pendente. [JSON de 60 segundos](evidence/phase9/soak-60s.json)
