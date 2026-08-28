// 对手牌谱的 sqlite 层：schema + 批量写入器
//
// 两张表：
//   opp_hands         一手一行（35k 量级），主键 hand_id，负责手牌级去重与库存概要
//   opp_player_hands  一手一人一行（19 万量级），主键 (hand_id, player)
//
// opp_player_hands 刻意把 ts / stakes / bb_cents / pos 冗余进来：
// /api/opponents 的聚合只扫这一张表，不用和 opp_hands join —— 19 万行 GROUP BY 才是秒内。
// 表尾那段「复盘明细」列（cards / pa / rn / seq_json …）只给 /api/opp-hands 用，
// 加列时记得三处一起改：OPP_SCHEMA、INSERT_OPP_PLAYER、writer 里的 stP.run() 实参。
//
// 去重与 Hero 侧同构（不变量 4）：文件级仍复用 upload_files.sha256，
// 手牌级用 INSERT OR IGNORE；opp_hands 没插进去（说明这手已在库里）就跳过它的玩家行。
import { POS_ORDER } from './parser.js';

export const OPP_SCHEMA = `
CREATE TABLE IF NOT EXISTS opp_hands (
  hand_id     TEXT PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES upload_files(id),
  ts          INTEGER NOT NULL,   -- 分钟戳
  ts_text     TEXT NOT NULL,      -- 'YYYY-MM-DD HH:MM:SS'，供 SQL 日期筛选
  stakes      TEXT NOT NULL,
  blinds      TEXT NOT NULL,
  sb_cents    INTEGER NOT NULL,
  bb_cents    INTEGER NOT NULL,
  ante_cents  INTEGER NOT NULL,
  table_name  TEXT NOT NULL,
  seats       INTEGER NOT NULL,   -- 在座人数
  nf          INTEGER NOT NULL,   -- 进翻人数
  pot_cents   INTEGER NOT NULL,
  rake_cents  INTEGER NOT NULL,
  flop        TEXT NOT NULL,
  turn        TEXT NOT NULL,
  river       TEXT NOT NULL,
  st          INTEGER NOT NULL DEFAULT 0,  -- 到达的最后一街 0..3（手牌级，与 Hero 侧同口径）
  sd          INTEGER NOT NULL DEFAULT 0,  -- 本手是否走到摊牌
  act         TEXT NOT NULL DEFAULT '',    -- 动作流，四街以 | 连接，段内「真实用户名 动作码」交替
  check_ok    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS opp_player_hands (
  hand_id     TEXT NOT NULL,
  player      TEXT NOT NULL,
  file_id     INTEGER NOT NULL,

  ts          INTEGER NOT NULL,
  ts_text     TEXT NOT NULL,
  stakes      TEXT NOT NULL,
  bb_cents    INTEGER NOT NULL,
  pos         INTEGER NOT NULL,   -- POS_ORDER 下标，-1 未识别

  inv_cents   INTEGER NOT NULL,
  col_cents   INTEGER NOT NULL,
  net_cents   INTEGER NOT NULL,

  -- 翻前：xxx_opp 是分母（有没有这个机会），xxx 是分子（做了没有）
  vpip        INTEGER NOT NULL,
  pfr         INTEGER NOT NULL,
  t3b_opp     INTEGER NOT NULL,
  t3b         INTEGER NOT NULL,
  f3b_opp     INTEGER NOT NULL,
  f3b         INTEGER NOT NULL,
  steal_opp   INTEGER NOT NULL,
  steal       INTEGER NOT NULL,

  -- 翻后
  saw_flop    INTEGER NOT NULL,
  wtsd        INTEGER NOT NULL,
  sd_won      INTEGER NOT NULL,
  wwsf        INTEGER NOT NULL,
  cbet_opp    INTEGER NOT NULL,
  cbet        INTEGER NOT NULL,
  fcb_opp     INTEGER NOT NULL,
  fcb         INTEGER NOT NULL,
  agg_bets    INTEGER NOT NULL,   -- 翻后 bet + raise 次数
  agg_calls   INTEGER NOT NULL,   -- 翻后 call 次数

  allin         INTEGER NOT NULL,
  folded_street TEXT,

  -- 逐手复盘明细（/api/opp-hands 用；口径照 Hero 侧的同名列，好让 hands.js 的筛选 SQL 原样复用）
  seat        INTEGER NOT NULL DEFAULT 0,
  cards       TEXT NOT NULL DEFAULT '',   -- 被亮出的底牌 'AhKd'，未摊牌为空串
  hand_group  TEXT NOT NULL DEFAULT '',   -- 'AKs' / 'QQ' / 'J7o'
  opp_cards   TEXT NOT NULL DEFAULT '',   -- 同桌其他人亮出的牌
  pa          TEXT NOT NULL DEFAULT 'X',  -- 翻前首个动作 F/C/R/X
  rn          INTEGER,                    -- 自己首次加注的层级：0 开池 / 1 3bet / 2 4bet…
  rba         INTEGER NOT NULL DEFAULT 0, -- 首次决策前的加注数
  pf4b        INTEGER NOT NULL DEFAULT 0,
  pf_agg      INTEGER NOT NULL DEFAULT 0, -- 自己是翻前最后一个加注者
  pf_def      INTEGER NOT NULL DEFAULT 0, -- 别人是侵略者且自己没弃牌
  sdw         INTEGER,                    -- 摊牌结果 1 赢 / 0 输 / 2 平，没到摊牌为 NULL
  flop_first  INTEGER NOT NULL DEFAULT 0, -- 翻牌第一个说话（单挑池即 OOP）
  seq_json    TEXT NOT NULL DEFAULT '{}', -- 自己的逐街动作种类，供 hands.js 的 SEQ_SQL 复用
  PRIMARY KEY (hand_id, player)
);

CREATE INDEX IF NOT EXISTS idx_oph_player ON opp_player_hands(player);
CREATE INDEX IF NOT EXISTS idx_oph_player_ts ON opp_player_hands(player, ts);
CREATE INDEX IF NOT EXISTS idx_oph_ts ON opp_player_hands(ts);
CREATE INDEX IF NOT EXISTS idx_oph_stakes ON opp_player_hands(stakes);
CREATE INDEX IF NOT EXISTS idx_oph_file ON opp_player_hands(file_id);
CREATE INDEX IF NOT EXISTS idx_opp_hands_ts ON opp_hands(ts);
CREATE INDEX IF NOT EXISTS idx_opp_hands_file ON opp_hands(file_id);
`;

const INSERT_OPP_HAND = `INSERT OR IGNORE INTO opp_hands (
  hand_id, file_id, ts, ts_text, stakes, blinds, sb_cents, bb_cents, ante_cents,
  table_name, seats, nf, pot_cents, rake_cents, flop, turn, river, st, sd, act, check_ok
) VALUES (${Array(21).fill('?').join(',')})`;

const INSERT_OPP_PLAYER = `INSERT OR IGNORE INTO opp_player_hands (
  hand_id, player, file_id, ts, ts_text, stakes, bb_cents, pos,
  inv_cents, col_cents, net_cents,
  vpip, pfr, t3b_opp, t3b, f3b_opp, f3b, steal_opp, steal,
  saw_flop, wtsd, sd_won, wwsf, cbet_opp, cbet, fcb_opp, fcb, agg_bets, agg_calls,
  allin, folded_street,
  seat, cards, hand_group, opp_cards, pa, rn, rba, pf4b, pf_agg, pf_def, sdw, flop_first, seq_json
) VALUES (${Array(44).fill('?').join(',')})`;

const pad = (x) => String(x).padStart(2, '0');
const tsText = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * 批量写入器：每 batchSize 手一个事务。用法与 db.js 的 createWriter 一致。
 * 一手牌会写 1 行 opp_hands + N 行 opp_player_hands。
 */
export function createOppWriter(db, fileId, batchSize = 500) {
  const stH = db.prepare(INSERT_OPP_HAND);
  const stP = db.prepare(INSERT_OPP_PLAYER);
  let pending = 0;
  let open = false;
  const stats = { total: 0, inserted: 0, players: 0, checkTotal: 0, checkPassed: 0 };

  const begin = () => {
    if (!open) {
      db.exec('BEGIN');
      open = true;
    }
  };
  const commit = () => {
    if (open) {
      db.exec('COMMIT');
      open = false;
      pending = 0;
    }
  };

  return {
    add(h) {
      begin();
      const min = Math.floor(h.ts.getTime() / 60000);
      const txt = tsText(h.ts);
      stats.total++;
      stats.checkTotal++;
      if (h.checkOk) stats.checkPassed++;

      const r = stH.run(
        h.id, fileId, min, txt, h.stakes, h.blinds, h.sbC, h.bbC, h.anteC,
        h.tableName, h.players.length, h.nf, h.potC, h.rakeC,
        h.board.flop, h.board.turn, h.board.river, h.st, h.sd, h.act, h.checkOk ? 1 : 0
      );
      // 这手已在库里（重叠时段的牌谱），玩家行必然也在，直接跳过省掉 N 次 INSERT
      if (r.changes === 0) {
        if (++pending >= batchSize) commit();
        return;
      }
      stats.inserted++;

      for (const p of h.players) {
        stP.run(
          h.id, p.name, fileId, min, txt, h.stakes, h.bbC, POS_ORDER.indexOf(p.pos),
          p.invC, p.colC, p.netC,
          p.vpip, p.pfr, p.t3bOpp, p.t3b, p.f3bOpp, p.f3b, p.stealOpp, p.steal,
          p.sawFlop, p.wtsd, p.sdWon, p.wwsf, p.cbetOpp, p.cbet, p.fcbOpp, p.fcb,
          p.aggBets, p.aggCalls,
          p.allin, p.foldedStreet,
          p.seat, p.cards, p.handGroup, p.oppCards, p.pa, p.rn, p.rba, p.pf4b,
          p.pfAggFlag, p.pfDef, p.sdw, p.flopFirst, JSON.stringify(p.seq)
        );
        stats.players++;
      }
      if (++pending >= batchSize) commit();
    },
    commit() {
      commit();
      return stats;
    },
    rollback() {
      if (open) {
        db.exec('ROLLBACK');
        open = false;
      }
    },
  };
}

/** 对手库存概要，供上传页药丸和对手页表头用 */
export function oppTotals(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS hands,
              MIN(ts_text) AS first_ts, MAX(ts_text) AS last_ts,
              COUNT(DISTINCT stakes) AS stakes_count,
              SUM(check_ok) AS check_passed
         FROM opp_hands`
    )
    .get();
  const players = Number(db.prepare('SELECT COUNT(DISTINCT player) AS n FROM opp_player_hands').get().n);
  const byStakes = db
    .prepare('SELECT stakes, COUNT(*) AS hands FROM opp_hands GROUP BY stakes ORDER BY stakes')
    .all()
    .map((r) => ({ stakes: r.stakes, hands: Number(r.hands) }));
  return {
    hands: Number(row.hands),
    players,
    first_ts: row.first_ts,
    last_ts: row.last_ts,
    stakes_count: Number(row.stakes_count ?? 0),
    check_passed: Number(row.check_passed ?? 0),
    by_stakes: byStakes,
  };
}

export function abortOppUpload(db, fileId) {
  db.prepare('DELETE FROM opp_player_hands WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM opp_hands WHERE file_id = ?').run(fileId);
}
