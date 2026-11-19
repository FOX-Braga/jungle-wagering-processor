# Contrato da API HTTP

A API usa JSON e valores monetários como strings decimais. No desenvolvimento a URL padrão é `http://127.0.0.1:3000`, o Swagger está em `/docs` e o documento OpenAPI em `/docs-json`. A documentação interativa fica disponível em `NODE_ENV=development` e `test`. A aplicação de avaliação executa sem autenticação e CORS está desabilitado. Um futuro guard OIDC poderá usar a porta de identidade para vincular o provedor autenticado ao comando e às consultas. [Arquitetura](../ARCHITECTURE.md)

| Método | Rota                                                                  | Resultado principal                                                       |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| POST   | `/wallets`                                                            | `201` com carteira aberta                                                 |
| GET    | `/wallets/:walletId`                                                  | `200` com saldo e versão atuais                                           |
| GET    | `/wallets/:walletId/ledger`                                           | `200` com lançamentos paginados                                           |
| POST   | `/wagering/transactions`                                              | `200` processada, `202` pendente ou `422` rejeitada                       |
| GET    | `/wagering/transactions/:transactionId`                               | `200` com a transação                                                     |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | `200` com a transação daquele par de identificadores                      |
| POST   | `/wallets/:walletId/reconciliation`                                   | `200` com a comparação dos saldos                                         |
| GET    | `/health/live`                                                        | `200` com `{"status":"ok"}`                                               |
| GET    | `/health/ready`                                                       | `200` se PostgreSQL e MiniStack respondem, `503` se uma dependência falha |

## Abrir e consultar uma carteira

Corpo de `POST /wallets`.

```json
{
  "playerId": "player-demo",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

A abertura positiva persiste uma transação interna `OPENING` e um lançamento de crédito. A abertura zerada cria a carteira na versão 1 com ledger vazio. A combinação jogador e moeda é única. A abertura e a consulta retornam os mesmos campos.

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "player-demo",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

## Submeter uma operação

Envie `POST /wagering/transactions` com `Content-Type: application/json` e `Idempotency-Key: provider-a:transaction-123`.

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "player-demo",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-demo",
  "gameId": "game-demo",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Os tipos externos são BET, WIN, LOSS, REFUND e ROLLBACK. REFUND e ROLLBACK exigem `referenceExternalTransactionId`. WIN aceita esse campo opcional. BET e LOSS usam o corpo sem referência. Os identificadores são opacos com 1 a 128 caracteres ASCII. O primeiro é alfanumérico e os demais também aceitam ponto, hífen, sublinhado, til e dois-pontos. A chave idempotente aceita até 256 caracteres com o mesmo alfabeto. Campos desconhecidos e valores monetários numéricos retornam `400`. O dinheiro é uma string com até 36 dígitos inteiros e exatamente duas casas, acompanhado por uma moeda ISO 4217 suportada pelo domínio. O limite de corpo JSON é 16 KiB.

Uma operação processada retorna seu saldo histórico e versão. `processedAt` é uma data ISO 8601. Quando resolvida, `referenceTransactionId` identifica a referência interna. Rejeições e pendências usam o mesmo formato principal com seu próprio status, sem `processedAt`.

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "processedAt": "2026-11-18T14:00:00.000Z",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "walletVersion": 2,
  "idempotentReplay": false
}
```

A chave é obrigatória e global. Uma repetição com a mesma chave e os mesmos campos financeiros mantém o mesmo resultado e retorna `idempotentReplay: true`. O motor usa SHA-256 de JSON canônico com chaves ordenadas e quantia normalizada. A chave, correlação e demais metadados do transporte ficam fora do hash. A mesma chave com conteúdo divergente retorna `409 IDEMPOTENCY_CONFLICT`. O mesmo provedor e ID externo com outra chave retorna `409 EXTERNAL_TRANSACTION_CONFLICT`. Se a resposta for perdida ou retornar `503`, reenvie com a chave original.

Um replay de rejeição retorna o `422` auditável original. Uma pendência retorna `202` e mantém seu próprio ID. Se for retomada internamente e alcançar um estado terminal, a consulta e o replay passam a devolver o resultado terminal gravado sob aquele ID. O agendamento da retomada pertence à Fase 6. [Motor financeiro](FINANCIAL_PROCESSING.md)

As duas rotas de consulta retornam a visão persistida, com ID, provedor, ID externo, carteira, tipo, estado, quantia, datas e referências aplicáveis. Saldo e versão históricos aparecem quando há snapshot. A consulta por provedor exclui a abertura interna.

## Ler o ledger

`GET /wallets/:walletId/ledger?limit=50` usa limite padrão de 50, com intervalo de 1 a 100. `items` contém IDs, direção, quantia, saldos anterior e posterior, versão e data de cada registro. A paginação segue a versão crescente, única por carteira, com ID no ordenamento. `hasMore: true` sinaliza que há mais registros. Use o valor de `nextCursor` como parâmetro `cursor` na próxima página. A última página retorna `nextCursor: null`. O cursor é opaco, vinculado à carteira e validado contra o ledger. Novas entradas com versões posteriores ficam disponíveis nas páginas seguintes.

```json
{
  "items": [],
  "nextCursor": null,
  "hasMore": false
}
```

## Reconciliar saldo

`POST /wallets/:walletId/reconciliation` sem corpo lê a carteira e a soma do ledger no mesmo snapshot SQL em uma transação somente leitura. O resultado aponta a diferença assinada `storedBalance − calculatedBalance`. Uma divergência retorna `consistent: false` com status `200`, registra `reconciliation.divergence` e incrementa `wager_reconciliation_total` com `result=divergent`.

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "75.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "75.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

## Erros e correlação

Envie um `X-Correlation-Id` válido ou use o que a API gera. O ID aparece no cabeçalho de resposta, nos erros estruturados, nos logs e nos eventos produzidos pela operação. Um cabeçalho inválido retorna `400` com um novo ID para rastrear a resposta.

| HTTP  | Códigos e resposta                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400` | `INVALID_REQUEST`, `INVALID_COMMAND`, `INVALID_CURSOR`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_CORRELATION_ID`                                              |
| `404` | `WALLET_NOT_FOUND`, `WAGER_NOT_FOUND`, `ROUTE_NOT_FOUND`                                                                                                 |
| `409` | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `HISTORICAL_RESULT_UNAVAILABLE`                                        |
| `413` | `PAYLOAD_TOO_LARGE`                                                                                                                                      |
| `415` | `UNSUPPORTED_MEDIA_TYPE` para codificação ou charset incompatível                                                                                        |
| `422` | Transação `REJECTED` com `failureCode`, ou erro `WALLET_OWNERSHIP_MISMATCH`                                                                              |
| `500` | `INTERNAL_ERROR`                                                                                                                                         |
| `503` | `PERSISTENCE_UNAVAILABLE`, `LOCK_TIMEOUT`, `DEADLOCK`, `SERIALIZATION_FAILURE`, `HTTP_OVERLOADED`. Reenvie com a mesma identidade após `Retry-After: 1`. |

Códigos financeiros de rejeição incluem `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `WALLET_MISMATCH`, `INVALID_REFERENCE`, `REFERENCE_NOT_FOUND`, `REFERENCE_TYPE_NOT_ALLOWED`, `AMOUNT_MISMATCH` e `ALREADY_REVERSED`. A rejeição gravada mantém o formato da operação com `status: "REJECTED"`. Erros de protocolo e infraestrutura usam o envelope abaixo.

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "The idempotency key is already bound to another payload",
    "correlationId": "client-request-21"
  }
}
```

Readiness mantém a resposta com `status` e `checks` como contrato de health, por exemplo `{"status":"unavailable","checks":{"postgres":"down","sqs":"up"}}`. Liveness verifica o processo. A API retorna mensagens de erro seguras e os logs de requisição evitam corpo, chave idempotente e credenciais.
