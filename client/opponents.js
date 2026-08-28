// 对手页：列出每个对手的 HUD 指标。筛选 / 排序 / 分页全部交给服务端 SQL，前端只持有当前一页。
// 与另外三个页面一样是普通脚本（非 ESM），$ / esc / POS 各有一份副本，刻意不共享。
const $ = (id) => document.getElementById(id);
const POS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 百分比/比率列：分母不足时服务端给 null，这里统一渲染 '—'（别拿 0 冒充没数据）
const p1 = (v) => (v == null ? '<span class="dim">—</span>' : v.toFixed(1));
const money = (v) => `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>`;
// bb/100 不带千分位（与数据页 sfix 同口径）
const sfix1 = (v) => (v == null ? '<span class="dim">—</span>' : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v.toFixed(1)}</span>`);

// 常见 NL100 6-max 区间，只用来上色提示「显著偏离」，不代表好坏
const BAND = {
  vpip: [22, 32], pfr: [16, 25], t3b: [6, 12], f3b: [40, 62], steal: [28, 46],
  cbet: [48, 72], fcb: [38, 56], wtsd: [24, 33], wsd: [46, 56], wwsf: [43, 51], af: [1.4, 3.2],
};
// 高于区间标 hi、低于标 lo
function band(key, v) {
  const b = BAND[key];
  if (b == null || v == null) return '';
  return v > b[1] ? ' class="hi"' : v < b[0] ? ' class="lo"' : '';
}

// ---------- 状态 ----------
const F = { q: '', minHands: 30, from: '', to: '', stakes: [], pos: [] };
let sort = 'hands';
let dir = 'desc';
let page = 1; // 1 基（与服务端一致，不像复盘页那样 0 基）
let reqSeq = 0;
let LIB = null;

function url() {
  const u = new URLSearchParams();
  const put = (k, v) => {
    if (v !== '' && v != null) u.set(k, v);
  };
  put('q', F.q.trim());
  put('minHands', F.minHands);
  put('from', F.from);
  put('to', F.to);
  put('stakes', F.stakes.join(','));
  put('pos', F.pos.join(','));
  put('sort', sort);
  put('dir', dir);
  put('page', page);
  put('per', 50);
  return '/api/opponents?' + u;
}

async function load() {
  const seq = ++reqSeq;
  const d = await fetch(url()).then((r) => r.json());
  if (seq !== reqSeq) return; // 慢响应淘汰：快速改筛选时不让旧响应覆盖新结果
  render(d);
}

function render(d) {
  const s = d.summary;
  $('sumbar').innerHTML =
    `<span><span class="k">符合条件的对手</span><b>${d.total.toLocaleString()}</b></span>` +
    `<span><span class="k">≥${d.minHands} 手</span><b>${d.total.toLocaleString()}</b> / ${s.players.toLocaleString()} 人</span>` +
    `<span><span class="k">覆盖手牌</span><b>${s.hands.toLocaleString()}</b></span>` +
    `<span><span class="k">玩家-手牌记录</span><b>${s.rows.toLocaleString()}</b></span>` +
    `<span><span class="k">整体 VPIP</span><b>${p1(s.vpip)}</b></span>` +
    `<span><span class="k">PFR</span><b>${p1(s.pfr)}</b></span>` +
    `<span><span class="k">3B</span><b>${p1(s.t3b)}</b></span>` +
    `<span><span class="k">WTSD</span><b>${p1(s.wtsd)}</b></span>`;

  $('rows').innerHTML =
    d.rows
      .map(
        (r) => `<tr>
        <td class="name">${esc(r.player)}</td>
        <td>${r.hands.toLocaleString()}</td>
        <td${band('vpip', r.vpip)}>${p1(r.vpip)}</td>
        <td${band('pfr', r.pfr)}>${p1(r.pfr)}</td>
        <td${band('t3b', r.t3b)}>${p1(r.t3b)}</td>
        <td${band('f3b', r.f3b)}>${p1(r.f3b)}</td>
        <td${band('steal', r.steal)}>${p1(r.steal)}</td>
        <td${band('cbet', r.cbet)}>${p1(r.cbet)}</td>
        <td${band('fcb', r.fcb)}>${p1(r.fcb)}</td>
        <td${band('wtsd', r.wtsd)}>${p1(r.wtsd)}</td>
        <td${band('wsd', r.wsd)}>${p1(r.wsd)}</td>
        <td${band('wwsf', r.wwsf)}>${p1(r.wwsf)}</td>
        <td${band('af', r.af)}>${r.af == null ? '<span class="dim">—</span>' : r.af.toFixed(2)}</td>
        <td>${sfix1(r.bb100)}</td>
        <td>${money(r.net)}</td>
        <td><a class="btn-sm" href="opp-review.html?player=${encodeURIComponent(r.player)}" target="_blank" rel="noopener">复盘</a></td>
      </tr>`
      )
      .join('') ||
    `<tr><td colspan="16" class="empty">${
      s.rows === 0 ? '当前筛选条件下没有对手数据' : `没有手数 ≥ ${d.minHands} 的对手，把「最少手数」调小些`
    }</td></tr>`;

  page = d.page;
  $('pginfo').textContent = `第 ${d.page} / ${d.pages} 页 · 共 ${d.total.toLocaleString()} 个对手`;
  $('prev').disabled = d.page <= 1;
  $('next').disabled = d.page >= d.pages;

  for (const th of document.querySelectorAll('#tbl th.s')) {
    th.classList.toggle('sorted', th.dataset.k === sort);
    th.classList.toggle('asc', th.dataset.k === sort && dir === 'asc');
  }
}

// ---------- 交互 ----------
// 改筛选一律回到第 1 页，否则筛窄了会停在一个不存在的页码上
let timer = null;
const apply = (debounce) => {
  page = 1;
  clearTimeout(timer);
  if (debounce) timer = setTimeout(load, 180);
  else load();
};

function chips(host, items, onToggle) {
  host.innerHTML = items.map((it) => `<span class="chip" data-v="${esc(it.v)}">${esc(it.label)}</span>`).join('');
  host.onclick = (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    c.classList.toggle('on');
    onToggle([...host.querySelectorAll('.chip.on')].map((x) => x.dataset.v));
  };
}

async function init() {
  LIB = await fetch('/api/opp-totals').then((r) => r.json());
  if (!LIB.hands) {
    $('loading').innerHTML = '还没有上传对手牌谱。到 <a href="index.html">上传</a> 页把对手牌谱拖进「对手牌谱」区域。';
    return;
  }

  chips($('fStakes'), LIB.by_stakes.map((x) => ({ v: x.stakes, label: `${x.stakes} (${x.hands.toLocaleString()})` })), (v) => {
    F.stakes = v;
    apply(false);
  });
  chips($('fPos'), POS.map((p, i) => ({ v: String(i), label: p })), (v) => {
    F.pos = v;
    apply(false);
  });

  $('fq').oninput = (e) => {
    F.q = e.target.value;
    apply(true);
  };
  $('fMin').oninput = (e) => {
    F.minHands = Math.max(1, Number(e.target.value) || 1);
    apply(true);
  };
  $('fFrom').onchange = (e) => {
    F.from = e.target.value;
    apply(false);
  };
  $('fTo').onchange = (e) => {
    F.to = e.target.value;
    apply(false);
  };
  $('fReset').onclick = () => {
    F.q = '';
    F.minHands = 30;
    F.from = '';
    F.to = '';
    F.stakes = [];
    F.pos = [];
    $('fq').value = '';
    $('fMin').value = 30;
    $('fFrom').value = '';
    $('fTo').value = '';
    for (const c of document.querySelectorAll('#filters .chip.on')) c.classList.remove('on');
    apply(false);
  };

  for (const th of document.querySelectorAll('#tbl th.s')) {
    th.onclick = () => {
      const k = th.dataset.k;
      // 同键再点反向；换键时玩家名默认升序，其余默认降序
      if (k === sort) dir = dir === 'desc' ? 'asc' : 'desc';
      else {
        sort = k;
        dir = k === 'player' ? 'asc' : 'desc';
      }
      page = 1;
      load();
    };
  }
  $('prev').onclick = () => {
    if (page > 1) {
      page--;
      load();
    }
  };
  $('next').onclick = () => {
    page++;
    load();
  };

  await load();
  $('loading').hidden = true;
  $('page').hidden = false;
}

init();
