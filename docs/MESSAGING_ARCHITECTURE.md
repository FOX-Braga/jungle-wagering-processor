# Mensageria e recuperação distribuída

A API HTTP e os três workers compartilham o domínio, os casos de uso financeiros e o PostgreSQL. O MiniStack fornece SQS local. Cada papel roda em um processo próprio e pode ter várias réplicas.

```mermaid
flowchart LR
  Producer[Provedor] --> Source[wager-transactions.fifo]
  Source --> Consumer[Consumers]
  Source -->|redrive nativo| DLQ[wager-transactions-dlq.fifo]
  Consumer --> Finance[Motor financeiro]
  HTTP[API HTTP] --> Finance
  Finance --> DB[(PostgreSQL)]
  Reference[Workers de referências] --> Finance
  DB --> Outbox[Publishers da outbox]
  Outbox --> Events[wager-events]
```

## Contrato de entrada

```json
{
  "schemaVersion": 1,
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "correlationId": "trace-123",
  "causationId": "upstream-event-123",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "player-123",
    "walletId": "wallet-123",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O corpo aceita até 32 KiB em UTF-8, usa ISO 8601 com fuso e rejeita campos desconhecidos. O parser interpreta envelopes legados sem `schemaVersion` como versão 1 e versões incompatíveis seguem pelo redrive. `correlationId` e `causationId` são opcionais. A correlação assume o `messageId` lógico quando ausente. Os eventos da outbox preservam esse ID em `sourceMessageId`. `occurredAt` identifica o instante do produtor. O processamento usa o relógio da aplicação. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. `WIN` aceita referência opcional. O contrato de dinheiro e as validações são compartilhados com a API.

O produtor deve agrupar por `walletId` e pode usar o ID lógico como `MessageDeduplicationId` para retransmissões idênticas. O SDK recebe `MessageId` e `ReceiptHandle` do broker. O primeiro identifica a entrega nos logs e o segundo autoriza a confirmação. O corpo define o `messageId` da Inbox. Os IDs do transporte e do corpo podem divergir. A operação financeira usa uma chave idempotente global e a identidade `(providerId, externalTransactionId)`. A carteira real e seu proprietário são conferidos pelo motor financeiro, inclusive quando o agrupamento enviado ao SQS difere da carteira.

## Consumer, Inbox e DLQ

Cada processo recebe até quatro mensagens simultâneas por padrão (`SQS_CONSUMER_CONCURRENCY`). Cada poll solicita uma mensagem por padrão. `SQS_CONSUMER_BATCH_SIZE` permite lotes de até dez, limitados pela capacidade do processo. Dentro de um lote, o worker processa cada grupo em ordem e pode executar grupos diferentes em paralelo. A fila FIFO usa visibilidade de 30 s, long polling de 10 s, retenção padrão de quatro dias e DLQ FIFO com retenção de 14 dias. O redrive nativo move a mensagem original após esgotar os três recebimentos configurados. O setup lê, atualiza e verifica os atributos. Em produção, provisiona SSE gerenciado quando a fila ainda está sem KMS. [Limites de ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html) · [Entrega FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html)

```mermaid
sequenceDiagram
  participant S as SQS
  participant C as Consumer
  participant P as PostgreSQL
  S->>C: ReceiveMessage
  C->>C: Validar envelope
  C->>P: Iniciar transação e consultar Inbox e wager
  C->>P: Persistir wager, wallet, ledger, Inbox e Outbox
  alt Processo morre antes do commit
    P->>P: Rollback da conexão
    S-->>C: Redelivery com novo receipt handle
  else Commit confirmado
    P-->>C: Retornar resultado
    alt Processo morre ou ACK falha
      S-->>C: Redelivery após visibilidade
      C->>P: Validar replay com o mesmo hash financeiro
      P-->>C: Commit do caminho de replay
    end
    C->>S: DeleteMessage
  end
```

A chave composta da Inbox usa o mesmo `SQS_CONSUMER_NAME` em todas as réplicas. O caso de uso grava o recibo processado, o wager, a projeção, o ledger e a outbox com o mesmo TransactionManager. Novas conclusões vinculam o recibo à operação por `transaction_id`. Recibos legados já concluídos mantêm vínculo nulo, com replay validado pelas identidades financeiras e pelo hash. O estado financeiro é consultado no wager, inclusive para referências que mudam de estado depois do ACK. A restrição de unicidade vence uma disputa entre instâncias e a operação perdedora relê o resultado em uma transação nova. O hash usa a representação canônica da operação e exclui metadados de transporte. A idempotência de negócio vale também com IDs lógicos distintos e entre HTTP e SQS. Mudar o conteúdo atrelado à mesma identidade resulta em conflito.

| Resultado                                                         | Decisão do consumer                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` ou replay persistido | Excluir do SQS após retornar do commit                                                         |
| Lock, deadlock, falha de conexão ou erro sem classificação        | Ajustar visibilidade para 1, 2, 4 s e assim por diante, até 30 s, sob o limite de recebimentos |
| Envelope inválido ou conflito permanente                          | Devolver visibilidade imediatamente para acelerar o redrive nativo                             |
| Última tentativa malsucedida                                      | Devolver visibilidade e deixar o broker encaminhar para a DLQ                                  |
| Falha de `DeleteMessage` ou alteração de visibilidade             | Registrar falha e deixar o SQS recuperar pela expiração                                        |

O consumer renova a visibilidade a cada metade do intervalo, por até cinco minutos. A renovação cobre mensagens aguardando sua vez no lote e termina no ACK ou no reagendamento. Uma falha bloqueia o processamento das mensagens seguintes do mesmo grupo naquele lote. O broker contabiliza o recebimento das mensagens adiadas. Com lotes maiores, uma sequência de falhas no início do grupo pode consumir o limite de recebimentos das mensagens seguintes. Em falhas de polling, a espera cresce de 250 ms até um teto de 30 s, com jitter. Em SIGINT ou SIGTERM, o processo aborta polls, devolve mensagens recebidas que ainda aguardam processamento e drena o trabalho ativo até `SHUTDOWN_TIMEOUT_MS`. No vencimento, encerra com código 1 e o SQS recupera entregas pendentes após a visibilidade expirar. [Visibilidade do SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)

## Publisher da Outbox

O destino é a fila standard `wager-events`, configurável. Cada evento carrega `eventId`, `eventType`, `version`, `aggregateId`, `correlationId`, `occurredAt`, `data` e `causationId` quando a origem fornece esse vínculo. A versão 1 cobre `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged`.

```mermaid
sequenceDiagram
  participant A as Publisher A
  participant D as PostgreSQL
  participant B as Publisher B
  participant S as SQS standard
  A->>D: Claim A com SKIP LOCKED e commit
  B->>D: Claim B de outras linhas disponíveis
  A->>S: Enviar evento
  S-->>A: MessageId confirmado pelo broker
  Note over A,D: Se A morrer, o lease expira
  B->>D: Recuperar claim com outro token
  B->>S: Reenviar o mesmo eventId
  S-->>B: MessageId
  B->>D: Marcar publishedAt com token e vencimento
```

O claim é persistido em uma transação SQL curta que usa `FOR UPDATE SKIP LOCKED`. Cada lote recebe token aleatório e lease de 30 s por padrão. O token e o vencimento protegem a finalização de um claim substituído. Os envios começam fora da transação, com timeout de 3 s por evento. O worker só inicia envio enquanto resta pelo menos esse intervalo no lease. Uma falha reagenda o evento em 1, 2, 4 s e assim por diante, até 60 s. Após o limite padrão de dez falhas registradas, o evento fica estacionado com payload, ID e tentativas preservados. O procedimento para recolocá-lo em entrega está no [runbook](FAILURE_SCENARIOS.md).

O SQS pode entregar eventos físicos repetidos e fora de ordem. Uma resposta ambígua ou um crash após o envio pode provocar outro envio antes de `publishedAt`. Consumidores downstream devem deduplicar de forma durável por `eventId` junto com seus efeitos. `WalletBalanceChanged` inclui a versão da carteira para consumidores que mantêm projeções. O sistema usa relógios sincronizados para os leases e a agenda.

## Worker de referências

```mermaid
flowchart TD
  Scan[Buscar pendentes com data vencida] --> Lock[Travar a wallet e reler estado e agenda]
  Lock --> Lookup[Procurar referência e aplicar regra do domínio]
  Lookup -->|Apta| Apply[Processar mesmo ID com ledger e outbox]
  Lookup -->|Incompatível| Rejected[Persistir rejeição de domínio]
  Lookup -->|Ausente ou pendente| Retry{Tentativas disponíveis?}
  Retry -->|Sim| Delay[Persistir backoff]
  Retry -->|Não| Expired[Rejeitar com REFERENCE_NOT_FOUND e emitir evento]
```

O worker lê até 25 candidatos por segundo por padrão. Antes de processar cada ID, adquire o lock da carteira e relê a transação e o horário do próximo retry. A serialização no lock da carteira também vale para API e consumer. Um processo concorrente que chega depois do commit encontra a nova agenda ou o estado terminal. A morte de um processo libera o lock SQL e reverte a tentativa em andamento. Linhas anteriores à migração são elegíveis desde `createdAt`.

O próximo retry usa backoff de 1 s até 60 s. O limite é de dez verificações sem referência apta, com a rejeição no último resultado pendente. O worker preserva o mesmo ID, chave de negócio e hash. Erros transitórios de infraestrutura ficam sujeitos à recuperação do loop e conservam o estado financeiro. A transição posterior mantém `transactionId` como correlação padrão.

## Operação

Os logs JSON registram identidade da instância, resultado, IDs de rastreamento aplicáveis, tentativa e latência ou lag. `wager_sqs_events_total` registra recebimentos, resultados de processamento, duplicatas, rejeições, falhas e ACKs. `wager_sqs_processing_duration_seconds` registra a latência de processamento. `bun run queues:inspect` consulta atributos, retenção, redrive e profundidades aproximadas. `bun run demo:inbox` valida interrupção após commit, reentrega, DLQ e auditoria financeira com recursos descartáveis. [Runbook operacional](OPERATIONS_RUNBOOK.md) · [Catálogo de métricas](OBSERVABILITY.md)
