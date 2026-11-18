# ADR 0002 — Persistência financeira e integridade do ledger

## Decisão

Usar PostgreSQL com MikroORM e migrations SQL versionadas. Classes de persistência e mappers preservam o domínio puro e seu contrato de reidratação. Repositórios compartilham um EntityManager por transação. O PostgreSQL coordena acessos concorrentes com lock pessimista por wallet.

As colunas monetárias usam um domínio sobre NUMERIC com faixa e escala validadas. O driver devolve texto para o mapper e Money continua exato. As constraints validam formato, unicidade, aritmética, referências e estados. O ledger é append-only e sua inserção atualiza o saldo materializado. Uma constraint diferível impede o commit de uma transação processada sem o lançamento exigido.

## Consequências

O registro de uma movimentação precisa gravar o resultado da transação antes do lançamento. O banco valida os dois no commit. Disputas da mesma wallet são serializadas e outras wallets podem avançar. A solução depende de recursos do PostgreSQL para constraints diferíveis, triggers e índices parciais. Migrations explícitas preservam esses recursos e os papéis de produção precisam separar execução e DDL.

Queries de replay já podem recuperar o saldo e a versão da operação confirmada. A resposta do provedor, a orquestração do retry e a publicação dos eventos serão acrescentadas depois.
