// CoinPoker 现金桌牌谱解析器
//
// 解析口径以 test_poker/hand_browser.py 为基准（更严格、带筹码守恒校验），
// 额外补上 poker_report.py 独有的派生字段（seq / streetAgg / facingBet / rakeShare
// / sawFlop / remaining / raisesPf / foldedToHero / walk / foldedTo3bet）。
//
// 与 Python 的唯一有意分歧：faced_3bet 统一采用 hand_browser 的口径
// （扫 pfOrder 找 Hero 开池后的第一个加注），比 report 用加注计数近似更准。
//
// 金额一律以「分」为整数单位累加，避免浮点累积误差。

const RE_HEADER = /^CoinPoker Hand #(\d+): NLH \(₮([\d.]+)\/₮([\d.]+)(?:\/₮([\d.]+))?\) (\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const RE_TABLE = /^Table '(\S+)' (\d+)-max Seat #(\d+) is the button/;
const RE_SEAT = /^Seat (\d+): (\S+) \(₮([\d.]+) in chips\)/;
const RE_ACTION = /^(\S+): (folds|checks|calls ₮([\d.]+)|bets ₮([\d.]+)|raises ₮([\d.]+) to ₮([\d.]+))/;
const RE_POST = /^(\S+): posts (ante|small blind|auto big blind|big blind) ₮([\d.]+)/;
const RE_ALLIN = /^(\S+): ALLIN ₮([\d.]+)/;
const RE_AUTOBB = /^(\S+): AUTOBB ₮([\d.]+)/;
const RE_STRADDLE = /^(\S+): STRADDLE ₮([\d.]+)/;
const RE_DEALT = /^Dealt to Hero \[(\S+) (\S+)\]/;
const RE_RETURN = /^(\S+): RETURN ₮([\d.]+)/;
const RE_COLLECT = /^(\S+) collected ₮([\d.]+) from pot/;
// 全下保险：牌谱不写 collected 行，且同一手内可能重复多行（金额相同），按人去重
const RE_CASHOUT = /^(\S+) cashed out the hand for ₮([\d.]+)/;
const RE_SHOWS = /^(\S+): shows \[(\S+) (\S+)\]/;
const RE_TOTAL = /^Total pot ₮([\d.]+) \| Rake ₮([\d.]+)(?: \| Splash Fee ₮([\d.]+))?/;
const RE_SPLASH_DROP = /^(?:MEGA )?SPLASH dropped ₮([\d.]+)/;
const RE_HSUM = /^Seat \d+: Hero showed \[(\S+) (\S+)\] and (won|lost)/;
const RE_BRACKET = /\[(.*)\]/;
const RE_BRACKET2 = /\]\s*\[(.*)\]/;

const RANKS = '23456789TJQKA';
export const POS_ORDER = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
const STREET_IDX = { preflop: 0, flop: 1, turn: 2, river: 3 };
const STREETS = ['preflop', 'flop', 'turn', 'river'];

const cents = (s) => Math.round(parseFloat(s) * 100);

export function handGroup(c1, c2) {
  const v1 = RANKS.indexOf(c1[0]);
  const v2 = RANKS.indexOf(c2[0]);
  if (v1 === v2) return c1[0] + c2[0];
  const [hi, lo] = v1 > v2 ? [c1[0], c2[0]] : [c2[0], c1[0]];
  return hi + lo + (c1[1] === c2[1] ? 's' : 'o');
}

export function positionsFor(seatsSorted, btnSeat) {
  const n = seatsSorted.length;
  const i = seatsSorted.indexOf(btnSeat);
  const cyc = [];
  for (let k = 0; k < n; k++) cyc.push(seatsSorted[(i + k) % n]);
  const labels = { [cyc[0]]: 'BTN' };
  if (n >= 2) labels[cyc[1]] = 'SB';
  if (n >= 3) labels[cyc[2]] = 'BB';
  const rest = cyc.slice(3);
  const m = rest.length;
  rest.forEach((s, j) => {
    labels[s] = m === 1 || j === 0 ? 'UTG' : j === m - 1 ? 'CO' : 'MP';
  });
  return labels;
}

// 紧凑金额: 62 分 -> "0.62"，650 分 -> "6.5"
const fa = (c) => String(c / 100);

// 四舍五入到 nd 位小数（带极小量修正，抵消 /bb 除法引入的浮点噪声）
function round(x, nd) {
  const f = 10 ** nd;
  return Math.round(x * f + (x >= 0 ? 1e-9 : -1e-9)) / f;
}

/**
 * 解析单手牌的行块（首行为 header）。
 * @returns 解析结果对象，格式非法时返回 null
 */
export function parseHand(lines) {
  const m = RE_HEADER.exec(lines[0]);
  if (!m) return null;
  const sbC = cents(m[2]);
  const bbC = cents(m[3]);
  const anteC = m[4] ? cents(m[4]) : 0;
  const [, , , , , Y, Mo, D, H, Mi, S] = m;
  const ts = new Date(+Y, +Mo - 1, +D, +H, +Mi, +S);
  const stakes = 'NL' + bbC;

  let i = 1;
  const mt = RE_TABLE.exec(lines[i] || '');
  if (!mt) return null;
  const btnSeat = +mt[3];
  i++;

  const seats = new Map();
  for (; i < lines.length; i++) {
    const ms = RE_SEAT.exec(lines[i]);
    if (!ms) break;
    seats.set(+ms[1], ms[2]);
  }
  const seatNums = [...seats.keys()].sort((a, b) => a - b);
  let heroSeat = null;
  for (const s of seatNums) if (seats.get(s) === 'Hero') heroSeat = s;
  const posmap = positionsFor(seatNums, btnSeat);

  const alias = { Hero: 'H' };
  let k = 1;
  for (const s of seatNums) if (seats.get(s) !== 'Hero') alias[seats.get(s)] = 'P' + k++;

  const h = {
    id: m[1],
    stakes,
    sbC,
    bbC,
    anteC,
    ts,
    pos: posmap[heroSeat] ?? '?',
    cards: null,
    heroInvested: 0,
    heroCollected: 0,
    potC: 0,
    rakeC: 0,
    splashC: 0,
    splashDropC: 0,
    splashWonC: 0,
    cashOutC: 0,
    invested: new Map(),
    folded: new Set(),
    heroFoldedStreet: null,
    streets: ['preflop'],
    pfOrder: [],
    board: { flop: '', turn: '', river: '' },
    oppCards: [],
    log: { preflop: [], flop: [], turn: [], river: [] },
    seq: { preflop: [], flop: [], turn: [], river: [] },
    streetAgg: {},
    facingBet: {},
    raisesPf: [],
    sawFlop: false,
    firstPf: null,
  };

  const committed = new Map();
  let raiseCountPf = 0;
  let heroFirstDone = false;
  let street = 'preflop';
  let nf = 0;
  let sd = false;
  let hsd = false;
  let ai = false;
  let collectedC = 0;
  const cashOut = new Map();

  const cAdd = (map, p, d) => map.set(p, (map.get(p) || 0) + d);
  const invest = (p, d) => {
    cAdd(committed, p, d);
    cAdd(h.invested, p, d);
    if (p === 'Hero') h.heroInvested += d;
  };
  const lg = (tok) => h.log[street].push(tok);
  const hseq = (kind) => h.seq[street].push(kind);
  const al = (who) => alias[who] ?? who.slice(0, 6);

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('CoinPoker Hand')) break;

    const mp = RE_POST.exec(line);
    if (mp) {
      const amt = cents(mp[3]);
      cAdd(h.invested, mp[1], amt);
      if (mp[1] === 'Hero') h.heroInvested += amt;
      if (mp[2] !== 'ante') cAdd(committed, mp[1], amt);
      continue;
    }
    if (line.startsWith('*** HOLE CARDS') || line.startsWith('*** SHOWDOWN') || line.startsWith('*** SUMMARY')) continue;

    const md = RE_DEALT.exec(line);
    if (md) {
      h.cards = [md[1], md[2]];
      continue;
    }
    if (line.startsWith('*** FLOP') || line.startsWith('*** FIRST FLOP')) {
      street = 'flop';
      h.streets.push('flop');
      h.sawFlop = h.heroFoldedStreet === null;
      nf = seats.size - h.folded.size;
      committed.clear();
      const mb = RE_BRACKET.exec(line);
      const cs = mb ? mb[1].trim().split(/\s+/).join(' ') : '';
      h.board.flop = h.board.flop ? h.board.flop + '; ' + cs : cs;
      continue;
    }
    if (
      line.startsWith('*** TURN') ||
      line.startsWith('*** RIVER') ||
      line.startsWith('*** FIRST TURN') ||
      line.startsWith('*** FIRST RIVER')
    ) {
      street = line.includes('TURN') ? 'turn' : 'river';
      h.streets.push(street);
      committed.clear();
      const mb = RE_BRACKET2.exec(line);
      const cs = mb ? mb[1].trim().split(/\s+/).join(' ') : '';
      h.board[street] = h.board[street] ? h.board[street] + '; ' + cs : cs;
      continue;
    }
    if (line.startsWith('*** SECOND') || line.startsWith('*** FIRST SHOWDOWN')) continue;

    const mtot = RE_TOTAL.exec(line);
    if (mtot) {
      h.potC = cents(mtot[1]);
      h.rakeC = cents(mtot[2]);
      h.splashC = mtot[3] ? cents(mtot[3]) : 0;
      continue;
    }
    const msd = RE_SPLASH_DROP.exec(line);
    if (msd) {
      h.splashDropC += cents(msd[1]);
      continue;
    }
    const mr = RE_RETURN.exec(line);
    if (mr) {
      invest(mr[1], -cents(mr[2]));
      continue;
    }
    const mc = RE_COLLECT.exec(line);
    if (mc) {
      collectedC += cents(mc[2]);
      if (mc[1] === 'Hero') h.heroCollected += cents(mc[2]);
      continue;
    }
    const mco = RE_CASHOUT.exec(line);
    if (mco) {
      cashOut.set(mco[1], cents(mco[2]));
      continue;
    }
    const msh = RE_SHOWS.exec(line);
    if (msh) {
      sd = true;
      if (msh[1] !== 'Hero') {
        const cs = msh[2] + ' ' + msh[3];
        if (!h.oppCards.includes(cs)) h.oppCards.push(cs);
      }
      continue;
    }
    const mhs = RE_HSUM.exec(line);
    if (mhs) {
      // summary 写 "Hero showed and won" 的局也包含未摊牌赢，用 SHOWDOWN 区是否有 shows 行排除
      if (sd) hsd = true;
      continue;
    }
    const mau = RE_AUTOBB.exec(line);
    if (mau) {
      // AUTOBB 与 ante 同口径：计投入、不计 committed（其后 "raises to X" 的 X 不含 AUTOBB）
      cAdd(h.invested, mau[1], cents(mau[2]));
      if (mau[1] === 'Hero') h.heroInvested += cents(mau[2]);
      continue;
    }
    const mst = RE_STRADDLE.exec(line);
    if (mst) {
      invest(mst[1], cents(mst[2]));
      lg(al(mst[1]) + ' S' + fa(cents(mst[2])));
      if (street === 'preflop') h.pfOrder.push([mst[1], 'straddle']);
      continue;
    }
    const mal = RE_ALLIN.exec(line);
    if (mal) {
      const who = mal[1];
      const amt = cents(mal[2]);
      invest(who, amt);
      if (who === 'Hero') ai = true;
      lg(al(who) + ' A' + fa(amt));
      h.streetAgg[street] = who;
      if (who !== 'Hero' && !(street in h.facingBet)) h.facingBet[street] = who;
      if (who === 'Hero') {
        // 翻后 check 后再 ALLIN 视为 check-raise
        hseq(street !== 'preflop' && h.seq[street].includes('check') ? 'raise' : 'bet');
        if (street === 'preflop') h.raisesPf.push(raiseCountPf);
      }
      if (street === 'preflop') {
        const rbBefore = raiseCountPf;
        raiseCountPf++;
        h.pfOrder.push([who, 'raise']);
        if (who === 'Hero' && !heroFirstDone) {
          heroFirstDone = true;
          h.firstPf = ['raise', rbBefore];
        }
      }
      continue;
    }
    const ma = RE_ACTION.exec(line);
    if (ma) {
      const who = ma[1];
      const st = street;
      if (ma[2] === 'folds') {
        h.folded.add(who);
        if (who === 'Hero' && h.heroFoldedStreet === null) {
          h.heroFoldedStreet = st;
          hseq('fold');
        }
        lg(al(who) + ' f');
        if (st === 'preflop') h.pfOrder.push([who, 'fold']);
        continue;
      }
      if (ma[2] === 'checks') {
        lg(al(who) + ' x');
        if (who === 'Hero') hseq('check');
        if (st === 'preflop') h.pfOrder.push([who, 'check']);
        continue;
      }
      if (ma[3] !== undefined) {
        const amt = cents(ma[3]);
        invest(who, amt);
        lg(al(who) + ' c' + fa(amt));
        if (who === 'Hero') {
          hseq('call');
          if (st === 'preflop' && !heroFirstDone) {
            heroFirstDone = true;
            h.firstPf = ['call', raiseCountPf];
          }
        }
        if (st === 'preflop') h.pfOrder.push([who, 'call']);
        continue;
      }
      if (ma[4] !== undefined) {
        const amt = cents(ma[4]);
        invest(who, amt);
        lg(al(who) + ' b' + fa(amt));
        h.streetAgg[st] = who;
        if (who !== 'Hero' && !(st in h.facingBet)) h.facingBet[st] = who;
        if (who === 'Hero') {
          hseq('bet');
          if (st === 'preflop' && !heroFirstDone) {
            heroFirstDone = true;
            h.firstPf = ['bet', raiseCountPf];
          }
        }
        if (st === 'preflop') h.pfOrder.push([who, 'bet']);
        continue;
      }
      const toAmt = cents(ma[6]);
      const delta = toAmt - (committed.get(who) || 0);
      invest(who, delta);
      committed.set(who, toAmt);
      lg(al(who) + ' r' + fa(toAmt));
      h.streetAgg[st] = who;
      if (st === 'preflop') {
        const rbBefore = raiseCountPf;
        raiseCountPf++;
        h.pfOrder.push([who, 'raise']);
        if (who === 'Hero') {
          heroFirstDone = true;
          h.raisesPf.push(rbBefore);
          if (!h.firstPf) h.firstPf = ['raise', rbBefore];
          hseq('raise');
        }
      } else {
        if (who !== 'Hero' && !(st in h.facingBet)) h.facingBet[st] = who;
        if (who === 'Hero') hseq('raise');
      }
      continue;
    }
  }

  // ---- 派生字段 ----
  // SPLASH 注入的钱算在 Total pot 里，但派彩不写 collected 行，按 collected 占比分给赢家
  if (h.splashDropC > 0 && h.heroCollected > 0) {
    h.splashWonC = Math.round((h.splashDropC * h.heroCollected) / collectedC);
    h.heroCollected += h.splashWonC;
  }
  // 全下保险的赔付要放在 SPLASH 之后：cash out 的人没赢池，不该分到 SPLASH
  h.cashOutC = cashOut.get('Hero') ?? 0;
  h.heroCollected += h.cashOutC;

  h.netC = h.heroCollected - h.heroInvested;

  const fp = h.firstPf;
  if (fp && fp[0] === 'call') {
    h.pa = 'C';
    h.rn = null;
  } else if (fp && (fp[0] === 'raise' || fp[0] === 'bet')) {
    h.pa = 'R';
    h.rn = fp[1];
  } else if (h.heroFoldedStreet === 'preflop') {
    h.pa = 'F';
    h.rn = null;
  } else {
    h.pa = 'X'; // BB 过牌 / walk
    h.rn = null;
  }

  const heroIdx = h.pfOrder.findIndex(([pl]) => pl === 'Hero');
  h.rba = heroIdx < 0 ? 0 : h.pfOrder.slice(0, heroIdx).filter(([, kd]) => kd === 'raise').length;

  // 被 3bet：Hero 开池后紧接的下一个加注来自对手（此后 Hero 4bet/跟注不影响标记）
  h.faced3bet = false;
  if (h.pa === 'R' && h.rn === 0) {
    const openIdx = h.pfOrder.findIndex(([p, kd]) => p === 'Hero' && kd === 'raise');
    if (openIdx >= 0) {
      for (const [p, kd] of h.pfOrder.slice(openIdx + 1)) {
        if (kd === 'raise') {
          if (p !== 'Hero') h.faced3bet = true;
          break;
        }
      }
    }
  }

  const beforeHero = [];
  for (const [p, kd] of h.pfOrder) {
    if (p === 'Hero') break;
    beforeHero.push(kd);
  }
  h.foldedToHero = beforeHero.length > 0 && beforeHero.every((kd) => kd === 'fold');
  h.walk = h.pos === 'BB' && h.pfOrder.length > 0 && h.pfOrder.every(([, kd]) => kd === 'fold');
  h.foldedTo3bet =
    h.faced3bet && h.heroFoldedStreet === 'preflop' && Math.max(0, ...h.raisesPf) === 0;

  h.st = STREET_IDX[h.streets[h.streets.length - 1]];
  h.sd = sd;
  h.hsd = hsd;
  h.ai = ai;
  h.nf = nf;
  h.remaining = seats.size - h.folded.size;

  let totInv = 0;
  for (const v of h.invested.values()) if (v > 0) totInv += v;
  h.rakeShareC = totInv > 0 ? ((h.rakeC + h.splashC) * h.heroInvested) / totInv : 0;

  // 筹码守恒：全桌净投入和 + 促销注入 == Total pot（容差 3 分）
  h.checkOk = Math.abs(totInv + h.splashDropC - h.potC) <= 3;

  return h;
}

/** 扁平记录，字段顺序与 hand_browser.py 的 to_record / 前端 K 常量一致 */
export function toRecord(h) {
  const cd = h.cards ? h.cards[0] + h.cards[1] : '';
  const hg = h.cards ? handGroup(h.cards[0], h.cards[1]) : '';
  const act = STREETS.map((s) => h.log[s].join(' ')).join('|');
  const bl = fa(h.sbC) + '/' + fa(h.bbC) + (h.anteC ? '/' + fa(h.anteC) : '');
  const net = h.netC / 100;
  return [
    Math.floor(h.ts.getTime() / 60000),
    h.stakes,
    POS_ORDER.indexOf(h.pos),
    cd,
    hg,
    h.pa,
    h.rba,
    h.rn,
    h.faced3bet ? 1 : 0,
    h.st,
    h.sd ? 1 : 0,
    h.hsd ? (h.netC > 0 ? 1 : h.netC < 0 ? 0 : 2) : null,
    h.ai ? 1 : 0,
    h.nf,
    round(h.potC / h.bbC, 1),
    h.potC / 100,
    net,
    round(h.netC / h.bbC, 2),
    h.heroInvested / 100,
    h.heroCollected / 100,
    (h.rakeC + h.splashC) / 100,
    h.board.flop,
    h.board.turn,
    h.board.river,
    h.oppCards.join(' '),
    act,
    h.id,
    bl,
    h.splashDropC / 100,
  ];
}

/**
 * 按行喂入的流式解析器：一手牌一个回调，内存占用与文件大小无关。
 * 用法: const p = createStreamParser(onHand); for (line of lines) p.line(line); p.end();
 */
export function createStreamParser(onHand) {
  let block = null;
  const flush = () => {
    if (!block) return;
    const h = parseHand(block);
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

export { STREETS };
