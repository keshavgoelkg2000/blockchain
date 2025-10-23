// public/main.js (updated)
async function fetchChain() {
  const res = await fetch('/api/chain');
  if (!res.ok) throw new Error('Failed to fetch chain');
  return res.json();
}

function renderTransaction(tx) {
  const div = document.createElement('div');
  div.className = 'tx';
  console.log(tx);

  let html = `<div><b>Version:</b> ${tx.version || 1}</div>`;
  html += `<div><b>Input Count:</b> ${tx.inputs.length}</div>`;

  tx.inputs.forEach((inp, idx) => {
    html += `
      <div class="input">
        <b>Input ${idx + 1}:</b><br>
        Previous Transaction Hash: ${inp.txid}<br>
        Output Index: ${inp.index}<br>
        Script Length: ${inp.scriptSig ? inp.scriptSig.length / 2 : 0}<br>
        ScriptSig: ${inp.scriptSig || ''}<br>
        Sequence: ${inp.sequence || 'ffffffff'}
      </div>
    `;
  });

  html += `<div><b>Output Count:</b> ${tx.outputs.length}</div>`;

  tx.outputs.forEach((out, idx) => {
    html += `
      <div class="output">
        <b>Output ${idx + 1}:</b><br>
        Value: ${out.value} satoshis<br>
        Script Length: ${parseInt(out.scriptPubKey.length / 2)}<br>
        ScriptPubKey: ${out.scriptPubKey}
      </div>
    `;
  });

  html += `<div><b>Locktime:</b> ${tx.locktime || 0}</div>`;
  // html += `<div><b>TxID:</b> ${tx.txid}</div>`;

  div.innerHTML = html;
  if (tx.isCoinbase) {
  div.classList.add('coinbase');
  const badge = document.createElement('span');
  badge.className = 'badge badge-coinbase';
  badge.textContent = 'Coinbase';
  div.appendChild(badge);
}

  return div;
}


function txView(tx) {
  const wrap = document.createElement('div');
  wrap.className = 'tx';
  const ins = (tx.inputs || []).map(i => `${i.txid.substr(0, 12)}...:${i.index}`).join(', ');
  const outs = (tx.outputs || []).map(o => `${o.value} sats`).join(', ');
  wrap.innerHTML = `
    <div class="kv"><span class="k">TxID:</span> <span class="v">${tx.txid}</span></div>
    ${tx.note ? `<div class="kv"><span class="k">Note:</span> <span class="v">${tx.note}</span></div>` : ''}
    <div class="kv"><span class="k">Inputs:</span> <span class="v">${ins}</span></div>
    <div class="kv"><span class="k">Outputs total:</span> <span class="v">${outs}</span></div>
  `;
  return wrap;
}

function blkView(blk, flag = new Set(), isGen = false, reList = []) {
  const isInv = typeof flag === 'boolean' ? flag : flag.has(blk.idx);
  const wrap = document.createElement('div');
  wrap.className = 'blk ' + (isInv ? 'inv' : 'val');

  wrap.innerHTML = `
    <div class="kv"><span class="k">Index:</span> <span class="v">${blk.idx}</span></div>
    <div class="kv"><span class="k">Timestamp:</span> <span class="v">${blk.ts}</span></div>
    <div class="kv"><span class="k">Previous Hash:</span> <span class="v">${blk.prevHash}</span></div>
    <div class="kv"><span class="k">Hash:</span> <span class="v">${blk.hash}</span></div>
    <div class="kv"><span class="k">Merkle Root:</span> <span class="v">${blk.merkleRoot || ''}</span></div>
    <div class="kv"><span class="k">Nonce:</span> <span class="v">${blk.nonce}</span></div>
    ${isInv ? '<span class="badge badge-inv">Invalid</span>' : ''}
    ${isGen ? '<span class="badge badge-genesis">Genesis</span>' : ''}
  `;

  // ✅ Show transactions if present
  if (Array.isArray(blk.transactions) && blk.transactions.length > 0) {
  const txCont = document.createElement('div');
  txCont.className = 'tx-list';
  const h = document.createElement('h4');
  h.textContent = 'Transactions';
  txCont.appendChild(h);

  blk.transactions.forEach((tx) => {
    const tEl = renderTransaction(tx);   // ✅ new function
    txCont.appendChild(tEl);
  });

  wrap.appendChild(txCont);
}

  return wrap;
}


function liveChain(pld) {
  const root = document.getElementById('chain');
  root.innerHTML = '';
  const idxInfo = new Map((pld.val.dets || []).map(d => [d.idx, d]));
  const invIdx = Array.isArray(pld.val?.invBlkIdx) ? pld.val.invBlkIdx : [];
  const badIdx = invIdx.length ? Math.min(...invIdx) : Infinity;
  let firstBad = false;
  for (let idx = 0; idx < pld.chain.length; idx += 1) {
    const b = pld.chain[idx];
    const d = idxInfo.get(b.idx) || {};
    const reasons = [];
    if (d.cc) reasons.push('Cascaded from previous invalid block');
    if (d.isIdxVal === false) reasons.push('Index broken');
    if (d.isPrevVal === false) reasons.push('Previous hash mismatch');
    if (d.isPowVal === false) reasons.push('Proof-of-Work not satisfied');
    if (d.isHashVal === false) reasons.push('Hash does not match block contents');
    const isGen = b.idx === 0;
    const isInv = firstBad || d.blkVal === false || d.cc === true || b.idx >= badIdx;
    if (!firstBad && (d.blkVal === false || d.cc === true || d.isHashVal === false || d.isPrevVal === false || d.isPowVal === false || d.isIdxVal === false)) firstBad = true;
    const el = blkView(b, isInv, isGen, reasons);
    if (idx === 0) el.classList.add('gen');
    root.appendChild(el);
  }

  updateLayout();
}

function uploadResult(pld) {
  const root = document.getElementById('uploaded');
  root.innerHTML = '';
  if (!pld || !pld.chain) {
    updateLayout();
    return;
  }

  const idxInfo = new Map((pld.val.dets || []).map(d => [d.idx, d]));
  const invIdx = Array.isArray(pld.val?.invBlkIdx) ? pld.val.invBlkIdx : [];
  const badIdx = invIdx.length ? Math.min(...invIdx) : Infinity;
  let firstBad = false;
  for (let idx = 0; idx < pld.chain.length; idx += 1) {
    const b = pld.chain[idx];
    const d = idxInfo.get(b.idx) || {};
    const reasons = [];
    if (d.cc) reasons.push('Cascaded from previous invalid block');
    if (d.isIdxVal === false) reasons.push('Index broken');
    if (d.isPrevVal === false) reasons.push('Previous hash mismatch');
    if (d.isPowVal === false) reasons.push('Proof-of-Work not satisfied');
    if (d.isHashVal === false) reasons.push('Hash does not match block contents');
    const isGen = b.idx === 0;
    const isInv = firstBad || d.blkVal === false || d.cc === true || b.idx >= badIdx;
    if (!firstBad && (d.blkVal === false || d.cc === true || d.isHashVal === false || d.isPrevVal === false || d.isPowVal === false || d.isIdxVal === false)) firstBad = true;
    const el = blkView(b, isInv, isGen, reasons);
    if (idx === 0) el.classList.add('gen');
    root.appendChild(el);
  }

  updateLayout();
}

function updateLayout() {
  const grid = document.querySelector('.grid');
  const uploadedSection = document.getElementById('uploaded');
  const hasValInfo = uploadedSection.children.length > 0;

  if (hasValInfo) {
    grid.classList.remove('single-column');
    uploadedSection.closest('section').style.display = 'block';
  } else {
    grid.classList.add('single-column');
    uploadedSection.closest('section').style.display = 'none';
  }
}

async function init() {
  const mineBtn = document.getElementById('mineBtn');
  const dlBtn = document.getElementById('downloadBtn');
  const dlFmt = document.getElementById('downloadFormat');
  const upInput = document.getElementById('uploadInput');

  const refresh = async () => {
    const pld = await fetchChain();
    liveChain(pld);
  };

  await refresh();

  updateLayout();

  mineBtn.addEventListener('click', async () => {
    mineBtn.disabled = true;
    mineBtn.textContent = 'Mining...';

    let blkData = "Block Data";

    const res = await fetch('/api/mine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: blkData }) });
    const resJ = await res.json();
    if (!res.ok) {
      mineBtn.disabled = false;
      mineBtn.textContent = 'Mine';
      throw new Error(resJ.error || 'Failed to mine');
    }
    await refresh();

    mineBtn.disabled = false;
    mineBtn.textContent = 'Mine';
  });

  dlBtn.addEventListener('click', () => {
    const fmt = dlFmt.value || 'json';
    const url = `/api/download?format=${encodeURIComponent(fmt)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `blockchain.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  upInput.addEventListener('change', async () => {
    const file = upInput.files[0];
    if (!file) return;

    const form = new FormData();
    form.append('file', file);

    const res = await fetch('/api/validate', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Val failed');
    uploadResult(data);

    upInput.value = '';
  });
}

init();
