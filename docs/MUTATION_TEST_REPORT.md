# Testes de mutação financeira

`bun run test:mutation` executou unidade e propriedades com o **Bun 1.4.4** no Windows. O runner local copiou código e testes para uma pasta temporária, aplicou uma alteração por rodada e reexecutou a mesma seleção de 145 testes. A linha de base passou integralmente. O diretório temporário foi removido ao concluir. [Runner e mutações](../scripts/validation/mutation.ts)

| Arquivo                                                           | Mutação intencional                            | Testes que falharam |
| ----------------------------------------------------------------- | ---------------------------------------------- | ------------------: |
| `src/domain/money/money.ts`                                       | Ignorar moeda em operações                     |                   2 |
| `src/domain/money/money.ts`                                       | Aceitar quantia negativa na entrada            |                   4 |
| `src/domain/money/money.ts`                                       | Inverter a comparação monetária                |                   1 |
| `src/domain/wallet/wallet.ts`                                     | Rejeitar débito que consome exatamente o saldo |                   1 |
| `src/domain/ledger/wallet-ledger-entry.ts`                        | Aceitar lançamento cuja aritmética diverge     |                   2 |
| `src/domain/wagering/wager-transaction.ts`                        | Creditar uma aposta que deveria debitar        |                   8 |
| `src/domain/wagering/wager-transaction.ts`                        | Permitir rejeitar uma operação já processada   |                  15 |
| `src/domain/wagering/wager-transaction.ts`                        | Marcar uma referência ausente como pronta      |                   2 |
| `src/domain/wagering/wager-transaction.ts`                        | Aceitar segunda reversão direta                |                   2 |
| `src/application/use-cases/process-wager-transaction.use-case.ts` | Aceitar replay com payload divergente          |                   1 |

Foram detectadas **10 de 10 mutações válidas**, com zero sobreviventes, em 23,56 s. Um rascunho da mutação de direção interrompia a preparação de uma fixture e ficou fora da pontuação. A execução final injeta a mesma classe de erro na decisão de débito, que a suíte consegue avaliar após concluir o setup. [JSON da execução](evidence/phase9/mutation.json)

A taxa descreve dez defeitos escolhidos manualmente. Ela mede a seleção de unidade e propriedades, com os contratos de persistência e concorrência avaliados pela regressão real. Uma ampliação desta medição pode aplicar mutações SQL em containers descartáveis e verificar se migrations, atomicidade e concorrência detectam a perda das proteções do banco. [Regressão](PHASE_9_FINAL_REPORT.md)
