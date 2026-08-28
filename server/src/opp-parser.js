// 对手牌谱解析器（整桌视角，与 parser.js 的 Hero 视角互不相干）
//
// 为什么要第二个解析器：对手牌谱是另一种导出格式，和 Hero 牌谱逐行都不一样 ——
//   header    Hold'em No Limit (₮0.50/₮1.00 - Ante ₮0.16 CPCC) - 2026/08/19 15:57:11 +00
//             （Hero 侧是 `NLH (₮0.05/₮0.10) 2026/08/06 20:14:31 CST`，无 ` - `）
//   全下       `X: calls ₮6.10 and is all-in`   （Hero 侧是独立的 `X: ALLIN ₮6.10` 行）
//   退还       `Uncalled bet (₮2.68) returned to X`（Hero 侧是 `X: RETURN ₮2.68`）
//   前注       `X: posts the ante ₮0.16`        （Hero 侧是 `posts ante`）
//   摊牌段     `*** SHOW DOWN ***`（带空格）     （Hero 侧是 `*** SHOWDOWN ***`）
//   没有 `Dealt to Hero`，所有人都是对手，且用的是真实用户名
// 反过来 Hero 牌谱里的 STRADDLE / AUTOBB / SPLASH / run-it-twice 在对手牌谱里不存在
// （170 份样本 35,439 手穷举过，全部行型只有 27 种，见 README-AI「对手牌谱」一节）。
//
// 一手牌产出「每个在座玩家一行」的行为标记，全部是 0/1 计数器 + 分母机会位，
// 这样 /api/opponents 端只做 SUM(x)/SUM(x_opp) 就能算出所有 HUD 指标。
//
// 除 HUD 计数外还产出「逐手复盘」需要的明细（/api/opp-hands 用）：
//   手牌级 act（动作流）/ st（到达街道）/ sd（是否摊牌）
//   玩家级 cards / handGroup / oppCards / pa / rn / rba / pf4b / pfAggFlag / pfDef
//          / sdw / flopFirst / seq
// 口径一律照 parser.js 的 Hero 侧抄，这样 hands.js 里的筛选 SQL 能原样复用。
//
// 金额同样一律以「分」为整数单位累加（不变量 1）。
import { POS_ORDER, positionsFor, handGroup } from './parser.js';

// 认格式就靠这条：`Hold'em No Limit` + ` - ` + 日期，Hero 牌谱匹配不上
const RE_HEADER =
  /^CoinPoker Hand #(\d+): Hold'em No Limit \(₮([\d.]+)\/₮([\d.]+)(?: - Ante ₮([\d.]+) CPCC)?\) - (\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const RE_TABLE = /^Table '(\S+)' (\d+)-max Seat #(\d+) is the button/;
const RE_SEAT = /^Seat (\d+): (\S+) \(₮([\d.]+) in chips\)/;
const RE_POST = /^(\S+): posts (the ante|small blind|big blind) ₮([\d.]+)/;
// 组号沿用 parser.js 的排布：3=call 金额，4=bet 金额，6=raise 的 to 金额
const RE_ACT = /^(\S+): (folds|checks|calls ₮([\d.]+)|bets ₮([\d.]+)|raises ₮([\d.]+) to ₮([\d.]+))/;
const RE_UNCALLED = /^Uncalled bet \(₮([\d.]+)\) returned to (\S+)/;
const RE_COLLECT = /^(\S+) collected ₮([\d.]+) from pot/;
const RE_SHOWS = /^(\S+): shows \[(\S+) (\S+)\]/;
const RE_TOTAL = /^Total pot ₮([\d.]+) \| Rake ₮([\d.]+)/;
const RE_BRACKET = /\[(.*)\]/;
const RE_BRACKET2 = /\]\s*\[(.*)\]/;

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const STREET_IDX = { preflop: 0, flop: 1, turn: 2, river: 3 };
// 偷盲位：翻前无人主动入池时，从这三个位置开池算偷盲
const STEAL_POS = new Set(['CO', 'BTN', 'SB']);

const cents = (s) => Math.round(parseFloat(s) * 100);
const fa = (c) => String(c / 100);

/** 判断某行是否对手牌谱的手牌起始行（也用于上传时校验格式） */
export const isOppHeader = (line) => RE_HEADER.test(line);

function newPlayer(name, seat, pos) {
  return {
    name,
    seat,
    pos,
    invC: 0,
    colC: 0,
    // 翻前
    vpip: 0,
    pfr: 0,
    t3bOpp: 0,
    t3b: 0,
    f3bOpp: 0,
    f3b: 0,
    stealOpp: 0,
    steal: 0,
    // 翻后
    sawFlop: 0,
    wtsd: 0,
    sdWon: 0,
    wwsf: 0,
    cbetOpp: 0,
    cbet: 0,
    fcbOpp: 0,
    fcb: 0,
    aggBets: 0, // 翻后 bet + raise 次数
    aggCalls: 0, // 翻后 call 次数
    allin: 0,
    foldedStreet: null,
    // ---- 复盘明细（口径见 parser.js 的同名字段）----
    cards: '', // 自己被亮出的底牌 'AhKd'，未摊牌为空
    handGroup: '', // 'AKs' / 'QQ' / 'J7o'，无底牌为空
    oppCards: '', // 同桌其他人亮出的牌，空格连接
    pa: 'X', // 翻前首个动作 F/C/R/X（整手没动过也是 X）
    rn: null, // 自己首次加注前已有的加注数：0 开池 / 1 3bet / 2 4bet…
    rba: 0, // 首次决策前已有的加注数（「面开」标签）
    pf4b: 0, // 做过 4bet 及以上
    pfAggFlag: 0, // 自己是翻前最后一个加注者
    pfDef: 0, // 别人是翻前侵略者且自己没弃牌（防守方）
    sdw: null, // 摊牌结果 1 赢 / 0 输 / 2 平，没走到摊牌为 null
    flopFirst: 0, // 翻牌第一个动作是自己
    seq: { preflop: [], flop: [], turn: [], river: [] }, // 自己的逐街动作种类
  };
}

/**
 * 解析单手牌的行块（首行为 header）。
 * @returns { id, ts, stakes, ..., players: [...] }，格式非法时返回 null
 */
export function parseOppHand(lines) {
  const m = RE_HEADER.exec(lines[0]);
  if (!m) return null;
  const sbC = cents(m[2]);
  const bbC = cents(m[3]);
  const anteC = m[4] ? cents(m[4]) : 0;
  const [, , , , , Y, Mo, D, H, Mi, S] = m;
  // 与 parser.js 一致按本地时间构造（不做时区换算），否则日期会和文件名对不上
  const ts = new Date(+Y, +Mo - 1, +D, +H, +Mi, +S);

  let i = 1;
  const mt = RE_TABLE.exec(lines[i] || '');
  if (!mt) return null;
  const tableName = mt[1];
  const btnSeat = +mt[3];
  i++;

  const seats = new Map();
  for (; i < lines.length; i++) {
    const ms = RE_SEAT.exec(lines[i]);
    if (!ms) break;
    seats.set(+ms[1], ms[2]);
  }
  if (seats.size < 2) return null;
  const seatNums = [...seats.keys()].sort((a, b) => a - b);
  const posmap = positionsFor(seatNums, btnSeat);

  // 同名同桌不可能重复，用名字做主键
  const P = new Map();
  for (const s of seatNums) P.set(seats.get(s), newPlayer(seats.get(s), s, posmap[s] ?? '?'));

  const h = {
    id: m[1],
    ts,
    stakes: 'NL' + bbC,
    blinds: fa(sbC) + '/' + fa(bbC) + (anteC ? '/' + fa(anteC) : ''),
    sbC,
    bbC,
    anteC,
    tableName,
    potC: 0,
    rakeC: 0,
    board: { flop: '', turn: '', river: '' },
    nf: 0,
    st: 0, // 本手到达的最后一街（与 Hero 侧同口径：某人翻前弃牌不影响它）
    sd: 0, // 本手是否走到摊牌
    log: { preflop: [], flop: [], turn: [], river: [] }, // 动作流，末尾拼成 act
    players: [],
  };

  const committed = new Map(); // 本街已投入（算 raise 增量用）
  const folded = new Set();
  let street = 'preflop';
  let showdown = false;

  // 翻前状态机
  let raises = 0; // 已发生的加注次数（盲注/前注不算）
  let opener = null; // 首个加注者
  let pfAgg = null; // 最后一个加注者 = 翻前侵略者（cbet 归属）
  let anyVol = false; // 是否已有人主动入池（跟注或加注）
  const decided = new Set(); // 已做过首次翻前决策的人
  // 开池者被 3bet 后「尚未应对」——只看紧接的那一个动作，4bet 之后再弃牌不算 fold to 3bet
  let f3bPending = null;

  // 翻牌状态机（cbet / fold to cbet）
  let flopBetBy = null; // 翻牌首个下注者
  let flopCbet = false; // 该下注是否来自翻前侵略者
  let flopActed = false; // 翻牌是否已有人动作过（定 flopFirst）
  const fcbDone = new Set(); // 已就 cbet 做过应对的人

  const invest = (who, d) => {
    const p = P.get(who);
    if (p) p.invC += d;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('CoinPoker Hand')) break;

    const mp = RE_POST.exec(line);
    if (mp) {
      const amt = cents(mp[3]);
      invest(mp[1], amt);
      // 前注不进 committed：其后 "raises to X" 的 X 不含前注（与 Hero 侧同口径）
      if (mp[2] !== 'the ante') committed.set(mp[1], (committed.get(mp[1]) || 0) + amt);
      continue;
    }
    if (line.startsWith('*** HOLE CARDS') || line.startsWith('*** SUMMARY')) continue;
    if (line.startsWith('*** SHOW DOWN')) {
      showdown = true;
      continue;
    }
    if (line.startsWith('*** FLOP')) {
      street = 'flop';
      h.st = 1;
      committed.clear();
      for (const p of P.values()) if (!folded.has(p.name)) p.sawFlop = 1;
      h.nf = seats.size - folded.size;
      const mb = RE_BRACKET.exec(line);
      h.board.flop = mb ? mb[1].trim().split(/\s+/).join(' ') : '';
      continue;
    }
    if (line.startsWith('*** TURN') || line.startsWith('*** RIVER')) {
      street = line.includes('TURN') ? 'turn' : 'river';
      h.st = STREET_IDX[street];
      committed.clear();
      const mb = RE_BRACKET2.exec(line);
      h.board[street] = mb ? mb[1].trim().split(/\s+/).join(' ') : '';
      continue;
    }

    const mtot = RE_TOTAL.exec(line);
    if (mtot) {
      h.potC = cents(mtot[1]);
      h.rakeC = cents(mtot[2]);
      continue;
    }
    const mu = RE_UNCALLED.exec(line);
    if (mu) {
      invest(mu[2], -cents(mu[1]));
      continue;
    }
    const mc = RE_COLLECT.exec(line);
    if (mc) {
      const p = P.get(mc[1]);
      if (p) p.colC += cents(mc[2]);
      continue;
    }
    const msh = RE_SHOWS.exec(line);
    if (msh) {
      showdown = true;
      const p = P.get(msh[1]);
      // 同一人可能被写两次（shows + summary showed），只认第一次
      if (p && !p.cards) {
        p.cards = msh[2] + msh[3];
        p.handGroup = handGroup(msh[2], msh[3]);
      }
      continue;
    }

    const ma = RE_ACT.exec(line);
    if (!ma) continue;
    const who = ma[1];
    const p = P.get(who);
    if (!p) continue;
    const isAI = line.includes(' and is all-in');
    if (isAI) p.allin = 1;

    const kind =
      ma[2] === 'folds' ? 'fold' : ma[2] === 'checks' ? 'check' : ma[3] !== undefined ? 'call' : ma[4] !== undefined ? 'bet' : 'raise';

    // ---- 金额 ----
    if (kind === 'call' || kind === 'bet') {
      const amt = cents(kind === 'call' ? ma[3] : ma[4]);
      invest(who, amt);
      committed.set(who, (committed.get(who) || 0) + amt);
    } else if (kind === 'raise') {
      const to = cents(ma[6]);
      invest(who, to - (committed.get(who) || 0));
      committed.set(who, to);
    }

    // ---- 动作流（复盘用）----
    // 动作码与 parser.js 的 lg() 同一套；全下在码尾加 '!'（对手格式没有独立 ALLIN 行）
    const code =
      kind === 'fold'
        ? 'f'
        : kind === 'check'
          ? 'x'
          : kind === 'call'
            ? 'c' + fa(cents(ma[3]))
            : kind === 'bet'
              ? 'b' + fa(cents(ma[4]))
              : 'r' + fa(cents(ma[6]));
    h.log[street].push(who, code + (isAI ? '!' : ''));
    p.seq[street].push(kind);

    // ---- 翻前行为 ----
    if (street === 'preflop') {
      if (!decided.has(who)) {
        decided.add(who);
        // 首次决策的动作码与面对的加注数（复盘页「翻前」列用）
        p.pa = kind === 'fold' ? 'F' : kind === 'call' ? 'C' : kind === 'raise' ? 'R' : 'X';
        p.rba = raises;
        // 偷盲机会：前面无人加注也无人跟注，且自己在 CO/BTN/SB
        if (raises === 0 && !anyVol && STEAL_POS.has(p.pos)) p.stealOpp = 1;
        // 3bet 机会：首次决策时正面对恰好一次加注
        if (raises === 1) p.t3bOpp = 1;
      }
      // 开池者面对 3bet 后的第一个动作即为应对，只在这一次结算
      if (f3bPending === who) {
        f3bPending = null;
        if (kind === 'fold') p.f3b = 1;
      }
      if (kind === 'raise') {
        p.vpip = 1;
        p.pfr = 1;
        if (p.rn === null) p.rn = raises; // 自己首次加注的层级：0 开池 / 1 3bet / 2 4bet…
        if (raises >= 2) p.pf4b = 1; // 4bet+（含开池被 3bet 后再 4bet 的手）
        if (p.stealOpp && raises === 0) p.steal = 1;
        if (p.t3bOpp && raises === 1) p.t3b = 1;
        // 这是针对开池者的 3bet：给开池者记上分母，等他下一个动作来结算
        if (raises === 1 && opener && opener !== who) {
          P.get(opener).f3bOpp = 1;
          f3bPending = opener;
        }
        if (raises === 0) opener = who;
        pfAgg = who;
        raises++;
        anyVol = true;
      } else if (kind === 'call') {
        p.vpip = 1;
        anyVol = true;
      }
    } else {
      // ---- 翻后行为 ----
      if (kind === 'bet') p.aggBets++;
      else if (kind === 'raise') p.aggBets++;
      else if (kind === 'call') p.aggCalls++;

      if (street === 'flop') {
        // 翻牌第一个说话的人 = 单挑池里的 OOP（复盘页 IP/OOP 筛选）
        if (!flopActed) {
          flopActed = true;
          p.flopFirst = 1;
        }
        if (flopBetBy === null && (kind === 'bet' || kind === 'raise')) {
          // 翻牌第一个下注：来自翻前侵略者才算持续下注
          flopBetBy = who;
          flopCbet = who === pfAgg;
        } else if (flopBetBy === null && kind === 'check' && who === pfAgg && !p.cbetOpp) {
          // 侵略者在无人下注时过牌 —— 有机会但放弃了
          p.cbetOpp = 1;
        }
        if (flopCbet && who !== flopBetBy && !fcbDone.has(who)) {
          fcbDone.add(who);
          p.fcbOpp = 1;
          if (kind === 'fold') p.fcb = 1;
        }
      }
    }

    if (kind === 'fold') {
      folded.add(who);
      if (p.foldedStreet === null) p.foldedStreet = street;
    }
  }

  // 侵略者下注成功即 cbet：机会位在这里补（上面只处理了「过牌放弃」的分支）
  if (pfAgg) {
    const a = P.get(pfAgg);
    if (a && a.sawFlop && flopCbet && flopBetBy === pfAgg) {
      a.cbetOpp = 1;
      a.cbet = 1;
    }
  }

  // ---- 派生 ----
  let totInv = 0;
  for (const p of P.values()) {
    totInv += p.invC; // 含退还产生的负数，否则守恒率从 99.98% 掉到 99.94%
    p.netC = p.colC - p.invC;
    if (showdown && !folded.has(p.name)) p.wtsd = 1;
    if (p.wtsd && p.netC > 0) p.sdWon = 1;
    if (p.sawFlop && p.netC > 0) p.wwsf = 1;
    // 摊牌结果三态：口径挂在 wtsd（走到摊牌）上而不是「有没有 shows 行」，
    // 这样 SUM(sdw=1)/SUM(sdw IS NOT NULL) 就等于 /api/opponents 的 sd_won/wtsd，两页 W$SD 不打架
    if (p.wtsd) p.sdw = p.netC > 0 ? 1 : p.netC < 0 ? 0 : 2;
    // 翻前侵略者归属：循环里 pfAgg 还会变，只能在这里定
    if (pfAgg === p.name) p.pfAggFlag = 1;
    else if (pfAgg && p.pa !== 'F') p.pfDef = 1;
  }
  // 亮牌是河牌动作之后才出现的，同桌其他人的牌只能在这里分配
  const shown = [...P.values()].filter((p) => p.cards);
  if (shown.length > 1) {
    for (const p of P.values()) {
      p.oppCards = shown
        .filter((q) => q !== p)
        .map((q) => q.cards.slice(0, 2) + ' ' + q.cards.slice(2))
        .join(' ');
    }
  }
  h.sd = showdown ? 1 : 0;
  h.act = STREETS.map((s) => h.log[s].join(' ')).join('|');
  // 筹码守恒：全桌净投入和 == Total pot（容差 3 分，与 Hero 侧同口径）
  h.checkOk = Math.abs(totInv - h.potC) <= 3;
  h.players = [...P.values()];
  return h;
}

/** 每行喂入的流式解析器，用法与 parser.js 的 createStreamParser 一致 */
export function createOppStreamParser(onHand) {
  let block = null;
  const flush = () => {
    if (!block) return;
    const h = parseOppHand(block);
    block = null;
    if (h) onHand(h);
  };
  return {
    line(text) {
      if (RE_HEADER.test(text)) {
        flush();
        block = [text];
      } else if (block) {
        block.push(text);
      }
    },
    end: flush,
  };
}

export { POS_ORDER, STREETS, STREET_IDX };
