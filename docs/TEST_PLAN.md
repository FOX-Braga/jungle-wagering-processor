# Plano de testes

## Fundação

A suíte unitária verifica configuração, composição Nest e respostas dos health checks com falhas simuladas nos probes. A suíte de integração usa PostgreSQL e MiniStack reais, confirma as filas provisionadas e cria banco e filas descartáveis para cenários mutáveis. Valida migrations up/down/up, conexão, credenciais inválidas, envio, recebimento, exclusão, redelivery e DLQ. Readiness deve passar com as duas dependências e retornar 503 se qualquer uma falhar.

## Etapa 02 — Domínio financeiro

| Componente       | Cenários e critérios de aceite                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money            | Factories, operações e serialização fixa. Aritmética exata acima do intervalo seguro de inteiros JS. Rejeitar expoente, NaN, infinidade, string vazia, escala acima de dois e valores negativos em entradas externas. Moedas diferentes falham. |
| Wallet           | Saldo inicial zero e positivo com versão 1. Crédito e débito preservam moeda e saldo. A versão muda somente com saldo. Saldos insuficientes produzem rejeição explícita.                                                                        |
| WagerTransaction | Factories e reidratação. BET debita, WIN credita, LOSS registra sem movimentação. REFUND e ROLLBACK obedecem tipo, vínculo, quantia integral e estado da referência. Estados terminais são imutáveis.                                           |
| Ledger           | Encapsulamento, direção, aritmética saldo anterior/posterior, moeda e reidratação. Rejeições e LOSS deixam o ledger intacto.                                                                                                                    |
| Eventos          | Tipo, versão, IDs, momento e payload monetário estável. Alteração de saldo emite evento correspondente, inclusive abertura positiva.                                                                                                            |

A suíte da Fase 2 executa os quatro cenários financeiros do roteiro, a matriz de transições e os testes de inbox, outbox e eventos. `bun run test:properties` verifica 10 propriedades com 300 casos por propriedade e seed `20261118`. Em caso de falha, o fast-check informa a seed e o caminho do contraexemplo. Os efeitos SQL e de mensageria são demonstrados nas etapas seguintes.

## Verificações nas próximas etapas

| Área                    | Evidência                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema e aplicação      | PostgreSQL real rejeita atualização/exclusão do ledger, saldo negativo, chaves e lançamentos duplicados e referências inválidas. Uma falha antes do commit desfaz resultado, ledger, inbox e outbox juntos. |
| Concorrência            | Usar três ou mais processos reais com barreiras. Disputar duas BET de 80.00 sobre 100.00, repetir 50 requisições idênticas, demonstrar paralelismo entre carteiras e disputar reversões e publicadores.     |
| Idempotência HTTP e SQS | Repetir o comando nos dois transportes e após reinício. Validar saldo histórico e conflito com hash divergente.                                                                                             |
| Referências             | Entregar REFUND ou ROLLBACK antes da referência, confirmar aplicação posterior ou rejeição por prazo e validar a emissão dos eventos.                                                                       |
| Recuperação             | Injetar falha antes do commit, depois do commit antes do ack e depois da publicação antes da marcação. Parar e recuperar PostgreSQL e SQS. Confirmar ausência de efeito duplicado e entrega recuperável.    |
| Auditoria e operação    | Reconciliar no mesmo snapshot, reportar divergência sem correção silenciosa e verificar logs e métricas dos cenários anteriores.                                                                            |

Cada teste financeiro deve comparar, em representação exata, o saldo materializado com créditos menos débitos reconstruídos a partir do ledger.
