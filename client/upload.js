// 上传页：拖拽/选择 txt -> 顺序上传（原文直传，服务端流式解析入库） -> 刷新概览
const $ = (id) => document.getElementById(id);
const POS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
const SU = { s: '♠', h: '♥', d: '♦', c: '♣' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const money = (v) => `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>`;
const cards = (s) =>
  ((s || '').replace(/\s+/g, '').match(/../g) || [])
    .map((c) => `<b class="mono">${c[0]}${SU[c[1]] || ''}</b>`)
    .join(' ');
const pfName = (r) =>
  r.pa === 'F' ? '弃牌' : r.pa === 'C' ? '跟注' : r.pa === 'X' ? '过牌' : ['开池', '3bet', '4bet'][r.rn] || '5bet+';

// ---------- 上传队列 ----------
let busy = false;
const jobs = [];

function jobRow(job) {
  const cls = job.state === 'ok' ? 'ok' : job.state === 'dup' ? 'dup' : job.state === 'err' ? 'err' : '';
  return `<div class="job ${cls}">
    <div class="row1"><span class="name">${esc(job.file.name)}</span><span class="state">${esc(job.label)}</span></div>
    <div class="bar"><i style="width:${job.pct}%"></i></div>
    ${job.detail ? `<div class="detail">${job.detail}</div>` : ''}
  </div>`;
}
const renderQueue = () => ($('queue').innerHTML = jobs.map(jobRow).join(''));

function enqueue(files) {
  for (const file of files) {
    jobs.unshift({ file, state: 'wait', label: '排队中', pct: 0, detail: '' });
  }
  renderQueue();
  pump();
}

async function pump() {
  if (busy) return;
  const job = [...jobs].reverse().find((j) => j.state === 'wait');
  if (!job) return;
  busy = true;
  try {
    await upload(job);
  } finally {
    busy = false;
    refresh();
    pump();
  }
}

function upload(job) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('content-type', 'text/plain');
    xhr.setRequestHeader('x-filename', encodeURIComponent(job.file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      job.state = 'up';
      job.pct = Math.round((90 * e.loaded) / e.total);
      job.label = `上传中 ${Math.round((100 * e.loaded) / e.total)}%`;
      renderQueue();
    };
    xhr.upload.onload = () => {
      job.state = 'parse';
      job.pct = 92;
      job.label = '服务端解析入库中…';
      renderQueue();
    };
    xhr.onload = () => {
      job.pct = 100;
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = { error: `响应异常 (HTTP ${xhr.status})` };
      }
      if (body.error) {
        job.state = 'err';
        job.label = '失败';
        job.detail = esc(body.error);
      } else if (body.status === 'duplicate_file') {
        job.state = 'dup';
        job.label = '整份重复，已跳过';
        job.detail = esc(body.message);
      } else {
        const s = body.stats;
        job.state = 'ok';
        job.label = `新增 ${s.inserted} 手`;
        job.detail =
          `解析 ${s.total} 手 · 新增 ${s.inserted} · 重复跳过 ${s.duplicated} · ` +
          `筹码守恒校验 ${s.checkPassed}/${s.checkTotal} (${s.checkRate.toFixed(1)}%) · 耗时 ${(s.elapsedMs / 1000).toFixed(1)}s`;
      }
      renderQueue();
      resolve();
    };
    xhr.onerror = () => {
      job.state = 'err';
      job.label = '失败';
      job.detail = '网络错误，服务端是否在运行？';
      job.pct = 100;
      renderQueue();
      resolve();
    };
    job.state = 'up';
    job.label = '上传中 0%';
    renderQueue();
    xhr.send(job.file);
  });
}

// ---------- 概览 / 历史 / 抽查 ----------
async function refresh() {
  const [filesRes, handsRes] = await Promise.all([
    fetch('/api/files').then((r) => r.json()),
    fetch('/api/hands?per=10&sort=t&dir=desc').then((r) => r.json()),
  ]);

  const t = filesRes.totals;
  const hands = Number(t.hands);
  const net = Number(t.net_cents) / 100;
  const pill = (label, value) => `<div class="pill"><div class="pill-v">${value}</div><div class="pill-l">${label}</div></div>`;
  $('totals').innerHTML =
    pill('总手数', hands.toLocaleString()) +
    pill('净盈亏 ₮', hands ? money(net) : '—') +
    pill('级别数', t.stakes_count ?? 0) +
    pill('最早一手', t.first_ts ? t.first_ts.slice(0, 16) : '—') +
    pill('最新一手', t.last_ts ? t.last_ts.slice(0, 16) : '—') +
    pill('上传文件数', filesRes.files.length);

  $('files').innerHTML =
    filesRes.files
      .map(
        (f) => `<tr>
          <td>${esc(f.filename)}</td>
          <td>${esc(String(f.uploaded_at).slice(0, 19).replace('T', ' '))}</td>
          <td>${mb(Number(f.size))}</td>
          <td>${Number(f.hands_total).toLocaleString()}</td>
          <td>${Number(f.hands_new).toLocaleString()}</td>
          <td>${(Number(f.hands_total) - Number(f.hands_new)).toLocaleString()}</td>
          <td>${f.check_total ? ((100 * Number(f.check_passed)) / Number(f.check_total)).toFixed(1) + '%' : '—'}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="7" class="empty">还没有上传过文件</td></tr>';

  $('recent').innerHTML =
    handsRes.rows
      .map(
        (r) => `<tr>
          <td>${esc(r.ts.slice(5, 16))}</td>
          <td>${esc(r.lv)}</td>
          <td>${r.pos >= 0 ? POS[r.pos] : '?'}</td>
          <td>${cards(r.cd)}</td>
          <td>${pfName(r)}</td>
          <td>${r.potbb}</td>
          <td>${money(r.net)}</td>
          <td>${money(r.bb)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="8" class="empty">库里还没有手牌</td></tr>';
}

// ---------- 交互 ----------
const drop = $('drop');
$('pick').onclick = () => $('picker').click();
$('picker').onchange = (e) => {
  enqueue(e.target.files);
  e.target.value = '';
};
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('hot');
  });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
    drop.classList.remove('hot');
  });
}
drop.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.txt$/i.test(f.name));
  if (files.length) enqueue(files);
});

refresh();
