# Jungle Wagering Processor

Fundação do desafio técnico da Jungle Gaming para processamento distribuído de apostas. A Fase 1 entrega uma API de health, configuração validada, migrations, PostgreSQL e SQS local reproduzíveis. A Fase 2 implementa o [domínio financeiro](docs/DOMAIN_MODEL.md) com aritmética exata, ledger e eventos. O [enunciado original](docs/challenge/README.original.md), a [arquitetura](ARCHITECTURE.md), a [matriz de requisitos](docs/REQUIREMENTS_MATRIX.md) e o [plano de testes](docs/TEST_PLAN.md) estão no repositório.

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

Os scripts carregam a configuração padrão de `.env.example`. Crie um `.env` local para sobrescrever apenas as variáveis necessárias. Valores exportados na sessão prevalecem. Os testes de integração adicionam `.env.test` para estabelecer o modo de teste e o nível de log. Use os exemplos como credenciais descartáveis exclusivas de desenvolvimento.

| Variável                                                             | Uso                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`                                      | Ambiente, porta HTTP do host e nível de log estruturado                                              |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Inicialização do container e porta publicada                                                         |
| `DATABASE_URL`                                                       | DSN da API e dos scripts no host. Padrão em `127.0.0.1:5434`.                                        |
| `DATABASE_URL_DOCKER`                                                | Sobrescrita opcional do DSN usado pelos containers. Padrão com serviço `postgres:5432`.              |
| `SQS_PORT`, `SQS_ENDPOINT`                                           | Porta publicada e endpoint do host. Padrão em `127.0.0.1:4567`. Internamente Compose usa `sqs:4566`. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`           | Região e credenciais locais. O identificador numérico de 12 dígitos é a conta do MiniStack.          |
| `SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL`                           | URLs das duas filas na mesma origem do endpoint e no caminho da conta configurada                    |

Ao trocar a porta publicada do PostgreSQL, ajuste `DATABASE_URL`. Ao trocar porta ou conta do MiniStack, ajuste o endpoint e as duas URLs de fila do host. As URLs internas usam os serviços DNS do Compose. Em DSNs com caracteres especiais, use _percent encoding_ e ajuste `DATABASE_URL_DOCKER` para o Compose, se necessário.

## PostgreSQL e migrations

A primeira migration cria o schema `wagering`. O histórico do MikroORM fica em `public.mikro_orm_migrations`. A API usa conexão preguiçosa e o bootstrap aplica as migrations em processo separado. Os arquivos versionados ficam em `src/infrastructure/persistence/migrations`.

```powershell
bun run migration:status
bun run migration:up
```

`bun run migration:down` reverte a última migration. Use uma conexão para banco descartável ao validar reversões. A suíte de integração faz o ciclo `up → down → up` em banco temporário e verifica tanto o schema quanto o histórico.

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
bun run infra:setup
bun run doctor
bun run test:integration
```

A integração exige PostgreSQL e MiniStack reais e a configuração local do Compose. O usuário de teste precisa criar bancos descartáveis. Os testes aguardam condições observáveis, limpam os recursos temporários e exercitam indisponibilidade por links TCP isolados que encaminham para os containers reais.

## Troubleshooting

| Sintoma                       | Verificação                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker não responde           | Abra o Docker Desktop e confirme a versão do servidor com `docker info`.                                                                                                                       |
| Porta ocupada                 | Ajuste a porta do host e as URLs correspondentes em `.env`. O Compose usa por padrão 5434 e 4567, além da porta 3000 da API.                                                                   |
| PostgreSQL recusa credenciais | Confirme `DATABASE_URL`. O volume preserva os usuários inicializados no primeiro startup. Alterar `POSTGRES_PASSWORD` no Compose depois do primeiro startup não muda a senha gravada no banco. |
| Ready retorna `sqs: down`     | Rode `bun run doctor` e `bun run infra:setup`. Confira conta, origem, nomes e alcance das URLs.                                                                                                |
| API containerizada não inicia | Inspecione `docker compose --env-file .env.example logs setup api` e o histórico de migrations.                                                                                                |
