# Jungle Wagering Processor

Processador financeiro distribuído do desafio técnico da Jungle Gaming. A API REST e o consumidor SQS compartilham o mesmo [motor financeiro](docs/FINANCIAL_PROCESSING.md), com saldo decimal exato, ledger imutável e idempotência no PostgreSQL. A Fase 6 coloca em operação a Inbox transacional, a publicação concorrente pela Outbox e a recuperação de referências fora de ordem. [Enunciado original](docs/challenge/README.original.md) · [Arquitetura](ARCHITECTURE.md) · [Matriz de requisitos](docs/REQUIREMENTS_MATRIX.md) · [Plano de testes](docs/TEST_PLAN.md)

## Stack

Bun 1.4.4, TypeScript 5.9.3 em modo estrito, NestJS 11.2.10, MikroORM 6.6.18, PostgreSQL 16.11, AWS SDK v3 e MiniStack 1.5.38. O `bun.lock` fixa a árvore de dependências.

## Pré-requisitos

- Bun 1.4.4 no `PATH`.
- Docker Desktop em modo de containers Linux com Docker Compose.
- PowerShell no Windows. A AWS CLI é opcional para inspeção manual.

```powershell
bun --version
docker compose version
docker info --format '{{.ServerVersion}}'
```

Se a instalação padrão do Bun estiver fora do `PATH` da sessão, acrescente seu diretório e confira novamente a versão.

```powershell
$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
bun --version
```

## Executar a API no Windows

Na raiz do repositório:

```powershell
bun install --frozen-lockfile
bun run infra:setup
bun run doctor
bun run start:dev
```

`infra:setup` verifica Bun e Docker, espera os serviços saudáveis, aplica migrations pendentes e cria ou configura as filas. Pode ser repetido. `start:dev` inicia a API com recarga quando o código muda. Para executar o build local, use `bun run build` seguido de `bun run start`.

Em outro terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

A documentação OpenAPI está em `http://127.0.0.1:3000/docs`. O readiness devolve HTTP 200 com ambos os serviços em `up`, ou 503 com o estado de cada dependência. O liveness devolve 200 enquanto o processo HTTP responde.

## Executar tudo no Docker Compose

```powershell
docker compose --env-file .env.example --profile workers up -d --build --wait
docker compose --env-file .env.example --profile workers ps -a
```

O serviço `setup` deve terminar com código `0`. A API roda com o usuário `bun` e fica acessível nas mesmas rotas. Use uma única forma de execução da API por vez para evitar disputa da porta 3000. Com personalizações em `.env`, acrescente `--env-file .env` depois de `--env-file .env.example` nos comandos do Compose. Com `docker compose --env-file .env.example down`, os volumes continuam disponíveis para a próxima inicialização.

## Ambiente

Os scripts carregam a configuração padrão de `.env.example`. Crie um `.env` local para sobrescrever apenas as variáveis necessárias. Valores exportados na sessão prevalecem. A integração carrega `.env.example` e `.env.test`, e usa `TEST_DATABASE_URL` como conexão de manutenção para os bancos descartáveis. Use os exemplos como credenciais descartáveis exclusivas de desenvolvimento.

| Variável                                                                           | Uso                                                                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`                                                    | Ambiente, porta HTTP do host e nível de log estruturado                                               |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`               | Inicialização do container e porta publicada                                                          |
| `DATABASE_URL`                                                                     | DSN da API e dos scripts no host. Padrão em `127.0.0.1:5434`.                                         |
| `TEST_DATABASE_URL`                                                                | Conexão de manutenção dos testes SQL, apontada para o Compose na porta `5434`.                        |
| `DATABASE_URL_DOCKER`                                                              | Sobrescrita opcional do DSN usado pelos containers. Padrão com serviço `postgres:5432`.               |
| `SQS_PORT`, `SQS_ENDPOINT`                                                         | Porta publicada e endpoint do host. Padrão em `127.0.0.1:4567`. Internamente Compose usa `sqs:4566`.  |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                         | Região e credenciais locais. O identificador numérico de 12 dígitos é a conta do MiniStack.           |
| `SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL`, `SQS_EVENT_QUEUE_URL`                  | Filas na mesma origem do endpoint e no caminho da conta configurada. A saída padrão é `wager-events`. |
| `SQS_POLL_WAIT_SECONDS`, `SQS_VISIBILITY_TIMEOUT_SECONDS`, `SQS_MAX_RECEIVE_COUNT` | Long poll, visibilidade e limite de recebimentos antes do redrive                                     |
| `SQS_CONSUMER_CONCURRENCY`, `SQS_CONSUMER_NAME`                                    | Slots por instância e nome lógico compartilhado pelas réplicas na Inbox                               |
| `OUTBOX_*`, `REFERENCE_*`                                                          | Lotes, intervalos, limites de tentativas e duração do lease de publicação                             |

Ao trocar a porta publicada do PostgreSQL, ajuste `DATABASE_URL`. Ao trocar porta ou conta do MiniStack, ajuste o endpoint e as URLs de entrada e DLQ do host. A URL padrão de eventos é derivada do endpoint e da conta. Use `SQS_EVENT_QUEUE_NAME` no Compose para personalizar a fila standard interna. Em DSNs com caracteres especiais, use _percent encoding_ e ajuste `DATABASE_URL_DOCKER` para o Compose, se necessário.

## API financeira e Postman

Com a API local em execução, abra `http://127.0.0.1:3000/docs` para o Swagger ou importe a coleção e selecione o ambiente local no Postman. A coleção abre uma carteira, demonstra o replay histórico, executa reversões e termina com reconciliação. [Contrato HTTP](docs/API_CONTRACT.md) · [Guia do Postman](docs/POSTMAN_GUIDE.md)

```powershell
bun run demo:http
```

O comando usa a API local na porta 3000. Se outro processo já ocupa a porta, defina `$env:PORT = "3005"` antes de iniciar a API e use `bun run demo:http http://127.0.0.1:3005`.

## PostgreSQL e migrations

A migration inicial cria o schema `wagering`. As migrations financeiras criam tabelas, índices, constraints e triggers de integridade. A migration da Fase 4 acrescenta snapshots de referências pendentes e preserva a moeda original de comandos rejeitados por divergência. O histórico fica em `public.mikro_orm_migrations`. O comando de migration usa `DATABASE_URL`, incluindo o valor de `.env` quando configurado. Se você usa pgAdmin com `jungle_db`, abra **Schemas → wagering → Tables** e atualize a árvore depois do `up`.

```powershell
bun run db:migrate
bun run db:migrate:status
```

`bun run db:migrate:down` reverte a última migration em um banco vazio. O rollback é bloqueado quando removeria proteções financeiras em uso ou descartaria dados. A suíte isolada faz o ciclo `up → down → up` e compara o catálogo do PostgreSQL antes e depois.

## SQS local

O MiniStack fornece as filas FIFO de solicitações e DLQ e a fila standard `wager-events`. A Inbox confirma a operação após o commit SQL. O redrive padrão move mensagens após três recebimentos sem exclusão. Para iniciar os workers no host, abra um terminal por comando após o provisionamento.

```powershell
bun run worker:consumer
bun run worker:outbox
bun run worker:references
bun run queues:inspect
```

O fluxo, o contrato de mensagens e a recuperação de eventos estacionados estão documentados. [Arquitetura de mensageria](docs/MESSAGING_ARCHITECTURE.md) · [Runbook](docs/FAILURE_SCENARIOS.md)

Para listar filas com AWS CLI:

```powershell
$env:AWS_ACCESS_KEY_ID = "000000000000"
$env:AWS_SECRET_ACCESS_KEY = "local-dev"
aws --region us-east-1 --endpoint-url http://127.0.0.1:4567 sqs list-queues
```

## Verificações

```powershell
bun run lint
bun run typecheck
bun run format:check
bun run build
bun run test:unit
bun run test:properties
```

Para rodar a integração completa, prepare os serviços descartáveis com os valores de `.env.example`.

```powershell
docker compose --env-file .env.example up -d --wait postgres sqs
bun --env-file=.env.example scripts/bootstrap/infra.ts provision
bun run test:integration
bun run test:e2e
bun run test:distributed
bun run test:messaging
bun run test:recovery
bun run demo:resilience
```

`provision` aplica as migrations e garante as filas de teste. `TEST_DATABASE_URL` identifica o PostgreSQL isolado na porta `5434`, e a conta deve ter permissão para criar bancos descartáveis. A suíte de persistência cria e limpa bancos com nomes gerados. Os testes de regressão usam PostgreSQL e MiniStack reais.

As suítes de mensageria também podem rodar em partes com `test:inbox`, `test:outbox` e `test:dlq`. A demonstração pausa processos em pontos controlados, reinicia workers e imprime o resultado da reconciliação. [Demonstração de resiliência](docs/RESILIENCE_DEMO.md) · [Relatório da Fase 6](docs/PHASE_6_REPORT.md)

Para executar uma parte isoladamente:

```powershell
bun run test:db:constraints
bun run test:db:transactions
bun run test:db:migrations
bun run test:financial
bun run test:concurrency
bun run test:atomicity
```

As três suítes da Fase 4 também fazem parte de `test:integration`. Elas executam os casos de uso contra PostgreSQL real, incluindo replay após reconexão, concorrência e falhas antes do commit. Os testes E2E fazem requisições HTTP reais e os distribuídos compilam e iniciam três processos separados sobre o mesmo banco descartável. [Motor financeiro](docs/FINANCIAL_PROCESSING.md) · [Concorrência distribuída](docs/DISTRIBUTED_CONCURRENCY.md)

## Troubleshooting

| Sintoma                       | Verificação                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker não responde           | Abra o Docker Desktop e confirme a versão do servidor com `docker info`.                                                                                                                       |
| Porta ocupada                 | Ajuste a porta do host e as URLs correspondentes em `.env`. O Compose usa por padrão 5434 e 4567, além da porta 3000 da API.                                                                   |
| PostgreSQL recusa credenciais | Confirme `DATABASE_URL`. O volume preserva os usuários inicializados no primeiro startup. Alterar `POSTGRES_PASSWORD` no Compose depois do primeiro startup não muda a senha gravada no banco. |
| Ready retorna `sqs: down`     | Rode `bun run doctor` e `bun run infra:setup`. Confira conta, origem, nomes e alcance das URLs.                                                                                                |
| API containerizada não inicia | Inspecione `docker compose --env-file .env.example logs setup api` e o histórico de migrations.                                                                                                |
