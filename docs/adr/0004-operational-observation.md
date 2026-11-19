# ADR 0004 — Observação operacional e integridade

## Decisão

Use logs JSON sanitizados, métricas por processo em loopback e coleta designada de gauges compartilhados. Use PostgreSQL como fonte persistente para backlog e auditoria. A reconciliação HTTP usa um statement em transação somente leitura. A auditoria paginada mantém um snapshot somente leitura pelo escopo solicitado. Preserve o envelope de eventos com metadados opcionais de correlação.

## Consequências

Os adaptadores medem após commit e cada processo pode reiniciar seus counters independentemente. A profundidade do SQS é aproximada. O coletor compartilhado expõe idade e disponibilidade da última amostra. A consulta de auditoria retém versões de linhas enquanto o snapshot estiver ativo. O novo índice parcial localiza a correlação de referências sem alterar restrições financeiras.

Os requisitos do desafio são logs, métricas obrigatórias, probes separados e registro de divergências. A exposição JSON, o CLI, os papéis PostgreSQL e o coletor designado são decisões da fase. Dashboards e tracing distribuído são opcionais. [Observabilidade](../OBSERVABILITY.md) · [Reconciliação](../RECONCILIATION.md)
