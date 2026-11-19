# Relatório de carga

`bun run test:load` executou os oito cenários com três APIs, três consumidores SQS e dois publishers independentes. Foram concluídas 2.683 operações HTTP ou entregas SQS, sem erros inesperados. A auditoria leu **88 carteiras e 2.491 lançamentos**, com zero divergências. O JSON registra os parâmetros e as amostras agregadas da rodada. [Evidência da execução](evidence/load-final.json) · [Código](../test/load/run.ts)

## Ambiente

- Windows 10 Home, Intel Xeon E5-2620 v3 a 2,40 GHz, 12 CPUs lógicas e aproximadamente 16 GiB de RAM.
- Bun 1.4.4 no host. Docker 29.9.3, Compose 5.7.0 e backend Linux x86-64 com 12 CPUs lógicas e aproximadamente 7,7 GiB disponíveis.
- PostgreSQL 16.11 e MiniStack 1.5.38 em containers locais. Transporte HTTP em loopback, sem proxy remoto. Banco migrado e filas descartáveis por execução.
- Pool PostgreSQL de até dez conexões por processo e lock timeout de 1 s. Os consumers usam quatro slots por processo, uma mensagem por poll e visibilidade de 10 s no fixture. Cada publisher usa lote de 25, polling de 100 ms e lease de 5 s.
- O gerador Bun registrou pico de RSS de 123,34 MiB e 3.078 ms de CPU durante a execução inteira. A medida cobre o gerador e sua verificação, com APIs, workers e containers em outros processos.

## Metodologia e reprodução

Prepare as dependências locais e execute o benchmark sem rodar outras suítes simultaneamente.

```powershell
bun run infra:setup
bun run test:load
```

A rodada aqueceu cada API com uma abertura e uma BET. Cada cenário abriu carteiras próprias, excluídas do tempo de requisições. O gerador programou 40 trabalhos por segundo, por 3 segundos por cenário e 30 segundos no cenário sustentado. Doze slots limitaram o paralelismo. O cenário de rajada disponibilizou os 120 trabalhos de imediato. A distribuição foi determinística com seed `20261118`. O benchmark usou 12 carteiras por cenário, exceto a hot wallet. A agenda do teste é independente dos IDs escolhidos pela API.

| Variável                 |   Padrão | Controle                                             |
| ------------------------ | -------: | ---------------------------------------------------- |
| `LOAD_RATE`              |       40 | Trabalhos/s e multiplicador do total da rajada       |
| `LOAD_DURATION_SECONDS`  |        3 | Janela de chegadas de L1 a L7                        |
| `LOAD_SUSTAINED_SECONDS` |       30 | Janela de L8                                         |
| `LOAD_WORKERS`           |       12 | Slots concorrentes do gerador                        |
| `LOAD_WALLETS`           |       12 | Carteiras por cenário, salvo L2                      |
| `LOAD_INSTANCES`         |        3 | Processos de API e, em L6, de consumo                |
| `LOAD_SEED`              | 20261118 | Seed da distribuição de carteira e mix               |
| `LOAD_REPLAY_PERCENT`    |       30 | Probabilidade configurada de replay em L3            |
| `LOAD_MIX_PERCENT`       |      100 | Fração de sequências de seis operações em L4         |
| `LOAD_SCENARIOS`         |  L1 a L8 | Lista separada por vírgulas para selecionar cenários |

`.env.test` fornece `TEST_DATABASE_URL`. O gerador usa o mesmo guard de testes, que exige PostgreSQL e SQS locais. Para testar portas diferentes do Compose, aponte `TEST_DATABASE_URL`, `SQS_ENDPOINT` e as URLs de fila para o projeto local correspondente.

Latência HTTP mede da chamada ao recebimento da resposta JSON. Em SQS, mede do início da publicação à observação do ACK do consumer. Os percentis usam nearest rank. Throughput divide respostas ou ACKs pelo tempo da primeira janela programada até a última conclusão. A coluna de Outbox mede o p95 entre `occurred_at` e `published_at` das linhas associadas ao cenário, incluindo a abertura. O JSON inclui a idade do evento pendente mais antigo observada na drenagem. O gerador registra atraso de agendamento à parte da latência de requisição.

## Resultado medido

| Cenário                             | Concluídos | Operações/s | p50 ms | p95 ms | p99 ms | Erro | Conflitos de lock | Outbox lag p95 ms |
| ----------------------------------- | ---------: | ----------: | -----: | -----: | -----: | ---: | ----------------: | ----------------: |
| L1 · BET em carteiras independentes |        120 |       39,32 |  45,59 |  86,75 | 133,55 |   0% |                 0 |            229,25 |
| L2 · Hot wallet                     |        120 |       39,96 |  30,05 |  60,88 |  70,73 |   0% |                 0 |             99,00 |
| L3 · Idempotência                   |        163 |       54,31 |  25,27 |  36,13 |  43,52 |   0% |                 0 |            109,85 |
| L4 · Mix com reversões              |        720 |      117,25 |  85,63 | 185,18 | 253,21 |   0% |                 0 |            267,00 |
| L5 · Rajada HTTP em três APIs       |        120 |      150,25 |  67,40 | 120,72 | 168,08 |   0% |                 0 |            330,70 |
| L6 · SQS, envio a ACK               |        120 |       35,69 | 327,48 | 539,43 | 608,81 |   0% |                 0 |            443,25 |
| L7 · Backlog da Outbox              |        120 |       39,85 |  37,99 |  60,73 |  83,56 |   0% |                 0 |          5.086,05 |
| L8 · Carga sustentada               |      1.200 |       40,00 |  27,69 |  49,87 | 109,09 |   0% |                 0 |             98,00 |

L3 confirmou 43 replays e 120 apostas distintas. L4 executou BET, WIN, LOSS, REFUND, ROLLBACK e uma reversão parcial esperadamente rejeitada por trabalho. As 120 rejeições `AMOUNT_MISMATCH` foram respostas de negócio esperadas. L6 persistiu 120 recibos, encerrou com fila de origem e DLQ vazias e obteve zero retries. L7 acumulou 264 eventos, iniciou dois publishers e drenou em 3,44 s incluindo startup. O evento pendente mais antigo observado na drenagem chegou a 5,13 s.

## Integridade e análise

Após cada cenário, o gerador compara os wagers e as entradas de ledger com o plano em Money exato, verifica o saldo reconstruído e conta recibos e eventos publicados. Cada carteira é reconciliada. O catálogo reflete as mesmas constraints e migrations da API.

L4 ofereceu até seis chamadas sequenciais por trabalho. Sua janela total foi 6,14 s, e o atraso p95 de agenda foi 2.497,62 ms. Esses números mostram fila no gerador com doze slots. L5 concentra chegadas e depende do tempo de drenagem de uma rajada curta. O maior p95 de L6 abrange broker, polling, fila FIFO, SQL, ACK e IPC local. A rodada mede o conjunto e deixa a atribuição por serviço para um perfil dedicado. L2 operou abaixo dos timeouts de lock. A contenção com timeout está coberta separadamente por injeção de lock e testes concorrentes.

O ensaio mede um host local sem HA, com um emulador SQS e trinta segundos de carga sustentada. Os valores caracterizam essa rodada. O enunciado deixa a taxa-alvo a cargo do experimento. [Concorrência](DISTRIBUTED_CONCURRENCY.md) · [Relatório final](FINAL_TEST_REPORT.md)
