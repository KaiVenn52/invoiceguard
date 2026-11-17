# InvoiceGuard

[Open public demo](https://kaivenn52.github.io/invoiceguard/) · [Validated deployment](https://github.com/KaiVenn52/invoiceguard/actions/runs/44125293861)

Every invoice. One exact payment. A noncustodial stablecoin invoice workspace for Aevum testnet: the merchant registers an invoice, shares it as JSON, and the customer pays through a contract that settles only once.

## Run and use

`npm run dev` listens on http://127.0.0.1:5182. Configure a deployed InvoiceGuard address. The app verifies its full runtime bytecode, including the official token immutable, before wallet actions. Arbitrary contracts and proxies are rejected.

1. Create an invoice draft using the recipient wallet address, exact tUSD8 amount and reference.
2. Connect the recipient EVM wallet on Aevum testnet (44005), then register it.
3. Export the invoice JSON to the customer. They import it in another browser and use the invoice-bound settlement address. Imported claims of payment are discarded.
4. Before payment, the app checks on-chain recipient, amount, expiry and reference hash. The wallet first approves the exact invoice amount of official tUSD8, then calls settlement. If settlement is rejected after approval, an allowance may remain; revoke it in the wallet before abandoning the payment.
5. Verify the settlement transaction. Both the matching InvoicePaid event and exact official-token Transfer must exist in a successful transaction to the bound contract. Export reconciliation evidence. A receipt is a fixed-node observation, not an independent consensus proof.

Official tUSD8: `0x456569838f1d43009A91ebA4263147Afd7233483`, 6 decimals. RPC: `https://rpc-test.qday.info`. Browser wallet required. No signing keys are stored in this project. Sample rows are explicitly labelled and cannot be paid or verified. Local drafts survive reload; payment status must be verified again rather than trusting browser storage.

## Contract build and deployment

The sibling `../invoiceguard-contracts` contains Solidity sources and adversarial settlement tests. Run `npm ci`, `npm test`, `npm run build`, then `npm run sync-artifact` there. The last command updates this app's pinned ABI and bytecode. Rebuild the frontend after changing the contract.

Deployment is not completed. The supplied Ignition module is `ignition/modules/InvoiceGuard.ts`. A testnet-only deploy can be run by the operator with their own testnet deployment account: `npx hardhat ignition deploy ignition/modules/InvoiceGuard.ts --network aevum`. See the contract README for configuration. Never use a funded mainnet key. Copy the resulting testnet address into the app, then collect a real create/payment/receipt demo.

## Safety properties

The contract rejects duplicate IDs, replayed payments, expired/cancelled invoices, unauthorized bound payers, self-payments, false-returning transfers and short/taxed token transfers. Creation is bound to the recipient's sender address; custody remains with buyer and merchant. Customer names/reference text remain in exported files and browser storage; only their hash is written on chain.

## Submission gates

Public frontend, contracts source and hosted demo are available. Still required: actual Aevum contract deployment and payments, walkthrough, registration and submission receipt. The starter guide requires a live finalist presentation if selected.

## Evidence and limitations

This is a working local prototype. Automated tests use fixtures and an in-process blockchain. They do not prove public deployment, registration, eligibility, a live wallet transaction or a submitted entry. No live payment is claimed. Testnet assets have no monetary value.

Run `npm ci`, `npm test`, `npm run build`, then `npm start`. Node 24 is supported. The production server serves the build and proxies only the fixed official upstream. Set `PORT` for hosting; terminate TLS at your hosting platform. A static-only host cannot serve the RPC proxy. A Dockerfile is included, but the container has not yet been built or deployed. No secrets are needed by the frontend or proxy.

## AI assistance

See AI_USAGE.md. MIT licensed. This prototype has not undergone an independent security audit.

Source repositories: [frontend](https://github.com/KaiVenn52/invoiceguard), [contracts](https://github.com/KaiVenn52/invoiceguard-contracts). Clone both into the same parent directory for artifact synchronization.

The GitHub Pages workflow builds with `VITE_DIRECT_RPC=true` to call only the official Aevum RPC directly. Its CORS preflight allows the public origin and content-type header. Default local/Node builds continue to use the fixed server proxy.
