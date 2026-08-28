// sqlite 层：schema + 入库去重（node:sqlite，无外部依赖）
//
// 去重两层：
//   1. 文件级 — upload_files.sha256 唯一，命中直接跳过，不重复解析
//   2. 手牌级 — hands.hand_id 主键 + INSERT OR IGNORE，重叠时段的牌谱可放心叠加上传
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { POS_ORDER, toRecord } from './parser.js';
import { OPP_SCHEMA, abortOppUpload } from './opp-db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS upload_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,
  sha256        TEXT NOT NULL UNIQUE,
  size          INTEGER NOT NULL,
  hands_total   INTEGER NOT NULL,
  hands_new     INTEGER NOT NULL,
  check_total   INTEGER NOT NULL,
  check_passed  INTEGER NOT NULL,
  uploaded_at   TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'hero'   -- 'hero' = 我的牌谱 / 'opp' = 对手牌谱
);

CREATE TABLE IF NOT EXISTS hands (
  hand_id       TEXT PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES upload_files(id),

  ts            INTEGER NOT NULL,   -- 分钟戳（与前端记录字段 t 一致）
  ts_text       TEXT NOT NULL,      -- 'YYYY-MM-DD HH:MM:SS'，供 SQL 日期筛选
  stakes        TEXT NOT NULL,
  blinds        TEXT NOT NULL,
  sb_cents      INTEGER NOT NULL,
  bb_cents      INTEGER NOT NULL,
  ante_cents    INTEGER NOT NULL,

  pos           INTEGER NOT NULL,   -- POS_ORDER 下标，-1 表示未识别
  cards         TEXT NOT NULL,
  hand_group    TEXT NOT NULL,

  pa            TEXT NOT NULL,      -- 翻前首动作 F/C/R/X
  rba           INTEGER NOT NULL,   -- 轮到 Hero 前的加注数
  rn            INTEGER,            -- Hero 加注时之前的加注数（0=开池,1=3bet,...）
  faced_3bet    INTEGER NOT NULL,
  st            INTEGER NOT NULL,   -- 到达街道 0..3
  sd            INTEGER NOT NULL,   -- 整手是否有摊牌
  sdw           INTEGER,            -- Hero 摊牌结果 1赢/0输/2平，未摊牌 NULL
  ai            INTEGER NOT NULL,
  nf            INTEGER NOT NULL,   -- 进翻人数

  pot_cents     INTEGER NOT NULL,
  net_cents     INTEGER NOT NULL,
  inv_cents     INTEGER NOT NULL,
  col_cents     INTEGER NOT NULL,
  rake_cents    INTEGER NOT NULL,   -- rake + splash fee
  splash_drop_cents INTEGER NOT NULL,

  flop          TEXT NOT NULL,
  turn          TEXT NOT NULL,
  river         TEXT NOT NULL,
  opp           TEXT NOT NULL,
  act           TEXT NOT NULL,

  -- 报表页所需派生字段
  seq_json          TEXT NOT NULL,
  street_agg_json   TEXT NOT NULL,
  facing_bet_json   TEXT NOT NULL,
  raises_pf_json    TEXT NOT NULL,
  rake_share_cents  REAL NOT NULL,
  saw_flop          INTEGER NOT NULL,
  remaining         INTEGER NOT NULL,
  folded_to_hero    INTEGER NOT NULL,
  walk              INTEGER NOT NULL,
  folded_to_3bet    INTEGER NOT NULL,
  hero_folded_street TEXT,
  check_ok          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hands_ts ON hands(ts);
CREATE INDEX IF NOT EXISTS idx_hands_stakes_ts ON hands(stakes, ts);
CREATE INDEX IF NOT EXISTS idx_hands_pos ON hands(pos);
CREATE INDEX IF NOT EXISTS idx_hands_group ON hands(hand_group);
CREATE INDEX IF NOT EXISTS idx_hands_file ON hands(file_id);
`;

const INSERT_HAND = `INSERT OR IGNORE INTO hands (
  hand_id, file_id, ts, ts_text, stakes, blinds, sb_cents, bb_cents, ante_cents,
  pos, cards, hand_group, pa, rba, rn, faced_3bet, st, sd, sdw, ai, nf,
  pot_cents, net_cents, inv_cents, col_cents, rake_cents, splash_drop_cents,
  flop, turn, river, opp, act,
  seq_json, street_agg_json, facing_bet_json, raises_pf_json, rake_share_cents,
  saw_flop, remaining, folded_to_hero, walk, folded_to_3bet, hero_folded_street, check_ok
) VALUES (${Array(44).fill('?').join(',')})`;

const pad = (x) => String(x).padStart(2, '0');
const tsText = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加新列，只能自己 ALTER
// specs 形如 { 列名: '类型与默认值' }，只补缺的，已有数据不动
function addMissingColumns(db, table, specs) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, decl] of Object.entries(specs)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  db.exec(OPP_SCHEMA);
  addMissingColumns(db, 'upload_files', { kind: "TEXT NOT NULL DEFAULT 'hero'" });
  // 对手复盘明细列（旧库补上后老行是默认值：没手牌没动作流，重导才完整）
  addMissingColumns(db, 'opp_hands', {
    st: 'INTEGER NOT NULL DEFAULT 0',
    sd: 'INTEGER NOT NULL DEFAULT 0',
    act: "TEXT NOT NULL DEFAULT ''",
  });
  addMissingColumns(db, 'opp_player_hands', {
    seat: 'INTEGER NOT NULL DEFAULT 0',
    cards: "TEXT NOT NULL DEFAULT ''",
    hand_group: "TEXT NOT NULL DEFAULT ''",
    opp_cards: "TEXT NOT NULL DEFAULT ''",
    pa: "TEXT NOT NULL DEFAULT 'X'",
    rn: 'INTEGER',
    rba: 'INTEGER NOT NULL DEFAULT 0',
    pf4b: 'INTEGER NOT NULL DEFAULT 0',
    pf_agg: 'INTEGER NOT NULL DEFAULT 0',
    pf_def: 'INTEGER NOT NULL DEFAULT 0',
    sdw: 'INTEGER',
    flop_first: 'INTEGER NOT NULL DEFAULT 0',
    seq_json: "TEXT NOT NULL DEFAULT '{}'",
  });
  return db;
}

export function findFileBySha(db, sha256) {
  return db.prepare('SELECT * FROM upload_files WHERE sha256 = ?').get(sha256);
}

export function listFiles(db) {
  return db.prepare('SELECT * FROM upload_files ORDER BY id DESC').all();
}

export function totals(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS hands,
              COALESCE(SUM(net_cents), 0) AS net_cents,
              MIN(ts_text) AS first_ts, MAX(ts_text) AS last_ts,
              COUNT(DISTINCT stakes) AS stakes_count
       FROM hands`
    )
    .get();
  const byStakes = db
    .prepare(
      `SELECT stakes, COUNT(*) AS hands, SUM(net_cents) AS net_cents
         FROM hands GROUP BY stakes ORDER BY stakes`
    )
    .all()
    .map((r) => ({ stakes: r.stakes, hands: Number(r.hands), net: Number(r.net_cents) / 100 }));
  return { ...row, hands: Number(row.hands), net_cents: Number(row.net_cents), by_stakes: byStakes };
}

const handRow = (h, fileId) => {
  const rec = toRecord(h);
  return [
    h.id,
    fileId,
    rec[0],
    tsText(h.ts),
    h.stakes,
    rec[27],
    h.sbC,
    h.bbC,
    h.anteC,
    POS_ORDER.indexOf(h.pos),
    rec[3],
    rec[4],
    h.pa,
    h.rba,
    h.rn,
    h.faced3bet ? 1 : 0,
    h.st,
    h.sd ? 1 : 0,
    rec[11],
    h.ai ? 1 : 0,
    h.nf,
    h.potC,
    h.netC,
    h.heroInvested,
    h.heroCollected,
    h.rakeC + h.splashC,
    h.splashDropC,
    h.board.flop,
    h.board.turn,
    h.board.river,
    h.oppCards.join(' '),
    rec[25],
    JSON.stringify(h.seq),
    JSON.stringify(h.streetAgg),
    JSON.stringify(h.facingBet),
    JSON.stringify(h.raisesPf),
    h.rakeShareC,
    h.sawFlop ? 1 : 0,
    h.remaining,
    h.foldedToHero ? 1 : 0,
    h.walk ? 1 : 0,
    h.foldedTo3bet ? 1 : 0,
    h.heroFoldedStreet,
    h.checkOk ? 1 : 0,
  ];
};

/**
 * 批量写入器：每 batchSize 手一个事务，35MB 文件也不会撑爆内存。
 * 调用 add() 收集，最后 commit() 返回统计。
 */
export function createWriter(db, fileId, batchSize = 1000) {
  const stmt = db.prepare(INSERT_HAND);
  let pending = 0;
  let open = false;
  const stats = { total: 0, inserted: 0, checkTotal: 0, checkPassed: 0 };

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
      const r = stmt.run(...handRow(h, fileId));
      stats.total++;
      stats.checkTotal++;
      if (h.checkOk) stats.checkPassed++;
      if (r.changes > 0) stats.inserted++;
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

// hands.file_id 需要先有文件行，所以入库分两步：先占位，解析完再回填统计
export function beginUpload(db, { filename, sha256, size, kind = 'hero' }) {
  const row = db
    .prepare(
      `INSERT INTO upload_files
         (filename, sha256, size, hands_total, hands_new, check_total, check_passed, uploaded_at, kind)
       VALUES (?,?,?,0,0,0,0,?,?) RETURNING id`
    )
    .get(filename, sha256, size, new Date().toISOString(), kind);
  return Number(row.id);
}

export function finishUpload(db, fileId, stats) {
  db.prepare(
    `UPDATE upload_files
        SET hands_total = ?, hands_new = ?, check_total = ?, check_passed = ?
      WHERE id = ?`
  ).run(stats.total, stats.inserted, stats.checkTotal, stats.checkPassed, fileId);
  return db.prepare('SELECT * FROM upload_files WHERE id = ?').get(fileId);
}

export function abortUpload(db, fileId) {
  db.prepare('DELETE FROM hands WHERE file_id = ?').run(fileId);
  abortOppUpload(db, fileId);
  db.prepare('DELETE FROM upload_files WHERE id = ?').run(fileId);
}
