async function fetchChain() {
  const res = await fetch('/api/chain');
  if (!res.ok) throw new Error('Failed to fetch chain');
  return res.json();
}

function blockView(block, invalidIndicesOrFlag = new Set(), isGenesis = false, reasonList = []) {
  const isInvalid = typeof invalidIndicesOrFlag === 'boolean' ? invalidIndicesOrFlag : invalidIndicesOrFlag.has(block.index);
  const wrap = document.createElement('div');
  wrap.className = 'block ' + (isInvalid ? 'invalid' : 'valid');
  wrap.innerHTML = `
    <div class="kv"><span class="k">Index:</span> <span class="v">${block.index}</span></div>
    <div class="kv"><span class="k">Timestamp:</span> <span class="v">${block.timestamp}</span></div>
    <div class="kv"><span class="k">Previous Hash:</span> <span class="v">${block.previousHash}</span></div>
    <div class="kv"><span class="k">Hash:</span> <span class="v">${block.hash}</span></div>
    <div class="kv"><span class="k">Data:</span> <span class="v">${typeof block.data === 'string' ? block.data : JSON.stringify(block.data)}</span></div>
    <div class="kv"><span class="k">Nonce:</span> <span class="v">${block.nonce}</span></div>
    ${isInvalid ? '<span class="badge badge-invalid">Invalid</span>' : ''}
    ${isGenesis ? '<span class="badge badge-genesis">Genesis</span>' : ''}
  `;

  if (isInvalid && reasonList.length) {
    const ul = document.createElement('ul');
    ul.className = 'reasons';
    for (const r of reasonList) {
      const li = document.createElement('li');
      li.textContent = r;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }
  return wrap;
}

function liveChain(payload) {
  const root = document.getElementById('chain');
  root.innerHTML = '';
  const detailsByIndex = new Map((payload.validation.details || []).map(d => [d.index, d]));
  const invalidIndices = Array.isArray(payload.validation?.invalidBlockIndices) ? payload.validation.invalidBlockIndices : [];
  const minBadIndex = invalidIndices.length ? Math.min(...invalidIndices) : Infinity;
  let firstBad = false;
  for (let idx = 0; idx < payload.chain.length; idx += 1) {
    const b = payload.chain[idx];
    const d = detailsByIndex.get(b.index) || {};
    const reasons = [];
    if (d.cascaded) reasons.push('Cascaded from previous invalid block');
    if (d.isIndexValid === false) reasons.push('Index broken');
    if (d.isPrevValid === false) reasons.push('Previous hash mismatch');
    if (d.isPowValid === false) reasons.push('Proof-of-Work not satisfied');
    if (d.isHashValid === false) reasons.push('Hash does not match block contents');
    const isGenesis = b.index === 0;
    const isInvalid = firstBad || d.blockValid === false || d.cascaded === true || b.index >= minBadIndex;
    if (!firstBad && (d.blockValid === false || d.cascaded === true || d.isHashValid === false || d.isPrevValid === false || d.isPowValid === false || d.isIndexValid === false)) firstBad = true;
    const el = blockView(b, isInvalid, isGenesis, reasons);
    if (idx === 0) el.classList.add('gen');
    root.appendChild(el);
  }

  updateLayout();
}

function uploadResult(payload) {
  const root = document.getElementById('uploaded');
  root.innerHTML = '';
  if (!payload || !payload.chain) {
    updateLayout();
    return;
  }

  const detailsByIndex = new Map((payload.validation.details || []).map(d => [d.index, d]));
  const invalidIndices = Array.isArray(payload.validation?.invalidBlockIndices) ? payload.validation.invalidBlockIndices : [];
  const minBadIndex = invalidIndices.length ? Math.min(...invalidIndices) : Infinity;
  let firstBad = false;
  for (let idx = 0; idx < payload.chain.length; idx += 1) {
    const b = payload.chain[idx];
    const d = detailsByIndex.get(b.index) || {};
    const reasons = [];
    if (d.cascaded) reasons.push('Cascaded from previous invalid block');
    if (d.isIndexValid === false) reasons.push('Index broken');
    if (d.isPrevValid === false) reasons.push('Previous hash mismatch');
    if (d.isPowValid === false) reasons.push('Proof-of-Work not satisfied');
    if (d.isHashValid === false) reasons.push('Hash does not match block contents');
    const isGenesis = b.index === 0;
    const isInvalid = firstBad || d.blockValid === false || d.cascaded === true || b.index >= minBadIndex;
    if (!firstBad && (d.blockValid === false || d.cascaded === true || d.isHashValid === false || d.isPrevValid === false || d.isPowValid === false || d.isIndexValid === false)) firstBad = true;
    const el = blockView(b, isInvalid, isGenesis, reasons);
    if (idx === 0) el.classList.add('gen');
    root.appendChild(el);
  }

  updateLayout();
}

function updateLayout() {
  const grid = document.querySelector('.grid');
  const uploadedSection = document.getElementById('uploaded');
  const hasValidationContent = uploadedSection.children.length > 0;

  if (hasValidationContent) {
    grid.classList.remove('single-column');
    uploadedSection.closest('section').style.display = 'block';
  } else {
    grid.classList.add('single-column');
    uploadedSection.closest('section').style.display = 'none';
  }
}

async function init() {
  const mineBtn = document.getElementById('mineBtn');
  const mineDataInput = document.getElementById('mineData');
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadFormat = document.getElementById('downloadFormat');
  const uploadInput = document.getElementById('uploadInput');

  const refresh = async () => {
    const payload = await fetchChain();
    liveChain(payload);
  };

  await refresh();

  updateLayout();

  mineBtn.addEventListener('click', async () => {
    mineBtn.disabled = true;
    mineBtn.textContent = 'Mining...';

    let blockData = mineDataInput.value.trim();
    if (blockData.length > 0) {
      try {
        blockData = JSON.parse(blockData);
      } catch (e) {
        // keep as string
      }
    } else {
      blockData = undefined;
    }

    const res = await fetch('/api/mine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: blockData }) });
    const resJson = await res.json();
    if (!res.ok) throw new Error(resJson.error || 'Failed to mine');
    await refresh();

    mineBtn.disabled = false;
    mineBtn.textContent = 'Mine';
  });

  downloadBtn.addEventListener('click', () => {
    const fmt = downloadFormat.value || 'json';
    const url = `/api/download?format=${encodeURIComponent(fmt)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `blockchain.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files[0];
    if (!file) return;

    const form = new FormData();
    form.append('file', file);

    const res = await fetch('/api/validate', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Validation failed');
    uploadResult(data);

    uploadInput.value = '';
  });
}

init();


