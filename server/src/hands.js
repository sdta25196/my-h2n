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

// 逐街 Hero 动作：seq_json 形如 {"flop":["check","call"],...}，按街存 Hero 的动作序列
// 只看翻后三街（翻前用「翻前」分组里的 pa 口径），下标与 st 列同一套编码
// 一条街上 check 只可能出现在首位，所以「是否先过牌」看前缀、动作归类看最后一个动作
// 八个选项 =（先过牌 or 没先过牌）×（最后 check/bet/raise/call/fold），两两互斥且覆盖全部有动作的街
const HA_STREETS = { 1: 'flop', 2: 'turn', 3: 'river' };
const SEQ = (s) => `json_extract(seq_json, '$.${s}')`;
const CK = (s) => `${SEQ(s)} LIKE '["check"%'`;
const END = (s, kind) => `${SEQ(s)} LIKE '%"${kind}"]'`;
const SEQ_SQL = {
  ck: (s) => `${CK(s)} AND ${END(s, 'check')}`,
  ckr: (s) => `${CK(s)} AND ${END(s, 'raise')}`,
  ckc: (s) => `${CK(s)} AND ${END(s, 'call')}`,
  ckf: (s) => `${CK(s)} AND ${END(s, 'fold')}`,
  b: (s) => `NOT (${CK(s)}) AND ${END(s, 'bet')}`,
  r: (s) => `NOT (${CK(s)}) AND ${END(s, 'raise')}`,
  c: (s) => `NOT (${CK(s)}) AND ${END(s, 'call')}`,
  f: (s) => `NOT (${CK(s)}) AND ${END(s, 'fold')}`,
};

// 翻后位置：只算单挑池（进翻 2 人且 Hero 进了翻牌），多人池一律排除
// act 形如 "翻前段|翻牌段|转牌段|河牌段"，段内是 "H x P2 b0.75 …"；单挑池翻后先说话的就是 OOP
// 取翻牌段头两个字符：'H ' = Hero 先说话（OOP），'P#' = 对手先说话（IP）
const HU = 'nf = 2 AND saw_flop = 1';
const FLOP_HEAD = "substr(act, instr(act, '|') + 1, 2)";

// 翻牌面牌型：flop 形如 'As Kd 2c'，三张牌固定落在第 1/4/7 位（run it twice 只看第一个牌面）
// FR 取牌力序号（1=2 … 9=T … 13=A），FS 取花色字母；无翻牌的手 flop 为空串，靠 length 兜掉
const FR = (i) => `instr('23456789TJQKA', substr(flop, ${i * 3 + 1}, 1))`;
const FS = (i) => `substr(flop, ${i * 3 + 2}, 1)`;
const F_MONO = `${FS(0)} = ${FS(1)} AND ${FS(1)} = ${FS(2)}`;
const F_RB = `${FS(0)} <> ${FS(1)} AND ${FS(0)} <> ${FS(2)} AND ${FS(1)} <> ${FS(2)}`;
const F_TRIPS = `${FR(0)} = ${FR(1)} AND ${FR(1)} = ${FR(2)}`;
const F_DIST = `${FR(0)} <> ${FR(1)} AND ${FR(0)} <> ${FR(2)} AND ${FR(1)} <> ${FR(2)}`;
// 高张 = T~A（序号 >= 9），布尔相加得高张张数；三小 = 三张都 <= 9
const F_HI = `((${FR(0)} >= 9) + (${FR(1)} >= 9) + (${FR(2)} >= 9))`;
// 天顺面 = 三连张（已可能成顺）：点数互不相同且极差为 2；A23 按轮子另算（1+2+13=16 唯一）
const F_MAX = `max(${FR(0)}, ${FR(1)}, ${FR(2)})`;
const F_MIN = `min(${FR(0)}, ${FR(1)}, ${FR(2)})`;
const F_WHEEL = `${F_MIN} = 1 AND ${F_MAX} = 13 AND ${FR(0)} + ${FR(1)} + ${FR(2)} = 16`;
const FLOP_SQL = {
  mono: F_MONO,
  two: `NOT (${F_MONO}) AND NOT (${F_RB})`,
  rb: F_RB,
  str: `(${F_DIST} AND ${F_MAX} - ${F_MIN} = 2) OR (${F_WHEEL})`,
  hi3: `${F_HI} = 3`,
  hi2: `${F_HI} = 2`,
  hi1: `${F_HI} = 1`,
  lo3: `${F_HI} = 0`,
  pair: `NOT (${F_TRIPS}) AND (${FR(0)} = ${FR(1)} OR ${FR(0)} = ${FR(2)} OR ${FR(1)} = ${FR(2)})`,
  trips: F_TRIPS,
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
  // 手牌编号：逗号分隔多个，容忍 "#123456" 写法
  const hid = list('hid').map((s) => s.replace(/^#+/, ''));
  if (hid.length) {
    w.push(`hand_id IN (${hid.map(() => '?').join(',')})`);
    args.push(...hid);
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
  // 翻前最后加注者口径：进攻方 = Hero 带着主动权进翻牌；防守方 = 对手加注、Hero 跟下来防守
  // 无人加注的 limp 池 street_agg_json 里没有 preflop 键，两边都不算
  const PFA = "json_extract(street_agg_json, '$.preflop')";
  const DEF = `${PFA} IS NOT NULL AND ${PFA} <> 'Hero' AND pa <> 'F'`;
  const agg = q.get('agg');
  if (agg === '1') w.push(`${PFA} = 'Hero'`);
  else if (agg === '0') w.push(`COALESCE(${PFA}, '') <> 'Hero'`);
  const def = q.get('def');
  if (def === '1') w.push(DEF);
  else if (def === '0') w.push(`NOT (${DEF})`);

  const join = q.get('join');
  if (join === 'yes') w.push("pa <> 'F'");
  else if (join === 'no') w.push("pa = 'F'");

  eq('f3', 'faced_3bet');
  eq('st', 'st');
  // 逐街 Hero 动作：hs 指定看哪一街（与「到达街道」st 无关），不给则翻后任一街命中即可
  const ha = q.get('ha');
  if (ha && ha !== 'any') {
    if (!SEQ_SQL[ha]) throw new Error('未知的 Hero 街道动作: ' + ha);
    const hs = num('hs');
    if (hs !== null && !HA_STREETS[hs]) throw new Error('Hero 动作街道超出范围: ' + hs);
    const streets = hs === null ? Object.values(HA_STREETS) : [HA_STREETS[hs]];
    w.push(`(${streets.map((s) => `(${SEQ_SQL[ha](s)})`).join(' OR ')})`);
  }
  const ip = q.get('ip');
  if (ip === 'ip') w.push(`${HU} AND ${FLOP_HEAD} LIKE 'P%'`);
  else if (ip === 'oop') w.push(`${HU} AND ${FLOP_HEAD} = 'H '`);
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
  // 翻牌面牌型：多选之间是「或」，且只保留发出了翻牌的手
  const fb = list('fb');
  if (fb.length) {
    const ors = fb.map((k) => {
      if (!FLOP_SQL[k]) throw new Error('未知的翻牌面牌型: ' + k);
      return `(${FLOP_SQL[k]})`;
    });
    w.push(`length(flop) >= 8 AND (${ors.join(' OR ')})`);
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
