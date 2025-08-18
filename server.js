const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const yaml = require('js-yaml');

class Block {
  constructor(index, timestamp, data, previousHash = '0') {
    this.index = index;
    this.timestamp = timestamp;
    this.data = data;
    this.previousHash = previousHash;
    this.nonce = 0;
    this.hash = this.computeHash();
  }

  computeHash() {
    const str = `${this.index}|${this.timestamp}|${JSON.stringify(this.data)}|${this.previousHash}|${this.nonce}`;
    return crypto.createHash('sha256').update(str).digest('hex');
  }
}

class Blockchain {
  constructor({ difficulty = 3 } = {}) {
    this.difficulty = difficulty;
    this.chain = [this.creatGenBlock()];
  }

  creatGenBlock() {
    const gen = new Block(0, new Date().toISOString(), { message: 'Genesis Block' }, '0');
    this.proofOfWork(gen);
    return gen;
  }

  getLastBlock() {
    return this.chain[this.chain.length - 1];
  }

  addBlock(data) {
    const latest = this.getLastBlock();
    const newBlock = new Block(
      latest.index + 1,
      new Date().toISOString(),
      data,
      latest.hash
    );
    this.proofOfWork(newBlock);
    this.chain.push(newBlock);
    return newBlock;
  }

  proofOfWork(block) {
    const targetPrefix = '0'.repeat(this.difficulty);
    while (true) {
      block.hash = block.computeHash();
      if (block.hash.startsWith(targetPrefix)) {
        return block.hash;
      }
      block.nonce += 1;
    }
  }

  validateChain() {
    const result = { isValid: true, invalidBlockIndices: [], details: [] };
    const targetPrefix = '0'.repeat(this.difficulty);
    let cascadeInvalid = false;
    for (let i = 0; i < this.chain.length; i += 1) {
      const current = this.chain[i];
      const recomputedHash = current.computeHash();
      const isHashValid = recomputedHash === current.hash;
      const isPowValid = current.hash.startsWith(targetPrefix);
      const isIndexValid = i === 0 ? current.index === 0 : current.index === this.chain[i - 1].index + 1;
      let isPrevValid;
      if (i === 0) {
        isPrevValid = current.previousHash === '0';
      } else {
        const prev = this.chain[i - 1];
        const prevRecomputedHash = prev.computeHash();
        isPrevValid = current.previousHash === prevRecomputedHash;
      }

      const blockValid = !cascadeInvalid && isHashValid && isPowValid && isPrevValid && isIndexValid;
      result.details.push({ index: current.index, isHashValid, isPowValid, isPrevValid, isIndexValid, blockValid, cascaded: cascadeInvalid });
      if (!blockValid) {
        result.isValid = false;
        result.invalidBlockIndices.push(current.index);
        cascadeInvalid = true;
      }
    }
    return result;
  }
}

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

const blockchain = new Blockchain({ difficulty: 3 });

app.get('/api/chain', (req, res) => {
  const validation = blockchain.validateChain();
  res.json({

    chain: blockchain.chain,
    validation,
  });
});

app.post('/api/mine', (req, res) => {
  const bodyData = req.body?.data;
  const data = bodyData ?? {
    note: 'Mined via /api/mine',
    ts: new Date().toISOString(),
    rand: Math.random().toString(36).slice(2, 10)
  };
  const newBlock = blockchain.addBlock(data);
  const validation = blockchain.validateChain();
  res.json({ message: 'Block mined', block: newBlock, validation });
});

app.get('/api/download', (req, res) => {
  const format = String(req.query.format || 'json').toLowerCase();
  const payload = {
    chain: blockchain.chain
  };

  if (format === 'yaml') {
    const yml = yaml.dump(payload, { noRefs: true, lineWidth: 120 });
    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', 'attachment; filename="blockchain.yaml"');
    return res.send(yml);
  }

  if (format === 'txt') {
    const lines = [];
    for (const b of blockchain.chain) {
      lines.push('---');
      lines.push(`Index: ${b.index}`);
      lines.push(`Timestamp: ${b.timestamp}`);
      lines.push(`Previous Hash: ${b.previousHash}`);
      lines.push(`Hash: ${b.hash}`);
      lines.push(`Data: ${typeof b.data === 'string' ? b.data : JSON.stringify(b.data)}`);
      lines.push(`Nonce: ${b.nonce}`);
    }
    const txt = lines.join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="blockchain.txt"');
    return res.send(txt);
  }


  const json = JSON.stringify(payload, null, 2);
  res.setHeader('Content-Disposition', 'attachment; filename="blockchain.json"');
  return res.send(json);
});

function parseUpChain(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { chain: parsed };
    if (parsed && Array.isArray(parsed.chain)) return { chain: parsed.chain };
  } catch (e) {
  }

  try {
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    if (Array.isArray(parsed)) return { chain: parsed };
    if (parsed && Array.isArray(parsed.chain)) return { chain: parsed.chain };
  } catch (e) {
  }

  const blocks = [];
  const sections = raw.split(/\n---\n|\n---\r?\n|\r?\n---\r?\n/g);
  for (const section of sections) {
    const s = section.trim();
    if (!s) continue;
    const getLine = (label) => {
      const re = new RegExp(`^${label}:\\s*(.*)$`, 'mi');
      const m = s.match(re);
      return m ? m[1].trim() : undefined;
    };
    const indexStr = getLine('Index');
    const timestamp = getLine('Timestamp');
    const previousHash = getLine('Previous Hash');
    const hash = getLine('Hash');
    const dataStr = getLine('Data');
    const nonceStr = getLine('Nonce');
    if (indexStr === undefined || nonceStr === undefined) continue;
    let dataVal = dataStr;
    try { dataVal = JSON.parse(dataStr); } catch (_) { }
    blocks.push({
      index: Number(indexStr),
      timestamp,
      previousHash,
      hash,
      data: dataVal,
      nonce: Number(nonceStr)
    });
  }

  if (blocks.length > 0) return { chain: blocks };
  throw new Error('Unsupported or malformed blockchain file');
}

function validateChain(chain, difficulty) {
  const targetPrefix = '0'.repeat(difficulty);
  const details = [];
  let isValid = true;
  const invalidBlockIndices = [];

  let cascadeInvalid = false;
  for (let i = 0; i < chain.length; i += 1) {
    const raw = chain[i] || {};
    const prevHashRaw = raw.previousHash ?? raw.prevHash ?? raw.prev_hash ?? raw.previous_hash;
    const hashRaw = raw.hash ?? raw.Hash ?? raw.HASH;
    const dataRaw = raw.data ?? raw.Data;
    const indexRaw = raw.index ?? raw.Index;
    const nonceRaw = raw.nonce ?? raw.Nonce;
    const timestampRaw = raw.timestamp ?? raw.Timestamp ?? raw.time;

    const bIndex = Number(indexRaw);
    const prevHashStr = String(prevHashRaw ?? '');
    const hashStr = String(hashRaw ?? '');
    const timestampStr = timestampRaw instanceof Date ? timestampRaw.toISOString() : String(timestampRaw ?? '');
    const nonceNum = Number(nonceRaw ?? 0);
    const temp = new Block(bIndex, timestampStr, dataRaw, prevHashStr);
    temp.nonce = nonceNum;
    const recomputedHash = temp.computeHash();
    const isHashValid = recomputedHash === hashStr;
    const isPowValid = hashStr.startsWith(targetPrefix);
    const prevIndex = i === 0 ? -1 : Number(chain[i - 1]?.index);
    const isIndexValid = i === 0 ? bIndex === 0 : bIndex === prevIndex + 1;
    let isPrevValid;
    if (i === 0) {
      isPrevValid = prevHashStr === '0';
    } else {
      const prev = chain[i - 1] || {};
      const prevTemp = new Block(
        Number(prev.index),
        String(prev.timestamp ?? ''),
        prev.data,
        String(prev.previousHash ?? '')
      );
      prevTemp.nonce = Number(prev.nonce ?? 0);
      const prevRecomputedHash = prevTemp.computeHash();
      isPrevValid = prevHashStr === prevRecomputedHash;
    }
    const matchesServerGenesis = i !== 0 || blockchain.chain.length === 0 ? true : hashStr === blockchain.chain[0].hash;
    const blockValid = !cascadeInvalid && isHashValid && isPowValid && isPrevValid && isIndexValid && matchesServerGenesis;
    details.push({ index: bIndex, isHashValid, isPowValid, isPrevValid, isIndexValid, matchesServerGenesis, blockValid, cascaded: cascadeInvalid });
    if (!blockValid) {
      isValid = false;
      invalidBlockIndices.push(bIndex);
      cascadeInvalid = true;
    }
  }

  return { isValid, invalidBlockIndices, details };
}

app.post('/api/validate', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    const { chain } = parseUpChain(req.file.path);
    const validation = validateChain(chain, blockchain.difficulty);
    fs.unlink(req.file.path, () => { });
    return res.json({ difficulty: blockchain.difficulty, chain, validation });
  } catch (err) {
    fs.unlink(req.file.path, () => { });
    return res.status(400).json({ error: err.message || 'Invalid blockchain file' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


