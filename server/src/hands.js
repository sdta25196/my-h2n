// GET /api/hands：服务端 SQL 筛选 + 分页 + 汇总条
// 汇总口径与 hand_browser.py 的 summary() 一致（手数/净盈亏/bb100/VPIP/PFR/进翻率/W$SD/全下率）
const SORTABLE = { t: 'ts', potbb: 'pot_bb', net: 'net_cents', bb: 'net_bb' };

// 列表与汇总共用的派生列
const DERIVED = `
  CAST(pot_cents AS REAL) / bb_cents AS pot_bb,
  CAST(net_cents AS REAL) / bb_cents AS net_bb`;

// 起手牌分组：hand_group 形如 'AKs' / 'QQ' / 'J7o'
// r1/r2 用 instr 取牌力序号（1=2 … 13=A），suited 看末位是否 's'
const R1 = "instr('23456789TJQKA', substr(hand_group, 1, 1))";
const R2 = "instr('23456789TJQKA', substr(hand_group, 2, 1))";
const PAIR = 'length(hand_group) = 2';
const SUITED = "substr(hand_group, 3, 1) = 's'";
const BRDY = "instr('TJQKA', substr(hand_group, 1, 1)) > 0 AND instr('TJQKA', substr(hand_group, 2, 1)) > 0";
const GROUP_SQL = {
  pair: PAIR,
  brdy: `NOT ${PAIR} AND ${BRDY}`,
  bs: `NOT ${PAIR} AND ${BRDY} AND ${SUITED}`,
  bo: `NOT ${PAIR} AND ${BRDY} AND NOT ${SUITED}`,
  conn: `NOT ${PAIR} AND ${SUITED} AND abs(${R1} - ${R2}) = 1`,
  gap1: `NOT ${PAIR} AND ${SUITED} AND abs(${R1} - ${R2}) = 2`,
  axs: `NOT ${PAIR} AND ${SUITED} AND substr(hand_group, 1, 1) = 'A'`,
};

function buildWhere(q) {
  const w = [];
  const args = [];
  const list = (key) => (q.get(key) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const num = (key) => {
    const v = q.get(key);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const eq = (key, col) => {
    const v = q.get(key);
    if (v !== null && v !== '' && v !== 'any') {
      w.push(`${col} = ?`);
      args.push(Number(v));
    }
  };

  const stakes = list('stakes');
  if (stakes.length) {
    w.push(`stakes IN (${stakes.map(() => '?').join(',')})`);
    args.push(...stakes);
  }
  const pos = list('pos');
  if (pos.length) {
    w.push(`pos IN (${pos.map(() => '?').join(',')})`);
    args.push(...pos.map(Number));
  }
  if (q.get('from')) {
    w.push('ts_text >= ?');
    args.push(q.get('from') + ' 00:00:00');
  }
  if (q.get('to')) {
    w.push('ts_text <= ?');
    args.push(q.get('to') + ' 23:59:59');
  }
  const h1 = num('h1');
  const h2 = num('h2');
  if (h1 !== null && h2 !== null && !(h1 === 0 && h2 === 23)) {
    const hourCol = 'CAST(substr(ts_text, 12, 2) AS INTEGER)';
    // 小时区间可跨天，如 21 ~ 6
    w.push(h1 <= h2 ? `${hourCol} BETWEEN ? AND ?` : `(${hourCol} >= ? OR ${hourCol} <= ?)`);
    args.push(h1, h2);
  }

  const pa = q.get('pa');
  if (pa && pa !== 'any') {
    w.push('pa = ?');
    args.push(pa);
  }
  const rt = q.get('rt');
  if (rt && rt !== 'any') {
    w.push("pa = 'R'");
    if (rt === 'open') w.push('rn = 0');
    else if (rt === '3b') w.push('rn = 1');
    else if (rt === '4b') w.push('rn >= 2');
  }
  const fc = q.get('fc');
  if (fc === 'open') w.push('rba >= 1');
  else if (fc === 'un') w.push('rba = 0');

  const join = q.get('join');
  if (join === 'yes') w.push("pa <> 'F'");
  else if (join === 'no') w.push("pa = 'F'");

  eq('f3', 'faced_3bet');
  eq('st', 'st');
  eq('sd', 'sd');
  eq('ai', 'ai');
  const sdw = q.get('sdw');
  if (sdw && sdw !== 'any') {
    w.push('sdw = ?');
    args.push(Number(sdw));
  }
  const nf = num('nf');
  if (nf !== null) {
    w.push(nf >= 4 ? 'nf >= 4' : 'nf = ?');
    if (nf < 4) args.push(nf);
  }

  const cards = (q.get('cards') || '').trim().toUpperCase();
  if (cards) {
    const toks = cards.split(/[,;，\s]+/).filter(Boolean);
    const ors = [];
    for (const tok of toks) {
      if (tok.length === 4) {
        ors.push('upper(cards) = ?');
        args.push(tok);
      } else if (tok.length === 3) {
        ors.push('upper(hand_group) = ?');
        args.push(tok);
      } else if (tok.length === 2) {
        if (tok[0] === tok[1]) {
          ors.push('upper(hand_group) = ?');
          args.push(tok);
        } else {
          ors.push('substr(upper(hand_group), 1, 2) = ?');
          args.push(tok);
        }
      }
    }
    w.push(ors.length ? `(${ors.join(' OR ')})` : '0');
  }
  const grp = q.get('grp');
  if (grp && grp !== 'any') {
    if (!GROUP_SQL[grp]) throw new Error('未知的起手牌分组: ' + grp);
    w.push(`hand_group <> '' AND (${GROUP_SQL[grp]})`);
  }
  const opp = (q.get('opp') || '').trim().toUpperCase();
  if (opp) {
    w.push('instr(upper(opp), ?) > 0');
    args.push(opp);
  }

  const res = q.get('res');
  if (res === 'win') w.push('net_cents > 0');
  else if (res === 'lose') w.push('net_cents < 0');

  const bbMin = num('bbMin');
  const bbMax = num('bbMax');
  const potMin = num('potMin');
  const potMax = num('potMax');
  if (bbMin !== null) {
    w.push('CAST(net_cents AS REAL) / bb_cents >= ?');
    args.push(bbMin);
  }
  if (bbMax !== null) {
    w.push('CAST(net_cents AS REAL) / bb_cents <= ?');
    args.push(bbMax);
  }
  if (potMin !== null) {
    w.push('CAST(pot_cents AS REAL) / bb_cents >= ?');
    args.push(potMin);
  }
  if (potMax !== null) {
    w.push('CAST(pot_cents AS REAL) / bb_cents <= ?');
    args.push(potMax);
  }
  const fileId = num('fileId');
  if (fileId !== null) {
    w.push('file_id = ?');
    args.push(fileId);
  }

  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', args };
}

export function queryHands(db, q) {
  const { sql: where, args } = buildWhere(q);
  const per = Math.min(Math.max(Number(q.get('per')) || 100, 1), 500);
  const page = Math.max(Number(q.get('page')) || 1, 1);
  const sortKey = SORTABLE[q.get('sort')] || 'ts';
  const dir = (q.get('dir') || (sortKey === 'ts' ? 'desc' : 'asc')).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const sum = db
    .prepare(
      `SELECT COUNT(*) AS hands,
              COALESCE(SUM(net_cents), 0) AS net_cents,
              COALESCE(SUM(CAST(net_cents AS REAL) / bb_cents), 0) AS net_bb,
              COALESCE(SUM(pa IN ('C','R')), 0) AS vpip,
              COALESCE(SUM(pa = 'R'), 0) AS pfr,
              COALESCE(SUM(st >= 1), 0) AS saw_flop,
              COALESCE(SUM(sdw IS NOT NULL), 0) AS showdowns,
              COALESCE(SUM(sdw = 1), 0) AS showdown_wins,
              COALESCE(SUM(ai), 0) AS allins
         FROM hands ${where}`
    )
    .get(...args);

  const rows = db
    .prepare(
      `SELECT hand_id, ts, ts_text, stakes, blinds, pos, cards, hand_group,
              pa, rba, rn, faced_3bet, st, sd, sdw, ai, nf,
              pot_cents, net_cents, inv_cents, col_cents, rake_cents, splash_drop_cents,
              flop, turn, river, opp, act, ${DERIVED}
         FROM hands ${where}
        ORDER BY ${sortKey} ${dir}, ts DESC
        LIMIT ? OFFSET ?`
    )
    .all(...args, per, (page - 1) * per);

  const n = Number(sum.hands);
  const pct = (x) => (n ? (100 * Number(x)) / n : null);
  return {
    page,
    per,
    total: n,
    pages: Math.max(1, Math.ceil(n / per)),
    summary: {
      hands: n,
      net: Number(sum.net_cents) / 100,
      bb100: n ? (Number(sum.net_bb) / n) * 100 : null,
      vpip: pct(sum.vpip),
      pfr: pct(sum.pfr),
      sawFlop: pct(sum.saw_flop),
      showdowns: Number(sum.showdowns),
      wsd: Number(sum.showdowns) ? (100 * Number(sum.showdown_wins)) / Number(sum.showdowns) : null,
      allin: pct(sum.allins),
    },
    rows: rows.map((r) => ({
      id: r.hand_id,
      t: Number(r.ts),
      ts: r.ts_text,
      lv: r.stakes,
      bl: r.blinds,
      pos: Number(r.pos),
      cd: r.cards,
      hg: r.hand_group,
      pa: r.pa,
      rba: Number(r.rba),
      rn: r.rn === null ? null : Number(r.rn),
      f3: Number(r.faced_3bet),
      st: Number(r.st),
      sd: Number(r.sd),
      sdw: r.sdw === null ? null : Number(r.sdw),
      ai: Number(r.ai),
      nf: Number(r.nf),
      pot: Number(r.pot_cents) / 100,
      potbb: Math.round(Number(r.pot_bb) * 10) / 10,
      net: Number(r.net_cents) / 100,
      bb: Math.round(Number(r.net_bb) * 100) / 100,
      inv: Number(r.inv_cents) / 100,
      col: Number(r.col_cents) / 100,
      rk: Number(r.rake_cents) / 100,
      sp: Number(r.splash_drop_cents) / 100,
      fl: r.flop,
      tu: r.turn,
      ri: r.river,
      opp: r.opp,
      act: r.act,
    })),
  };
}
