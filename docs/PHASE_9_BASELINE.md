# Linha de base da Fase 9

Auditoria iniciada em 19/11/2026 sobre `6c68af4dafb88775932345ed29f797ee8b376217` (`main`), com árvore de trabalho limpa. O diff com o README do desafio fornecido confirmou que a cópia versionada coincide após normalizar as quebras de linha. O enunciado define os requisitos do produto. O texto da Fase 9 orienta o trabalho adicional, com escopo limitado à validação e à apresentação.

## Inventário

| Área         | O que já existe                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qualidade    | Instalação congelada, ESLint, TypeScript estrito, Prettier, build e runner Bun. [`package.json`](../package.json)                                                                                                                                              |
| Financeiro   | Unidade, propriedades com fast-check, integração PostgreSQL para migrations, constraints, atomicidade e idempotência, além do contrato HTTP e E2E. [Plano de testes](TEST_PLAN.md)                                                                             |
| Distribuição | Três processos de API e três consumers em suítes próprias, 50 entregas equivalentes, disputas por saldo e progresso de wallets independentes. [Testes distribuídos](../test/distributed)                                                                       |
| Recuperação  | Crash antes do commit, crash depois do commit antes do ACK, repetição após lease da Outbox, falhas de conexão, DLQ, heartbeat, referência tardia e reinício de processos. [Recuperação](../test/recovery) · [Mensageria](../test/messaging)                    |
| Carga        | Benchmark configurável com oito cenários, três APIs, SQS, backlog, carga sustentada e auditoria. [Relatório](LOAD_TEST_REPORT.md) · [JSON da rodada anterior](evidence/load-final.json)                                                                        |
| Auditoria    | `audit:wallets` abre uma transação PostgreSQL somente leitura com snapshot `REPEATABLE READ` e emite JSON. Já existe teste que comprova divergência sem escrita corretiva. [CLI](../scripts/audit/wallets.ts) · [Teste](../test/audit/financial-audit.test.ts) |
| Operação     | `doctor`, `queues:inspect`, `diagnostics:operations`, liveness e readiness. [Runbook](OPERATIONS_RUNBOOK.md)                                                                                                                                                   |
| Apresentação | Demos HTTP, Inbox e resiliência, Postman e roteiro técnico. [Roteiro](TECHNICAL_PRESENTATION.md)                                                                                                                                                               |
| CI           | Instalação congelada, lint, typecheck, formatação, provisionamento PostgreSQL e MiniStack, doctor, build via `test:all`, regressão e benchmark opcional com artefato. [Workflow inicial](../.github/workflows/ci.yml)                                          |

## Resultados iniciais

- Bun 1.4.4 em Windows. Unidade, propriedades e observabilidade passaram juntas com **151 testes, zero falhas**, em 10 arquivos. O runner registrou 1,99 s.
- A auditoria anterior documenta 296 testes aprovados em infraestrutura de uma revisão anterior. O resultado desta revisão é registrado separadamente. [Relatório anterior](FINAL_TEST_REPORT.md)
- A primeira tentativa encontrou Docker Compose 5.7.0 e ausência do daemon no pipe padrão. `test:all` compilou e terminou com 151 aprovações, 36 falhas reportadas e 1 erro do runner. Houve recusas de conexão do PostgreSQL, falhas de setup e timeout de liveness. A repetição com Docker e portas isoladas passou os 297 testes. [Relatório final](PHASE_9_FINAL_REPORT.md)

## Lacunas da validação

- A CI existente publica o benchmark opcional. A regressão principal precisa de um resumo persistente com contagens, revisão, versões, duração, categoria da falha e isolamento explícito.
- A apresentação já tem as cinco evidências financeiras e distribuídas em comandos separados. Um comando pode compor os cenários existentes com PostgreSQL e MiniStack descartáveis.
- O benchmark mede cenários isolados. Um ensaio de estabilidade pode intercalar disputa por saldo, replay, carteiras independentes e troca de workers durante a mesma janela.
- Os casos de chaos existentes são reutilizáveis e merecem um índice de reprodução. Uma matriz de mutações intencionais pode medir se os testes sem infraestrutura detectam defeitos financeiros em uma cópia temporária.
