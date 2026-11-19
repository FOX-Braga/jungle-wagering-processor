# Guia de implantação

O Docker Compose é o caminho verificado para avaliação em um host isolado. A implantação com PostgreSQL gerenciado e Amazon SQS exige configuração própria de infraestrutura e validação em homologação. A API do desafio opera sem autenticação efetiva e deve permanecer em rede privada. A exposição a provedores externos depende de identidade e autorização por provedor e carteira. [Decisão de arquitetura](../ARCHITECTURE.md) · [Segurança operacional](SECURITY.md)

## Preparar a revisão

Na raiz da revisão a implantar, use Bun 1.4.4 e Docker com containers Linux. Rode as verificações em um ambiente de CI ou de avaliação com daemon local disponível.

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run format:check
bun run verify:evidence
```

`verify:evidence` compila e roda a regressão com PostgreSQL e MiniStack em um projeto separado, usando portas dinâmicas. No GitHub Actions, o artefato `verification-evidence` reúne o commit, as versões, as etapas e as contagens. Guarde a evidência da revisão. O workflow entrega os resultados da validação. A publicação da imagem e o rollout são operações da implantação. [Workflow](../.github/workflows/ci.yml) · [Última verificação da Fase 9](PHASE_9_FINAL_REPORT.md)

## Subir o ambiente de avaliação

Escolha um nome de projeto exclusivo e use o mesmo nome em todos os comandos. Este exemplo usa `jungle-avaliacao`. PostgreSQL, MiniStack e API são publicados em `127.0.0.1`, nas portas 5434, 4567 e 3000. Se uma porta estiver ocupada, ajuste `POSTGRES_PORT`, `SQS_PORT` ou `PORT` no ambiente antes de subir. Dentro da rede Compose, os serviços continuam usando `postgres:5432`, `sqs:4566` e `api:3000`.

```sh
docker compose -p jungle-avaliacao --env-file .env.example --profile workers config -q
docker compose -p jungle-avaliacao --env-file .env.example --profile workers up -d --build --wait --wait-timeout 120
docker compose -p jungle-avaliacao --env-file .env.example --profile workers ps -a
```

`setup` aguarda PostgreSQL e MiniStack saudáveis, aplica as migrations e provisiona as filas. O estado esperado é `Exited (0)` para `setup`, API saudável e `consumer`, `outbox` e `references` em execução. O estado `Up` dos workers representa processo ativo. Para comprovar o processamento, acompanhe seus logs e os efeitos no ambiente. [Ordem de dependências do Compose](https://docs.docker.com/compose/how-tos/startup-order/) · [Mensageria](MESSAGING_ARCHITECTURE.md)

### Conferir o ambiente

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
docker compose -p jungle-avaliacao --env-file .env.example --profile workers exec -T api bun --no-env-file dist/scripts/bootstrap/infra.js doctor
bun run demo:financial http://127.0.0.1:3000
docker compose -p jungle-avaliacao --env-file .env.example --profile workers exec -T api bun --no-env-file dist/scripts/audit/wallets.js
```

Em Bash, use `curl -fsS` com as URLs de health. Se alterou `PORT`, use a porta publicada nas consultas HTTP. As duas rotas devem devolver HTTP 200. Em readiness, `checks.postgres` e `checks.sqs` devem estar em `up`. O `doctor` deve mostrar zero migrations pendentes. Em uma base nova, a demo cria uma carteira sintética, termina em `120.00 BRL` e registra cinco lançamentos com diferença `0.00`. A auditoria CLI deve retornar `PASS`. O Compose usa `NODE_ENV=production`, que desativa `/docs` e `/docs-json`. Use o [contrato HTTP](API_CONTRACT.md) e a [coleção Postman](POSTMAN_GUIDE.md).

Em 19/11/2026, esse fluxo foi conferido em um projeto descartável com portas dinâmicas. O `setup` saiu com código zero, a API respondeu aos dois health checks, os três workers iniciaram, sete migrations estavam aplicadas e a auditoria retornou uma carteira e cinco lançamentos sem divergência.

### Diagnosticar e encerrar

```sh
docker compose -p jungle-avaliacao --env-file .env.example --profile workers logs --since 10m setup api consumer outbox references
docker compose -p jungle-avaliacao --env-file .env.example --profile workers stop --timeout 65
docker compose -p jungle-avaliacao --env-file .env.example --profile workers down
```

Use `stop` para pausar e manter os containers. Use `down` para remover containers e a rede preservando os volumes nomeados. Para reinstalar ou atualizar a avaliação, execute o mesmo `up` na revisão aprovada com o mesmo nome de projeto e confira o `setup` e o readiness. Preserve os volumes e confirme compatibilidade das migrations antes de atualizar um ambiente com dados que precisam ser mantidos. [Comando `down` do Docker](https://docs.docker.com/reference/cli/docker/compose/down/) · [Runbook](OPERATIONS_RUNBOOK.md)

## Implantação privada com AWS

O caminho abaixo usa a imagem do `Dockerfile` e os entrypoints existentes. A execução com Amazon SQS, PostgreSQL gerenciado e o orquestrador escolhido precisa ser comprovada em homologação antes de receber tráfego. O Compose desta entrega provisiona MiniStack e usa a configuração de avaliação.

### Infraestrutura e configuração

- Use rede privada e controle de ingresso para a API. Separe o login proprietário de migrations, o login de runtime e o login de auditoria. Aplique os grants versionados após as migrations. [Privilégios do PostgreSQL](SECURITY.md#privilégios-postgresql)
- Injete `NODE_ENV=production`, `ALLOW_LOCAL_SERVICES=false`, `PORT=3000`, `LOG_LEVEL=info` e os segredos pelo ambiente do runtime. O `DATABASE_URL` exige `sslmode=verify-full` e senha de pelo menos 16 caracteres. Para RDS, disponibilize uma CA confiável no container e referencie o caminho legível pelo usuário `bun` em `sslrootcert`. Use o hostname do servidor e codifique caracteres especiais da senha no DSN. [TLS do PostgreSQL no RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html)
- Configure `AWS_REGION`, `AWS_ACCOUNT_ID` de 12 dígitos e `SQS_ENDPOINT` como origem HTTPS regional. Configure `SQS_WAGER_QUEUE_URL` e `SQS_WAGER_DLQ_URL` com os nomes FIFO fixos `wager-transactions.fifo` e `wager-transactions-dlq.fifo`. A fila standard `SQS_EVENT_QUEUE_URL` usa `wager-events` por padrão. As três URLs devem compartilhar origem e conta. [Endpoints do SQS](https://docs.aws.amazon.com/general/latest/gr/sqs-service.html)
- Configure redrive da origem para a DLQ e alinhe visibilidade, espera do poll e limite de recebimentos com `SQS_VISIBILITY_TIMEOUT_SECONDS`, `SQS_POLL_WAIT_SECONDS` e `SQS_MAX_RECEIVE_COUNT`. Preserve o mesmo `SQS_CONSUMER_NAME` nas réplicas que compartilham a Inbox. Use credenciais temporárias do papel do runtime, por exemplo uma task role no ECS. [Task roles no ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html) · [Topologia de mensageria](MESSAGING_ARCHITECTURE.md)

Conceda permissões SQS sobre as filas necessárias a cada processo. Ajuste também a política da chave se usar uma chave KMS gerenciada pelo ambiente. [Permissões do SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-api-permissions-reference.html) · [Filas criptografadas com KMS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-least-privilege-policy.html)

| Processo                                           | Ações SQS usadas                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| API e diagnóstico `doctor`                         | `GetQueueAttributes` na origem, na DLQ e na fila de eventos                                                         |
| Consumer                                           | `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` e `GetQueueAttributes` na origem                       |
| Outbox                                             | `SendMessage` e `GetQueueAttributes` na fila de eventos                                                             |
| References                                         | Resolve referências no PostgreSQL                                                                                   |
| Provisionamento de filas pelo `infra.js provision` | `GetQueueUrl`, `CreateQueue`, `GetQueueAttributes` e `SetQueueAttributes` conforme os recursos que o job administra |

### Implantar e liberar tráfego

Em um checkout limpo da revisão aprovada, com acesso ao registry do ambiente, substitua o repositório de imagem do exemplo e publique a imagem. Guarde o digest devolvido pelo registry.

```sh
registry_image='registry.example.com/team/jungle-wagering-processor'
image="${registry_image}:$(git rev-parse HEAD)"
docker build -t "$image" . && docker push "$image"
```

1. Configure o digest publicado no orquestrador e preserve o digest anterior. Confirme backup recuperável do PostgreSQL antes de migrations em um ambiente com dados persistentes.
2. Provisione as filas e execute `bun --no-env-file dist/scripts/bootstrap/migrate.js up` em um job único com a credencial proprietária. Use `bun --no-env-file dist/scripts/bootstrap/infra.js provision` quando o mesmo job também for responsável pelas filas. Confirme o término com código zero e aplique os grants de runtime e auditoria.
3. Inicie a API e os três workers como processos separados da mesma imagem, com os comandos abaixo. Configure encerramento por `SIGTERM` com prazo do orquestrador maior que `SHUTDOWN_TIMEOUT_MS`.

   | Processo   | Comando no container                                   |
   | ---------- | ------------------------------------------------------ |
   | API        | `bun --no-env-file dist/src/main.js`                   |
   | Consumer   | `bun --no-env-file dist/src/worker.main.js consumer`   |
   | Outbox     | `bun --no-env-file dist/src/worker.main.js outbox`     |
   | References | `bun --no-env-file dist/src/worker.main.js references` |

4. Use `/health/live` para verificar o processo HTTP e `/health/ready` para habilitar tráfego. Rode `bun --no-env-file dist/scripts/bootstrap/infra.js doctor` com a identidade de diagnóstico. Em homologação, valide uma transação sintética ponta a ponta, incluindo ACK, publicação, reconciliação e auditoria read-only. Confira DLQ, eventos estacionados e lag antes da promoção. [Observabilidade](OBSERVABILITY.md) · [Runbook](OPERATIONS_RUNBOOK.md)

### Recuperar uma release

Se aparecerem falhas depois do rollout, interrompa a promoção e preserve logs, transações, filas e volumes. Reimplante o digest anterior somente se a versão anterior for compatível com o schema já aplicado. Se a migration impedir esse retorno, valide uma correção de avanço ou o procedimento de restauração em homologação antes de agir sobre o banco. `db:migrate:down` é exercitado em banco descartável e tem proteções contra remoção de dados financeiros. Depois de recuperar, confirme readiness, reconsulte a operação por identidade, verifique a drenagem da Outbox e confira a reconciliação. [Schema](DATABASE_SCHEMA.md) · [Cenários de falha](FAILURE_SCENARIOS.md)
