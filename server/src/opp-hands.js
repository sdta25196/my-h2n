// GET /api/opp-hands：把某个对手当成 Hero 的逐手复盘（服务端 SQL 筛选 + 分页 + 汇总条）
//
// 与 /api/hands 的关系：
//   * 筛选参数名、响应字段名逐个对齐，前端可以照抄 review.js
//   * GROUP_SQL / FLOP_SQL / SEQ_SQL / HA_STREETS 从 hands.js 原样导入复用
//   * 两处口径差异（文档里也记了）：
//       1. 没有 sp（splash）—— 对手牌谱格式里不存在这项
//       2. summary.sawFlop 用玩家级 saw_flop（真的进了翻牌），
//          而不是 Hero 侧的 st >= 1（那是「牌局走到了翻牌」）
//
// SQL 里的列前缀规矩（opp_player_hands p JOIN opp_hands h USING (hand_id)）：
//   两张表都有的 file_id / ts / ts_text / stakes / bb_cents 必须写 p. 或 h.，
//   其余列各只出现在一边，裸名即可 —— 这正是能复用 hands.js 那四组片段的前提。
import { GROUP_SQL, FLOP_SQL, SEQ_SQL, HA_STREETS } from './hands.js';

const SORTABLE = { t: 'p.ts', potbb: 'pot_bb', net: 'net_cents', bb: 'net_bb' };

const DERIVED = `
  CAST(pot_cents AS REAL) / p.bb_cents AS pot_bb,
  CAST(net_cents AS REAL) / p.bb_cents AS net_bb`;

const FROM = 'opp_player_hands p JOIN opp_hands h USING (hand_id)';

// 翻后位置：只算单挑池（进翻 2 人且本人进了翻牌）
// flop_first 是解析时直接标好的「翻牌第一个动作是不是自己」，单挑池里先说话 = OOP
const HU = 'nf = 2 AND saw_flop = 1';

function buildWhere(q) {
  const player = (q.get('player') || '').trim();
  if (!player) throw new Error('缺少 player 参数');

  const w = ['p.player = ?'];
  const args = [player];
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
    w.push(`p.stakes IN (${stakes.map(() => '?').join(',')})`);
    args.push(...stakes);
  }
  const pos = list('pos');
  if (pos.length) {
    w.push(`pos IN (${pos.map(() => '?').join(',')})`);
    args.push(...pos.map(Number));
  }
  const hid = list('hid').map((s) => s.replace(/^#+/, ''));
  if (hid.length) {
    w.push(`hand_id IN (${hid.map(() => '?').join(',')})`);
    args.push(...hid);
  }
  if (q.get('from')) {
    w.push('p.ts_text >= ?');
    args.push(q.get('from') + ' 00:00:00');
  }
  if (q.get('to')) {
    w.push('p.ts_text <= ?');
    args.push(q.get('to') + ' 23:59:59');
  }
  const h1 = num('h1');
  const h2 = num('h2');
  if (h1 !== null && h2 !== null && !(h1 === 0 && h2 === 23)) {
    const hourCol = 'CAST(substr(p.ts_text, 12, 2) AS INTEGER)';
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
  // 进攻方 / 防守方：解析时已按 Hero 侧同口径落成 pf_agg / pf_def 两列
  const agg = q.get('agg');
  if (agg === '1') w.push('pf_agg = 1');
  else if (agg === '0') w.push('pf_agg = 0');
  const def = q.get('def');
  if (def === '1') w.push('pf_def = 1');
  else if (def === '0') w.push('pf_def = 0');
  // 4bet+：做过「之前已有 >= 2 次加注」的加注（覆盖开池被 3bet 后再 4bet 的手）
  const h4b = q.get('h4b');
  if (h4b === '1') w.push('pf4b = 1');
  else if (h4b === '0') w.push('pf4b = 0');

  const join = q.get('join');
  if (join === 'yes') w.push("pa <> 'F'");
  else if (join === 'no') w.push("pa = 'F'");

  eq('f3', 'f3b_opp');
  eq('st', 'h.st');
  const ha = q.get('ha');
  if (ha && ha !== 'any') {
    if (!SEQ_SQL[ha]) throw new Error('未知的街道动作: ' + ha);
    const hs = num('hs');
    if (hs !== null && !HA_STREETS[hs]) throw new Error('动作街道超出范围: ' + hs);
    const streets = hs === null ? Object.values(HA_STREETS) : [HA_STREETS[hs]];
    w.push(`(${streets.map((s) => `(${SEQ_SQL[ha](s)})`).join(' OR ')})`);
  }
  const ip = q.get('ip');
  if (ip === 'ip') w.push(`${HU} AND flop_first = 0`);
  else if (ip === 'oop') w.push(`${HU} AND flop_first = 1`);
  eq('sd', 'h.sd');
  eq('ai', 'allin');
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

  // 底牌类筛选只对摊牌过的手有效（源数据里没摊牌就没有底牌），未摊牌的手会被这些条件筛掉
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
    w.push('instr(upper(opp_cards), ?) > 0');
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
    w.push('CAST(net_cents AS REAL) / p.bb_cents >= ?');
    args.push(bbMin);
  }
  if (bbMax !== null) {
    w.push('CAST(net_cents AS REAL) / p.bb_cents <= ?');
    args.push(bbMax);
  }
  if (potMin !== null) {
    w.push('CAST(pot_cents AS REAL) / p.bb_cents >= ?');
    args.push(potMin);
  }
  if (potMax !== null) {
    w.push('CAST(pot_cents AS REAL) / p.bb_cents <= ?');
    args.push(potMax);
  }
  const fileId = num('fileId');
  if (fileId !== null) {
    w.push('p.file_id = ?');
    args.push(fileId);
  }

  return { player, sql: 'WHERE ' + w.join(' AND '), args };
}

// 本页手牌的同桌清单：真实用户名的动作流靠它才读得懂谁在什么位置
function seatmates(db, ids) {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT hand_id, player, pos, net_cents
         FROM opp_player_hands
        WHERE hand_id IN (${ids.map(() => '?').join(',')})
        ORDER BY seat`
    )
    .all(...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.hand_id)) map.set(r.hand_id, []);
    map.get(r.hand_id).push({ n: r.player, pos: Number(r.pos), net: Number(r.net_cents) / 100 });
  }
  return map;
}

export function queryOppHands(db, q) {
  const { player, sql: where, args } = buildWhere(q);
  const per = Math.min(Math.max(Number(q.get('per')) || 100, 1), 500);
  const page = Math.max(Number(q.get('page')) || 1, 1);
  const sortKey = SORTABLE[q.get('sort')] || 'p.ts';
  const dir = (q.get('dir') || (sortKey === 'p.ts' ? 'desc' : 'asc')).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const sum = db
    .prepare(
      `SELECT COUNT(*) AS hands,
              COALESCE(SUM(net_cents), 0) AS net_cents,
              COALESCE(SUM(CAST(net_cents AS REAL) / p.bb_cents), 0) AS net_bb,
              COALESCE(SUM(vpip), 0) AS vpip,
              COALESCE(SUM(pfr), 0) AS pfr,
              COALESCE(SUM(saw_flop), 0) AS saw_flop,
              COALESCE(SUM(sdw IS NOT NULL), 0) AS showdowns,
              COALESCE(SUM(sdw = 1), 0) AS showdown_wins,
              COALESCE(SUM(allin), 0) AS allins
         FROM ${FROM} ${where}`
    )
    .get(...args);

  const rows = db
    .prepare(
      `SELECT hand_id, p.ts AS ts, p.ts_text AS ts_text, p.stakes AS stakes, blinds, pos,
              cards, hand_group, pa, rba, rn, f3b_opp, h.st AS st, h.sd AS sd, sdw, allin, nf,
              pot_cents, net_cents, inv_cents, col_cents, rake_cents,
              flop, turn, river, opp_cards, act, ${DERIVED}
         FROM ${FROM} ${where}
        ORDER BY ${sortKey} ${dir}, p.ts DESC
        LIMIT ? OFFSET ?`
    )
    .all(...args, per, (page - 1) * per);

  const mates = seatmates(db, rows.map((r) => r.hand_id));
  const playerTotal = Number(
    db.prepare('SELECT COUNT(*) AS n FROM opp_player_hands WHERE player = ?').get(player).n
  );

  const n = Number(sum.hands);
  const pct = (x) => (n ? (100 * Number(x)) / n : null);
  return {
    player,
    page,
    per,
    total: n,
    pages: Math.max(1, Math.ceil(n / per)),
    playerTotal,
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
      f3: Number(r.f3b_opp),
      st: Number(r.st),
      sd: Number(r.sd),
      sdw: r.sdw === null ? null : Number(r.sdw),
      ai: Number(r.allin),
      nf: Number(r.nf),
      pot: Number(r.pot_cents) / 100,
      potbb: Math.round(Number(r.pot_bb) * 10) / 10,
      net: Number(r.net_cents) / 100,
      bb: Math.round(Number(r.net_bb) * 100) / 100,
      inv: Number(r.inv_cents) / 100,
      col: Number(r.col_cents) / 100,
      rk: Number(r.rake_cents) / 100,
      fl: r.flop,
      tu: r.turn,
      ri: r.river,
      opp: r.opp_cards,
      act: r.act,
      ps: mates.get(r.hand_id) || [],
    })),
  };
}
