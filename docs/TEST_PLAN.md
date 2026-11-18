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

## Verificações nas próximas etapas

| Área                    | Evidência                                                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concorrência            | Usar três ou mais processos reais com barreiras. Disputar duas BET de 80.00 sobre 100.00, repetir 50 requisições idênticas, demonstrar paralelismo entre carteiras e disputar reversões e publicadores.  |
| Idempotência HTTP e SQS | Repetir o comando nos dois transportes e após reinício. Validar saldo histórico e conflito com hash divergente.                                                                                          |
| Referências             | Exercitar entrega pelo SQS, retomada via agendamento e rejeição por prazo com emissão dos eventos.                                                                                                       |
| Recuperação             | Injetar falha antes do commit, depois do commit antes do ack e depois da publicação antes da marcação. Parar e recuperar PostgreSQL e SQS. Confirmar ausência de efeito duplicado e entrega recuperável. |
| Auditoria e operação    | Reconciliar no mesmo snapshot, reportar divergência sem correção silenciosa e verificar logs e métricas dos cenários anteriores.                                                                         |

Cada teste financeiro deve comparar, em representação exata, o saldo materializado com créditos menos débitos reconstruídos a partir do ledger.
