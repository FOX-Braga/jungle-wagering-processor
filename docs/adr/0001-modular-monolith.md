# ADR 0001 — Monólito modular

**Estado** Aceito para a Fase 1

## Contexto

O processador precisa proteger saldo, ledger, inbox e outbox em um único commit e operar com múltiplos processos. O desafio pede uma implementação distribuída com foco em correção financeira e recuperação.

## Decisão

Manter uma base de código modular, com dependências orientadas ao domínio e ao caso de uso. NestJS compõe a API. Workers futuros poderão usar entrypoints distintos e compartilhar os mesmos casos de uso e contratos. PostgreSQL coordena concorrência e persistência entre processos. SQS desacopla a entrega.

## Consequências

API e workers podem escalar como processos separados. A transação financeira permanece local ao PostgreSQL, o que simplifica a recuperação. Os limites de código precisam ser preservados mesmo com dependências e release compartilhados. Separar serviços com bancos próprios nesta fase exigiria protocolos de consistência e operação adicionais para o mesmo fluxo financeiro.
