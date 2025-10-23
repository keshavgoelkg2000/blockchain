// server.js
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const yaml = require('js-yaml');

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Utility helpers
 */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}
function doubleSha256(buffer) {
  return sha256(sha256(buffer));
}
function hexLEfromBE(hex) {
  return Buffer.from(hex, 'hex').reverse().toString('hex');
}
function hexBEfromLE(hexLE) {
  return Buffer.from(hexLE, 'hex').reverse().toString('hex');
}
function randHex(len) {
  return crypto.randomBytes(len).toString('hex');
}

/**
 * Transaction model (simplified for assignment)
 * - inputs: [{ txid, index }]
 * - outputs: [{ value (sats), scriptPubKey }]
 * createTxHex() creates a deterministic (for given fields) raw-hex string
 * getTxid() returns double-sha256(txHex) reversed (bitcoin txid)
 */
class Tx {
  constructor(inputs = [], outputs = []) {
    this.version = 1;
    this.inputs = inputs; // [{ txid, index }]
    this.outputs = outputs; // [{ value, scriptPubKey }]
    this.locktime = 0;
  }

  // Very small serializer sufficient to get a txid (not full bitcoin spec)
  createTxHex() {
    const parts = [];
    // version (4 bytes LE)
    const ver = Buffer.alloc(4);
    ver.writeUInt32LE(this.version);
    parts.push(ver);

    // input count (varint small)
    parts.push(Buffer.from([this.inputs.length]));

    for (const inp of this.inputs) {
      // txid (32 bytes little-endian)
      const txidLE = Buffer.from(inp.txid, 'hex').reverse();
      parts.push(txidLE);

      // index (4 bytes LE)
      const idx = Buffer.alloc(4);
      idx.writeUInt32LE(inp.index);
      parts.push(idx);

      // scriptSig - empty for now (push 0)
      parts.push(Buffer.from([0x00]));

      // sequence (4 bytes, default 0xffffffff)
      const seq = Buffer.alloc(4);
      seq.writeUInt32LE(inp.sequence ?? 0xffffffff);
      parts.push(seq);
    }

    // output count
    parts.push(Buffer.from([this.outputs.length]));

    for (const out of this.outputs) {
      // value (8 bytes LE)
      const val = Buffer.alloc(8);
      // support up to 2^53-1, but assignment values are small
      val.writeBigUInt64LE(BigInt(out.value));
      parts.push(val);

      // script length + script bytes (scriptPubKey is hex)
      const script = Buffer.from(out.scriptPubKey, 'hex');
      parts.push(Buffer.from([script.length]));
      parts.push(script);
    }

    // locktime (4 bytes LE)
    const lt = Buffer.alloc(4);
    lt.writeUInt32LE(this.locktime);
    parts.push(lt);

    return Buffer.concat(parts).toString('hex');
  }

  getTxid() {
    const txHex = this.createTxHex();
    const buf = Buffer.from(txHex, 'hex');
    const hashed = doubleSha256(buf);
    return Buffer.from(hashed).reverse().toString('hex'); // txid is little-endian of double-sha
  }
}

/**
 * Merkle tree helper: accepts array of txids (hex, BE) and returns merkle root (hex BE)
 * We'll follow bitcoin convention: double-sha256(concat(le(hashA), le(hashB))) and result reversed back to BE.
 */
function computeMerkleRoot(txidsBE) {
  // convert to buffers (LE) for concatenation
  let level = txidsBE.map((h) => Buffer.from(h, 'hex').reverse());

  if (level.length === 0) return Buffer.alloc(32).toString('hex');

  while (level.length > 1) {
    if (level.length % 2 === 1) {
      // duplicate last
      level.push(level[level.length - 1]);
    }
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const concat = Buffer.concat([level[i], level[i + 1]]);
      const hashed = doubleSha256(concat);
      next.push(hashed); // keep as BE? hashed is BE; but we will maintain as LE for next iteration
    }
    // convert hashed (BE) to LE to match earlier approach where we used LE buffers
    level = next.map((b) => Buffer.from(b).reverse());
  }

  // final hash is level[0] (LE), return BE hex
  return Buffer.from(level[0]).reverse().toString('hex');
}

/**
 * UTXO Pool: a simple in-memory store mapping txid -> [{ index, value, scriptPubKey, spent }]
 */
class UTXOPool {
  constructor() {
    this.pool = new Map();
  }

  addTxOutputs(txid, outputs) {
    // outputs = [{ value, scriptPubKey }]
    const arr = outputs.map((o, i) => ({
      index: i,
      value: o.value,
      scriptPubKey: o.scriptPubKey,
      spent: false
    }));
    this.pool.set(txid, arr);
  }

  // list of available UTXOs as { txid, index, value, scriptPubKey }
  listAvailable() {
    const out = [];
    for (const [txid, outs] of this.pool.entries()) {
      for (const o of outs) {
        if (!o.spent) {
          out.push({ txid, index: o.index, value: o.value, scriptPubKey: o.scriptPubKey });
        }
      }
    }
    return out;
  }

  // Mark a given utxo (txid,index) as spent; returns true if existed & unspent
  spend(txid, index) {
    const outs = this.pool.get(txid);
    if (!outs) return false;
    const o = outs.find((x) => x.index === index);
    if (!o || o.spent) return false;
    o.spent = true;
    return true;
  }
}

/**
 * Block header-based model:
 * header: { idx, ts, prevHash, merkleRoot, nonce }
 * block.hash is hash of header string
 * block.transactions is array of full transactions
 */
class Block {
  constructor(idx, prevHash = '0', transactions = []) {
    this.idx = idx;
    this.prevHash = prevHash;
    this.transactions = transactions; // full tx objects
    this.ts = new Date().toISOString();
    this.nonce = 0;

    // compute merkle root from txids
    const txids = transactions.map((tx) => tx.txid);
    this.merkleRoot = computeMerkleRoot(txids);
    this.hash = this.computeHeaderHash();
  }

  headerString() {
    // deterministic representation of header fields only
    return `${this.idx}|${this.ts}|${this.prevHash}|${this.merkleRoot}|${this.nonce}`;
  }

  computeHeaderHash() {
    // SHA256 of headerString (we'll use hex)
    const h = crypto.createHash('sha256').update(this.headerString()).digest('hex');
    return h;
  }
}

/**
 * Blockchain container with mining on header (proof-of-work)
 */
class Blockchain {
  constructor({ diff = 3 } = {}) {
    this.diff = diff;
    this.chain = [];
    this.utxo = new UTXOPool();

    // seed with genesis block and initial UTXO (Alice's 1 BTC as specified)
    this.createGenesis();
  }

  createGenesis() {
    // genesis has no transactions, but we can add a UTXO that replicates assignment start:
    // Alice has txid provided in assignment with 1 BTC (100,000,000 sats) at output index 0
    const genesis = new Block(0, '0', []);
    // proof-of-work for genesis
    this.mineHeader(genesis);
    this.chain.push(genesis);

    // seed UTXO: txid from assignment (Alice's UTXO)
    const aliceTxid = '48437ddb190b006f858cdd881284ad467d68bfc4c74f3e6f621eb5af33be88d8';
    const aliceOutputs = [{
      value: 100000000, // 1 BTC in sats
      scriptPubKey: '76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac' // arbitrary script
    }];
    this.utxo.addTxOutputs(aliceTxid, aliceOutputs);
  }

  getLastBlock() {
    return this.chain[this.chain.length - 1];
  }

  /**
   * Miner: create block header with merkleRoot from transactions provided,
   * perform PoW by incrementing nonce until header hash startsWith target.
   * After successful PoW, append block to chain and update UTXO pool with new outputs,
   * and mark spent inputs as spent.
   */
  mineBlock(transactions) {
    const latest = this.getLastBlock();
    const newBlock = new Block(latest.idx + 1, latest.hash, transactions);

    this.mineHeader(newBlock);

    // apply tx effects on UTXO pool (mark spent inputs and add outputs)
    for (const tx of transactions) {
      // mark inputs as spent
      for (const inp of tx.inputs) {
        // skip coinbase (txid all zeros) which has no real inputs
        if (inp.txid === '0000000000000000000000000000000000000000000000000000000000000000') continue;
        this.utxo.spend(inp.txid, inp.index);
      }
      // add outputs for this tx
      this.utxo.addTxOutputs(tx.txid, tx.outputs);
    }

    this.chain.push(newBlock);
    return newBlock;
  }

  mineHeader(block) {
    const target = '0'.repeat(this.diff);
    while (true) {
      block.hash = block.computeHeaderHash();
      if (block.hash.startsWith(target)) return block.hash;
      block.nonce += 1;
    }
  }

  validateChain() {
    const res = { isValid: true, invBlkIdx: [], dets: [] };
    const target = '0'.repeat(this.diff);
    let ccInv = false;
    for (let i = 0; i < this.chain.length; i += 1) {
      const curr = this.chain[i];
      // rebuild header hash from header fields
      const headerStr = `${curr.idx}|${curr.ts}|${curr.prevHash}|${curr.merkleRoot}|${curr.nonce}`;
      const reHash = crypto.createHash('sha256').update(headerStr).digest('hex');

      const isHashVal = reHash === curr.hash;
      const isPowVal = curr.hash.startsWith(target);
      const isIdxVal = i === 0 ? curr.idx === 0 : curr.idx === this.chain[i - 1].idx + 1;
      let isPrevVal;
      if (i === 0) {
        isPrevVal = curr.prevHash === '0';
      } else {
        const prev = this.chain[i - 1];
        isPrevVal = curr.prevHash === prev.hash;
      }

      const blkVal = !ccInv && isHashVal && isPowVal && isPrevVal && isIdxVal;
      res.dets.push({ idx: curr.idx, isHashVal, isPowVal, isPrevVal, isIdxVal, blkVal, cc: ccInv });
      if (!blkVal) {
        res.isValid = false;
        res.invBlkIdx.push(curr.idx);
        ccInv = true;
      }
    }
    return res;
  }
}

/**
 * Build a few helper functions to create transactions that spend real UTXOs
 */
function p2pkhScript(pubKeyHash20) {
  // OP_DUP OP_HASH160 <20b> OP_EQUALVERIFY OP_CHECKSIG
  return `76a914${pubKeyHash20}88ac`;
}

/**
 * Create creative transactions that spend UTXOs from the current pool.
 * We will:
 *  - always include 5 transactions that each pick a random available UTXO and spend it.
 *  - each tx creates 2 outputs (recipient + change) where change = input_value - amount - fee.
 *  - coinbase tx is also added (txid zeros) with 50 BTC reward to miner
 */
function createFiveRandomTxs(utxoPool) {
  const available = utxoPool.listAvailable();
  const randomize = (n) => Math.floor(Math.random() * n);
  const chosenUTXOs = [];

  // if fewer than 5 UTXOs available, we may reuse some (or create dummy small UTXOs)
  // but ensure we don't spend the same UTXO twice in this set
  const poolCopy = available.slice();

  // If pool is small, create dummy UTXOs from "faucet" for variety
  if (poolCopy.length < 5) {
    // create a temporary UTXO (simulated faucet) so we can always create 5 txs
    // faucet txid random, output 0 = 0.5 BTC each
    const faucetTxid = randHex(32);
    utxoPool.addTxOutputs(faucetTxid, [{
      value: 50000000,
      scriptPubKey: p2pkhScript(randHex(20))
    }]);
    poolCopy.push({ txid: faucetTxid, index: 0, value: 50000000, scriptPubKey: p2pkhScript(randHex(20)) });
  }

  // pick up to 5 unique UTXOs
  while (chosenUTXOs.length < 5  && poolCopy.length > 0) {
    const idx = randomize(poolCopy.length);
    chosenUTXOs.push(poolCopy.splice(idx, 1)[0]);
  }

  // Build five txs (if less than 5 chosen, repeat some but still ensure pool marking happens later)
  const txs = [];
  for (let i = 0; i < 5; i++) {
    const utxo = chosenUTXOs[i % chosenUTXOs.length];

    // creative use case naming
    const usecases = [
      { note: 'Alice pays Bob (shopping)' },
      { note: 'Charlie pays Dave (peer payment)' },
      { note: 'Eve buys coffee' },
      { note: 'Donation to charity' },
      { note: 'Micro tip to content creator' }
    ];
    const uc = usecases[i % usecases.length];

    // base: spend full utxo (single input)
    const fee = 10000; // 10k sats default
    // choose sending amount randomly (but less than utxo.value - fee)
    const maxSend = Math.max(0, utxo.value - fee - 1000);
    const sendAmt = Math.floor(Math.max(1, Math.min(maxSend, Math.floor((Math.random() * (maxSend)) + 1))));
    const change = utxo.value - sendAmt - fee;
    // ensure scriptPubKeys random 20-byte hex for recipients and change addresses
    const recipientHash = randHex(20);
    const changeHash = randHex(20);

    // build tx
    const tx = new Tx(
      [{ txid: utxo.txid, index: utxo.index }],
      [
        { value: sendAmt, scriptPubKey: p2pkhScript(recipientHash) },
        { value: change, scriptPubKey: p2pkhScript(changeHash) }
      ]
    );

    // compute txid and attach meta (note)
    const txid = tx.getTxid();
    tx.txid = txid;
    tx.note = uc.note;
    tx.fee = fee;
    txs.push(tx);
  }

  return txs;
}

/**
 * Create coinbase tx (txid all zeros) paying minerReward sats to miner scriptPubKey
 */
function createCoinbaseTx(minerPubKeyHash) {
  const coin = new Tx(
    // coinbase has no real inputs; we represent a single input with coinbase txid = zeros and index = 0xffffffff
    [{ txid: '0000000000000000000000000000000000000000000000000000000000000000', index: 0xffffffff }],
    [{ value: 50 * 100000000, scriptPubKey: p2pkhScript(minerPubKeyHash) }]
  );
  // special txid should be all zeros per assignment, override computed one
  coin.txid = '0000000000000000000000000000000000000000000000000000000000000000';
  coin.isCoinbase = true;
  return coin;
}

/**
 * Initialize blockchain instance
 */
const blkch = new Blockchain({ diff: 3 });

/**
 * API Endpoints
 */
app.get('/api/chain', (req, res) => {
  const val = blkch.validateChain();
  // return chain as-is (blocks contain header fields plus transactions)
  res.json({
    chain: blkch.chain,
    val
  });
});

app.post('/api/mine', (req, res) => {
  // create 5 txs spending from current utxo pool
  const minerAddr = randHex(20);
  const coinbase = createCoinbaseTx(minerAddr);
  const txs = createFiveRandomTxs(blkch.utxo);

  // ensure coinbase is first tx (common bitcoin convention)
  const allTxs = [coinbase, ...txs];

  // compute txids for each tx object we created (Tx.getTxid sets tx.txid except coinbase we force)
  for (const t of allTxs) {
    if (!t.txid) t.txid = t.getTxid();
  }

  // now mine the block (merkle root and header hash computed inside)
  const newBlk = blkch.mineBlock(allTxs);

  const val = blkch.validateChain();
  res.json({ msg: 'Block mined', blk: newBlk, txs: allTxs.map(t => ({ txid: t.txid, note: t.note, inputs: t.inputs, outputs: t.outputs, fee: t.fee })), val });
});

app.get('/api/download', (req, res) => {
  const fmt = String(req.query.format || 'json').toLowerCase();
  const pld = {
    chain: blkch.chain
  };

  if (fmt === 'yaml') {
    const yml = yaml.dump(pld, { noRefs: true, lineWidth: 120 });
    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', 'attachment; filename="blockchain.yaml"');
    return res.send(yml);
  }

  if (fmt === 'txt') {
    const lines = [];
    for (const b of blkch.chain) {
      lines.push('---');
      lines.push(`Index: ${b.idx}`);
      lines.push(`Timestamp: ${b.ts}`);
      lines.push(`Previous Hash: ${b.prevHash}`);
      lines.push(`Hash: ${b.hash}`);
      lines.push(`MerkleRoot: ${b.merkleRoot}`);
      lines.push(`Transactions: ${JSON.stringify(b.transactions)}`);
      lines.push(`Nonce: ${b.nonce}`);
    }
    const txt = lines.join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="blockchain.txt"');
    return res.send(txt);
  }

  const json = JSON.stringify(pld, null, 2);
  res.setHeader('Content-Disposition', 'attachment; filename="blockchain.json"');
  return res.send(json);
});

/**
 * Keep the existing parse/validate endpoints (adapted) so file uploads still work
 */
function parse(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    const jsonParsed = JSON.parse(raw);
    if (jsonParsed) {
      if (Array.isArray(jsonParsed)) return { chain: jsonParsed };
      if (jsonParsed.chain && Array.isArray(jsonParsed.chain)) return { chain: jsonParsed.chain };
    }
  }

  try {
    const yamlParsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    if (yamlParsed) {
      if (Array.isArray(yamlParsed)) return { chain: yamlParsed };
      if (yamlParsed.chain && Array.isArray(yamlParsed.chain)) return { chain: yamlParsed.chain };
    }
  } catch (e) {
    // ignore
  }

  // fallback: try parsing the TXT style we export
  const blks = [];
  const sections = raw.split(/\n---\n|\n---\r?\n|\r?\n---\r?\n/g);
  for (const section of sections) {
    const s = section.trim();
    if (!s) continue;
    const getLine = (label) => {
      const re = new RegExp(`^${label}:\\s*(.*)$`, 'mi');
      const m = s.match(re);
      return m ? m[1].trim() : undefined;
    };
    const idxStr = getLine('Index');
    const ts = getLine('Timestamp');
    const prevHash = getLine('Previous Hash');
    const hash = getLine('Hash');
    const dataStr = getLine('Data') || getLine('Transactions') || getLine('MerkleRoot');
    const nonceStr = getLine('Nonce');
    if (idxStr === undefined || nonceStr === undefined) continue;

    let dataVal = dataStr;
    if (dataStr && dataStr.trim() && (dataStr.startsWith('{') || dataStr.startsWith('['))) {
      try {
        const parsedData = JSON.parse(dataStr);
        if (parsedData) dataVal = parsedData;
      } catch (e) { /* pass */ }
    }

    blks.push({
      idx: Number(idxStr),
      ts,
      prevHash,
      hash,
      data: dataVal,
      nonce: Number(nonceStr)
    });
  }

  if (blks.length > 0) return { chain: blks };
  throw new Error('Unsupported or malformed blockchain file');
}

function validChain(chain, diff) {
  const target = '0'.repeat(diff);
  const dets = [];
  let isValid = true;
  const invBlkIdx = [];

  let ccInv = false;
  for (let i = 0; i < chain.length; i += 1) {
    const raw = chain[i] || {};
    const prevHashRaw = raw.prevHash ?? raw.previousHash ?? raw.previous_hash ?? '';
    const hashRaw = raw.hash ?? '';
    const dataRaw = raw.transactions ?? raw.data ?? raw.Data;
    const idxRaw = raw.idx ?? raw.Index ?? 0;
    const nonceRaw = raw.nonce ?? raw.Nonce ?? 0;
    const tsRaw = raw.ts ?? raw.Timestamp ?? '';

    const bIdx = Number(idxRaw);
    const prevHashStr = String(prevHashRaw ?? '');
    const hashStr = String(hashRaw ?? '');
    const tsStr = String(tsRaw ?? '');
    const nonceNum = Number(nonceRaw ?? 0);

    const headerStr = `${bIdx}|${tsStr}|${prevHashStr}|${(raw.merkleRoot ?? '')}|${nonceNum}`;
    const reHash = crypto.createHash('sha256').update(headerStr).digest('hex');

    const isHashVal = reHash === hashStr;
    const isPowVal = hashStr.startsWith(target);
    const isIdxVal = i === 0 ? bIdx === 0 : bIdx === (chain[i - 1]?.idx ?? -1) + 1;
    let isPrevVal;
    if (i === 0) {
      isPrevVal = prevHashStr === '0';
    } else {
      const prev = chain[i - 1] || {};
      isPrevVal = prevHashStr === prev.hash;
    }
    const blkVal = !ccInv && isHashVal && isPowVal && isPrevVal && isIdxVal;
    dets.push({ idx: bIdx, isHashVal, isPowVal, isPrevVal, isIdxVal, blkVal, cc: ccInv });
    if (!blkVal) {
      isValid = false;
      invBlkIdx.push(bIdx);
      ccInv = true;
    }
  }

  return { isValid, invBlkIdx, dets };
}

app.post('/api/validate', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  let chain;
  try {
    const parsed = parse(req.file.path);
    chain = parsed.chain;
  } catch (e) {
    fs.unlink(req.file.path, () => { });
    return res.status(400).json({ error: 'Failed to parse blockchain file' });
  }

  const val = validChain(chain, blkch.diff);
  fs.unlink(req.file.path, () => { });
  return res.json({ diff: blkch.diff, chain, val });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(8080, () => {
  console.log(`Server listening on http://localhost:8080`);
});
