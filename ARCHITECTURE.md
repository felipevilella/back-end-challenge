# Arquitetura

## Referência e padrões preservados

Referência local examinada: `/Users/felipevilella/Desktop/finnance/econFin-backEnd`.

Preservamos `src/module/<feature>`, controllers finos, DTOs e mappers por feature, serviços com `execute()`, contratos em `src/repositories`, adapters em `src/infra/repositories`, entidades em `src/infra/entities`, configuração e migrations em `src/infra/database/typeorm` e composição por `UseCaseProxyModule.register()` com factories e tokens explícitos.

Fluxo atual: WalletsController → UseCaseProxy<GetWalletService> → IWalletsRepository → WalletsRepository → TypeORM/PostgreSQL. Serviços dependem de contratos, sem decorators NestJS. NestJS monta as dependências no composition root.

## Adaptações ao desafio

TypeORM foi escolhido para manter o padrão da referência e é aceito pelo enunciado. Migrations explícitas substituem sincronização automática. TypeScript usa strict e noUncheckedIndexedAccess. O runtime e test runner são Bun 1.x.

Money usa decimal.js com precisão 40; entrada e saída são strings. Persistência usa NUMERIC(20,2), devolvido pelo driver PostgreSQL como string. Mais de duas casas são rejeitadas, sem arredondamento de entrada. Valores internos negativos são necessários para diferenças e inversões; contratos de entrada não os aceitam. A validação atual de moeda verifica formato de três letras maiúsculas; catálogo ISO-4217 ainda não foi integrado.

Entidades ORM são separadas das classes de domínio, construídas por factories. O mapper chama rehydrate para reconstruir o domínio. O guard ProviderAuthGuard é no-op: autenticação foi adiada conforme seção 2, para priorizar consistência financeira. A evolução prevista é validar tokens de um IdP OIDC externo e confrontar a identidade autenticada com providerId. Health checks são públicos.

## Desenho previsto para processamento financeiro

Os itens abaixo são decisões de implementação futura, ainda não garantias desta base:

- Uma unidade transacional compartilhada por HTTP e SQS deve gravar operação, wallet, ledger, inbox e outbox com o mesmo EntityManager.
- Lock pessimista por wallet (`SELECT FOR UPDATE`), sem lock global. Repositórios de escrita devem receber contexto transacional explícito; não executar writes independentes em repositories globais.
- Constraints únicas para idempotency key, identidade externa por provedor, inbox, lançamento por operação e reversão por referência/tipo.
- SHA-256 do JSON canônico dos campos de negócio normalizados. A mesma key com hash distinto é conflito. Persistir resultado e saldo histórico para replay.
- Publicação de eventos somente pela outbox após commit; claim com lease recuperável e eventId estável. Consumidor deve tolerar duplicatas.
- Referências pendentes persistidas e reprocessadas com backoff. TTL e taxonomia de failureCode serão definidos junto com o fluxo.
- Ledger append-only com proteções no PostgreSQL. Reconciliação deve usar snapshot consistente.

## Limitações verificáveis

A migration atual cobre apenas wallets: unicidade player/moeda, saldo não negativo e versão positiva. Ainda não existe ledger nem vínculo entre saldo e lançamentos. Os métodos debit/credit do domínio validam estado em memória, mas não constituem um caminho de escrita persistente. Não há endpoints de movimentação nesta etapa.

A infraestrutura Compose e os scripts de migration exigem validação em PostgreSQL/LocalStack reais. Os testes unitários não comprovam concorrência distribuída, atomicidade, redelivery nem crash recovery.
