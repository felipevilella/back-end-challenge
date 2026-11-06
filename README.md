# Distributed Wagering Processor

Base NestJS do desafio, seguindo os padrões do `econFin-backEnd`.

## Requisitos

Bun 1.x e Docker Compose. Copie `.env.example` para `.env`.

```sh
bun install
bun run infra:up
bun run migration:run
bun run dev
```

```sh
bun run typecheck
bun run build
bun test
bun run migration:revert
```

A API usa a porta 3000. Rotas implementadas:

- `GET /health/live`: liveness sem autenticação.
- `GET /health/ready`: verifica PostgreSQL e a fila SQS.
- `GET /wallets/:walletId`: consulta wallet; 404 quando inexistente.

Não há seed nem endpoint de criação nesta base. A migration cria a tabela de wallets. As filas FIFO e DLQ são provisionadas pelo script de inicialização do LocalStack.

Para executar a API em container, após aplicar as migrations:

```sh
docker compose --profile app up --build -d
```

## Organização

```text
src/
  module/
    app.module.ts
    domains/                # Classes de domínio sem NestJS/ORM
    auth/                   # Guard de extensão para OIDC
    health/
    wallets/
      dto/
      mapper/
      services/             # Classes com execute(), construídas por factory
      wallets.controller.ts
      wallets.module.ts
  repositories/             # Contratos de persistência
  infra/
    database/config/
    database/typeorm/migrations/
    entities/               # Mapeamento ORM separado do domínio
    repositories/           # Adapters TypeORM
    messaging/              # Cliente SQS
    usecase-proxy/          # Composition root e UseCaseProxy<T>
scripts/
test/unit/
```

## Escopo atual

Esta entrega é a estrutura inicial executável, não a implementação completa do desafio.

Implementado: composição NestJS, configuração por ambiente, TypeORM sem synchronize, migration reversível de wallets, leitura de wallet, validação global, Money decimal imutável, Wallet, health checks, infraestrutura local e testes unitários básicos.

Pendente: criação de wallet com OPENING, processamento de apostas, ledger, idempotência, inbox/outbox, workers, reconciliação, métricas, logs correlacionados e testes de integração/concorrência. Não use esta base para movimentar valores antes de implementar a unidade transacional e essas garantias.

O guard de autenticação é intencionalmente no-op; consulte ARCHITECTURE.md.
