# mpp-client: an outside payer, refused before signing

This example is an outside payer. It installs the published ClawRouter fork
(`@twzrd1111/clawrouter@0.12.306`) and its MPP rail (`@twzrd1111/clawrouter-mpp@0.1.0`) and
points the local proxy at an MPP inference seller (default `https://openrouter.mpp.tempo.xyz`,
model `openai/gpt-4o-mini`).

The per-request spend cap is 0.0001 USD, below the seller's listed price of 0.00075 USD. The spend
check refuses the call with `403 spend_policy_denied` before any payment is signed. The payer is a
throwaway key generated fresh on every run. It holds no funds and nothing is saved.

## Run

No key is needed:

```bash
npm install && npm start
```

The script prints the HTTP status, the error type, and whether a `Payment-Receipt` header was present.
It exits 0 only when the result is `403 spend_policy_denied`, and nonzero otherwise.

Optional overrides: `DEMO_SELLER` (seller base URL) and `DEMO_MODEL` (model id).

This runs on the published fork packages. The upstream ClawRouter PRs #545 and #546 are not required.

## Live paid call (operator only)

A paid run spends real funds. It is not part of this example. Only the operator runs it, with their
own funded Tempo wallet and a key supplied out of band. Agents never run it, and this repository
holds no key or command for it.
