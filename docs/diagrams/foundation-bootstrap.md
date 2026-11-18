# Inicialização da fundação

```mermaid
flowchart TD
    H[Host ou CI com Bun] --> B[bun run infra:setup]
    B --> I[Compose inicia PostgreSQL e MiniStack]
    C[Compose com API] --> I
    I --> S[Health checks dos serviços]
    S --> P[Migrations e provisionamento SQS]
    P --> L[API local com start:dev]
    P --> A[API no Compose]
    L --> R[GET /health/ready]
    A --> R
    R --> DB[(PostgreSQL)]
    R --> Q[Filas SQS]
```

No host, o bootstrap aplica migrations e cria filas pelas portas publicadas. No Compose completo, o serviço `setup` usa os nomes internos `postgres` e `sqs`, e a API aguarda sua conclusão.
