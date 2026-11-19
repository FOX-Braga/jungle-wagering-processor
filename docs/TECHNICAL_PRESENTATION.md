# Roteiro da apresentação técnica

| Tempo | Assunto                                                          | Evidência para mostrar                                                                                                                                           |
| ----- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 min | A mesma operação pode chegar em duas interfaces ou após um crash | Contrato do provedor e casos HTTP/SQS. [Arquitetura](../ARCHITECTURE.md)                                                                                         |
| 2 min | Compartilhamento do caso de uso, agregados e precisão            | Money em bigint, wallet versionada e ledger protegido no banco. Execute `bun run demo:financial`.                                                                |
| 2 min | Atomicidade e contenção por carteira                             | Duas BET de 80.00 sobre 100.00 em três processos. Mostre uma rejeição, um débito e saldo 20.00. Execute `bun run test:distributed`.                              |
| 1 min | Idempotência                                                     | Na mesma suíte, mostre 50 chamadas com a mesma identidade e um débito. Mostre o snapshot histórico no replay após novos movimentos.                              |
| 2 min | Inbox, Outbox e falha entre commit e ACK                         | Execute `bun run demo:inbox`. Mostre segundo recebimento, confirmação por outro processo, um recibo e DLQ. A demo de resiliência inclui publisher e referências. |
| 1 min | Reconciliação e métricas                                         | Compare a soma do ledger e o saldo. Mostre logs correlacionados, backlog e lag. [Observabilidade](OBSERVABILITY.md)                                              |
| 2 min | Capacidade observada e trade-offs                                | Mostre L4, L6 e L7. Diferencie latência da requisição, espera no gerador e lag da Outbox. [Amostras](LOAD_TEST_REPORT.md)                                        |
| 1 min | Limites e evolução                                               | Discuta lock por wallet, dependência de PostgreSQL, entrega física at-least-once, segurança de rede e integração futura com IdP.                                 |

## Perguntas para discutir

| Pergunta                              | Resposta aplicável ao projeto                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Por que PostgreSQL?                   | Transações ACID, tipos exatos, constraints, locks por linha e SKIP LOCKED cobrem a unidade de consistência.                             |
| Por que MikroORM?                     | O EntityManager transacional delimita Unit of Work. Os mappers preservam o contrato de domínio e a precisão.                            |
| Por que monólito modular?             | HTTP e workers executam separados, com casos de uso e invariantes compartilhados e um commit financeiro.                                |
| Quando dividir em serviços?           | Quando escalabilidade, autonomia ou isolamento justificarem a fronteira. O ledger e o saldo ainda precisam de uma unidade transacional. |
| Por que centavos em bigint?           | A escala contratual de duas casas permite operações inteiras exatas e persistência NUMERIC.                                             |
| Como impedir saldo negativo?          | O domínio recusa o débito e o PostgreSQL valida a projeção do ledger e o CHECK de saldo.                                                |
| Como impedir lost update?             | A carteira é lida sob lock de linha até o commit, e o ledger exige a próxima versão.                                                    |
| Por que lock pessimista?              | Ele resolve a disputa na unidade da carteira e deixa carteiras distintas progredirem.                                                   |
| Qual identidade garante idempotência? | Chave global obrigatória, índice por provedor e ID externo, hash canônico e identidade da Inbox.                                        |
| Por que saldo histórico no replay?    | A resposta é snapshot do commit que decidiu a operação. Ela continua a mesma após outros movimentos.                                    |
| Por que a janela FIFO é insuficiente? | O broker deduplica em uma janela curta. PostgreSQL protege o efeito mesmo após crash ou entrada por HTTP.                               |
| O que a Inbox grava?                  | Consumidor, ID lógico, hash, timestamps e vínculo com o resultado confirmado.                                                           |
| Como o publisher usa a Outbox?        | Reserva linhas com SKIP LOCKED, publica fora do SQL e confirma com token e prazo de lease válidos.                                      |
| E se o consumer cair após commit?     | O SQS reentrega, a Inbox resolve o replay e a nova instância confirma a entrega.                                                        |
| E se o publisher cair após envio?     | O lease expira. Outro publisher envia com o mesmo eventId e registra sucesso.                                                           |
| Como o downstream deduplica?          | Persiste eventId na mesma unidade de trabalho do efeito que aplica.                                                                     |
| Por que REFUND pode ficar pendente?   | Uma referência ainda pode chegar. A agenda persiste as tentativas e produz rejeição depois do limite.                                   |
| Como impedir duas reversões?          | Lock da carteira, verificação de referências e restrições de unicidade de reversões aplicadas.                                          |
| Como funciona a reconciliação?        | Compara saldo materializado e somatório assinado do ledger em um snapshot de leitura.                                                   |
| Por que ledger imutável?              | O histórico deve reconstruir e auditar o saldo. Uma correção contábil é uma nova operação com direção própria.                          |
| Quais trade-offs foram aceitos?       | Serialização da hot wallet, processamento a partir de uma base consistente e duplicidade física recuperável.                            |
| O que a carga mostrou?                | O mix acumulou espera no gerador, e SQS adicionou latência de entrega a ACK. Os percentis refletem o ambiente local.                    |
| Como escalar?                         | Réplicas HTTP, consumers e publishers para carteiras e grupos independentes, dimensionando pool, backlog e capacidade SQL.              |
| Como ampliar observabilidade?         | Expor métricas a um coletor, correlacionar traces entre processos e alertar pela idade de backlog e pela disponibilidade.               |
| O que muda em produção?               | IdP externo, papéis separados, TLS, IAM, alertas, plano de restore e validação de HA e do serviço SQS gerenciado.                       |
