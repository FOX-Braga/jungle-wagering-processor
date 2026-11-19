# ADR 0003 — SQS e workers com recuperação persistente

## Decisão

Executar consumer, publisher e worker de referências como papéis independentes do monólito. A API e o consumer chamam o mesmo caso de uso e o mesmo modelo transacional. O SQS confirma a entrega após o retorno do commit e controla a DLQ pelo redrive nativo. A Outbox usa leases persistentes e envia para uma fila standard dedicada. Referências usam agenda persistida e o lock da carteira antes de revalidar a pendência.

## Consequências

Escalar papéis independe de replicar regras financeiras. O PostgreSQL controla as identidades e protege efeitos repetidos. O destino aceita entregas repetidas e consumidores downstream deduplicam por `eventId`. Quando o publisher esgota retries, o evento permanece estacionado e recuperável pelo operador. A fila de entrada mantém o redrive da mensagem original para diagnóstico.
