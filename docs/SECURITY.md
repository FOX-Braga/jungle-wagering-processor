# Segurança operacional

## Identidade e rede

A API financeira de avaliação opera sem autenticação efetiva conforme a opção do desafio. Qualquer cliente com acesso à rede da API pode consultar ou submeter operações. Restrinja o acesso ao ambiente privado. O Compose publica as portas locais no loopback e mantém as métricas no namespace de cada processo. As rotas de saúde são públicas por contrato. A porta de métricas tem escopo de loopback e deve permanecer acessível apenas ao coletor autorizado.

O ponto de extensão é `ProviderIdentityPort`. A integração para um ambiente com clientes externos usa um guard NestJS respaldado por um IdP OIDC. Valide emissor, audiência, assinatura e expiração. Derive o provedor da identidade verificada e aplique escopo por provedor e carteira. Limite o acesso às filas a papéis IAM dedicados. [Decisão de arquitetura](../ARCHITECTURE.md)

## Configuração e segredos

Em produção, use `DATABASE_URL` com `sslmode=verify-full`, senha não padrão e origem SQS HTTPS. Configure `AWS_ACCOUNT_ID` com a conta das URLs de filas. Prefira identidade gerenciada pela cadeia do SDK. Credenciais explícitas exigem o par de acesso e segredo e aceitam token de sessão. O Compose de avaliação usa `ALLOW_LOCAL_SERVICES=true` com credenciais fictícias e SQS emulado. Use essa exceção somente em ambiente isolado.

Injete segredos pelo ambiente do runtime ou gerenciador de segredos. Mantenha `.env` local fora do Git. Para rotação PostgreSQL, provisione uma credencial substituta com os mesmos grants aprovados, teste a conexão e o `doctor` com o usuário de auditoria, faça o rollout e revogue a credencial anterior. Para AWS, use duração e renovação do papel IAM e confira o acesso às filas antes de revogar uma credencial explícita. Use CA confiável para PostgreSQL. Logs operacionais registram códigos e identificadores de correlação. [Campos e redaction](OBSERVABILITY.md)

## Privilégios PostgreSQL

Use três identidades. A conta de migrations possui o schema e aplica DDL. A conta de runtime recebe SELECT, INSERT e UPDATE de colunas operacionais. O papel de auditoria recebe SELECT, inclui inventário de migrations e executa consultas em transações somente leitura. Provisione logins dedicados sem propriedade de tabelas, sem superusuário e sem herança de papel proprietário. Aplique os grants como proprietário após as migrations.

```powershell
psql -X -v ON_ERROR_STOP=1 -v runtime_role=wagering_app -v audit_role=wagering_audit -f scripts/bootstrap/database-privileges.sql
```

Configure a conexão de `psql` pelo mecanismo de credenciais aprovado. O arquivo contém apenas os grants. Retire grants amplos anteriores e verifique privilégios herdados de PUBLIC antes de adotar papéis existentes. O trigger `apply_ledger_entry()` projeta saldo com privilégios do proprietário em `search_path` fixo. UPDATE, DELETE e TRUNCATE do ledger continuam protegidos também pelo trigger append-only.

O Compose local preserva a conta de bootstrap simplificada. O teste de segurança executa a aplicação com login restrito e verifica a recusa de DDL e alterações indevidas. Segmentação entre proprietário e runtime permanece necessária em ambientes implantados. [Schema](DATABASE_SCHEMA.md)

## Superfície HTTP

A API preserva as validações estritas de DTO, parâmetros, cursor e chave idempotente. A entrada JSON aceita até 16 KiB e desativa descompressão. CORS fica fechado por padrão. Swagger e seu JSON estão disponíveis fora de produção. Respostas incluem `Cache-Control: no-store` e `X-Content-Type-Options: nosniff`. Erros inesperados retornam código genérico e correlação. `HTTP_MAX_IN_FLIGHT` limita admissão por processo e devolve 503 com `Retry-After`; use a mesma identidade financeira ao reenviar. Para limite global por cliente e proteção de sockets, use o ingress do ambiente. [Contrato da API](API_CONTRACT.md)
