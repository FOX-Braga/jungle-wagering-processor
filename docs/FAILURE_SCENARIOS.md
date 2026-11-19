# Cenários de falha e recuperação

| Ponto de falha                                 | PostgreSQL                                                | SQS                                      | Recuperação                                                              | Evidência                                          |
| ---------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| Consumer morre antes do commit                 | Inbox, wager, ledger e outbox da operação sofrem rollback | Mensagem volta após perder visibilidade  | Outra instância executa o efeito uma vez                                 | `test:recovery`, crash antes do commit             |
| Consumer morre após commit e antes de ACK      | Inbox processada e movimento presentes                    | Mensagem volta com novo receipt handle   | Replay idempotente e ACK após consulta transacional                      | `demo:resilience`                                  |
| DeleteMessage falha                            | Commit preservado                                         | Entrega pode voltar                      | Instância reiniciada verifica recibo e exclui                            | `test:recovery`, falha de ACK                      |
| Conexão com PostgreSQL cai durante a transação | Rollback dos efeitos em andamento                         | Retry via visibilidade                   | Restaurar conectividade para processar na entrega seguinte               | `test:recovery`, proxy TCP cortado antes do commit |
| PostgreSQL já está indisponível                | Nenhuma escrita inicial                                   | Backoff por visibilidade                 | Restaurar conectividade e confirmar a operação aplicada                  | `test:messaging`, falha de conexão                 |
| Mensagem inválida ou identidade em conflito    | Sem nova movimentação                                     | Redrive nativo preserva o corpo original | Inspecionar a DLQ e corrigir a origem                                    | `test:dlq`                                         |
| SQS indisponível ao publicar                   | Evento com retry persistido ou estacionado                | Nenhum sucesso presumido                 | Restabelecer o destino, seguir agenda ou reativar o ID estacionado       | `test:outbox`, proxy TCP                           |
| Publisher morre entre claim e envio            | Claim vence                                               | Evento ainda aguardando envio            | Outra instância recupera o lease                                         | `test:outbox`, crash antes do envio                |
| Publisher morre após confirmação do envio      | `publishedAt` ausente até novo envio                      | Pode haver múltiplas entregas físicas    | Outro publisher envia o mesmo payload e ID                               | `test:outbox` e `demo:resilience`                  |
| Referência ainda ausente                       | Referência pendente com agenda                            | Solicitação original já confirmada       | Processar a mesma transação após chegada ou rejeitar ao esgotar o limite | `test:messaging`, referências                      |
| Worker de referência morre antes do commit     | Pendência recuperável sob o mesmo ID                      | Outbox só expõe eventos confirmados      | Próxima instância retoma após liberação do lock                          | `test:messaging`, crash de referências             |
| Shutdown durante operação                      | Commit antes do ACK ou rollback após encerramento forçado | Drenagem ou redelivery                   | Reiniciar worker, checar logs e reconciliar                              | `test:recovery`, drenagem e renovação              |

## Runbook

1. Rode `bun run doctor` para checar conectividade e schema. Rode `bun run queues:inspect` para conferir atributos, redrive e profundidades aproximadas. Use logs do papel afetado e correlacione o `transportMessageId`, o `messageId` lógico e o `transactionId`.
2. Para fila de entrada parada, confira poll ativo, erros de banco, tentativas e mensagens em trânsito. Uma mensagem em uma fila FIFO pode atrasar as seguintes do mesmo grupo até ACK ou redrive. Após recuperação, consulte o wager por provedor ou ID e reconcilie a carteira.
3. Para crescimento da DLQ, inspecione o corpo original em uma sessão controlada com acesso de operador. Corrija a causa antes de reenviar um caso selecionado. Preserve a chave idempotente em reenvios equivalentes. Uma alteração de negócio exige uma identidade nova e aprovação conforme a operação financeira.
4. Para acúmulo na outbox, confira `outbox_retry`, `outbox_parked`, `outbox_lease_lost`, disponibilidade do SQS e configuração da fila de destino. Reinicie o publisher após recuperar a conectividade. Claims abandonados ficam elegíveis no vencimento.
5. Para referências, use `reference_rescheduled` e `reference_expired` para identificar reentregas fora de ordem. Uma rejeição por expiração é terminal. Consulte a referência e o wager original antes de qualquer compensação operacional.

```sql
select count(*) filter (where parked_at is null) as backlog,
       count(*) filter (where parked_at is not null) as parked,
       now() - min(occurred_at) filter (where parked_at is null) as oldest_pending_age
from wagering.outbox_messages
where published_at is null;

select count(*) as pending_references, min(coalesce(reference_next_attempt_at, created_at)) as oldest_due
from wagering.wager_transactions
where status = 'PENDING_REFERENCE';
```

Depois que o destino recuperar, um operador pode reativar um evento estacionado pelo ID. Essa operação conserva o payload e habilita novamente a entrega at-least-once.

```sql
update wagering.outbox_messages
set parked_at = null, attempts = 0
where id = :event_id and parked_at is not null and published_at is null
returning id;
```
