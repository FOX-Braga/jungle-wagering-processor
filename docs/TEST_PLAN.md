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

## Etapa 03 — Persistência financeira

- `test:db:constraints` executa SQL direto e verifica SQLSTATE, nome da constraint e estado após a tentativa.
- `test:db:transactions` valida mappers, precisão máxima, abertura, reconciliação, rollback após cada gravação, claims da outbox e locks reais em três conexões.
- `test:db:migrations` compara o catálogo antes e depois de reverter e reaplicar migrations, testa o bloqueio de rollback com dados e demonstra privilégios de execução limitados.
- `test:integration` executa as suítes acima e a regressão de PostgreSQL, SQS e health da Fase 1. Usa `TEST_DATABASE_URL` e bancos descartáveis.

## Etapa 04 — Motor financeiro

- `test:financial` verifica abertura, movimentos, rejeições, pendência, retomada, snapshots após reconexão, consultas e sequências geradas com auditoria de saldo. O fast-check usa seed `20261118` para reprodução.
- `test:concurrency` verifica efeitos únicos sob repetição, disputas de saldo e reversão, deadlock, timeout e progresso independente entre carteiras.
- `test:atomicity` injeta falhas ao redor das gravações e provoca uma colisão de chave primária da outbox. Compara as cinco tabelas e confirma que o comando pode ser reapresentado.
- `test:unit` cobre validação, hash canônico, mapeamento de erros e resposta histórica em isolamento. `test:integration` inclui as três suítes PostgreSQL da fase.

## Etapa 05 — API HTTP e concorrência distribuída

- `test:e2e` verifica contratos, validação, carteira, operações, reconciliação, histórico, OpenAPI, indisponibilidade e shutdown com PostgreSQL real.
- `test:distributed` compila a API, inicia três processos e prova idempotência, locking, efeitos persistidos, recuperação e reconciliação sobre um banco compartilhado.
- `test:http-contract` seleciona o cenário que compara schemas OpenAPI com entradas e respostas reais.
- Os testes de integração das fases anteriores continuam disponíveis em `test:integration`.

## Etapa 06 — Mensageria e recuperação distribuída

- `test:messaging` roda com PostgreSQL, MiniStack e processos filhos. Exercita idempotência HTTP/SQS nas duas ordens e simultaneamente, rejeições terminais, DLQ, falha de conexão, publicação concorrente e referências fora de ordem.
- `test:inbox`, `test:dlq` e `test:outbox` selecionam esses fluxos por subsistema.
- `test:recovery` comprova rollback antes do commit, replay após commit e antes do ACK, falha de ACK, perda de conexão durante a transação, renovação de visibilidade e drenagem.
- `test:distributed` inclui três consumers SQS independentes e 50 entregas equivalentes, além dos processos HTTP da etapa anterior.
- `demo:resilience` roda um cenário com consumidores e publishers reiniciados em pontos controlados e imprime o relatório de reconciliação.

Os testes de mensageria criam bancos e filas com nomes únicos e removem somente esses recursos. [Runbook](FAILURE_SCENARIOS.md) · [Relatório da Fase 6](PHASE_6_REPORT.md)

Cada teste financeiro deve comparar, em representação exata, o saldo materializado com créditos menos débitos reconstruídos a partir do ledger.

## Etapa 07 — Observabilidade, auditoria e segurança

- `test:observability` cobre formato e redaction, correlação, isolamento assíncrono, limites das labels, loopback e deadline compartilhado.
- `test:audit` usa conexões PostgreSQL independentes, carteira zerada, movimentos, rejeição, precisão acima do intervalo seguro de inteiros em centavos, divergência de leitura simulada e exit codes.
- `test:security` aplica os grants a logins reais e verifica restrições de DDL e escrita no ledger. Também valida o perfil de configuração de produção.
- `test:recovery` inclui cortes TCP isolados de PostgreSQL e SQS, readiness durante falhas, limite de admissão, contenção, DLQ, lag, recuperação de publisher e resolução de referência com correlação preservada.

## Etapa 08 — SQS Consumer e Transactional Inbox

- `test:unit` cobre envelopes legados e versão 1, classificação de falhas, backoff, jitter e cancelamento de polling.
- `test:db:migrations` cobre recibos legados em banco populado, FK para wager, gravação do vínculo no commit e recusa de rollback com vínculos existentes.
- `test:messaging` cobre HTTP/SQS, redrive e shutdown de um lote FIFO durante trabalho ativo.
- `test:distributed` comprova três consumidores simultâneos, 50 entregas, disputa de saldo, concorrência com mesmo ID lógico e conflito entre carteiras.
- `test:inbox-recovery` interrompe o processo após commit e antes de ACK, comprova reentrega, redrive e integridade financeira em banco e filas descartáveis. `demo:inbox` inicia também PostgreSQL e MiniStack pelo Compose. [Relatório da Fase 08](PHASE_8_REPORT.md)

## Validação final

- `test:all` compila e executa todos os arquivos `*.test.ts`, incluindo as suítes reais dependentes do Compose.
- `test:resilience` executa os cenários de recuperação, reinício e resolução de referências fora de ordem.
- `test:load` executa L1–L8 e auditoria exata de wagers, ledger, saldo, Inbox e Outbox. A carga é uma execução separada.
- O teste de reinício troca API, consumer e publisher sobre o mesmo banco e as mesmas filas, retoma uma referência e reconcilia o saldo após o replay.

[Relatório final](FINAL_TEST_REPORT.md) · [Carga](LOAD_TEST_REPORT.md) · [Reversões](REVERSAL_MATRIX.md)
