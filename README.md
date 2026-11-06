# Distributed Wagering Processor

Processador financeiro NestJS, Bun, TypeScript estrito, TypeORM, PostgreSQL e SQS. Organização baseada no `econFin-backEnd`: módulos por feature, serviços com `execute()`, contratos de repositório e composição via `UseCaseProxyModule`.

## Executar localmente

Requisitos: Bun 1.x e Docker Compose.

```sh
cp .env.example .env
bun install
bun run infra:up
bun run migration:run
bun run dev
```

Em outro terminal:

```sh
bun run worker
```

O script do LocalStack cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. Aguarde a inicialização do LocalStack antes de testar readiness ou os workers.

Para executar API e workers em containers, depois de aplicar as migrations:

```sh
docker compose --profile app up --build -d --scale worker=3
```

`RUN_WORKERS=false` é o padrão da API. O entrypoint de worker habilita os três loops: consumo SQS, outbox e referências pendentes. SIGTERM interrompe novas leituras e aguarda as mensagens em andamento antes de fechar conexões.

## API

| Método | Rota | Comportamento |
|---|---|---|
| POST | `/wallets` | Cria wallet; saldo positivo gera OPENING e ledger atômicos |
| GET | `/wallets/:walletId` | Consulta saldo e versão |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Paginação ascendente por versão, cursor opaco |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo com soma do ledger, sem corrigir divergências |
| POST | `/wagering/transactions` | Processa BET, WIN, LOSS, REFUND e ROLLBACK |
| GET | `/wagering/transactions/:transactionId` | Consulta operação |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta identidade externa |
| GET | `/health/live` | Liveness público |
| GET | `/health/ready` | PostgreSQL e fila SQS acessíveis |
| GET | `/health/metrics` | Métricas Prometheus locais ao processo |

Exemplo de criação:

```sh
curl -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Submissão de aposta (substitua `walletId` pelo ID retornado):

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "10.00", "currency": "BRL" }
}
```

Use `Content-Type: application/json` e o header obrigatório `Idempotency-Key: provider-a:bet-1`. `X-Correlation-Id` é opcional. REFUND/ROLLBACK exigem `referenceExternalTransactionId`. LOSS exige amount `"0.00"`; as demais operações externas exigem valor positivo. OPENING é exclusivamente interno.

HTTP: 400 contrato inválido; 404 recurso ausente; 409 conflito; 422 rejeição de negócio; 202 referência pendente; 200 operação processada/replay; 500 falha terminal auditada ou erro interno; 503 infraestrutura temporariamente indisponível. Criação de wallet retorna 201.

Mensagens SQS usam o envelope do desafio (`messageId`, `type`, `occurredAt`, `data`), com `idempotencyKey` dentro de `data`. `type` deve ser `WagerTransactionRequested`. Os eventos saem em `wager-events.fifo`; consumidores externos devem deduplicar pelo `eventId` persistente.

## Postman

Importe a coleção [wagering.postman_collection.json](postman/wagering.postman_collection.json). Ela contém 38 requisições com exemplos, testes e captura automática de IDs. A ordem de execução está em [postman/README.md](postman/README.md).

## Testes

```sh
bun run format:check
bun run typecheck
bun run build
bun test test/unit
```

PostgreSQL real temporário, sem depender de Docker (instalação local não root):

```sh
bun run test:postgres
```

O runner usa binários PostgreSQL do pacote `embedded-postgres`, uma porta livre e um diretório temporário próprio. Instalações com scripts de dependências bloqueados são atendidas pela reidratação de symlinks do pacote. O banco é encerrado e removido ao final.

Para a suíte com PostgreSQL e LocalStack reais em containers, use um banco dedicado a testes:

```sh
TEST_DATABASE_URL=postgresql://wager:wager@localhost:5432/wager_test \
TEST_SQS_ENDPOINT=http://localhost:4566 \
bun run test:integration
```

Crie o banco `wager_test` previamente. Os testes aplicam migrations, criam dados com identificadores únicos e criam/removem suas próprias filas. Nunca apontam automaticamente para `DATABASE_URL`. Sem `TEST_DATABASE_URL`, testes de PostgreSQL são pulados explicitamente; sem `TEST_SQS_ENDPOINT`, testes SQS também são pulados.

Há testes para races entre três processos, saldo disputado, idempotência, rollback atômico, inbox, reversões, referência fora de ordem, constraints, leases e recuperação. A suíte SQS inclui processo encerrado após commit/antes do ack e publisher encerrado após envio/antes da confirmação. As flags `TEST_CRASH_AFTER_COMMIT` e `TEST_CRASH_AFTER_PUBLISH` só têm efeito com `NODE_ENV=test`.

## Padrões de código

Use `bun run format` para formatar e `bun run format:check` para validar. Prettier e EditorConfig mantêm indentação de duas posições, limite de 100 colunas e blocos/métodos em múltiplas linhas.

A persistência usa entidades TypeORM para wallet, operações, ledger, inbox e outbox. Repositórios financeiros são obtidos pelo EntityManager da transação; consultas, inserções e atualizações usam Repository/QueryBuilder. Workers delegam consultas de pendências ao repositório. Constraints e triggers permanecem nas migrations PostgreSQL.

## Estado de validação desta entrega

- 26 testes unitários passaram.
- Uma execução com PostgreSQL real passou nos 11 cenários iniciais, incluindo 50 duplicatas em três processos, disputa de saldo, atomicidade, referências e claims concorrentes.
- A suíte foi ampliada e os repositórios foram refatorados para entidades TypeORM depois dessa execução. A repetição com PostgreSQL/HTTP não foi autorizada; os casos novos e as alterações posteriores ainda precisam dessa execução.
- A suíte SQS/LocalStack e o Compose não foram executados neste ambiente, que não dispõe de Docker.

Autenticação permanece como guard no-op, conforme permitido pelo desafio. Veja decisões, garantias e limites em ARCHITECTURE.md.
