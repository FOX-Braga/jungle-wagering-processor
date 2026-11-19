# Matriz de reversões

As regras da seção 7 do desafio exigem igualdade de provedor, jogador, carteira, moeda e rodada. REFUND e ROLLBACK exigem referência explícita e o valor integral.

| Referência                                                                       | REFUND                             | ROLLBACK                      |
| -------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------- |
| BET processada                                                                   | Crédito integral                   | Crédito integral              |
| WIN processada                                                                   | `REFERENCE_TYPE_NOT_ALLOWED`       | Débito integral               |
| REFUND processada                                                                | `REFERENCE_TYPE_NOT_ALLOWED`       | Débito integral               |
| LOSS ou ROLLBACK processada                                                      | `REFERENCE_TYPE_NOT_ALLOWED`       | `REFERENCE_TYPE_NOT_ALLOWED`  |
| Ausente ou ainda em processamento, quando elegível                               | `PENDING_REFERENCE`                | `PENDING_REFERENCE`           |
| Referência elegível rejeitada ou falha terminal                                  | `INVALID_REFERENCE`                | `INVALID_REFERENCE`           |
| Valor divergente                                                                 | `AMOUNT_MISMATCH`                  | `AMOUNT_MISMATCH`             |
| Moeda divergente da referência                                                   | `CURRENCY_MISMATCH`                | `CURRENCY_MISMATCH`           |
| Carteira, jogador, provedor, rodada ou ID incompatíveis em referência localizada | `INVALID_REFERENCE`                | `INVALID_REFERENCE`           |
| Reversão direta incompatível já aplicada                                         | `ALREADY_REVERSED`                 | `ALREADY_REVERSED`            |
| Saldo insuficiente no débito de reversão                                         | Não se aplica ao crédito de REFUND | `REVERSAL_INSUFFICIENT_FUNDS` |

A busca por provedor e ID externo pode classificar uma referência de outro provedor como ausente. Uma pendência expirando sem referência elegível produz `REFERENCE_NOT_FOUND`. A regra de uma única reversão direta da BET impede que REFUND e ROLLBACK restituam a mesma aposta duas vezes. Uma restituição aplicada ainda pode ser revertida como referência independente. [Motor financeiro](FINANCIAL_PROCESSING.md)

Os testes de domínio verificam códigos, saldo, versão, terminalidade e tipo da referência. A integração e o E2E verificam persistência, ledger, eventos e replay. A concorrência disputa reversões da mesma referência entre processos. [Matriz unitária](../test/unit/domain/wager-transaction.test.ts) · [Financeiro SQL](../test/integration/application/financial.test.ts) · [E2E](../test/e2e/http-financial.test.ts) · [Concorrência](../test/distributed/http-concurrency.test.ts)
