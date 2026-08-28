// 清空数据库：删掉所有手牌与上传历史，保留表结构
// 用法：node server/scripts/reset.js --yes   （不加 --yes 只报告将要删多少，不动手）
//
// 走 SQL 而不是删文件，所以服务端不用停 —— 下一次请求就能看到空库。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(HERE, '..', 'data');
const DB_FILE = join(DATA_DIR, 'poker.db');

if (!existsSync(DB_FILE)) {
  console.log(`数据库不存在，无需清理: ${DB_FILE}`);
  process.exit(0);
}

const db = new DatabaseSync(DB_FILE);
const count = (t) => {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  } catch {
    return 0; // 老库还没有对手表
  }
};
const hands = count('hands');
const files = count('upload_files');
const oppHands = count('opp_hands');
const oppRows = count('opp_player_hands');

console.log(`数据库: ${DB_FILE}`);
console.log(`当前: ${hands} 手牌 / ${files} 份上传记录`);
console.log(`      对手 ${oppHands} 手牌 / ${oppRows} 条玩家-手牌记录`);

if (!process.argv.includes('--yes')) {
  console.log('这是预演，什么都没删。确认要清空请加 --yes');
  process.exit(0);
}

db.exec('DELETE FROM hands');
for (const t of ['opp_player_hands', 'opp_hands']) {
  try {
    db.exec(`DELETE FROM ${t}`);
  } catch {
    /* 老库还没有这张表 */
  }
}
db.exec('DELETE FROM upload_files');
db.exec('DELETE FROM sqlite_sequence WHERE name = \'upload_files\'');
try {
  db.exec('VACUUM');
} catch (err) {
  // 服务端正在写入时 VACUUM 会拿不到锁，数据已经清了，只是文件没收缩
  console.log('提示: 未能 VACUUM 收缩文件（' + err.message + '），数据已清空');
}
db.close();
console.log(`已清空: 删除 ${hands} 手牌 / ${files} 份上传记录 / 对手 ${oppHands} 手牌 ${oppRows} 条记录`);
