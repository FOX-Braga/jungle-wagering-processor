# Auditoria final e entrega técnica

**Classificação interna — READY WITH DOCUMENTED LIMITATIONS.** A verificação local cobriu os 23 requisitos obrigatórios rastreados e as oito falhas eliminatórias do enunciado. A carga também foi executada como diferencial. A CI hospedada, a implantação AWS e uma topologia HA ficam fora da evidência desta rodada. [Matriz de requisitos](FINAL_REQUIREMENTS_MATRIX.md) · [Checklist eliminatório](ELIMINATORY_CHECKLIST.md)

## Ambiente e instalação limpa

- Windows 10 Home, Intel Xeon E5-2620 v3, 12 CPUs lógicas e aproximadamente 16 GiB de RAM. Bun 1.4.4 e Node 20.12.2 para Newman.
- Docker 29.9.3, Compose 5.7.0, backend Linux x86-64, PostgreSQL 16.11 e MiniStack 1.5.38. A entrega usa TypeScript 5.9.3, NestJS 11.2.10 e MikroORM 6.6.18.
- Linha de base na branch `main`, com mudanças locais das fases anteriores e referência Git `e018296`. Os arquivos existentes foram preservados. A cópia inclusa do README original coincide com o enunciado fornecido após normalizar finais de linha. A busca no workspace não encontrou `AGENTS.md`.
- O projeto Compose descartável `jungle-final-7d9e10a` usou volumes novos e portas 55434, 54667 e 53005. As etapas Linux do Docker instalaram dependências congeladas e compilaram a aplicação. Setup terminou com código zero, provisionou o schema e as filas e liberou API, consumer, Outbox e worker de referências. A imagem foi refeita com a árvore final auditada e os serviços voltaram saudáveis.

## Qualidade e testes

A linha de base executou 287 testes em 29 arquivos, com zero falhas em 171,79 s. Foram acrescentados oito casos de reversões e um teste de reinício integrado. O harness da regressão usa bancos e filas descartáveis. Timeouts e falhas de transporte são exercitados sem alterar a infraestrutura de desenvolvimento.

`bun run test:all` aprovou **296 testes em 30 arquivos** no Compose descartável. A execução de Bun Test durou 178,82 s, sem falhas ou ignorados. Instalação congelada, lint, typecheck, formatação e build passaram. A coluna de tempo por grupo soma as durações individuais informadas pelo Bun, enquanto a duração total inclui setup e limpeza.

| Grupo em `test:all`      | Aprovados | Falhas | Tempo dos casos |
| ------------------------ | --------: | -----: | --------------: |
| Unidade                  |       135 |      0 |          0,10 s |
| Propriedades             |        10 |      0 |          0,18 s |
| Integração               |        95 |      0 |         21,86 s |
| E2E HTTP                 |        14 |      0 |          8,46 s |
| Concorrência distribuída |        12 |      0 |         21,03 s |
| Mensageria               |        12 |      0 |         56,17 s |
| Recuperação              |         9 |      0 |         50,64 s |
| Observabilidade          |         5 |      0 |          0,04 s |
| Auditoria                |         2 |      0 |          6,04 s |
| Segurança                |         2 |      0 |          1,04 s |

O diagnóstico estático procurou conversões monetárias para ponto flutuante. Os casts a `double precision` em produção são de timestamps, idade e contagens. O caminho financeiro usa `bigint`, strings decimais e `NUMERIC`; os testes incluem valores acima do intervalo de inteiros seguros para JavaScript.

O fast-check usa seed `20261118`: dez propriedades com 300 rodadas cada e uma propriedade integrada com 16 sequências de comandos em PostgreSQL. A suíte cobre precisão e serialização, saldo e encadeamento, rejeição sem efeito, moedas, imutabilidade de terminais e replay. Os testes de reversões complementam a geração de sequências. Mutation testing ficou fora da rodada. [Propriedades](../test/properties/finance.properties.test.ts) · [Financeiro SQL](../test/integration/application/financial.test.ts) · [Matriz de reversões](REVERSAL_MATRIX.md)

## Financeiro, concorrência e idempotência

Na demo HTTP, a abertura de 100.00 BRL seguida de BET de 30.00 devolveu 70.00. Após WIN de 50.00, o replay manteve 70.00 e o mesmo ID. REFUND, ROLLBACK da REFUND e LOSS levaram a 120.00, cinco lançamentos e diferença zero. Newman executou 21 requisições e aprovou as 73 asserções em 2,4 s, incluindo todos os fluxos financeiros, conflitos, cursor e health.

Os testes HTTP distribuídos sincronizaram três execuções de duas BET de 80.00 sobre 100.00. Cada tentativa terminou em um débito, uma rejeição e saldo 20.00. Cinquenta chamadas equivalentes distribuídas entre três processos geraram um efeito. A suíte SQS repetiu o teste com 50 entregas distintas e três consumers. Carteiras independentes avançaram enquanto outra estava bloqueada. A concorrência de reversões e de ID lógico conflitante também foi verificada. [HTTP distribuído](../test/distributed/http-concurrency.test.ts) · [SQS distribuído](../test/distributed/messaging-concurrency.test.ts)

## Chaos e recuperação

| Cenário | Falha controlada                                                             | Verificação                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| C1      | Interrupção da conexão PostgreSQL dentro do commit e durante tráfego isolado | Rollback, resposta transitória e retry com a mesma identidade. [Resiliência](../test/recovery/resilience.test.ts)                             |
| C2      | Interrupção da conexão de worker com MiniStack                               | Backoff de polling, disponibilidade restaurada e ACK posterior. [Consumer](../test/messaging/consumer.test.ts)                                |
| C3      | Consumer encerrado antes do commit                                           | Anulação das gravações, redelivery e aplicação única. [Resiliência](../test/recovery/resilience.test.ts)                                      |
| C4      | Consumer encerrado após commit e antes do ACK                                | Outro processo assume a segunda entrega, confirma por replay e preserva um débito e saldo 75.00. [Inbox](../test/recovery/inbox-demo.test.ts) |
| C5      | Publisher encerrado após envio                                               | Outro publisher recupera o lease e envia novamente com o mesmo eventId. [Outbox](../test/messaging/outbox.test.ts)                            |
| C6      | Worker de referências encerrado dentro da transação                          | Referência permanece pendente e depois é aplicada exatamente uma vez. [Referências](../test/messaging/references.test.ts)                     |
| C7      | API encerrada em operação em voo ou após commit                              | Outro processo preserva a disponibilidade e a identidade histórica. [HTTP distribuído](../test/distributed/http-concurrency.test.ts)          |
| C8      | Falha após gravar Outbox e colisão real em SQL                               | O commit reverte wager, wallet, ledger, Inbox e Outbox. [Atomicidade](../test/integration/application/atomicity.test.ts)                      |

O cenário integrado de reinício usa as mesmas filas e a mesma base entre o desligamento e a retomada. Ele inicia API, consumer e publisher, confirma BET e WIN e persiste um REFUND sem referência. Depois troca processos, completa a referência, verifica replay histórico e drena 11 eventos. A reconciliação termina em 125.00 BRL, cinco lançamentos e diferença zero. [Teste de reinício](../test/recovery/full-restart.test.ts)

No Compose descartável, `stop consumer` enviou SIGTERM ao entrypoint Linux. O processo registrou `worker.draining` e terminou com código zero. Em seguida, cada container de dependência foi interrompido e restaurado separadamente. Readiness devolveu 503 durante cada interrupção e retornou a 200 após o restart. Liveness permaneceu em 200. Após restaurar os mesmos volumes, o doctor confirmou sete migrations aplicadas e zero pendentes. O CLI auditou as duas carteiras das demos e seus dez lançamentos, com zero diferenças.

## Performance e integridade

O benchmark registrou 2.683 conclusões, zero erros inesperados, 120 rejeições de negócio esperadas, 43 replays e zero conflitos de lock reportados nesta carga. Em 30 s sustentados, obteve 40,00 operações/s com p95 de 49,87 ms. No SQS, 120 entregas confirmadas obtiveram 35,69/s e p95 de 539,43 ms do envio ao ACK. A Outbox drenou um backlog de 264 eventos. O relatório registra p50, p95, p99, taxas, lag, atraso do gerador, setup e limites. A auditoria confirmou 88 carteiras e 2.491 lançamentos com zero diferenças. [Relatório de carga](LOAD_TEST_REPORT.md)

## CI, segurança e limitações

O workflow instala o lockfile, roda lint, typecheck e formatação, provisiona os serviços e executa `test:all`. Uma execução manual pode medir carga e publicar o JSON como artefato do workflow. O pipeline equivalente foi exercitado localmente. O resultado do GitHub Actions precisa ser verificado após a publicação da revisão. [Workflow](../.github/workflows/ci.yml)

A auditoria de dependências encontrava o aviso do Ajv. O pin direto e o override transitivo foram ajustados e a reexecução consultou 307 pacotes com zero avisos. A API de avaliação usa a extensão documentada para autenticação OIDC em rede isolada. Publicação de eventos tem semântica at-least-once e eventos estacionados exigem ação operacional. A comprovação de SQS aplica-se ao MiniStack. [Revisão de segurança](SECURITY_REVIEW.md) · [Trade-offs](../ARCHITECTURE.md#trade-offs-de-operação)

## Reprodução e apresentação

```powershell
bun install --frozen-lockfile
docker compose --env-file .env.example --profile workers up -d --build --wait
bun run lint
bun run typecheck
bun run format:check
bun run test:all
bun run demo:financial
bun run demo:inbox
bun run demo:resilience
bun run test:load
bun run audit:wallets
```

O README é o ponto de partida para a instalação. O runbook cobre operação e diagnóstico, o guia Postman documenta a coleção executada e o roteiro técnico orienta a apresentação. [README](../README.md) · [Runbook](OPERATIONS_RUNBOOK.md) · [Postman](POSTMAN_GUIDE.md) · [Apresentação](TECHNICAL_PRESENTATION.md)
