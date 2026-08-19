// 对拍：Node 解析器 vs Python hand_browser.py 的 29 字段记录，逐手逐字段比对
// 用法: node server/scripts/verify.js <牌谱.txt> <python_data.json>
import { createReadStream } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createStreamParser, toRecord } from '../src/parser.js';

const [handFile, jsonFile] = process.argv.slice(2);
if (!handFile || !jsonFile) {
  console.error('用法: node server/scripts/verify.js <牌谱.txt> <python_data.json>');
  process.exit(2);
}

const NAMES = 't lv pos cd hg pa rba rn f3 st sd sdw ai nf potbb pot net bb inv col rk fl tu ri opp act id bl sp'.split(' ');
const TOL = { potbb: 0.1, bb: 0.01 }; // 除法字段容许 1 个末位单位（Python 银行家舍入差异）

const py = JSON.parse(readFileSync(jsonFile, 'utf8'));
const pyById = new Map(py.hands.map((r) => [r[26], r]));
console.log(`Python 基准: ${py.hands.length} 手, 净盈亏 ${py.meta.net}`);

const mine = [];
const parser = createStreamParser((h) => mine.push(h));
const rl = createInterface({ input: createReadStream(handFile, 'utf8'), crlfDelay: Infinity });
const t0 = Date.now();
for await (const line of rl) parser.line(line);
parser.end();
const secs = ((Date.now() - t0) / 1000).toFixed(1);

let netC = 0;
let checkPassed = 0;
const diffs = new Map();
let badHands = 0;
const samples = [];

for (const h of mine) {
  netC += h.netC;
  if (h.checkOk) checkPassed++;
  const a = toRecord(h);
  const b = pyById.get(h.id);
  if (!b) {
    badHands++;
    diffs.set('MISSING', (diffs.get('MISSING') || 0) + 1);
    continue;
  }
  pyById.delete(h.id);
  let bad = false;
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[i];
    let ok;
    if (typeof a[i] === 'number' && typeof b[i] === 'number') {
      ok = Math.abs(a[i] - b[i]) <= (TOL[name] ?? 1e-9) + 1e-12;
    } else {
      ok = a[i] === b[i] || (a[i] == null && b[i] == null);
    }
    if (!ok) {
      bad = true;
      diffs.set(name, (diffs.get(name) || 0) + 1);
      if (samples.length < 12) samples.push(`#${h.id} ${name}: node=${JSON.stringify(a[i])} py=${JSON.stringify(b[i])}`);
    }
  }
  if (bad) badHands++;
}

console.log(`Node   解析: ${mine.length} 手, 净盈亏 ${(netC / 100).toFixed(2)}, 用时 ${secs}s`);
console.log(`筹码守恒校验通过 ${checkPassed}/${mine.length}`);
console.log(`Python 有而 Node 没有的手数: ${pyById.size}`);
console.log(`字段不一致的手数: ${badHands}`);
if (diffs.size) {
  console.log('按字段统计差异:', [...diffs].map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(samples.join('\n'));
}
process.exit(badHands === 0 && pyById.size === 0 && mine.length === py.hands.length ? 0 : 1);
