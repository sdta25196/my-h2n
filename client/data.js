// 数据页：从 /api/report 拿聚合结果，渲染出 poker_report.py 生成页的同一套内容
// 与脚本版唯一差异：热图明细不再内嵌全量 JSON，改成点击时按需 GET /api/hands
const POS_ORDER = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
const HR = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const $ = (id) => document.getElementById(id);

// Python round()：银行家舍入，保证展示层数字与脚本版一致
function pyRound(x, nd = 0) {
  const f = 10 ** nd;
  const v = x * f;
  const fl = Math.floor(v);
  const d = v - fl;
  const r = Math.abs(d - 0.5) < 1e-9 ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(v);
  return r / f;
}
// Python 的 format：先银行家舍入，再按固定小数位输出
// nfmt/sfmt 带千分位（对应 f'{v:,.Nf}'），sfix 不带（对应 f'{v:+.Nf}'，bb/100 用）
const grouped = (v, nd) => v.toLocaleString('en-US', { minimumFractionDigits: nd, maximumFractionDigits: nd });
const signOf = (r, v) => (r > 0 ? '+' : r < 0 || v < 0 ? '-' : '');
const nfmt = (v, nd = 0) => grouped(pyRound(v, nd), nd);
const sfmt = (v, nd = 0) => {
  const r = pyRound(v, nd);
  return signOf(r, v) + grouped(Math.abs(r), nd);
};
const sfix = (v, nd = 0) => {
  const r = pyRound(v, nd);
  return signOf(r, v) + Math.abs(r).toFixed(nd);
};
const money = (v) => {
  const s = nfmt(Math.abs(v), 2);
  return v > 0 ? `+₮${s}` : v < 0 ? `-₮${s}` : '₮0.00';
};
const f1 = (v) => (v === null || v === undefined ? '-' : v.toFixed(1));
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let S = null; // 整份 report

function renderHead() {
  const { meta, overview: ov, overall } = S;
  $('hdSub').innerHTML =
    `玩家 <b>${esc(meta.player)}</b> ｜ ${meta.date_from} ~ ${meta.date_to} ｜ 级别 ${S.stakes.join(' / ')} ｜ 报告生成 ${meta.generated}`;
  const pre = ov.net + ov.rake_est;
  $('kpis').innerHTML = `
<div class="card kpi"><div class="v">${nfmt(ov.hands)}</div><div class="l">总手数</div><div class="s">${ov.sessions} 个场次</div></div>
<div class="card kpi"><div class="v ${cls(ov.net)}">${money(ov.net)}</div><div class="l">总盈亏</div><div class="s">扣抽水后</div></div>
<div class="card kpi"><div class="v ${cls(ov.bb100)}">${sfix(ov.bb100, 1)}</div><div class="l">bb/100</div><div class="s">${sfmt(ov.bb, 0)} bb</div></div>
<div class="card kpi"><div class="v">${nfmt(ov.play_hours)}h</div><div class="l">在桌时长</div><div class="s">${nfmt(ov.hands_per_hour)} 手/时</div></div>
<div class="card kpi"><div class="v">₮${nfmt(ov.rake_est)}</div><div class="l">估算承担抽水</div><div class="s">扣抽前约 ${money(pre)}</div></div>
<div class="card kpi"><div class="v">${f1(overall.vpip)} / ${f1(overall.pfr)}</div><div class="l">VPIP / PFR</div><div class="s">差值 ${(overall.vpip - overall.pfr).toFixed(1)}</div></div>
<div class="card kpi"><div class="v">${f1(overall.threebet)}% / ${f1(overall.fold3bet)}%</div><div class="l">3-Bet / 弃给3-Bet</div><div class="s">4-Bet ${overall.fourbet.toFixed(1)}% (${overall.fourbet_n}/${overall.fourbet_opp})</div></div>
<div class="card kpi"><div class="v">${f1(overall.wtsd)}% / ${f1(overall.wsd)}%</div><div class="l">WTSD / W$SD</div><div class="s">WWSF ${f1(overall.wwsf)}%</div></div>`;
  $('navHint').textContent = `${nfmt(ov.hands)} 手 · ${S.stakes.join(' / ')}`;
}

function renderTables() {
  $('stkRows').innerHTML = Object.entries(S.by_stakes)
    .map(
      ([k, v], i) =>
        `<tr><td><span class="badge b${i % 8}">${esc(k)}</span></td><td>${nfmt(v.hands)}</td>` +
        `<td class="${cls(v.net)}">${money(v.net)}</td><td class="${cls(v.bb)}">${sfmt(v.bb, 0)}</td>` +
        `<td class="${cls(v.bb100)}">${sfix(v.bb100, 1)}</td><td>${f1(v.vpip)}%</td><td>${f1(v.pfr)}%</td>` +
        `<td>${f1(v.threebet)}%</td><td>${f1(v.wtsd)}%</td><td>${f1(v.wsd)}%</td></tr>`
    )
    .join('');

  $('posRows').innerHTML = POS_ORDER.map((p) => {
    const v = S.by_pos[p];
    const note = p === 'SB' || p === 'BB' ? '<span class="dim">负值大部分来自强制投注(盲注+ante)</span>' : '';
    return (
      `<tr><td><b>${p}</b></td><td>${nfmt(v.hands)}</td><td>${f1(v.vpip)}%</td><td>${f1(v.pfr)}%</td>` +
      `<td>${f1(v.threebet)}%</td><td>${f1(v.wtsd)}%</td><td>${f1(v.wsd)}%</td>` +
      `<td class="${cls(v.bb100)}">${sfix(v.bb100, 1)}</td><td class="${cls(v.net)}">${money(v.net)}</td><td>${note}</td></tr>`
    );
  }).join('');

  $('sessTitle').textContent = `场次明细（${S.sessions.length} 场）`;
  $('sessRows').innerHTML = S.sessions
    .map(
      (s) =>
        `<tr><td>${s.date}</td><td>${s.start}–${s.end}</td><td>${nfmt(s.hands)}</td><td>${s.hours.toFixed(1)}h</td>` +
        `<td>${nfmt(s.hands / s.hours)}</td><td class="${cls(s.net)}">${money(s.net)}</td>` +
        `<td class="${cls(s.net)}">${sfmt(s.bb, 0)}</td></tr>`
    )
    .join('');

  const potRows = (pots) =>
    pots
      .map(
        (p) =>
          `<tr><td class="mono">${esc(p.cards)}</td><td>${esc(p.stakes)}</td><td>${p.pos}</td>` +
          `<td class="mono dim">${esc(p.board) || '—'}</td><td>${p.ts}</td>` +
          `<td class="${cls(p.net)}"><b>${money(p.net)}</b></td></tr>`
      )
      .join('');
  $('potWin').innerHTML = potRows(S.top_wins.slice(0, 8));
  $('potLose').innerHTML = potRows(S.top_losses.slice(0, 8));

  const ov = S.overview;
  const o = S.overall;
  $('methodList').innerHTML = [
    `解析 ${nfmt(ov.hands)} 手；覆盖 ALLIN/AUTOBB/STRADDLE、跑两次、SPLASH 促销金等 Coin 特殊格式。`,
    '每手盈亏 = 回收 − 净投入（投入 − 被退回的未跟注下注）；ante 计入投入但不参与加注额度基准。',
    '抽水为估算值：按投入比例分摊总底池 Rake + Splash Fee。',
    '场次切分：相邻两手间隔 &gt;60 分钟为新场次；匿名桌每手换新对手，未做对手维度统计。',
    'bb/100 = 盈亏大盲数 ÷ 手数 × 100，各级别按各自大盲归一化。',
  ]
    .map((t) => `<li>${t}</li>`)
    .join('');
  const src = S.meta.sources || [];
  $('foot').textContent =
    `数据来源：${src.length > 2 ? src.length + ' 份牌谱' : src.join('、')} ｜ 统计由 server/src/report.js 实时聚合（口径对齐 poker_report.py）。`;

  const pill = (label, value, hint = '') =>
    `<div class="pill"><div class="pill-v">${value}</div><div class="pill-l">${label}</div>${hint ? `<div class="pill-h">${hint}</div>` : ''}</div>`;
  $('pfPills').innerHTML =
    pill('VPIP', `${f1(o.vpip)}%`) +
    pill('PFR', `${f1(o.pfr)}%`) +
    pill('3-Bet', `${f1(o.threebet)}%`, `${o.threebet_n}/${o.threebet_opp} 机会`) +
    pill('4-Bet', `${f1(o.fourbet)}%`, `${o.fourbet_n}/${o.fourbet_opp} 次`) +
    pill('弃给 3-Bet', `${f1(o.fold3bet)}%`, `${o.fold3bet_opp} 次面对`) +
    pill('偷盲', `${f1(o.steal)}%`, `${o.steal_opp} 次全折机会`) +
    pill('大盲防守', `${f1(o.bbdef)}%`, `${o.bb_hands} 手大盲`) +
    pill('大盲走人', `${o.walks} 次`) +
    pill('跛入', `${o.limps} 次`);
  $('poPills').innerHTML =
    pill('C-Bet 翻牌', `${f1(o.cbet_f)}%`, `${o.cbet_f_opp} 次`) +
    pill('C-Bet 转牌', `${f1(o.cbet_t)}%`, `${o.cbet_t_opp} 次`) +
    pill('C-Bet 河牌', `${f1(o.cbet_r)}%`, `${o.cbet_r_opp} 次`) +
    pill('弃给翻牌下注', `${f1(o.fcbet_f)}%`, `${o.fcbet_f_opp} 次`) +
    pill('弃给转牌下注', `${f1(o.fcbet_t)}%`, `${o.fcbet_t_opp} 次`) +
    pill('弃给河牌下注', `${f1(o.fcbet_r)}%`, `${o.fcbet_r_opp} 次`) +
    pill('过牌-加注', `${f1(o.xr)}%`, `${o.xr_opp} 次`) +
    pill('AFq 翻/转/河', `${f1(o.afq_flop)} / ${f1(o.afq_turn)} / ${f1(o.afq_river)}`) +
    pill('看翻牌', nfmt(o.saw_flop), `${((o.saw_flop / ov.hands) * 100).toFixed(1)}%`);
}

function renderHeatmap() {
  const groups = S.groups;
  const rows = HR.map((r1, i) => {
    const cells = HR.map((r2, j) => {
      const key = i === j ? r1 + r2 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o';
      const g = groups[key];
      if (!g) return '<td class="hm" style="background:#141c2c"></td>';
      let style;
      let label;
      if (g.hands < 15) {
        style = 'background:#1a2334;color:#5b6b85';
        label = '·';
      } else {
        const cap = 150.0;
        const t = Math.max(-cap, Math.min(cap, g.bb100)) / cap;
        style =
          t >= 0
            ? `background:rgba(34,197,94,${0.12 + 0.55 * t});color:#dff5e6`
            : `background:rgba(239,68,68,${0.12 + 0.55 * -t});color:#fde2e2`;
        label = sfix(g.bb100, 0);
      }
      const title = `${key}: ${g.hands}手 ${money(g.net)} (${sfix(g.bb100, 0)} bb/100)，点击查看明细`;
      return `<td class="hm" style="${style}" data-g="${key}" title="${title}">${label}</td>`;
    }).join('');
    return `<tr><td class="hml">${r1}</td>${cells}</tr>`;
  }).join('');
  const head = HR.map((r) => `<td class="hml">${r}</td>`).join('');
  $('heatmap').innerHTML = `<table class="heatmap" id="hmTable"><tr><td class="hml"></td>${head}</tr>${rows}</table>`;

  const topTable = (winners) => {
    const items = Object.entries(groups).sort((a, b) => b[1].net - a[1].net);
    const sel = winners ? items.slice(0, 8) : items.slice(-8).reverse();
    const rs = sel
      .map(
        ([k, g]) =>
          `<tr><td class="mono">${k}</td><td>${g.hands}</td><td class="${cls(g.net)}">${money(g.net)}</td>` +
          `<td class="${cls(g.net)}">${sfix(g.bb100, 1)}</td></tr>`
      )
      .join('');
    return `<table class="mini"><tr><th>牌型</th><th>手数</th><th>盈亏</th><th>bb/100</th></tr>${rs}</table>`;
  };
  $('topWin').innerHTML = topTable(true);
  $('topLose').innerHTML = topTable(false);
}

// ---------------- 图表 ----------------
function renderCharts() {
  const stakes = S.stakes;
  const hourOn = S.by_hour.filter((e) => e.hands > 0);
  const D = {
    cum_x: S.cumulative.x,
    cum_all: S.cumulative.all,
    cum_sd: S.cumulative.sd,
    cum_nsd: S.cumulative.nsd,
    cum_bb: S.cumulative.bb,
    stakes,
    labels_day: S.by_day.map((d) => d.date.slice(5)),
    daily: Object.fromEntries(stakes.map((k) => [k, S.by_day.map((d) => d.stk[k] || 0)])),
    hour_labels: hourOn.map((e) => String(e.hour).padStart(2, '0')),
    hour_net: hourOn.map((e) => e.net),
    hour_hands: hourOn.map((e) => e.hands),
    pos_labels: POS_ORDER,
    pos_bb100: POS_ORDER.map((p) => S.by_pos[p].bb100),
    pos_vpip: POS_ORDER.map((p) => S.by_pos[p].vpip),
    pos_pfr: POS_ORDER.map((p) => S.by_pos[p].pfr),
  };

  Chart.defaults.color = '#8194b3';
  Chart.defaults.borderColor = '#22304a';
  Chart.defaults.font.family = '"Microsoft YaHei",system-ui,sans-serif';
  const PAL = ['#22c55e', '#f59e0b', '#38bdf8', '#a78bfa', '#ef4444', '#eab308', '#14b8a6', '#f472b6'];
  const GZ = (c) => (c.tick.value === 0 ? '#3b4d6e' : '#1b2740');

  new Chart($('cumChart'), {
    type: 'line',
    data: {
      labels: D.cum_x,
      datasets: [
        { label: '非摊牌收益', data: D.cum_nsd, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.08)', fill: true, pointRadius: 0, borderWidth: 1.6, tension: 0.15 },
        { label: '摊牌收益', data: D.cum_sd, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,.08)', fill: true, pointRadius: 0, borderWidth: 1.6, tension: 0.15 },
        { label: '总利润', data: D.cum_all, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.08)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } } },
      scales: { x: { ticks: { maxTicksLimit: 9 } }, y: { grid: { color: GZ } } },
    },
  });

  new Chart($('cumBBChart'), {
    type: 'line',
    data: {
      labels: D.cum_x,
      datasets: D.stakes.map((s, i) => ({
        label: s + ' 累计 bb',
        data: D.cum_bb[s] || [],
        borderColor: PAL[i % 8],
        pointRadius: 0,
        borderWidth: 1.6,
        tension: 0.15,
      })),
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top' } },
      scales: { x: { ticks: { maxTicksLimit: 9 } }, y: { grid: { color: GZ } } },
    },
  });

  new Chart($('dailyChart'), {
    type: 'bar',
    data: {
      labels: D.labels_day,
      datasets: D.stakes.map((s, i) => ({ label: s, data: D.daily[s], backgroundColor: PAL[i % 8], stack: 's', borderRadius: 3 })),
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: { x: { stacked: true }, y: { stacked: true, grid: { color: GZ } } },
    },
  });

  new Chart($('hourChart'), {
    data: {
      labels: D.hour_labels,
      datasets: [
        { type: 'bar', label: '盈亏 ₮', data: D.hour_net, backgroundColor: D.hour_net.map((v) => (v >= 0 ? 'rgba(34,197,94,.75)' : 'rgba(239,68,68,.75)')), borderRadius: 3, yAxisID: 'y' },
        { type: 'line', label: '手数', data: D.hour_hands, borderColor: '#a78bfa', pointRadius: 2, borderWidth: 1.5, yAxisID: 'y1' },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: { y: { position: 'left', grid: { color: GZ } }, y1: { position: 'right', grid: { display: false } } },
    },
  });

  new Chart($('posChart'), {
    type: 'bar',
    data: {
      labels: D.pos_labels,
      datasets: [{ label: 'bb/100', data: D.pos_bb100, backgroundColor: D.pos_bb100.map((v) => (v >= 0 ? 'rgba(34,197,94,.75)' : 'rgba(239,68,68,.75)')), borderRadius: 5 }],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { grid: { color: GZ } } } },
  });

  new Chart($('posVpipChart'), {
    type: 'bar',
    data: {
      labels: D.pos_labels,
      datasets: [
        { label: 'VPIP %', data: D.pos_vpip, backgroundColor: 'rgba(56,189,248,.7)', borderRadius: 4 },
        { label: 'PFR %', data: D.pos_pfr, backgroundColor: 'rgba(167,139,250,.7)', borderRadius: 4 },
      ],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'top' } } },
  });
}

// ---------------- 热图明细弹窗（按需拉 /api/hands） ----------------
const cache = new Map();
let curRows = [];
let sortCol = 5;
let sortDir = 1;

function renderRows() {
  $('mBody').innerHTML = curRows
    .map(
      (r) =>
        `<tr><td class="mono">${esc(r[0])}</td><td>${esc(r[1])}</td><td>${r[2]}</td>` +
        `<td class="mono dim">${esc(r[3]) || '—'}</td><td class="mono${r[4] ? ' opp' : ' dim'}">${esc(r[4]) || '—'}</td>` +
        `<td>${r[5]}</td><td class="${cls(r[6])}">${money(r[6])}</td></tr>`
    )
    .join('');
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.querySelector('.arr').textContent = +th.dataset.c === sortCol ? (sortDir > 0 ? '▲' : '▼') : '';
  });
}

async function fetchGroup(g) {
  if (cache.has(g)) return cache.get(g);
  const q = new URLSearchParams({ cards: g, per: '500', sort: 't', dir: 'asc', stakes: S.stakes.join(',') });
  const res = await fetch('/api/hands?' + q);
  const data = await res.json();
  const rows = data.rows.map((r) => [
    r.cd ? r.cd.slice(0, 2) + ' ' + r.cd.slice(2) : '',
    r.lv,
    r.pos >= 0 ? POS_ORDER[r.pos] : '?',
    [r.fl, r.tu, r.ri].filter(Boolean).join(' '),
    (r.opp || '').split(' ').filter(Boolean).join(' / '),
    r.ts.slice(5, 16),
    r.net,
  ]);
  cache.set(g, rows);
  return rows;
}

async function showGroup(g) {
  $('mTitle').textContent = g + ' · 加载中…';
  $('mSub').textContent = '';
  $('mBody').innerHTML = '';
  $('mask').classList.add('open');
  const rows = await fetchGroup(g);
  if (!rows.length) {
    $('mTitle').textContent = g + ' · 0 手';
    return;
  }
  curRows = rows.slice();
  sortCol = 5;
  sortDir = 1;
  const sum = rows.reduce((a, r) => a + r[6], 0);
  $('mTitle').textContent = `${g} · ${rows.length} 手`;
  $('mSub').textContent = '合计 ' + money(sum);
  renderRows();
}

function sortBy(c) {
  if (sortCol === c) sortDir *= -1;
  else {
    sortCol = c;
    sortDir = c === 5 ? 1 : -1;
  }
  curRows.sort((a, b) => (a[c] === b[c] ? 0 : a[c] > b[c] ? 1 : -1) * sortDir);
  renderRows();
}

function wireModal() {
  $('mClose').onclick = () => $('mask').classList.remove('open');
  $('mask').addEventListener('click', (e) => {
    if (e.target.id === 'mask') e.target.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('mask').classList.remove('open');
  });
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.onclick = () => sortBy(+th.dataset.c);
  });
  $('hmTable').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-g]');
    if (td) showGroup(td.dataset.g);
  });
  if (location.hash.indexOf('#g=') === 0) {
    const g0 = decodeURIComponent(location.hash.slice(3));
    if (S.groups[g0]) showGroup(g0);
  }
}

(async function init() {
  try {
    const res = await fetch('/api/report?minHands=100');
    S = await res.json();
  } catch (err) {
    $('loading').textContent = '加载 /api/report 失败：' + err.message;
    return;
  }
  if (S.empty) {
    const d = S.dropped && Object.keys(S.dropped).length ? `（样本不足被剔除：${JSON.stringify(S.dropped)}）` : '';
    $('loading').innerHTML = `库里还没有足够的手牌${d}。请先到 <a href="index.html" style="color:#38bdf8">上传</a> 页导入牌谱。`;
    return;
  }
  $('loading').hidden = true;
  $('page').hidden = false;
  renderHead();
  renderTables();
  renderHeatmap();
  renderCharts();
  wireModal();
})();
