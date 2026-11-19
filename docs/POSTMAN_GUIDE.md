# Testar a Fase 5 no Postman

Abra o PowerShell na raiz e inicie a API local. O pgAdmin pode usar o banco local na porta `5432`, conforme o `.env` da API. Use o Compose para o MiniStack local.

```powershell
docker compose --env-file .env.example up -d --wait postgres sqs
bun --env-file=.env.example scripts/bootstrap/infra.ts provision
bun run db:migrate:status
bun run start:dev
```

Se o status indicar migrations pendentes no banco do seu `.env`, execute `bun run db:migrate` antes de iniciar a API.

1. No Postman, clique em **Import** e importe os dois arquivos JSON. [Coleção financeira](../postman/Jungle-Wagering-Processor.postman_collection.json) · [Ambiente local](../postman/Jungle-Local.postman_environment.json)
2. Selecione **Jungle Local — Fase 5**. A variável `baseUrl` usa `http://127.0.0.1:3000`. Ajuste a porta se a API escutar em outra.
3. Abra **Run collection** e mantenha a ordem das requisições com uma iteração. Cada execução gera um jogador novo, captura `walletId`, guarda o ID externo e a chave da BET e captura a referência da REFUND.
4. Confira o resultado de cada requisição em **Test Results**. Para executar à mão, siga a mesma ordem a partir de **Wallets → Criar carteira com 100.00 BRL**.

O roteiro abre com `100.00`, debita `25.00`, credita `50.00`, mantém saldo e versão na LOSS e repete a BET com saldo histórico de `75.00`. Depois restitui a aposta e reverte a restituição. A reconciliação final espera `125.00` em cinco lançamentos. A coleção inclui respostas esperadas de `400`, `409` e `422`.

| Sintoma                                                                         | Conferência                                                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Falha de conexão HTTP                                                           | Mantenha `bun run start:dev` aberto e confira `baseUrl`.                                                       |
| Porta `3000` ocupada ou rotas financeiras retornam `404` em um contêiner antigo | Rode `$env:PORT = "3005"` antes de `bun run start:dev` e use `http://127.0.0.1:3005` no ambiente Postman.      |
| Readiness retorna `503`                                                         | Veja `checks.postgres` e `checks.sqs`. Confira o PostgreSQL do `.env` e o MiniStack publicado na porta `4567`. |
| A URL ainda contém `{{walletId}}`                                               | Selecione o ambiente da coleção e execute a criação da carteira primeiro.                                      |
| Replay retorna `409` inesperado                                                 | Execute a requisição de replay após a BET da mesma rodada, usando o mesmo corpo e `Idempotency-Key`.           |
| Os testes da coleção veem saldos de uma rodada anterior                         | Inicie a coleção pela primeira abertura. Seu script gera um jogador novo e limpa as variáveis capturadas.      |

O Swagger interativo fica em `http://127.0.0.1:3000/docs`. O teste com três processos reais é executado por `bun run test:distributed` e usa outro banco temporário. [Contrato HTTP](API_CONTRACT.md) · [Testes distribuídos](DISTRIBUTED_CONCURRENCY.md)
