import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  createPublicClient, createWalletClient, encodeAbiParameters, erc20Abi,
  formatEther, formatUnits, http, keccak256, parseAbiParameters, parseEther,
  stringToHex, zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import artifact from '../src/contract.json' with { type: 'json' };
import {
  aevum, EXPLORER, TOKEN, expectedRuntime, exactUnits, makeInvoice,
  matchEvidence, validateRegistered,
} from '../src/chain.ts';

const [mode, keyPath, ...extra] = process.argv.slice(2);
if (!['check', 'run'].includes(mode) || !keyPath || extra.length) {
  console.error('Usage: node scripts/settle-aevum.mjs <check|run> <testnet-key-file>');
  process.exit(64);
}
const keys = JSON.parse(await readFile(resolve(keyPath), 'utf8'));
const merchant = privateKeyToAccount(keys.merchant);
const buyer = privateKeyToAccount(keys.buyer);
assert.notEqual(merchant.address, buyer.address, 'Separate wallets are required');

const rpc = () => http(aevum.rpcUrls.default.http[0], {
  fetchOptions: { headers: { 'User-Agent': 'Mozilla/5.0 InvoiceGuard/0.1' } },
  timeout: 15_000,
  retryCount: 0,
});
const reader = createPublicClient({ chain: aevum, transport: rpc() });
assert.equal(await reader.getChainId(), aevum.id, 'Unexpected chain');
assert.equal(await reader.readContract({
  address: TOKEN, abi: erc20Abi, functionName: 'decimals',
}), 6);

async function balances(address) {
  const [gas, token] = await Promise.all([
    reader.getBalance({ address }),
    reader.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ]);
  return { address, gas, token };
}
const [merchantFunds, buyerFunds] = await Promise.all([
  balances(merchant.address), balances(buyer.address),
]);
const amount = '0.125001';
const units = exactUnits(amount);
const buyerGasFloor = parseEther('0.05');
const merchantGasFloor = parseEther('0.05');

function readiness() {
  return {
    network: 'QDay Aevum Testnet',
    chainId: aevum.id,
    expectedPayment: amount + ' tUSD8',
    accounts: [merchantFunds, buyerFunds].map(({address, gas, token}) => ({
      address, tQDAY: formatEther(gas), tUSD8: formatUnits(token, 6),
    })),
    canStart: merchantFunds.gas >= merchantGasFloor + (buyerFunds.gas < buyerGasFloor ? buyerGasFloor : 0n) &&
      merchantFunds.token + buyerFunds.token >= units,
  };
}

if (mode === 'check') {
  console.log(JSON.stringify(readiness(), null, 2));
  process.exit(0);
}

const folder = dirname(resolve(keyPath));
const journalPath = resolve(folder, 'aevum-invoiceguard-journal.json');
const proofPath = resolve(folder, 'invoiceguard-aevum-evidence.json');
let journal;
try {
  journal = JSON.parse(await readFile(journalPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  assert(readiness().canStart, 'The testnet accounts need tQDAY and tUSD8 before broadcasting.');
  journal = {
    chainId: aevum.id,
    merchant: merchant.address,
    buyer: buyer.address,
    invoice: makeInvoice('AEVUM-DEMO', 'Testnet demonstration', merchant.address, amount),
    transactions: {},
  };
}
assert.equal(journal.chainId, aevum.id);
assert.equal(journal.merchant, merchant.address);
assert.equal(journal.buyer, buyer.address);
assert.equal(journal.invoice.amount, amount);

const sellerClient = createWalletClient({ account: merchant, chain: aevum, transport: rpc() });
const buyerClient = createWalletClient({ account: buyer, chain: aevum, transport: rpc() });

async function saveJournal() {
  await mkdir(folder, { recursive: true });
  await writeFile(journalPath + '.new', JSON.stringify(journal, null, 2));
  await rename(journalPath + '.new', journalPath);
}

async function transaction(step, broadcast) {
  const existing = journal.transactions[step];
  assert(existing !== 'broadcasting', 'A prior ' + step + ' broadcast may be in flight. Recover its hash before retrying.');
  let hash = existing;
  if (!hash) {
    journal.transactions[step] = 'broadcasting';
    await saveJournal();
    hash = await broadcast();
    journal.transactions[step] = hash;
    await saveJournal();
  }
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 60_000 });
  assert.equal(receipt.status, 'success', step + ' reverted at ' + hash);
  console.log(JSON.stringify({ step, hash, block: receipt.blockNumber.toString() }));
  return receipt;
}

await saveJournal();
if (journal.transactions.fundGas || (!journal.transactions.approve && buyerFunds.gas < buyerGasFloor)) {
  await transaction('fundGas', () => sellerClient.sendTransaction({
    to: buyer.address, value: buyerGasFloor,
  }));
}
if (journal.transactions.fundToken || (!journal.transactions.approve && buyerFunds.token < units)) {
  await transaction('fundToken', () => sellerClient.writeContract({
    address: TOKEN, abi: erc20Abi, functionName: 'transfer',
    args: [buyer.address, units - buyerFunds.token],
  }));
}

const deployment = await transaction('deploy', () => sellerClient.deployContract({
  abi: artifact.abi, bytecode: artifact.bytecode, args: [TOKEN],
}));
const contract = deployment.contractAddress;
assert(contract, 'Deployment receipt had no address');
assert.equal((await reader.getBytecode({ address: contract }))?.toLowerCase(), expectedRuntime());
const invoice = journal.invoice;
const id = keccak256(encodeAbiParameters(
  parseAbiParameters('uint256,address,address,bytes32'),
  [BigInt(aevum.id), contract, merchant.address, invoice.nonce],
));
const referenceHash = keccak256(stringToHex(JSON.stringify({
  reference: invoice.reference, customer: invoice.customer,
})));
await transaction('create', () => sellerClient.writeContract({
  address: contract, abi: artifact.abi, functionName: 'create',
  args: [invoice.nonce, zeroAddress, units, BigInt(invoice.expiresAt), referenceHash],
}));
await transaction('approve', () => buyerClient.writeContract({
  address: TOKEN, abi: erc20Abi, functionName: 'approve', args: [contract, units],
}));
const payment = await transaction('pay', () => buyerClient.writeContract({
  address: contract, abi: artifact.abi, functionName: 'pay', args: [id],
}));
const tx = await reader.getTransaction({ hash: payment.transactionHash });
const settledInvoice = { ...invoice, id, contract };
const record = await reader.readContract({ address: contract, abi: artifact.abi, functionName: 'invoices', args: [id] });
validateRegistered(settledInvoice, contract, record);
assert.equal(record[5], 2, 'Invoice must be paid');
const checks = matchEvidence(settledInvoice, contract, payment, tx, await reader.getChainId());
assert(checks.every(check => check.pass), JSON.stringify(checks));

const evidence = {
  network: 'QDay Aevum Testnet',
  chainId: aevum.id,
  token: TOKEN,
  merchant: merchant.address,
  buyer: buyer.address,
  invoice: settledInvoice,
  transactions: Object.fromEntries(Object.entries(journal.transactions).map(([step, hash]) => [
    step, { hash, explorer: EXPLORER + '/tx/' + hash },
  ])),
  paymentBlock: payment.blockNumber.toString(),
  checks,
};
await writeFile(proofPath, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ evidenceFile: proofPath, paymentHash: payment.transactionHash, checks }));

