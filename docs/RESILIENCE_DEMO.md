# Demonstração de resiliência

```powershell
docker compose --env-file .env.example up -d --wait postgres sqs
bun --env-file=.env.example scripts/bootstrap/infra.ts provision
bun run demo:resilience
```

O comando usa PostgreSQL e MiniStack reais, uma base de dados descartável e três filas isoladas. O teste controla os pontos de parada e encerra processos filhos. Cria uma carteira com `100.00 BRL`, confirma uma BET de `25.00 BRL` no banco, encerra o consumer antes do ACK e espera a segunda entrega. Envia uma duplicata por um novo transporte, depois um REFUND antes da BET referenciada. Um worker resolve a referência usando a mesma transação pendente.

Em seguida, o publisher envia um evento e é encerrado antes de registrar `publishedAt`. O próximo publisher recupera o claim vencido e confirma a publicação do mesmo ID. A saída JSON é construída com logs de ACK e consultas ao PostgreSQL. O cenário verifica nove eventos confirmados, quatro transações incluindo a abertura, quatro lançamentos e reconciliação de `75.00 BRL`. O comando retorna código diferente de zero se uma verificação falhar.

`bun run test:recovery` também cobre crash antes do commit, falha de ACK, perda de conectividade SQL durante a transação e shutdown. Os pontos de pausa ficam no processo auxiliar de teste. No Windows, o teste de drenagem sinaliza esse processo via entrada padrão. Em ambientes POSIX, o teste envia SIGTERM.
