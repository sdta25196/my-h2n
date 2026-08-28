// GET /api/opponents：对手 HUD 指标聚合（筛选 / 排序 / 分页全部下推到 SQL）
//
// 全部指标都是 SUM(分子) / SUM(分母) 的形式，所以一条 GROUP BY player 就够，
// 19 万行全量约 0.1s。分母为 0 时返回 null，前端渲染成 '—'（别拿 0 冒充「没数据」）。
//
// 口径（与常见 HUD 一致，定义写在 opp-parser.js 的状态机里）：
//   VPIP  主动入池 / 总手数            PFR   翻前加注 / 总手数
//   3B    面对单次加注时再加注 / 该机会  F3B   开池被 3bet 后弃牌 / 被 3bet 次数
//   ATS   CO/BTN/SB 无人入池时开池 / 该机会
//   CB    翻前侵略者在翻牌持续下注 / 有此机会
//   FCB   面对持续下注弃牌 / 面对次数
//   WTSD  摊牌 / 看到翻牌            W$SD  摊牌且净赢 / 摊牌
//   WWSF  看到翻牌且净赢 / 看到翻牌    AF    翻后(下注+加注) / 翻后跟注
//   bb100 100 * SUM(净盈亏/bb) / 手数

// 排序白名单：键 -> SQL 表达式（别改成拼接列名，会开注入口子）
const SORTABLE = {
  hands: 'hands',
  player: 'player',
  net: 'net_cents',
  bb100: 'bb100',
  vpip: 'vpip',
  pfr: 'pfr',
  t3b: 't3b',
  f3b: 'f3b',
  steal: 'steal',
  cbet: 'cbet',
  fcb: 'fcb',
  wtsd: 'wtsd',
  wsd: 'wsd',
  wwsf: 'wwsf',
  af: 'af',
};

// 比率列：SQL 里直接算成百分比，分母为 0 时给 NULL
const pct = (num, den) => `CASE WHEN SUM(${den}) > 0 THEN 100.0 * SUM(${num}) / SUM(${den}) ELSE NULL END`;

const SELECT = `
  player,
  COUNT(*) AS hands,
  SUM(net_cents) AS net_cents,
  100.0 * SUM(CAST(net_cents AS REAL) / bb_cents) / COUNT(*) AS bb100,
  ${pct('vpip', '1')} AS vpip,
  ${pct('pfr', '1')} AS pfr,
  ${pct('t3b', 't3b_opp')} AS t3b,
  ${pct('f3b', 'f3b_opp')} AS f3b,
  ${pct('steal', 'steal_opp')} AS steal,
  ${pct('cbet', 'cbet_opp')} AS cbet,
  ${pct('fcb', 'fcb_opp')} AS fcb,
  ${pct('wtsd', 'saw_flop')} AS wtsd,
  ${pct('sd_won', 'wtsd')} AS wsd,
  ${pct('wwsf', 'saw_flop')} AS wwsf,
  CASE WHEN SUM(agg_calls) > 0 THEN CAST(SUM(agg_bets) AS REAL) / SUM(agg_calls) ELSE NULL END AS af,
  SUM(saw_flop) AS saw_flop, SUM(wtsd) AS n_wtsd, SUM(allin) AS n_allin,
  MIN(ts_text) AS first_ts, MAX(ts_text) AS last_ts`;

function buildWhere(q) {
  const w = [];
  const args = [];
  const list = (key) => (q.get(key) || '').split(',').map((s) => s.trim()).filter(Boolean);

  const stakes = list('stakes');
  if (stakes.length) {
    w.push(`stakes IN (${stakes.map(() => '?').join(',')})`);
    args.push(...stakes);
  }
  // 位置筛选让「这人在 BTN 上什么样」这类问题可答；-1 未识别不进选项
  const pos = list('pos').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 5);
  if (pos.length) {
    w.push(`pos IN (${pos.map(() => '?').join(',')})`);
    args.push(...pos);
  }
  // 日期按 ts_text 整天闭区间，口径与 hands.js / report.js 一致
  const from = q.get('from');
  if (from) {
    w.push('ts_text >= ?');
    args.push(from + ' 00:00:00');
  }
  const to = q.get('to');
  if (to) {
    w.push('ts_text <= ?');
    args.push(to + ' 23:59:59');
  }
  // 玩家名模糊搜索；escape 掉 LIKE 的通配符，否则输入 % 会匹配全部
  const name = (q.get('q') || '').trim();
  if (name) {
    w.push("player LIKE ? ESCAPE '\\'");
    args.push('%' + name.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
  }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args };
}

export function queryOpponents(db, q) {
  const { where, args } = buildWhere(q);

  const num = (key, dflt) => {
    const v = q.get(key);
    if (v === null || v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  // 手数门槛在 HAVING 上：样本太小的对手指标全是噪声，默认 30 手
  const minHands = Math.max(1, Math.floor(num('minHands', 30)));
  const per = Math.min(500, Math.max(1, Math.floor(num('per', 50))));
  const page = Math.max(1, Math.floor(num('page', 1)));
  const sort = SORTABLE[q.get('sort')] || 'hands';
  const dir = (q.get('dir') || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const base = `FROM opp_player_hands ${where} GROUP BY player HAVING COUNT(*) >= ?`;
  const gargs = [...args, minHands];

  const cnt = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT player ${base})`).get(...gargs);
  const total = Number(cnt.n);
  const pages = Math.max(1, Math.ceil(total / per));
  const pg = Math.min(page, pages);

  // 比率列可能为 NULL，排序时统一沉底，否则「按 CB 排序」头几名全是没样本的
  const rows = db
    .prepare(
      `SELECT ${SELECT} ${base}
         ORDER BY (${sort} IS NULL), ${sort} ${dir}, hands DESC, player ASC
         LIMIT ? OFFSET ?`
    )
    .all(...gargs, per, (pg - 1) * per)
    .map((r) => ({
      player: r.player,
      hands: Number(r.hands),
      net: Number(r.net_cents) / 100,
      bb100: r.bb100,
      vpip: r.vpip,
      pfr: r.pfr,
      t3b: r.t3b,
      f3b: r.f3b,
      steal: r.steal,
      cbet: r.cbet,
      fcb: r.fcb,
      wtsd: r.wtsd,
      wsd: r.wsd,
      wwsf: r.wwsf,
      af: r.af,
      sawFlop: Number(r.saw_flop),
      nWtsd: Number(r.n_wtsd),
      nAllin: Number(r.n_allin),
      first_ts: r.first_ts,
      last_ts: r.last_ts,
    }));

  // 汇总条：注意这是「行为记录」总量而不是手牌数（一手牌 N 个玩家 = N 条）
  const sum = db
    .prepare(
      `SELECT COUNT(*) AS rows_n, COUNT(DISTINCT player) AS players,
              COUNT(DISTINCT hand_id) AS hands,
              ${pct('vpip', '1')} AS vpip, ${pct('pfr', '1')} AS pfr,
              ${pct('t3b', 't3b_opp')} AS t3b, ${pct('wtsd', 'saw_flop')} AS wtsd
         FROM opp_player_hands ${where}`
    )
    .get(...args);

  return {
    page: pg,
    per,
    total,
    pages,
    minHands,
    filters: {
      stakes: q.get('stakes') || '',
      pos: q.get('pos') || '',
      from: q.get('from') || '',
      to: q.get('to') || '',
      q: q.get('q') || '',
    },
    summary: {
      rows: Number(sum.rows_n),
      players: Number(sum.players),
      hands: Number(sum.hands),
      vpip: sum.vpip,
      pfr: sum.pfr,
      t3b: sum.t3b,
      wtsd: sum.wtsd,
    },
    rows,
  };
}
