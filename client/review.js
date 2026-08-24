// 复盘页：筛选/排序/分页全部交给 /api/hands，页面逻辑与 hand_browser.py 生成页保持一致
const POS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
// flop 牌型 chips：[后端值, 显示名]
const FLOP_BRD = [
  ['mono', '天花面'], ['two', '两同花'], ['rb', '彩虹面'], ['str', '天顺面'],
  ['hi3', '三高张'], ['hi2', '双高张'], ['hi1', '单高张'], ['lo3', '三小'],
  ['pair', '对子面'], ['trips', '三条面'],
];
const SU = { s: '♠', h: '♥', d: '♦', c: '♣' };
const $ = (id) => document.getElementById(id);

let CUR = [];        // 当前页的行
let page = 0;        // 0 基（与原脚本一致）
let pages = 1;
let total = 0;       // 命中手数
let libTotal = 0;    // 库内总手数
let SK = 't';
let SD = -1;
let reqSeq = 0;
let timer = null;

const fmt = (t) => {
  const d = new Date(t * 60000);
  const p = (x) => String(x).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
const ch = (c) => (c ? '<span class="cd ' + c[1] + '">' + c[0] + SU[c[1]] + '</span>' : '');
const chs = (s) => ((s || '').replace(/\s+/g, '').match(/../g) || []).map(ch).join(' ');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (id) => {
  const v = parseFloat($(id).value);
  return isNaN(v) ? null : v;
};

function mkChips(el, values) {
  values.forEach((x) => {
    const [v, txt] = Array.isArray(x) ? x : [x, x];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = txt;
    b.dataset.v = v;
    b.onclick = () => {
      b.classList.toggle('on');
      apply();
    };
    el.appendChild(b);
  });
}
const selSet = (el) => [...el.querySelectorAll('.chip.on')].map((b) => b.dataset.v);

function params() {
  const q = new URLSearchParams();
  const put = (k, v) => {
    if (v !== null && v !== undefined && v !== '' && v !== 'any') q.set(k, v);
  };
  const lv = selSet($('g_lv'));
  if (lv.length) q.set('stakes', lv.join(','));
  const ps = selSet($('g_pos')).map((p) => POS.indexOf(p));
  if (ps.length) q.set('pos', ps.join(','));
  put('from', $('d1').value);
  put('to', $('d2').value);
  put('hid', $('hidTxt').value.trim());
  if ($('h1').value !== '0' || $('h2').value !== '23') {
    q.set('h1', $('h1').value);
    q.set('h2', $('h2').value);
  }
  put('pa', $('paSel').value);
  put('rt', $('rtSel').value);
  put('agg', $('aggSel').value);
  put('def', $('defSel').value);
  put('f3', $('f3Sel').value);
  put('join', $('joinSel').value);
  put('cards', $('cardTxt').value.trim());
  put('grp', $('grpSel').value);
  const fb = selSet($('g_fb'));
  if (fb.length) q.set('fb', fb.join(','));
  put('st', $('stSel').value);
  put('hs', $('hsSel').value);
  put('ha', $('haSel').value);
  put('ip', $('ipSel').value);
  put('sd', $('sdSel').value);
  put('sdw', $('sdwSel').value);
  put('ai', $('aiSel').value);
  put('nf', $('nfSel').value);
  put('res', $('resSel').value);
  put('opp', $('oppTxt').value.trim());
  ['bbMin', 'bbMax', 'potMin', 'potMax'].forEach((k) => put(k, num(k)));
  q.set('sort', SK);
  q.set('dir', SD < 0 ? 'desc' : 'asc');
  q.set('per', $('perSel').value);
  q.set('page', page + 1);
  return q;
}

function pfTag(r) {
  let t;
  if (r.pa === 'F') t = '弃牌';
  else if (r.pa === 'C') t = '跟注';
  else if (r.pa === 'X') t = '过牌';
  else t = r.rn === 0 ? '开池' : r.rn === 1 ? '3bet' : r.rn === 2 ? '4bet' : '5bet+';
  let s = '<span class="tag">' + t + '</span>';
  if (r.rba >= 1 && r.pa !== 'R') s += '<span class="tag dim">面开</span>';
  if (r.f3) s += '<span class="tag warn">被3b</span>';
  return s;
}
function stTag(r) {
  const nm = ['翻前', '翻牌', '转牌', '河牌'][r.st];
  let s = '<span class="tag dim">' + nm + '</span>';
  if (r.sdw !== null && r.sdw !== undefined) s += '<span class="tag">摊</span>';
  if (r.ai) s += '<span class="tag warn">全下</span>';
  return s;
}
function resTag(r) {
  if (r.sdw !== null && r.sdw !== undefined)
    return r.sdw === 1
      ? '<span class="tag win">摊牌赢</span>'
      : r.sdw === 0
        ? '<span class="tag lose">摊牌输</span>'
        : '<span class="tag">摊牌平</span>';
  if (r.net > 0) return '<span class="tag win">未摊赢</span>';
  if (r.net < 0) return '<span class="tag dim">' + (r.st === 0 ? '翻前弃' : '弃牌') + '</span>';
  return '<span class="tag dim">' + (r.pa === 'F' ? '弃牌' : '平') + '</span>';
}
function det(r) {
  const STN = ['翻前', '翻牌', '转牌', '河牌'];
  const seg = r.act.split('|');
  const boards = [null, r.fl, r.tu, r.ri];
  let h = `<div class="detbox"><div class="hd"><b>Hand #${esc(r.id)}</b> · ${esc(r.lv)} · 盲注 ₮${esc(r.bl)} · 位置 ${r.pos >= 0 ? POS[r.pos] : '?'} · 手牌 ${chs(r.cd) || '—'} · ${fmt(r.t)}</div>`;
  for (let i = 0; i < 4; i++) {
    const tk = (seg[i] || '').split(' ').filter(Boolean);
    if (!tk.length && !boards[i]) continue;
    h += '<div class="stl"><b>' + STN[i] + '</b>';
    h += tk.map((x) => esc(x).replace(/^(H|P\d+)/, '<span class="ak">$1</span>')).join(' ');
    if (boards[i]) h += ' <span style="color:#69758a">｜牌面</span> ' + chs(boards[i]);
    h += '</div>';
  }
  h +=
    '<div class="money">投入 <b>₮' + r.inv + '</b> · 收回 <b>₮' + r.col +
    '</b> · 净盈亏 <b class="' + (r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : '') + '">₮' + r.net + '</b> (' +
    (r.bb > 0 ? '+' : '') + r.bb + ' bb) · 整桌底池 ₮' + r.pot +
    '（rake+splash ₮' + r.rk + (r.sp ? '，促销注入 +₮' + r.sp : '') + '）</div>';
  if (r.opp) h += '<div class="money">对手摊牌: ' + chs(r.opp) + '</div>';
  return h + '</div>';
}

function summary(s) {
  const pc = (x) => (x === null || x === undefined ? '—' : x.toFixed(1) + '%');
  const b100 = s.bb100 === null ? '—' : s.bb100.toFixed(1);
  $('sumbar').innerHTML =
    '<span class="pill">手数 <b>' + s.hands + '</b></span>' +
    '<span class="pill">净盈亏 <b class="' + (s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : '') + '">₮' + s.net.toFixed(2) + '</b></span>' +
    '<span class="pill">bb/100 <b class="' + (b100 > 0 ? 'pos' : b100 < 0 ? 'neg' : '') + '">' + b100 + '</b></span>' +
    '<span class="pill">VPIP <b>' + pc(s.vpip) + '</b></span>' +
    '<span class="pill">PFR <b>' + pc(s.pfr) + '</b></span>' +
    '<span class="pill">进翻率 <b>' + pc(s.sawFlop) + '</b></span>' +
    '<span class="pill">W$SD <b>' + (s.showdowns ? s.wsd.toFixed(1) + '%' : '—') + '</b> <span style="color:#69758a">(' + s.showdowns + '次摊牌)</span></span>' +
    '<span class="pill">全下率 <b>' + pc(s.allin) + '</b></span>';
}

function render() {
  let h = '';
  for (let i = 0; i < CUR.length; i++) {
    const r = CUR[i];
    h += '<tr class="hr" data-k="' + i + '">' +
      '<td>' + fmt(r.t) + '</td><td>' + esc(r.lv) + '</td><td>' + (r.pos >= 0 ? POS[r.pos] : '?') + '</td>' +
      '<td>' + chs(r.cd) + '</td><td>' + pfTag(r) + '</td><td>' + stTag(r) + '</td>' +
      '<td>' + (r.nf || '—') + '</td><td>' + r.potbb + '</td>' +
      '<td class="' + (r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : '') + '">' + r.net.toFixed(2) + '</td>' +
      '<td class="' + (r.bb > 0 ? 'pos' : r.bb < 0 ? 'neg' : '') + '">' + (r.bb > 0 ? '+' : '') + r.bb.toFixed(1) + '</td>' +
      '<td>' + resTag(r) + '</td></tr>';
  }
  $('tbody').innerHTML = h || '<tr><td colspan="11" style="text-align:center;color:#69758a;padding:26px">没有符合条件的手牌</td></tr>';
  $('pgInfo').textContent = '命中 ' + total + ' 手 / 共 ' + libTotal + ' 手 · 第 ' + (total ? page + 1 : 0) + '/' + pages + ' 页';
  $('pgPrev').disabled = page <= 0;
  $('pgNext').disabled = page >= pages - 1;
  document.querySelectorAll('th.srt').forEach((th) => {
    th.style.color = th.dataset.k === SK ? 'var(--blu)' : '';
  });
}

async function load() {
  const seq = ++reqSeq;
  $('pgInfo').textContent = '查询中…';
  const res = await fetch('/api/hands?' + params());
  const data = await res.json();
  if (seq !== reqSeq) return; // 慢响应被后续请求淘汰
  if (data.error) {
    $('tbody').innerHTML = '<tr><td colspan="11" style="text-align:center;color:#d0453e;padding:26px">' + esc(data.error) + '</td></tr>';
    return;
  }
  CUR = data.rows;
  total = data.total;
  pages = data.pages;
  page = data.page - 1;
  summary(data.summary);
  render();
}

function apply() {
  page = 0;
  clearTimeout(timer);
  timer = setTimeout(load, 180);
}

$('tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr.hr');
  if (!tr) return;
  const nx = tr.nextElementSibling;
  if (nx && nx.classList.contains('det') && nx.dataset.dk === tr.dataset.k) {
    nx.remove();
    return;
  }
  const d = document.createElement('tr');
  d.className = 'det';
  d.dataset.dk = tr.dataset.k;
  d.innerHTML = '<td colspan="11">' + det(CUR[+tr.dataset.k]) + '</td>';
  tr.after(d);
});
document.querySelectorAll('th.srt').forEach((th) => {
  th.onclick = () => {
    const k = th.dataset.k;
    if (SK === k) SD = -SD;
    else {
      SK = k;
      SD = k === 't' ? -1 : 1;
    }
    load();
  };
});
$('pgPrev').onclick = () => {
  page--;
  load();
};
$('pgNext').onclick = () => {
  page++;
  load();
};
$('perSel').onchange = () => {
  page = 0;
  load();
};
$('resetBtn').onclick = () => {
  ['g_lv', 'g_pos', 'g_fb'].forEach((id) => $(id).querySelectorAll('.chip.on').forEach((b) => b.classList.remove('on')));
  ['d1', 'd2', 'hidTxt', 'cardTxt', 'oppTxt', 'bbMin', 'bbMax', 'potMin', 'potMax'].forEach((id) => ($(id).value = ''));
  $('h1').value = '0';
  $('h2').value = '23';
  ['paSel', 'rtSel', 'aggSel', 'defSel', 'f3Sel', 'joinSel', 'grpSel', 'stSel', 'hsSel', 'haSel', 'ipSel', 'sdSel', 'sdwSel', 'aiSel', 'nfSel', 'resSel'].forEach(
    (id) => ($(id).value = 'any')
  );
  apply();
};
document.querySelectorAll('#filters select,#filters input').forEach((el) => {
  el.addEventListener('input', apply);
  el.addEventListener('change', apply);
});

// ---- 初始化 ----
(async function () {
  for (let i = 0; i < 24; i++) {
    $('h1').add(new Option(i + '点', i));
    $('h2').add(new Option(i + '点', i));
  }
  $('h2').value = '23';
  mkChips($('g_pos'), POS);
  mkChips($('g_fb'), FLOP_BRD);

  // 从 URL 预填手牌编号筛选（数据页热图明细点击编号跳转过来）
  const hid0 = new URLSearchParams(location.search).get('hid');
  if (hid0) $('hidTxt').value = hid0;

  const t = await fetch('/api/totals').then((r) => r.json());
  libTotal = t.hands;
  if (!t.hands) {
    $('tbody').innerHTML =
      '<tr><td colspan="11" style="text-align:center;color:#69758a;padding:26px">库里还没有手牌，请先到 <a href="index.html">上传</a> 页导入牌谱</td></tr>';
    return;
  }
  mkChips($('g_lv'), t.by_stakes.map((s) => s.stakes));
  load();
})();
