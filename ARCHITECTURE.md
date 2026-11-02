# Como eu montei

O enunciado pede correção com várias instâncias, mensagem repetida e saldo que bata com o ledger. Eu foquei nisso. Auth ficou de fora: a seção 2 diz que não pontua, e um Keycloak no compose ia competir com o tempo do saldo. O gancho está em `ProviderIdentity`. Health não passa por ele. Quando for plugar um IdP, troca essa classe e chama antes do use case. A fila continua sendo canal interno, mas o `providerId` da mensagem passa pelo mesmo lugar.

## Dinheiro

`Money` guarda centavos em `bigint`. `number` quebra em `0.10 + 0.20`. Eu não quis puxar uma lib só pra isso. Na entrada, mais de duas casas é erro, não arredondamento. No banco o valor vai para `numeric(18,2)` e a moeda em outra coluna. Na leitura eu aceito zero à direita (`10.5000`) porque o driver às vezes devolve assim. Lixo eu recuso.

Dá para rodar o desafio inteiro em BRL. USD contra uma wallet BRL vira `CURRENCY_MISMATCH` e fica gravado.

## Transação

A unidade de concorrência é a wallet. Eu uso `SELECT FOR UPDATE` nela, não um lock global. Optimistic lock com `version` também funcionaria, mas a segunda aposta de 80 viraria retry. Com o lock pessimista ela espera, vê os 20 que sobraram e rejeita com `INSUFFICIENT_BALANCE`. `version` começa em 1 e só sobe quando o saldo muda. Na abertura eu já gravo o saldo inicial com version 1, porque o exemplo da API é esse. O crédito `OPENING` explica o salto de zero até esse saldo no ledger, sem um segundo incremento.

Tudo que uma operação mexe (wallet, transação, ledger, inbox se veio da fila, outbox) entra no mesmo `transactional()` do MikroORM. O publish no SQS fica fora. Se o processo morre antes do commit, não existe linha e não existe evento. Se morre depois, a outbox está lá e outra instância publica.

O Postgres também segura a invariante. Saldo não negativo é `check`. Ledger não atualiza nem apaga, tem trigger. Aritmética do lançamento é `check`. No commit, uma constraint trigger adiada compara o saldo da wallet com a soma do ledger. Se o código esquecer o lançamento, o commit cai.

## Idempotência

A chave do header é a fonte da verdade. O hash é SHA-256 de um JSON com as chaves ordenadas, só dos campos de negócio. `Idempotency-Key`, `messageId` e correlation não entram. `10.5` e `10.50` dão o mesmo hash.

A unique de `idempotency_key` e a de `(provider_id, external_transaction_id)` ficam no banco. Replay devolve a linha que já está lá, com `idempotentReplay: true` e o saldo que foi observado quando aquele desfecho foi aplicado, não o saldo de agora. Se a operação nasceu `PENDING_REFERENCE` e o worker depois aplicou, o replay seguinte mostra o desfecho novo. Devolver 202 para sempre mentiria.

Mesma chave com outro hash é 409. Não é replay.

Inbox é outra coisa. Ela deduplica a mensagem da fila por `(consumer, messageId)`. A chave HTTP deduplica a operação. Dá para a mesma aposta chegar por HTTP e por SQS, ou em duas mensagens com ids diferentes: o efeito financeiro continua único.

## Reversão

O texto diz que a mesma referência não pode ser revertida duas vezes pelo mesmo tipo. `REFUND` de uma BET e `ROLLBACK` dessa mesma BET são os dois créditos. Se os dois passassem, o saldo subia duas vezes. Eu fechei um índice único para qualquer reversão `PROCESSED` daquela referência. `ROLLBACK` de um `REFUND` continua valendo, porque a referência é o refund, não a bet.

Reversão que deixaria o saldo negativo volta `NEGATIVE_BALANCE_ON_REVERSAL`, não `INSUFFICIENT_BALANCE`. Os dois ficam gravados como `REJECTED`, sem ledger.

## Fora de ordem

`REFUND` e `ROLLBACK` sem a referência, e `WIN` que citou uma referência que ainda não existe, gravam `PENDING_REFERENCE`. Um worker tenta de novo com backoff. O default é 8 tentativas, base de 500ms, teto de 60s. Acabou o limite: `REJECTED` com `REFERENCE_NOT_FOUND` e evento na outbox. Dá para baixar isso no env quando eu quero ver o caso no teste.

`PENDING` eu uso só em memória, antes de decidir. O que commita é `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`. `FAILED` existe no modelo e a transição está testada, mas no fluxo real uma falha de infra antes do commit desfaz a transação e a fila é quem tenta de novo. Eu não gravei um `FAILED` fictício só para aparecer.

## Fila

`wager-transactions.fifo` entra no mesmo use case do HTTP. Ack (`DeleteMessage`) só depois do commit. Erro de negócio (já processado, rejeitado, pendente) dá ack. Payload inválido e conflito de idempotência vão para a DLQ. Wallet que ainda não existe eu trato como transitório até 5 receives, porque a mensagem pode chegar antes da carteira. A fila também tem redrive com `maxReceiveCount` 5.

No SIGTERM eu paro de pegar mensagem nova e espero a que está na mão terminar. Se o processo morre no meio, a visibilidade expira e outra instância pega. O teste de "morreu depois do commit e antes do ack" manda a mesma mensagem de novo: a inbox segura e o saldo não mexe.

A outbox publica em `domain-events.fifo`. O claim é `FOR UPDATE SKIP LOCKED` com um token que expira em 30s. Dois publishers não levam a mesma linha. Se um publica e morre antes de marcar, o outro pega de novo. O consumidor de evento grava o `eventId` na inbox e não mexe em saldo. Dedup do FIFO ajuda, mas o banco é que garante. A outbox não tem DLQ: evento de dinheiro confirmado eu não descarto, só empurro o retry com teto de 60s.

## HTTP

| Situação | Status |
|---|---|
| payload inválido | 400 |
| wallet ou transação inexistente | 404 |
| wallet duplicada, mesma chave com outro payload | 409 |
| `PROCESSED` | 200 |
| `PENDING_REFERENCE` | 202 |
| `REJECTED` | 422, com `failureCode` |
| postgres/SQS fora | 503 |

Rejeição de negócio é 422 com o corpo da transação, porque a linha foi gravada. 409 é quando eu não vou aplicar de novo.

## O que eu não fiz

- IdP. Está escrito acima.
- Swagger. O contrato cabe no README e eu não quis dependência só para espelhar rota.
- Teste de carga. Sem número medido eu não ia inventar p95.
- Partida dobrada. O enunciado marca como opcional.

MikroORM entrou porque o enunciado prefere, e o `transactional()` mais o `LockMode` cobrem o que eu precisava sem esconder a transação.
