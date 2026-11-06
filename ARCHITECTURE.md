# Arquitetura

## Padrões do econFin

Referência examinada: `/Users/felipevilella/Desktop/finnance/econFin-backEnd`.

Mantemos `src/module/<feature>` com controllers, DTOs, mappers e serviços; contratos em `src/repositories`; implementações em `src/infra/repositories`; entidades em `src/infra/entities`; configuração/migrations em `src/infra/database/typeorm`; factories e tokens no `UseCaseProxyModule.register()`. Serviços não dependem de decorators NestJS. Controllers e consumidor compartilham o `ProcessWagerService.execute()`.

O TypeORM foi preservado por compatibilidade com a referência e por ser aceito pelo desafio. A persistência usa Repository e QueryBuilder do TypeORM, sempre obtidos pelo EntityManager da mesma transação. Wallet, operações, ledger, inbox e outbox possuem entidades tipadas com colunas explícitas e valores monetários string. Locks pessimistas, SKIP LOCKED e conflitos de inserção são expressos pelas APIs do ORM. SQL DDL permanece nas migrations; agregações e aritmética de tempo usam expressões parametrizadas no QueryBuilder. `synchronize` e migrations automáticas no startup estão desabilitados.

## Domínio e dinheiro

Money é imutável e usa decimal.js com precisão 40. Contratos e persistência usam strings; NUMERIC(20,2) é lido pelo driver como string. Entradas numéricas, negativas, notação científica, NaN/Infinity e mais de duas casas são rejeitadas. A saída tem duas casas. A moeda tem formato de três letras maiúsculas; não há catálogo ISO-4217 completo nesta implementação.

BET/WIN/REFUND/ROLLBACK exigem valor positivo. LOSS exige zero e não altera saldo/versão nem gera ledger. Uma wallet aberta com zero começa na versão 1 sem OPENING; a primeira movimentação usa versão 2. Abertura positiva tem OPENING e ledger CREDIT na versão 1.

Wallet encapsula saldo e versão; WagerTransaction encapsula transições; WalletLedgerEntry valida sua aritmética e não possui métodos de mutação. Entidades ORM são separadas do domínio. Rehydrate reconstrói estado persistido sem reaplicar transições.

## Unidade transacional e concorrência

O fluxo adquire `SELECT FOR UPDATE` na wallet antes de inbox, operação e referências. Operações da mesma wallet são serializadas; wallets distintas continuam paralelas. Não existe lock global. A conexão aplica lock_timeout de 5s e statement_timeout de 15s; timeout/deadlock resulta em falha transitória, sem retry financeiro oculto no HTTP. O cliente pode repetir com a mesma chave; o consumidor usa backoff.

Na mesma transação SQL são gravados: inbox quando aplicável, operação, wallet, ledger, resultado para replay e outbox. Ack ocorre após a resolução do commit. Injeção de falha na gravação da outbox verifica rollback dos demais registros.

O banco impõe unicidade player/moeda, identidade externa por provider, idempotency key global, inbox por consumer/message, ledger por wallet/operação e por wallet/versão, além de reversão processada por referência/tipo. Há checks monetários e foreign keys compostas. Triggers impedem UPDATE/DELETE/TRUNCATE no ledger e alterações em operações terminais ou em sua identidade de negócio.

Constraint triggers diferidos verificam no commit: saldo materializado igual à soma do ledger, cadeia de saldos/versões, correspondência entre operação processada e lançamento, moeda/player e referências de operações processadas. Assim um UPDATE direto no saldo sem ledger também falha. Essas verificações percorrem o histórico da wallet: priorizam garantia verificável sobre throughput; uma evolução para volumes altos deve substituir a varredura por validação incremental igualmente protegida.

## Idempotência e replay

O header HTTP é obrigatório; na fila, `data.idempotencyKey` ocupa o mesmo papel. A chave é global e deve incluir o provider. A identidade `(providerId, externalTransactionId)` também é única: reapresentar essa identidade com uma chave diferente é conflito.

O hash usa SHA-256 de JSON canônico recursivo, com chaves ordenadas lexicograficamente, campos undefined omitidos e arrays preservados. O subconjunto contém os campos de negócio, com Money normalizado para duas casas. Idempotency key, headers, correlationId e metadados de transporte não entram nesse hash. Colisões concorrentes são resolvidas por INSERT ON CONFLICT e comparação do registro vencedor.

O resultado e o saldo observado são persistidos na operação. Replay terminal não lê o saldo atual. Operações pendentes retornam o estado/resultado persistido mais recente; quando o worker as conclui, os replays passam a retornar o resultado terminal. `idempotentReplay` muda para true.

A inbox é outra garantia: `(consumerName,messageId)` deduplica entregas e seu hash inclui o envelope validado. O mesmo messageId com envelope diferente é conflito permanente. Mesmo uma entrega com novo messageId continua sujeita à idempotência financeira.

## Referências e reversões

Referências são resolvidas por provider/ID externo e devem corresponder a wallet, player, moeda e rodada. WIN e LOSS podem informar referência a BET; quando informada, a referência também é validada e aguardada. REFUND referencia BET. ROLLBACK referencia BET/WIN/REFUND e inverte a direção do ledger original. Reversões parciais não são aceitas.

A unicidade de reversão é por referência **e tipo**, conforme o texto do desafio. Portanto uma BET pode ter um REFUND e um ROLLBACK, um de cada. Reverter um REFUND não libera uma segunda devolução da mesma BET. Essas escolhas são explícitas para evitar uma interpretação implícita de exclusividade entre tipos.

Referências ausentes ou ainda pendentes geram PENDING_REFERENCE. Referências terminais rejeitadas/falhas causam REFERENCE_NOT_PROCESSED. Contexto incompatível e autorreferência são rejeitados. O worker adquire a wallet antes de revalidar a operação pendente, evitando inversão de ordem de locks; múltiplos workers rechecando a mesma pendência não avançam tentativas antecipadamente.

Backoff: 1, 2, 4... segundos, limitado a 300s. A operação expira quando já registrou 20 esperas, ou após 24h desde a criação. Em atividade contínua, o limite de tentativas encerra a espera em aproximadamente uma hora; o TTL limita pendências após indisponibilidades prolongadas. Expiração é REJECTED/REFERENCE_EXPIRED com evento. O evento de pendência é emitido uma vez na transição inicial.

## Estados e códigos

Transições: PENDING → PENDING_REFERENCE/PROCESSED/REJECTED/FAILED; PENDING_REFERENCE → PENDING_REFERENCE/PROCESSED/REJECTED/FAILED. PROCESSED/REJECTED/FAILED são terminais, também protegidos pelo banco.

| Código | Significado / ação do provedor |
|---|---|
| INVALID_MONEY, INVALID_OPERATION_AMOUNT, INVALID_TRANSACTION_KIND | Corrigir contrato/valor/tipo |
| INVALID_IDEMPOTENCY_KEY, REFERENCE_REQUIRED, REFERENCE_NOT_ALLOWED | Corrigir metadados de negócio |
| IDEMPOTENCY_CONFLICT, INBOX_PAYLOAD_CONFLICT | Investigar colisão; não reenviar payload divergente com a mesma identidade |
| WALLET_ALREADY_EXISTS | Consultar wallet existente |
| WALLET_NOT_FOUND, TRANSACTION_NOT_FOUND | Recurso inexistente |
| PLAYER_MISMATCH, CURRENCY_MISMATCH | Corrigir destino/moeda |
| INSUFFICIENT_FUNDS | Aposta recusada; não repetir esperando reaplicação |
| REVERSAL_INSUFFICIENT_FUNDS | Reversão debitadora recusada; requer tratamento operacional |
| BALANCE_LIMIT_EXCEEDED | Crédito excederia NUMERIC(20,2) |
| SELF_REFERENCE, REFERENCE_CONTEXT_MISMATCH, INVALID_REFERENCE_KIND, REFERENCE_AMOUNT_MISMATCH | Corrigir referência |
| REFERENCE_ALREADY_REVERSED | Reversão desse tipo já aplicada |
| REFERENCE_NOT_PROCESSED | Referência chegou a um estado terminal sem aplicação |
| REFERENCE_EXPIRED | Referência ausente/não resolvida dentro do prazo |
| INFRASTRUCTURE_UNAVAILABLE | Falha transitória HTTP; repetir com mesma chave |
| INFRASTRUCTURE_RETRY_EXHAUSTED | FAILED auditável após esgotamento no consumidor |
| INVALID_QUEUE_MESSAGE, RETRY_EXHAUSTED | Falha permanente/DLQ; inspecionar mensagem |

Erros internos de programação não são convertidos em rejeições financeiras de negócio. FAILED não tem ledger. Se o banco estiver disponível ao esgotar retries, o consumidor persiste o resultado FAILED e sua outbox antes de enviar à DLQ. Se o banco permanecer indisponível, o redrive nativo ainda preserva a mensagem na DLQ, mas não é possível prometer um registro SQL de falha durante essa indisponibilidade.

## Inbox, SQS e shutdown

O consumidor usa long polling, uma mensagem por loop por processo, visibilidade de 60s e heartbeat a cada 20s. Múltiplas instâncias dão paralelismo. FIFO/deduplicação do broker são otimizações; as constraints continuam necessárias inclusive entre HTTP e fila.

Rejeições de negócio e pendências aceitas são duráveis e recebem ack. Mensagens inválidas/conflitos são permanentes e vão para DLQ. Erros transitórios usam visibilidade com backoff e limite de 5 entregas. Envio à DLQ precede DeleteMessage; falha no envio não remove a original. Falha no ack depois de um commit tenta redelivery segura, sem refazer efeitos financeiros.

SIGTERM aborta o long polling e acorda loops ociosos. Trabalho já iniciado mantém heartbeat e conclui commit/ack antes do fechamento das conexões. Se shutdown ocorrer logo após ReceiveMessage, a visibilidade é devolvida. Não há limite próprio de drain: o orquestrador deve conceder prazo compatível com os timeouts de banco/SQS.

## Outbox

Publishers fazem claim atômico com FOR UPDATE SKIP LOCKED, token e lease de 60s, e enviam fora da transação SQL. Confirmação/retry exige o mesmo token. Um owner antigo não confirma uma lease retomada. Leases vencidas são recuperadas após crash.

Falhas de envio usam backoff exponencial limitado a 300s, sem descartar eventos. Timeout de envio é 10s. Crash após enviar e antes de confirmar pode duplicar publicação; eventId e deduplicationId são estáveis. Consumidores devem manter inbox própria, pois a janela de deduplicação FIFO é limitada. Eventos incluem version, correlationId, causationId e MoneyProps JSON. Eventos mínimos e o adicional WagerTransactionFailed têm subclasses concretas.

## Reconciliação e observabilidade

A reconciliação usa uma única instrução SQL para obter saldo e ledger no mesmo snapshot MVCC. Não corrige diferenças. Divergências geram métrica e log sem expor valores completos.

Logs são JSON. O fluxo financeiro registra correlationId, messageId quando aplicável, transactionId, walletId, providerId e status, sem payloads monetários. Há contadores de status, duplicatas, conflitos, retries, DLQ e erros de worker, além de soma/contagem de latência e gauge de outbox lag. Métricas são locais ao processo; o endpoint HTTP expõe as métricas da API. Workers executados como application context precisam de um exporter/servidor de métricas adicional para scraping separado; seus logs continuam disponíveis. OpenTelemetry, histogramas por faixa e dashboards não foram adicionados.

## Testes e limites de validação

Testes unitários exercitam domínio e protocolo dos workers com adapters controlados. Testes PostgreSQL usam banco real, incluindo três processos concorrentes, falha de outbox, redelivery, referências e constraints. A suíte LocalStack adicional cobre SQS, DLQ e crash entre commit/ack ou envio/confirmação. Não há substituição integral do banco por mocks.

Nesta sessão passaram 26 unitários e os 11 cenários da primeira execução PostgreSQL. Após ampliar a suíte, ajustar código/schema e refatorar os repositórios para entidades TypeORM, a integração precisa ser repetida. A execução adicional com portas locais foi recusada na etapa anterior. A revisão final passou pela checagem de tipos/build; a suíte ampliada PostgreSQL/HTTP e a integração LocalStack ainda precisam ser executadas. Docker não estava instalado. Não houve teste de carga.

Autenticação foi adiada conforme seção 2. ProviderAuthGuard é no-op; a evolução prevista é validar tokens OIDC de IdP externo e vincular providerId à identidade autenticada. Health é público. Atualmente provedores são identificadores validados estruturalmente, sem cadastro/allowlist externo.
