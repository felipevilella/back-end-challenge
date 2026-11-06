# Testar a API com Postman

Importe os dois arquivos pelo botão **Import** do Postman:

- `wagering.postman_collection.json`: coleção v2.1 com 38 requisições, exemplos e testes.
- `local.postman_environment.json`: ambiente opcional com `baseUrl=http://localhost:3000`.

A coleção já define baseUrl, então também funciona sem importar o ambiente. Se importar, selecione **Wagering — Local**. Não exige token: a autenticação da API ainda é no-op.

## Preparar a aplicação

Com Docker e as dependências instalados, na raiz do projeto:

```sh
npm run infra:up
npm run migration:run
npm run dev
```

Em outro terminal, para concluir referências pendentes:

```sh
npm run worker
```

Se não houver `.env`, copie `.env.example` antes de executar. Aguarde PostgreSQL e LocalStack iniciarem antes das migrations e dos testes de readiness.

## Ordem de execução

Abra **Run collection** e execute uma iteração das pastas na ordem. Também é possível enviar as requests manualmente:

1. **01 - Health:** processo, PostgreSQL/SQS e métricas.
2. **02 - Preparar wallet:** cria jogador/identificadores únicos e wallet com 1000.00 BRL. A resposta salva walletId automaticamente.
3. **03 - Fluxo financeiro completo:** BET 25, WIN 50, LOSS 0, REFUND 25, ROLLBACK do WIN 50 e replay da BET. Saldo final 1000.00. O replay retorna o saldo histórico de 975.00, sem debitar novamente.
4. **04 - Consultas e reconciliação:** wallet, operação por ID interno/externo, duas páginas do ledger e reconciliação. São cinco lançamentos, incluindo OPENING.
5. **05 - Validações, conflitos e rejeições:** duplicidade de wallet, payload divergente, saldo insuficiente, reversão duplicada, moeda incorreta, contratos inválidos e erros de paginação. Os códigos 400/404/409/422 são esperados; os testes devem passar.
6. **06 - Referência fora de ordem:** cria outra wallet com 100.00, envia REFUND antes da BET e depois envia a referência. O worker conclui o REFUND. Reenvie 06.4 após alguns segundos até ver PROCESSED; depois 06.5 deve mostrar saldo 100.00 e consistent=true.

Enquanto o REFUND não for retomado, 06.4 pode mostrar PENDING_REFERENCE e a reconciliação pode mostrar 90.00. Os testes aceitam esse estado intermediário porque não pressupõem conclusão imediata do worker. A coleção não faz polling automático.

## Repetir testes

- Para uma execução nova do fluxo principal, comece em **02.1**: ela gera novos IDs, limpa variáveis do fluxo principal e cria outra wallet.
- Para repetir o cenário fora de ordem, comece em **06.1**.
- Reenviar uma operação já processada mantém o resultado original e retorna idempotentReplay=true. Os testes de primeira aplicação de 03.1–03.5 esperam false; use **03.6** para testar explicitamente replay.
- Os dados de teste ficam no banco; não há endpoint de exclusão nem limpeza automática.

Veja os exemplos de resposta salvos em cada request quando disponíveis. Todos os valores de dinheiro válidos são strings. O cenário de valor numérico contém um número de propósito e deve retornar 400.

## O que foi validado

Os arquivos foram verificados como JSON, todos os scripts foram analisados quanto à sintaxe e as variáveis foram resolvidas simulando a ordem da coleção. Não houve execução HTTP contra a API nesta etapa. A coleção não substitui testes de concorrência, integração SQS ou crash recovery.
