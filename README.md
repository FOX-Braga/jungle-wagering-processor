# Jungle Wagering Processor

Fundação do desafio técnico da Jungle Gaming para processamento distribuído de apostas. A Fase 1 entrega uma API de health, configuração validada, migrations, PostgreSQL e SQS local reproduzíveis. A Fase 2 implementa o [domínio financeiro](docs/DOMAIN_MODEL.md) com aritmética exata, ledger e eventos. A Fase 3 adiciona o [schema financeiro](docs/DATABASE_SCHEMA.md), repositórios MikroORM e proteção SQL do ledger. O [enunciado original](docs/challenge/README.original.md), a [arquitetura](ARCHITECTURE.md), a [matriz de requisitos](docs/REQUIREMENTS_MATRIX.md) e o [plano de testes](docs/TEST_PLAN.md) estão no repositório.

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
docker compose --env-file .env.example up -d --build --wait
docker compose --env-file .env.example ps -a
```

O serviço `setup` deve terminar com código `0`. A API roda com o usuário `bun` e fica acessível nas mesmas rotas. Use uma única forma de execução da API por vez para evitar disputa da porta 3000. Com personalizações em `.env`, acrescente `--env-file .env` depois de `--env-file .env.example` nos comandos do Compose. Com `docker compose --env-file .env.example down`, os volumes continuam disponíveis para a próxima inicialização.

## Ambiente

Os scripts carregam a configuração padrão de `.env.example`. Crie um `.env` local para sobrescrever apenas as variáveis necessárias. Valores exportados na sessão prevalecem. A integração carrega `.env.example` e `.env.test`, e usa `TEST_DATABASE_URL` como conexão de manutenção para os bancos descartáveis. Use os exemplos como credenciais descartáveis exclusivas de desenvolvimento.

| Variável                                                             | Uso                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`                                      | Ambiente, porta HTTP do host e nível de log estruturado                                              |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Inicialização do container e porta publicada                                                         |
| `DATABASE_URL`                                                       | DSN da API e dos scripts no host. Padrão em `127.0.0.1:5434`.                                        |
| `TEST_DATABASE_URL`                                                  | Conexão de manutenção dos testes SQL, apontada para o Compose na porta `5434`.                       |
| `DATABASE_URL_DOCKER`                                                | Sobrescrita opcional do DSN usado pelos containers. Padrão com serviço `postgres:5432`.              |
| `SQS_PORT`, `SQS_ENDPOINT`                                           | Porta publicada e endpoint do host. Padrão em `127.0.0.1:4567`. Internamente Compose usa `sqs:4566`. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`           | Região e credenciais locais. O identificador numérico de 12 dígitos é a conta do MiniStack.          |
| `SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL`                           | URLs das duas filas na mesma origem do endpoint e no caminho da conta configurada                    |

Ao trocar a porta publicada do PostgreSQL, ajuste `DATABASE_URL`. Ao trocar porta ou conta do MiniStack, ajuste o endpoint e as duas URLs de fila do host. As URLs internas usam os serviços DNS do Compose. Em DSNs com caracteres especiais, use _percent encoding_ e ajuste `DATABASE_URL_DOCKER` para o Compose, se necessário.

## PostgreSQL e migrations

A migration inicial cria o schema `wagering`. As migrations financeiras criam tabelas, índices, constraints e triggers de integridade. A migration da Fase 4 acrescenta snapshots de referências pendentes e preserva a moeda original de comandos rejeitados por divergência. O histórico fica em `public.mikro_orm_migrations`. O comando de migration usa `DATABASE_URL`, incluindo o valor de `.env` quando configurado. Se você usa pgAdmin com `jungle_db`, abra **Schemas → wagering → Tables** e atualize a árvore depois do `up`.

```powershell
bun run db:migrate
bun run db:migrate:status
```

`bun run db:migrate:down` reverte a última migration em um banco vazio. O rollback é bloqueado quando removeria proteções financeiras em uso ou descartaria dados. A suíte isolada faz o ciclo `up → down → up` e compara o catálogo do PostgreSQL antes e depois.

## SQS local

O MiniStack atende às operações SQS da fundação sem licença paga. A fila `wager-transactions.fifo` tem deduplicação por conteúdo, visibilidade de 30 segundos, long polling de 10 segundos e encaminhamento à `wager-transactions-dlq.fifo` após três recebimentos sem exclusão. A suíte usa filas temporárias para cenários com mensagens. A configuração e o estado dos emuladores usam volumes do Compose.

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
```

`provision` aplica as migrations e garante as filas de teste. `TEST_DATABASE_URL` identifica o PostgreSQL isolado na porta `5434`, e a conta deve ter permissão para criar bancos descartáveis. A suíte de persistência cria e limpa bancos com nomes gerados. Os testes de regressão usam PostgreSQL e MiniStack reais.

Para executar uma parte isoladamente:

```powershell
bun run test:db:constraints
bun run test:db:transactions
bun run test:db:migrations
bun run test:financial
bun run test:concurrency
bun run test:atomicity
```

As três suítes da Fase 4 também fazem parte de `test:integration`. Elas executam os casos de uso contra PostgreSQL real, incluindo replay após reconexão, concorrência e falhas antes do commit. Os endpoints financeiros serão integrados na Fase 5. [Motor financeiro](docs/FINANCIAL_PROCESSING.md)

## Troubleshooting

| Sintoma                       | Verificação                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker não responde           | Abra o Docker Desktop e confirme a versão do servidor com `docker info`.                                                                                                                       |
| Porta ocupada                 | Ajuste a porta do host e as URLs correspondentes em `.env`. O Compose usa por padrão 5434 e 4567, além da porta 3000 da API.                                                                   |
| PostgreSQL recusa credenciais | Confirme `DATABASE_URL`. O volume preserva os usuários inicializados no primeiro startup. Alterar `POSTGRES_PASSWORD` no Compose depois do primeiro startup não muda a senha gravada no banco. |
| Ready retorna `sqs: down`     | Rode `bun run doctor` e `bun run infra:setup`. Confira conta, origem, nomes e alcance das URLs.                                                                                                |
| API containerizada não inicia | Inspecione `docker compose --env-file .env.example logs setup api` e o histórico de migrations.                                                                                                |
