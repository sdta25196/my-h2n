// 重导对手牌谱：清掉库里所有 kind='opp' 的数据，把一个文件夹里的 *.txt 重新解析入库
// 用法：node server/scripts/reimport-opp.js <文件夹> [--yes]   （不加 --yes 只报告将删多少，不动手）
//
// 为什么需要它：opp_player_hands 的「复盘明细」列（cards / act / seq_json …）是后加的，
// 老库里这些列是默认值。上传时原始文件已被删，只能拿本地牌谱文件夹重跑一遍解析。
// 入库口径与 index.js 的 handleUpload 完全一致（同样的 sha256 / size / kind='opp'），
// 所以 /api/files 看不出这些行是脚本写的还是网页传的。
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, beginUpload, finishUpload, abortUpload } from '../src/db.js';
import { createOppWriter, oppTotals } from '../src/opp-db.js';
import { createOppStreamParser } from '../src/opp-parser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(HERE, '..', 'data');
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const yes = args.includes('--yes');

if (!dir) {
  console.log('用法: node server/scripts/reimport-opp.js <牌谱文件夹> [--yes]');
  process.exit(1);
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.log(`文件夹不存在: ${dir}`);
  process.exit(1);
}
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt')).sort();
if (!files.length) {
  console.log(`文件夹里没有 .txt: ${dir}`);
  process.exit(1);
}

const db = openDb(join(DATA_DIR, 'poker.db'));
const count = (sql) => Number(db.prepare(sql).get().n);
const oldRows = count('SELECT COUNT(*) AS n FROM opp_player_hands');
const oldHands = count('SELECT COUNT(*) AS n FROM opp_hands');
const oldFiles = count("SELECT COUNT(*) AS n FROM upload_files WHERE kind = 'opp'");

console.log(`数据库: ${join(DATA_DIR, 'poker.db')}`);
console.log(`将删除: 对手 ${oldHands} 手牌 / ${oldRows} 条玩家-手牌记录 / ${oldFiles} 份上传记录`);
console.log(`将导入: ${files.length} 个文件（${dir}）`);
console.log('注意: 只影响对手数据，hands 表（我的牌谱）一行都不动');
if (!yes) {
  console.log('这是预演，什么都没做。确认重导请加 --yes');
  process.exit(0);
}

db.exec('DELETE FROM opp_player_hands');
db.exec('DELETE FROM opp_hands');
db.exec("DELETE FROM upload_files WHERE kind = 'opp'");
console.log('已清空旧的对手数据，开始重导…');

const t0 = Date.now();
const all = { total: 0, inserted: 0, players: 0, checkTotal: 0, checkPassed: 0, failed: 0 };

for (const [i, name] of files.entries()) {
  const full = join(dir, name);
  const size = statSync(full).size;
  const sha256 = createHash('sha256').update(readFileSync(full)).digest('hex');
  const fileId = beginUpload(db, { filename: name, sha256, size, kind: 'opp' });
  const writer = createOppWriter(db, fileId);
  try {
    const parser = createOppStreamParser((h) => writer.add(h));
    const rl = createInterface({ input: createReadStream(full, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) parser.line(line);
    parser.end();
    const st = writer.commit();
    if (st.total === 0) {
      abortUpload(db, fileId);
      console.log(`  [${i + 1}/${files.length}] ${name}: 没解析到手牌，跳过`);
      all.failed++;
      continue;
    }
    finishUpload(db, fileId, st);
    for (const k of ['total', 'inserted', 'players', 'checkTotal', 'checkPassed']) all[k] += st[k];
    const rate = st.checkTotal ? ((100 * st.checkPassed) / st.checkTotal).toFixed(1) : '0.0';
    console.log(
      `  [${i + 1}/${files.length}] ${name}: ${st.total} 手（新 ${st.inserted}）/ ${st.players} 玩家行 / 守恒 ${rate}%`
    );
  } catch (err) {
    writer.rollback();
    abortUpload(db, fileId);
    all.failed++;
    console.log(`  [${i + 1}/${files.length}] ${name}: 失败 —— ${err.message}`);
  }
}

const tt = oppTotals(db);
const rate = all.checkTotal ? ((100 * all.checkPassed) / all.checkTotal).toFixed(2) : '0.00';
console.log('---');
console.log(`解析 ${all.total} 手（去重后入库 ${all.inserted}）/ ${all.players} 条玩家-手牌记录`);
console.log(`守恒校验 ${all.checkPassed}/${all.checkTotal}（${rate}%）/ 失败文件 ${all.failed}`);
console.log(`库存: ${tt.hands} 手牌 / ${tt.players} 名玩家 / ${tt.first_ts} ~ ${tt.last_ts}`);
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
db.close();
