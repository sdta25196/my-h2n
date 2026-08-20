// GET /api/report：poker_report.py 的 build_stats() 移植版，每次请求实时从 sqlite 聚合
//
// 统计口径与 Python 版一一对应（add / fin / build_stats）。两处有意分歧：
//   1. faced_3bet 用 hand_browser 的口径（扫翻前动作序列，比 report 的加注计数近似更准）
//   2. 翻前 ALLIN 开池在 hand_browser 口径里算 raise（report 记作 bet），
//      因此偷盲/大盲防守分母会把「全下开池」也算进去
import { POS_ORDER } from './parser.js';

// Python round()：银行家舍入（四舍六入五取偶），保证与基准数字完全一致
function pyRound(x, nd = 0) {
  const f = 10 ** nd;
  const v = x * f;
  const fl = Math.floor(v);
  const d = v - fl;
  const r = Math.abs(d - 0.5) < 1e-9 ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(v);
  return r / f;
}
const pct = (a, b) => (b ? pyRound((100 * a) / b, 1) : 0.0);

const COLS = `ts_text, stakes, bb_cents, net_cents, pos, cards, hand_group, pa, rba, rn,
  faced_3bet, st, sd, hero_folded_street, seq_json, street_agg_json, facing_bet_json,
  raises_pf_json, saw_flop, remaining, folded_to_hero, walk, folded_to_3bet,
  rake_share_cents, flop, turn, river, opp`;

// 时间/级别筛选：日期口径与 hands.js 的 from/to 一致（比较 ts_text，含首尾整天）
function loadHands(db, { from = '', to = '', stakes = [] } = {}) {
  const w = [];
  const args = [];
  if (from) {
    w.push('ts_text >= ?');
    args.push(from + ' 00:00:00');
  }
  if (to) {
    w.push('ts_text <= ?');
    args.push(to + ' 23:59:59');
  }
  if (stakes.length) {
    w.push(`stakes IN (${stakes.map(() => '?').join(',')})`);
    args.push(...stakes);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  return db
    .prepare(`SELECT ${COLS} FROM hands ${where} ORDER BY ts_text, hand_id`)
    .all(...args)
    .map((r) => ({
      ts: new Date(String(r.ts_text).replace(' ', 'T')),
      tsText: String(r.ts_text),
      stakes: r.stakes,
      bbC: Number(r.bb_cents),
      netC: Number(r.net_cents),
      net: Number(r.net_cents) / 100,
      bb: Number(r.net_cents) / Number(r.bb_cents),
      pos: Number(r.pos) >= 0 ? POS_ORDER[Number(r.pos)] : '?',
      cards: r.cards,
      hg: r.hand_group,
      pa: r.pa,
      rba: Number(r.rba),
      rn: r.rn === null ? null : Number(r.rn),
      faced3bet: Number(r.faced_3bet) === 1,
      st: Number(r.st),
      sd: Number(r.sd) === 1,
      heroFoldedStreet: r.hero_folded_street,
      seq: JSON.parse(r.seq_json),
      streetAgg: JSON.parse(r.street_agg_json),
      facingBet: JSON.parse(r.facing_bet_json),
      raisesPf: JSON.parse(r.raises_pf_json),
      sawFlop: Number(r.saw_flop) === 1,
      remaining: Number(r.remaining),
      foldedToHero: Number(r.folded_to_hero) === 1,
      walk: Number(r.walk) === 1,
      foldedTo3bet: Number(r.folded_to_3bet) === 1,
      rakeShare: Number(r.rake_share_cents) / 100,
      board: [r.flop, r.turn, r.river].filter(Boolean).join(' '),
      opp: r.opp,
    }));
}

const blank = () =>
  new Proxy(
    {},
    {
      get: (t, k) => (k in t ? t[k] : 0),
      set: (t, k, v) => ((t[k] = v), true),
    }
  );

function add(st, h) {
  st.hands += 1;
  st.net += h.net;
  st.bb += h.bb;
  const vpip = h.pa === 'C' || h.pa === 'R';
  if (vpip) {
    st.vpip += 1;
    if (h.pa === 'C' && h.rba === 0) st.limps += 1;
  }
  if (h.raisesPf.length) {
    st.pfr += 1;
    if (h.raisesPf[0] === 1) st.threebet += 1;
    if (h.raisesPf.includes(2)) st.fourbet += 1;
  }
  if (h.rba >= 1) st.threebet_opp += 1;
  if (h.rba === 2) st.fourbet_opp += 1;
  if (h.faced3bet) {
    st.fold3bet_opp += 1;
    st.fourbet_opp += 1;
    if (h.foldedTo3bet) st.fold3bet += 1;
  }
  if (['CO', 'BTN', 'SB'].includes(h.pos) && h.foldedToHero) {
    st.steal_opp += 1;
    if (h.pa === 'R') st.steal += 1;
  }
  if (h.pos === 'BB') {
    st.bb_hands += 1;
    if (h.walk) st.walks += 1;
    if (h.rba >= 1) {
      st.bbdef_opp += 1;
      if (h.pa === 'C' || h.pa === 'R') st.bbdef += 1;
    }
  }
  const seq = h.seq;
  if (h.sawFlop) {
    st.saw_flop += 1;
    const seqf = seq.flop || [];
    if (h.streetAgg.preflop === 'Hero') {
      st.cbet_f_opp += 1;
      if (seqf.includes('bet')) st.cbet_f += 1;
    }
    if (seqf.length && h.facingBet.flop) {
      st.fcbet_f_opp += 1;
      if (seqf.includes('fold')) st.fcbet_f += 1;
    }
    for (const sname of ['flop', 'turn', 'river']) {
      const s = seq[sname] || [];
      if (s.includes('check')) {
        st.xr_opp += 1;
        if (s.includes('raise') && s.indexOf('raise') > s.indexOf('check')) st.xr += 1;
      }
      st['ag_' + sname] += s.filter((x) => x === 'bet' || x === 'raise').length;
      st['pas_' + sname] += s.filter((x) => x === 'call' || x === 'fold').length;
    }
    if (h.remaining >= 2) {
      st.wtsd += 1;
      if (h.net > 0) st.wsd_win += 1;
    } else if (h.net > 0 && h.remaining === 1) {
      st.wwsf += 1;
    }
  }
  if (h.st >= 2) {
    const seqf = seq.flop || [];
    const seqt = seq.turn || [];
    if (h.streetAgg.flop === 'Hero' && seqf.includes('bet')) {
      st.cbet_t_opp += 1;
      if (seqt.includes('bet')) st.cbet_t += 1;
    }
    if (seqt.length && h.facingBet.turn) {
      st.fcbet_t_opp += 1;
      if (seqt.includes('fold')) st.fcbet_t += 1;
    }
  }
  if (h.st >= 3) {
    const seqt = seq.turn || [];
    const seqr = seq.river || [];
    if (h.streetAgg.turn === 'Hero' && seqt.includes('bet')) {
      st.cbet_r_opp += 1;
      if (seqr.includes('bet')) st.cbet_r += 1;
    }
    if (seqr.length && h.facingBet.river) {
      st.fcbet_r_opp += 1;
      if (seqr.includes('fold')) st.fcbet_r += 1;
    }
  }
}

function fin(st) {
  const hands = st.hands;
  const out = {
    hands,
    net: pyRound(st.net, 2),
    bb: pyRound(st.bb, 1),
    bb100: hands ? pyRound((st.bb / hands) * 100, 1) : 0.0,
    vpip: pct(st.vpip, hands),
    pfr: pct(st.pfr, hands),
    threebet: pct(st.threebet, st.threebet_opp),
    threebet_n: st.threebet,
    threebet_opp: st.threebet_opp,
    fourbet: pct(st.fourbet, st.fourbet_opp),
    fourbet_n: st.fourbet,
    fourbet_opp: st.fourbet_opp,
    fold3bet: pct(st.fold3bet, st.fold3bet_opp),
    fold3bet_opp: st.fold3bet_opp,
    limps: st.limps,
    bb_hands: st.bb_hands,
    walks: st.walks,
    bbdef: pct(st.bbdef, st.bbdef_opp),
    steal: pct(st.steal, st.steal_opp),
    steal_opp: st.steal_opp,
    saw_flop: st.saw_flop,
    wtsd: pct(st.wtsd, st.saw_flop),
    wsd_n: st.wtsd,
    wsd: pct(st.wsd_win, st.wtsd),
    wwsf: pct(st.wwsf, st.saw_flop),
    xr: pct(st.xr, st.xr_opp),
    xr_opp: st.xr_opp,
  };
  for (const [k, opp] of [
    ['cbet_f', 'cbet_f_opp'],
    ['cbet_t', 'cbet_t_opp'],
    ['cbet_r', 'cbet_r_opp'],
    ['fcbet_f', 'fcbet_f_opp'],
    ['fcbet_t', 'fcbet_t_opp'],
    ['fcbet_r', 'fcbet_r_opp'],
  ]) {
    out[k] = pct(st[k], st[opp]);
    out[opp] = st[opp];
  }
  for (const sn of ['flop', 'turn', 'river']) {
    out['afq_' + sn] = pct(st['ag_' + sn], st['ag_' + sn] + st['pas_' + sn]);
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
const mmdd = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// 玩家名沿用 poker_report.py 的取法：牌谱文件名按 '_' 分段取第 2 段
function playerFrom(sources) {
  for (const s of sources) {
    const seg = String(s).split('_');
    if (seg.length > 1) return seg[1];
  }
  return 'Hero';
}

export function buildReport(db, { minHands = 100, from = '', to = '', stakes = [] } = {}) {
  const filters = { from, to, stakes };
  let hands = loadHands(db, filters);
  if (!hands.length) return { empty: true, filters };
  const sources = db.prepare('SELECT filename FROM upload_files ORDER BY id').all().map((r) => r.filename);

  const count = new Map();
  for (const h of hands) count.set(h.stakes, (count.get(h.stakes) || 0) + 1);
  const dropped = {};
  for (const [k, c] of count) if (c < minHands) dropped[k] = c;
  hands = hands.filter((h) => !(h.stakes in dropped));
  if (!hands.length) return { empty: true, dropped, filters };

  const total = hands.length;
  let totalNet = 0;
  let totalBb = 0;
  let rakeEst = 0;
  for (const h of hands) {
    totalNet += h.net;
    totalBb += h.bb;
    rakeEst += h.rakeShare;
  }

  // 场次切分：相邻两手间隔 > 60 分钟为新场次
  const sessions = [];
  let cur = null;
  let prev = null;
  for (const h of hands) {
    if (prev && (h.ts - prev) / 1000 > 3600 && cur) {
      sessions.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: h.ts, end: h.ts, hands: 0, net: 0, bb: 0 };
    cur.end = h.ts;
    cur.hands += 1;
    cur.net += h.net;
    cur.bb += h.bb;
    prev = h.ts;
  }
  if (cur) sessions.push(cur);

  let playMin = 0;
  const sessOut = sessions.map((s) => {
    const mins = Math.max((s.end - s.start) / 60000, 1);
    playMin += mins;
    return {
      date: mmdd(s.start),
      start: hhmm(s.start),
      end: hhmm(s.end),
      hands: s.hands,
      hours: pyRound(mins / 60, 2),
      net: pyRound(s.net, 2),
      bb: pyRound(s.bb, 1),
    };
  });

  const stAll = blank();
  const stPos = Object.fromEntries(POS_ORDER.map((p) => [p, blank()]));
  const stStk = new Map();
  for (const h of hands) {
    add(stAll, h);
    if (h.pos in stPos) add(stPos[h.pos], h);
    if (!stStk.has(h.stakes)) stStk.set(h.stakes, blank());
    add(stStk.get(h.stakes), h);
  }

  const byDay = new Map();
  for (const h of hands) {
    const d = h.tsText.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, { hands: 0, net: 0, stk: {} });
    const e = byDay.get(d);
    e.hands += 1;
    e.net += h.net;
    e.stk[h.stakes] = (e.stk[h.stakes] || 0) + h.net;
  }

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, hands: 0, net: 0 }));
  for (const h of hands) {
    const e = byHour[h.ts.getHours()];
    e.hands += 1;
    e.net += h.net;
  }

  const groups = new Map();
  for (const h of hands) {
    if (!h.cards) continue;
    const e = groups.get(h.hg) || [0, 0, 0];
    e[0] += 1;
    e[1] += h.net;
    e[2] += h.bb;
    groups.set(h.hg, e);
  }

  const potinfo = (h) => ({
    ts: `${mmdd(h.ts)} ${hhmm(h.ts)}`,
    stakes: h.stakes,
    cards: h.cards ? h.cards.slice(0, 2) + ' ' + h.cards.slice(2) : '',
    board: h.board,
    net: pyRound(h.net, 2),
    pos: h.pos,
  });

  // 累计曲线，每 25 手取一个点
  const STEP = 25;
  const cumX = [];
  const cumAll = [];
  const cumSd = [];
  const cumNsd = [];
  const cumBb = {};
  let cAll = 0;
  let cSd = 0;
  let cNsd = 0;
  const cBb = {};
  hands.forEach((h, idx0) => {
    const idx = idx0 + 1;
    const isSd = h.sd && h.heroFoldedStreet === null;
    cAll += h.net;
    if (isSd) cSd += h.net;
    else cNsd += h.net;
    cBb[h.stakes] = (cBb[h.stakes] || 0) + h.bb;
    if (idx % STEP === 0 || idx === total) {
      cumX.push(idx);
      cumAll.push(pyRound(cAll, 2));
      cumSd.push(pyRound(cSd, 2));
      cumNsd.push(pyRound(cNsd, 2));
      for (const k of Object.keys(cBb)) {
        (cumBb[k] ||= []).push(pyRound(cBb[k], 1));
      }
    }
  });

  const stakesSorted = [...stStk.keys()].sort();
  const byStakes = {};
  for (const k of stakesSorted) byStakes[k] = fin(stStk.get(k));

  const wins = hands.filter((h) => h.net > 0).sort((a, b) => b.net - a.net).slice(0, 10);
  const losses = hands.filter((h) => h.net < 0).sort((a, b) => a.net - b.net).slice(0, 10);

  return {
    meta: {
      player: playerFrom(sources),
      sources,
      date_from: hands[0].tsText.slice(0, 10),
      date_to: hands[total - 1].tsText.slice(0, 10),
      generated: (() => {
        const d = new Date();
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm(d)}`;
      })(),
      min_hands: minHands,
      dropped,
      filters,
    },
    overview: {
      hands: total,
      net: pyRound(totalNet, 2),
      bb: pyRound(totalBb, 1),
      bb100: total ? pyRound((totalBb / total) * 100, 1) : 0,
      rake_est: pyRound(rakeEst, 2),
      sessions: sessions.length,
      play_hours: pyRound(playMin / 60, 1),
      hands_per_hour: playMin ? pyRound((total / playMin) * 60, 1) : 0,
    },
    overall: fin(stAll),
    by_stakes: byStakes,
    by_pos: Object.fromEntries(POS_ORDER.map((p) => [p, fin(stPos[p])])),
    by_day: [...byDay].map(([date, v]) => ({
      date,
      hands: v.hands,
      net: pyRound(v.net, 2),
      stk: Object.fromEntries(Object.entries(v.stk).map(([k, x]) => [k, pyRound(x, 2)])),
    })),
    by_hour: byHour.map((e) => ({ ...e, net: pyRound(e.net, 2) })),
    groups: Object.fromEntries(
      [...groups].map(([g, e]) => [g, { hands: e[0], net: pyRound(e[1], 2), bb100: pyRound((e[2] / e[0]) * 100, 1) }])
    ),
    top_wins: wins.map(potinfo),
    top_losses: losses.map(potinfo),
    sessions: sessOut,
    cumulative: { x: cumX, all: cumAll, sd: cumSd, nsd: cumNsd, bb: cumBb },
    stakes: stakesSorted,
  };
}
