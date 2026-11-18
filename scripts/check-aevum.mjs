import assert from 'node:assert/strict';
import { createPublicClient, encodeDeployData, erc20Abi, http, keccak256 } from 'viem';
import artifact from '../src/contract.json' with { type: 'json' };
import { aevum, TOKEN, expectedRuntime } from '../src/chain.ts';

const client = createPublicClient({
  chain: aevum,
  transport: http(aevum.rpcUrls.default.http[0], {
    fetchOptions: { headers: { 'User-Agent': 'Mozilla/5.0 InvoiceGuard/0.1' } },
    timeout: 15_000,
    retryCount: 0,
  }),
});

assert.equal(await client.getChainId(), aevum.id, 'Expected Aevum testnet');
const blockNumber = await client.getBlockNumber();
const decimals = await client.readContract({
  address: TOKEN, abi: erc20Abi, functionName: 'decimals', blockNumber,
});
assert.equal(decimals, 6, 'Expected official 6-decimal tUSD8');

const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [TOKEN] });
const result = await client.call({ data, blockNumber });
assert.equal(result.data?.toLowerCase(), expectedRuntime(), 'Unexpected runtime from constructor');

console.log(JSON.stringify({
  observation: 'Read-only eth_call deployment simulation',
  chainId: aevum.id,
  block: blockNumber.toString(),
  token: TOKEN,
  tokenDecimals: decimals,
  runtimeBytes: (result.data.length - 2) / 2,
  runtimeHash: keccak256(result.data),
  matchesReviewedRuntime: true,
}, null, 2));
