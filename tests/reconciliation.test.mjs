import {test} from 'node:test';import assert from 'node:assert/strict';
import {encodeEventTopics,encodeAbiParameters,parseAbi,parseAbiParameters,keccak256,toHex} from 'viem';
import {exactUnits,makeInvoice,matchEvidence,TOKEN,expectedRuntime,validateInvoice,boundContract,validateRegistered,client,findPayment} from '../src/chain.ts';
const guard='0x1111111111111111111111111111111111111111',payee='0x2222222222222222222222222222222222222222',payer='0x3333333333333333333333333333333333333333',id='0x'+'ab'.repeat(32);
const invoice={reference:'QA-204',customer:'Fixture',recipient:payee,amount:'125.00',id};
const abi=parseAbi(['event InvoicePaid(bytes32 indexed id,address indexed payer,address indexed payee,uint256 amount)','event Transfer(address indexed from,address indexed to,uint256 value)']);
function fixture(){return {status:'success',logs:[{address:guard,topics:encodeEventTopics({abi,eventName:'InvoicePaid',args:{id,payer,payee}}),data:encodeAbiParameters(parseAbiParameters('uint256'),[125000000n])},{address:TOKEN,topics:encodeEventTopics({abi,eventName:'Transfer',args:{from:payer,to:payee}}),data:encodeAbiParameters(parseAbiParameters('uint256'),[125000000n])}]};}
test('amount precision rejects exponent and over-precision',()=>{assert.equal(exactUnits('0.000001'),1n);for(const v of ['0','1e3','1.0000001','-1'])assert.throws(()=>exactUnits(v));});
test('draft validates recipient checksum and required fields',()=>{assert.throws(()=>makeInvoice('','','0x0','1'));assert.throws(()=>makeInvoice('INV','Customer','0x'+'0'.repeat(40),'1'));assert.equal(makeInvoice('INV','Customer',payee,'1.25').amount,'1.25');});
test('matching fixture needs both settlement event and token movement',()=>{assert(matchEvidence(invoice,guard,fixture(),{to:guard,from:payer},44005).every(c=>c.pass));});
test('an invoice event without official-token transfer cannot prove payment',()=>{const p=fixture();p.logs.pop();assert.equal(matchEvidence(invoice,guard,p,{to:guard,from:payer},44005).find(c=>c.label==='Exact token transfer').pass,false);});
test('wrong invoice ID, token or amount independently fail',()=>{for(const change of [p=>p.logs[0].topics[1]='0x'+'cd'.repeat(32),p=>p.logs[1].address=guard,p=>p.logs[1].data=encodeAbiParameters(parseAbiParameters('uint256'),[124999999n])]){const p=fixture();change(p);assert(matchEvidence(invoice,guard,p,{to:guard,from:payer},44005).some(c=>!c.pass));}});
test('wrong network, reverted receipt and wrong contract independently fail',()=>{assert(matchEvidence(invoice,guard,fixture(),{to:guard,from:payer},1).some(c=>!c.pass));assert(matchEvidence(invoice,guard,{...fixture(),status:'reverted'},{to:guard,from:payer},44005).some(c=>!c.pass));assert(matchEvidence(invoice,guard,fixture(),{to:payee,from:payer},44005).some(c=>!c.pass));});

test('runtime pins token immutable and rejects another-token runtime',()=>{assert.notEqual(expectedRuntime(),expectedRuntime(guard));assert.match(expectedRuntime(),/^0x[0-9a-f]+$/);assert(expectedRuntime().includes(TOKEN.slice(2).toLowerCase()));});
test('portable invoices cannot import paid status or move settlement contracts',()=>{const draft=makeInvoice('Share-1','Customer',payee,'1');const v=validateInvoice({...draft,id,contract:guard,paidHash:id});assert.equal(v.paidHash,undefined);assert.equal(v.contract,guard);assert.throws(()=>boundContract(v,payee));assert.doesNotThrow(()=>boundContract(v,guard));assert.throws(()=>validateInvoice({...v,contract:undefined}));assert.throws(()=>validateInvoice({...draft,nonce:'0x00'}));assert.throws(()=>validateInvoice({...draft,amount:'1e8'}));});

test('shared reference, expiry, nonce and recipient must match chain state',()=>{const v=makeInvoice('Share-2','Customer',payee,'1');v.contract=guard;v.id=keccak256(encodeAbiParameters(parseAbiParameters('uint256,address,address,bytes32'),[44005n,guard,payee,v.nonce]));const record=[payee,payer,1000000n,BigInt(v.expiresAt),keccak256(toHex(JSON.stringify({reference:v.reference,customer:v.customer}))),2];assert.doesNotThrow(()=>validateRegistered(v,guard,record));for(const change of [{reference:'Other'},{customer:'Other'},{expiresAt:v.expiresAt+1},{nonce:id},{recipient:payer},{amount:'2'}])assert.throws(()=>validateRegistered({...v,...change},guard,record));});


test('finds a paid invoice in bounded log windows, then verifies the full receipt', async (context) => {
  const registered = makeInvoice('Late return', 'Test customer', payee, '125.00');
  registered.contract = guard;
  registered.id = keccak256(encodeAbiParameters(
    parseAbiParameters('uint256,address,address,bytes32'), [44005n, guard, payee, registered.nonce],
  ));
  const metadata = keccak256(toHex(JSON.stringify({reference:registered.reference,customer:registered.customer})));
  context.mock.method(client, 'getChainId', async () => 44005);
  context.mock.method(client, 'getBytecode', async () => expectedRuntime());
  context.mock.method(client, 'readContract', async ({ functionName }) => functionName === 'token'
    ? TOKEN
    : [payee, payer, 125000000n, BigInt(registered.expiresAt), metadata, 2]);
  context.mock.method(client, 'getBlockNumber', async () => 20000n);
  const txHash = '0x' + '88'.repeat(32);
  const queries = [];
  context.mock.method(client, 'getLogs', async (query) => {
    assert.equal(query.address, guard);
    assert.equal(query.args.id, registered.id);
    assert.equal(query.args.payee, payee);
    queries.push([query.fromBlock, query.toBlock]);
    return queries.length === 1 ? [] : [{ transactionHash: txHash }];
  });
  context.mock.method(client, 'getTransaction', async ({ hash }) => {
    assert.equal(hash, txHash);
    return { to: guard, from: payer };
  });
  context.mock.method(client, 'getTransactionReceipt', async ({ hash }) => {
    assert.equal(hash, txHash);
    const receipt = { ...fixture(), blockNumber: 17999n };
    receipt.logs[0].topics[1] = registered.id;
    return receipt;
  });
  const proof = await findPayment(registered, guard);
  assert.deepEqual(queries, [[18001n, 20000n], [16001n, 18000n]]);
  assert.equal(proof.hash, txHash);
  assert(proof.checks.every(({pass}) => pass));
});
