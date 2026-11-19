# Diagnóstico da Fase 08

A solicitação da Fase 08 usa um planejamento diferente da documentação histórica. O repositório já possui consumer SQS, Inbox, publisher e worker de referências. O README original define os contratos financeiros e de mensageria. A implementação parte do código atual e preserva as mudanças locais da Fase 7.

## Verificação antes das alterações

- Bun 1.4.4, SDK SQS 3.1171.0, MikroORM 6.6.18 e NestJS 11.2.10. O Compose usa PostgreSQL 16.11 e MiniStack 1.5.38.
- A API e os workers têm entrypoints distintos. O caso de uso compartilha a transação SQL entre wager, carteira, ledger, Inbox e outbox. Lock por wallet e unicidades representam as garantias de concorrência.
- Seis migrations versionadas definem e ampliam as tabelas existentes. A Inbox armazena chave composta, hash e datas. A conclusão ainda não tem vínculo direto com o wager. A migration da fase será aditiva e manterá recibos legados.
- O parser estrito valida o contrato original e a correlação. Falta uma versão explícita compatível com os produtores atuais.
- O consumer já tem longa espera, slots, visibilidade renovada, ACK após commit e redrive nativo. Cada poll recebe uma mensagem. A fase acrescenta recepção opcional em lotes limitados por capacidade, ordem por grupo e jitter para falhas de polling.
- As suítes existentes cobrem idempotência HTTP/SQS, falhas de ACK e rede, DLQ, crash, shutdown e cinquenta entregas. Faltam casos explícitos de ID lógico simultâneo, conflito entre carteiras e evidência direta de integridade da Inbox.

## Plano e rastreabilidade

| Critério                         | Componente existente              | Alteração e evidência planejada                                                |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| Envelope, identidade e hash      | Parser e canonicalização de wager | Versão 1 opcional com fallback legado, validação e testes de replay            |
| Commit e ACK                     | Caso de uso e consumer            | Vínculo de recibo opcional, teste de crash entre commit e ACK com inspeção SQL |
| Retry, visibilidade e DLQ        | MiniStack, SQS e heartbeat        | Jitter de polling, testes de lotes, duplicata e poison                         |
| Três consumidores e concorrência | Locks e constraints PostgreSQL    | Três PIDs, mesmo ID e hash, conflito e disputa de saldo entre grupos           |
| Operação e regressão             | Bootstrap, testes e scripts       | Inspeção de estado, demo isolada e regressão em containers                     |

Os riscos centrais são introduzir ordenação incorreta em lotes FIFO, quebrar o envelope original, reinterpretar recibos históricos e confirmar um recibo sem efeito financeiro persistido. As verificações priorizam o saldo exato, a cardinalidade do ledger, a identidade financeira e a confirmação final no broker.
