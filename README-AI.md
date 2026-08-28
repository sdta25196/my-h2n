# my-h2n

给 AI 看的项目说明：结构、约定、不变量、坑。人类向的介绍见 `README-HUMAN.md`。

## 技术栈

数据库:sqlite；用内置 node:sqlite
后端：nodejs
前端:html js css

**零外部依赖**是硬约束：只用 `node:http` / `node:sqlite` / `node:readline` / `node:crypto` / `node:fs`。没有 npm 运行时依赖、没有框架。改代码时不要引入任何包（Chart.js 是唯一第三方，已 vendor 到 `client/vendor/chart.umd.min.js`）。ESM（`"type": "module"`），要求 Node ≥ 22.5（`node:sqlite` 起始版本），本机 v22.22.1。唯一的构建步骤只服务于打包 exe（见「打包成绿色版 exe」），日常开发不需要构建。

## 跑起来

```bash
node server/src/index.js        # http://localhost:3000 ，静态页由服务端一起托管
cd server && npm start          # 等价
cd server && npm run reset      # 清库预演（只报数）；加 -- --yes 才真删
node server/scripts/reimport-opp.js <牌谱文件夹>          # 重导对手牌谱：预演（只报数）
node server/scripts/reimport-opp.js <牌谱文件夹> --yes    # 真删旧对手数据并重导（只动对手侧）
```

数据库落在 `server/data/poker.db`（gitignore），可用 `DATA_DIR` / `PORT` 环境变量覆盖。没有测试框架，也没有 lint/构建；验证靠手跑脚本和浏览器。

## 目录

```
server/src/parser.js   499 行  牌谱解析器（Hero 视角，状态机，逐行喂）
server/src/opp-parser.js 413 行 对手牌谱解析器（整桌视角，另一种导出格式）
server/src/db.js       292 行  schema + 两层去重 + 批量事务写入
server/src/opp-db.js   230 行  对手两张表的 schema + 批量写入 + 库存
server/src/hands.js    357 行  GET /api/hands：SQL 筛选/分页/汇总
server/src/opp-hands.js 321 行 GET /api/opp-hands：以某个对手为 Hero 的逐手复盘
server/src/report.js   416 行  GET /api/report：实时聚合（build_stats 移植）
server/src/opponents.js 183 行 GET /api/opponents：HUD 指标 SQL 聚合
server/src/index.js    228 行  路由 + 上传 + 静态托管
server/src/main-sea.js         打包 exe 时的入口（起服务 + 开浏览器），开发模式不加载
server/scripts/verify.js       解析器对拍（需 Python 基准 JSON，见下）
server/scripts/reset.js        清库（含对手两张表）
server/scripts/reimport-opp.js 重导对手牌谱（加了新列后必须重跑，原始文件上传完就删了）
scripts/build-sea.sh           打包单文件 exe
sea-config.json                SEA 配置（前端资源清单在这里）
client/index.html+upload.js    上传页（两个拖拽区：我的牌谱 / 对手牌谱）
client/data.html+data.js       数据页（暗色，1:1 复刻 poker_report.py）
client/review.html+review.js   复盘页（浅色，1:1 复刻 hand_browser.py）
client/opponents.html+opponents.js 对手页（暗色，HUD 表，行末「复盘」按钮）
client/opp-review.html+opp-review.js 对手复盘页（浅色，复用 review.css，以某个对手为 Hero）
client/vendor/chart.umd.min.js Chart.js 4.4.1
```

死文件（留着没用，可删）：`client/src/index.js`（空）。前端细节见 `client/README.md`。

## 数据流

上传原文（`POST /api/upload`，请求体就是 txt 本体，文件名在 `x-filename` 头里，**不走 multipart**）→ 落临时文件同时算 sha256 → `readline` 逐行喂 `createStreamParser` → 每手 `toRecord` 化 → 1000 手一个事务 `INSERT OR IGNORE`。35MB / 29,658 手约 3 秒。

**两条平行管道**，靠 `?kind=` 分流（`opp` = 对手牌谱，缺省 = 我的牌谱）：

| | 我的牌谱（hero） | 对手牌谱（opp） |
|---|---|---|
| 解析器 | `parser.js` `createStreamParser` | `opp-parser.js` `createOppStreamParser` |
| 写入 | `db.js` `createWriter`，1000 手/事务 | `opp-db.js` `createOppWriter`，500 手/事务 |
| 表 | `hands` | `opp_hands` + `opp_player_hands` |
| 视角 | 只记 Hero 一行 | 每手每个在座玩家一行（6-max 约 5.4 行/手） |
| 消费 | `/api/report` `/api/hands` | `/api/opponents` `/api/opp-hands` |

两条管道共用同一份 `upload_files`（多出一列 `kind`）、同一套临时文件/回滚/sha256 去重逻辑。18MB / 15,777 手 hero 约 1.7 秒；44MB / 35,439 手 / 189,811 玩家行的对手牌谱走 HTTP 全量约 21 秒（本地 `reimport-opp.js` 直调 writer 约 37 秒，慢是因为多算了 170 次整文件 sha256）。

**上传完原始 txt 就删了**，所以给对手表加新列之后，历史数据只能靠本地牌谱文件夹重跑 `server/scripts/reimport-opp.js`。它删掉全部 `kind='opp'` 的行再逐文件重导，入库口径（sha256 / size / `kind`）与 `handleUpload` 完全一致，`hands` 表一行不动。

前端只 fetch API，页面里不内嵌数据。这是相对两个 Python 脚本唯一的架构差异（README 既定）：

- 数据页热图弹窗原本内嵌全量明细（1.8MB HTML 的大头），现在点击时才 `GET /api/hands?cards=<牌型>&stakes=<报表保留的级别>`
- 复盘页筛选/排序/分页从前端全量数组换成服务端 SQL，前端只持有当前一页

## 不变量（改代码前必读）

1. **金额一律用「分」整数累加**，只在输出层除 100。浮点累加会让筹码守恒校验挂掉。列名带 `_cents` 的都是整数分。
2. **`pyRound()` 是 Python 的银行家舍入**（`.5` 进偶数），`report.js` 和 `data.js` 各有一份。不要换成 `Math.round`，数字会跟脚本口径分叉。
3. **两套格式化函数别混用**：`nfmt/sfmt` 带千分位（对应 Python `f"{v:,.2f}"`），`sfix` 不带（对应 `f"{v:+.1f}"`，bb/100 用这个）。曾经因为 bb/100 用了带千分位的版本出现 `+1,237.9` vs `+1237.9`。
4. **两层去重**：文件级 `upload_files.sha256` UNIQUE（命中直接跳过，不重复解析）；手牌级 `hands.hand_id` 主键 + `INSERT OR IGNORE`（重叠时段的牌谱可放心叠加）。对手侧同理：`opp_hands.hand_id` 主键 + `(hand_id, player)` 复合主键，重复手牌**连玩家行一起跳过**（`createOppWriter` 靠 `r.changes === 0` 判断，别改成先写玩家行）。
5. **筹码守恒校验**：每手「净投入和 + SPLASH == Total pot」（±0.03），结果存 `hands.check_ok`，上传返回里报通过率。当前样本 29658/29658。这个校验是解析正确性的主要护栏，别绕过。对手侧同一思路存 `opp_hands.check_ok`（±0.03），当前 35436/35439。
6. 解析必须**流式**（`readline` 逐行）。不要 `readFileSync().split('\n')`，样本就有 35MB。
7. **两套牌谱格式是两个解析器，别去合并**。CoinPoker 导出两种格式，行文法不同（见下节），共用一个状态机只会两边都写错。判定用 `isOppHeader(line)`，上传时顺手校验、拖错区直接 400。

## 两种牌谱格式

同一个 CoinPoker 导出出来的两套文法，**不能混用解析器**：

| | 我的牌谱（hero） | 对手牌谱（opp） |
|---|---|---|
| 头行 | `CoinPoker Hand #105333700003: NLH (₮0.05/₮0.10) 2026/08/06 20:14:31 CST` | `CoinPoker Hand #114731000243: Hold'em No Limit (₮0.50/₮1.00) - 2026/08/19 15:57:11 +00` |
| 游戏名 | `NLH` | `Hold'em No Limit` |
| 时间 | 无 `-` 分隔，`CST` | 有 `-` 分隔，`+00` |
| ante | `(₮x/₮y)` + `posts ante` | 头行里 `(₮x/₮y - Ante ₮z CPCC)` + `posts the ante` |
| 玩家名 | `Hero` + `P1..P5` 匿名 | 真实用户名，**没有 Hero** |
| 底牌 | `Dealt to Hero [Ah Kd]` | 只有摊牌才有牌 |
| 全下 | 单独一行 `ALLIN ₮x` | 动作行后缀 ` and is all-in` |
| 退还 | `RETURN ₮x` | `Uncalled bet (₮x) returned to <name>` |
| 摊牌标记 | `*** SHOWDOWN ***` | `*** SHOW DOWN ***`（**中间有空格**） |
| 促销 | `SPLASH` 注入 | 无，但 ante 会被抽走一部分进彩池 |

对手格式的行型是**封闭集合**（把 170 个文件全量枚举过，27 种行型），没有 straddle / AUTOBB / SPLASH / run it twice。

**对手格式不满足整桌零和**：`Σnet == -rake` 在 35,439 手里有 259 手不成立（其中 256 手带 ante），因为 CPCC ante 有一部分被抽进彩池、不进底池 —— 和 hero 格式的 SPLASH 是同一类东西。所以护栏只用**每手筹码守恒**（`|Σ投入 - Total pot| ≤ 0.03`），别再去加零和断言。另外 `Uncalled bet` 退还要作为**负投入**累加进同一个和里；只累加正投入的话通过率从 99.98% 掉到 99.94%。

剩下那 3 手守恒失败的是**源数据本身有问题**（比如 `#114731000243`：Total pot ₮34.14 而 Rake 记成 ₮18.65），不是解析 bug，`check_ok=0` 如实记下即可。

## 与 poker_report.py 的两处有意分歧

以 `hand_browser.py` 为解析基准（更严格且有守恒校验），因此：

1. **AUTOBB 计入投入但不计入 committed**，`poker_report.py` 计入 → 金额类差约 0.25₮（total net -397.25 vs -397.00，rake_est 403.57 vs 403.63）
2. **翻前 ALLIN 开池算 raise**（report 记作 bet）→ 偷盲/大盲防守的分母把「全下开池」也算进去，`bbdef` 差 0.1~0.2 个点

看到 `/api/report` 与旧 Python 输出有数值差，先对照这两条，别当 bug 修。

## API

| 接口 | 说明 |
|---|---|
| `POST /api/upload[?kind=opp]` | 原文直传，返回 `{status, kind, file, stats, totals, opp}`；`status` 可能是 `duplicate_file`；格式不匹配返回 400 并提示该拖哪个区 |
| `GET /api/files` | 上传历史（带 `kind`）+ 两侧库存（`totals` / `opp`） |
| `GET /api/totals` | 手数/净盈亏/时间范围/分级别明细（hero） |
| `GET /api/opp-totals` | 对手侧库存：手数/玩家数/时间范围/分级别/守恒通过数 |
| `GET /api/hands` | 20+ 筛选参数 + `page/per/sort/dir`，返回 `{page,per,total,pages,summary,rows}` |
| `GET /api/report?minHands=100&from=&to=&stakes=` | `build_stats()` 聚合，全量约 0.4s；筛选参数下推到 SQL |
| `GET /api/opponents` | 每个对手一行 HUD，全量 578 人约 0.45s |
| `GET /api/opp-hands?player=<名字>` | 以该对手为 Hero 的逐手复盘，筛选项与 `/api/hands` 同名同义；缺 `player` 返回 400 |

`/api/hands` 参数（全部走 SQL，见 `hands.js` 的 `buildWhere`）：`stakes` `pos`（逗号分隔）、`hid`（`hand_id` 精确匹配，逗号分隔，容忍 `#` 前缀）、`from` `to`、`h1` `h2`（小时可跨天如 21~6）、`pa` `rt` `fc` `f3` `join` `h4b`、`cards`（2/3/4 字符 token，逗号分隔）、`grp`（`pair|brdy|bs|bo|conn|gap1|axs`）、`fb`（翻牌面牌型，逗号分隔取「或」：`mono|two|rb|str|hi3|hi2|hi1|lo3|pair|trips`）、`st` `sd` `sdw` `ai` `nf`、`res` `bbMin` `bbMax` `potMin` `potMax`、`opp`、`fileId`。`sort` 只接受 `t|potbb|net|bb`（白名单，别改成拼接列名）；`per` 上限 500。

`h4b`（`1`/`0`）看的是 `raises_pf_json`（Hero 翻前每次加注**之前**的加注数数组，`[0]`=只开池、`[0,2]`=开池后再 4bet、`[2]`=冷 4bet、`[1,3]`=3bet 后 5bet），`EXISTS json_each(...) WHERE value >= 2` 即「Hero 做过 4bet 及以上」。**别和 `rt=4b` 搞混**：`rt` 只看 `rn`（Hero 首个动作），漏掉「开池被 3bet 后 4bet」这类最常见的 4bet 池 —— 当前库 `h4b=1` 502 手 / `rt=4b` 只有 74 手。

`fb` 直接在 `flop` 文本上按定长位置取牌（第 1/4/7 位是三张牌，run it twice 只取第一个牌面），所以必须先卡 `length(flop) >= 8` 把没翻牌的手排掉，否则 `instr` 返回 0 会混进结果。口径：高张 = `T~A`（序号 ≥ 9），`hi3/hi2/hi1/lo3` 按高张张数分档，四档互斥且覆盖全部有翻牌的手；`mono/two/rb` 同理按花色分三档；`str` = 三连张（点数互不相同且极差 2，另加 A23 轮子，用 `min=1 AND max=13 AND 和=16` 唯一识别）；`pair` 不含 `trips`。

行字段是缩写（`id t ts lv bl pos cd hg pa rba rn f3 st sd sdw ai nf pot potbb net bb inv col rk sp fl tu ri opp act`），前端直接按这套用。

`/api/report` 顶层：`meta / overview / overall / by_stakes / by_pos / by_day / by_hour / groups / top_wins / top_losses / sessions / cumulative / stakes`；空库返回 `{empty:true}`。`meta.player` 从牌谱文件名按 `_` 取第 2 段（沿用 Python 取法）。

`/api/report` 的筛选参数：`from` `to`（`YYYY-MM-DD`，按 `ts_text` 整天闭区间，口径和 `hands.js` 一致）、`stakes`（逗号分隔），都在 `loadHands()` 里下推到 SQL WHERE，不是聚合完再过滤。**`minHands` 的默认值是动态的**（在 `index.js` 的路由里算）：无筛选 `100`，带了任一筛选就 `0` —— 否则一选窄时间段所有级别都掉到 100 手以下，整份报表被剔空。显式传 `minHands` 仍然优先。筛选条件回显在 `meta.filters`，`{empty:true}` 响应里也带，前端靠它区分「库是空的」和「筛没了」。

### `/api/opponents`

参数：`q`（玩家名模糊，`LIKE ... ESCAPE '\'`，`%` `_` 已转义）、`minHands`（默认 **30**，走 `HAVING COUNT(*) >= ?`）、`from` `to`、`stakes` `pos`（逗号分隔）、`sort` `dir` `page` `per`（1 基页码，`per` 默认 50 上限 500）。`sort` 白名单：`hands|player|net|bb100|vpip|pfr|t3b|f3b|steal|cbet|fcb|wtsd|wsd|wwsf|af`，非法值回落 `hands`。

返回 `{page, per, total, pages, minHands, filters, summary, rows}`。**`summary` 受 WHERE 影响但不受 `minHands` 影响** —— 前端汇总条靠这个显示「符合条件的 N 人 / 全部 M 人」。

指标一律 `SUM(分子)/SUM(分母)`，**分母为 0 时返回 `null` 而不是 0**（`pct()` 里的 `CASE WHEN ... ELSE NULL`），排序时用 `ORDER BY (expr IS NULL), expr` 把 null 沉底。前端把 `null` 渲染成 `—`，别在任何一层拿 0 冒充「没数据」。

口径（分子 / 分母，都是 `opp_player_hands` 上的 0/1 列）：

| 指标 | 分子 / 分母 |
|---|---|
| VPIP / PFR | `vpip` / `pfr` ÷ 总手数 |
| 3Bet | `t3b` ÷ `t3b_opp`（面对且仅面对 1 次加注时） |
| 弃3Bet | `f3b` ÷ `f3b_opp`（开池者被 3bet 的**紧接下一个动作**是弃牌） |
| 偷盲 | `steal` ÷ `steal_opp`（CO/BTN/SB 且前面无人自愿入池） |
| CBet | `cbet` ÷ `cbet_opp`（翻前最后加注者进了翻牌） |
| 弃CBet | `fcb` ÷ `fcb_opp`（面对翻牌 cbet） |
| WTSD | `wtsd` ÷ `saw_flop` |
| W$SD | `sd_won` ÷ `wtsd` |
| WWSF | `wwsf` ÷ `saw_flop` |
| AF | `agg_bets` ÷ `agg_calls`（翻后三街的下注+加注 ÷ 跟注） |
| bb/100 | `100 * SUM(net_cents / bb_cents) / COUNT(*)` |

**弃3Bet 容易写错**：不能「标记开池者，之后见到他弃牌就算」—— 开池者 4bet 之后在河牌弃牌会被误计。`opp-parser.js` 用 `f3bPending` 只认紧接的那一个动作。

### `/api/opp-hands`

「把某个对手当成 Hero」的复盘接口（`opp-hands.js`）。`player` 必填（缺了在路由层直接 400），其余参数与 `/api/hands` **同名同义**，前端因此能照抄 `review.js`。查询是 `opp_player_hands p JOIN opp_hands h USING (hand_id)`。

能这么省事的关键：`hands.js` 里的 `GROUP_SQL` / `FLOP_SQL` / `SEQ_SQL` / `HA_STREETS` 引用的都是**裸列名**（`hand_group` / `flop` / `seq_json`），这些列在两张对手表里各只出现一次，JOIN 后无歧义 —— 所以这四组片段是 `export` 出来原样复用的，改它们时对手复盘页会跟着变。反过来，两张表都有的 `file_id` / `ts` / `ts_text` / `stakes` / `bb_cents` 在这个文件里**必须带 `p.` 前缀**。

筛选项到列的映射（左边是与 `/api/hands` 共用的参数名）：

| 参数 | 对手侧实现 | 参数 | 对手侧实现 |
|---|---|---|---|
| `pa` / `rt` | `pa` / `pa='R' AND rn=0\|1\|>=2` | `st` / `sd` | `h.st` / `h.sd`（**手牌级**） |
| `f3` | `f3b_opp`（有没有被 3bet 这个机会） | `sdw` | `sdw`（1 赢 / 0 输 / 2 平 / NULL 未摊） |
| `join` | `pa <> 'F'` / `pa = 'F'` | `ai` | `allin` |
| `agg` / `def` | `pf_agg` / `pf_def` | `nf` | `h.nf` |
| `h4b` | `pf4b` | `ip` / `oop` | `nf=2 AND saw_flop=1 AND flop_first=0/1` |
| `cards` / `grp` | `cards` / `hand_group` + `GROUP_SQL` | `ha` + `hs` | `seq_json` + `SEQ_SQL` |
| `fb` | `h.flop` + `FLOP_SQL` | `opp` | `instr(upper(opp_cards), ?)` |

响应形状与 `/api/hands` 对齐（同一套缩写字段名），差异四处：

1. **没有 `sp`** —— 对手牌谱格式里不存在 SPLASH
2. `summary.sawFlop` 用**玩家级 `saw_flop`**（他真的进了翻牌），不是 Hero 侧的 `st >= 1`（那其实是「牌局走到了翻牌」）
3. 多一个 `playerTotal`：该玩家不带筛选的总手数，分页条「命中 X 手 / 该玩家共 Y 手」用
4. 每行多一个 `ps`：同桌清单 `[{n, pos, net}]`（本页 id 一条 `WHERE hand_id IN (…)` 查出来）。动作流里是真实用户名，靠它才读得懂谁在什么位置

**`sdw` 故意是从 `wtsd` 派生的**（走到摊牌），不是「有没有 shows 行」—— 这样 `SUM(sdw=1)/SUM(sdw IS NOT NULL)` 恰好等于 `/api/opponents` 的 `sd_won/wtsd`，两个页面的 W$SD 不会打架（实测 RiverDeuce 两边 62.5% / 275 次摊牌逐位相同）。摊牌里选择盖牌的人没有 `cards`，所以 `cards` 非空（9,043 行）少于摊牌行数（11,271 行）。

## 库表

`upload_files(id, filename, sha256 UNIQUE, size, hands_total, hands_new, check_total, check_passed, uploaded_at, kind)`

`kind` 是 `'hero'`（缺省）或 `'opp'`，老库靠 `openDb()` 里的 `addMissingColumns()`（`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`）自动补列（已在 38,457 手的真实老库上验证过：补列 + 建对手两张表 + 原数据不动）。同一个 helper 也负责给两张对手表补「复盘明细」列。**补列而不是 DROP 重建**：老行拿默认值（`''` / `0` / `NULL`），HUD 照常算，只是复盘页对老行没手牌没动作流 —— 重导后才完整，绝不能悄悄删用户数据。

`hands(hand_id PK, file_id, ts, ts_text, stakes, blinds, sb/bb/ante_cents, pos, cards, hand_group, pa, rba, rn, faced_3bet, st, sd, sdw, ai, nf, pot/net/inv/col/rake/splash_drop_cents, flop, turn, river, opp, act, seq_json, street_agg_json, facing_bet_json, raises_pf_json, rake_share_cents, saw_flop, remaining, folded_to_hero, walk, folded_to_3bet, hero_folded_street, check_ok)`

`pos` 是 `POS_ORDER=['UTG','MP','CO','BTN','SB','BB']` 的下标，`-1` = 未识别。`ts` 是分钟戳（与前端 `t` 一致），日期筛选用 `ts_text`。索引在 `ts` / `(stakes,ts)` / `pos` / `hand_group` / `file_id`。加字段要同步改三处：`SCHEMA`、`INSERT_HAND`（含 `Array(44)` 的占位数量）、`handRow()`。

### 对手侧两张表（`opp-db.js`）

`opp_hands(hand_id PK, file_id, ts, ts_text, stakes, blinds, sb/bb/ante_cents, table_name, seats, nf, pot/rake_cents, flop, turn, river, st, sd, act, check_ok)` —— 一手一行，21 列。末尾三列是给复盘页用的：`st` 牌局走到的最后一街（0..3，**手牌级**，跟某个人有没有弃牌无关）、`sd` 本手有没有摊牌、`act` 动作流。

`opp_player_hands(hand_id, player, file_id, ts, ts_text, stakes, bb_cents, pos, inv/col/net_cents, vpip, pfr, t3b_opp, t3b, f3b_opp, f3b, steal_opp, steal, saw_flop, wtsd, sd_won, wwsf, cbet_opp, cbet, fcb_opp, fcb, agg_bets, agg_calls, allin, folded_street, seat, cards, hand_group, opp_cards, pa, rn, rba, pf4b, pf_agg, pf_def, sdw, flop_first, seq_json, PRIMARY KEY(hand_id, player))` —— 一手每个在座玩家一行，44 列。

前 31 列是 HUD 的 0/1 计数；`seat` 之后那 13 列是**逐手复盘明细**，列名与口径刻意照抄 `hands` 表的同名列，好让 `hands.js` 的筛选 SQL 原样复用（见 `/api/opp-hands`）：`cards` 摊牌亮出的底牌（`'AhKd'`，没亮为空串）、`hand_group` 起手牌型、`opp_cards` 同桌其他人亮出的牌、`pa` 翻前首个动作（`F/C/R/X`，整手没动过也记 `X`）、`rn` 首次加注的层级（0 开池 / 1 3bet / …，没加注为 NULL）、`rba` 首次决策前的加注数、`pf4b`、`pf_agg`（他是翻前最后加注者）、`pf_def`、`sdw`、`flop_first`（翻牌第一个说话 —— 比 Hero 侧 `substr(act, instr(act,'|')+1, 2)` 那个字符串判定稳得多）、`seq_json` 自己的逐街动作种类。

`ts` / `ts_text` / `stakes` / `bb_cents` / `pos` 在玩家表里是**故意反范式**的：`/api/opponents` 的筛选和聚合因此只扫一张表，不用 JOIN `opp_hands`。加字段要同步改三处：`OPP_SCHEMA`、`INSERT_OPP_PLAYER` 的占位数量（现在 `Array(44)`）、writer 里 `stP.run()` 的实参顺序。索引在 `player` / `(player,ts)` / `ts` / `stakes` / `file_id`（`(player,ts)` 是给单玩家复盘查询加的）。

`act` 的格式与 Hero 侧同构（四街以 `|` 连接，段内「演员 动作码」交替、单空格分隔，动作码 `f/x/c<额>/b<额>/r<到额>`，全下后缀 `!`），唯一区别是**演员是真实用户名而不是 `H`/`P1..P5`** —— 用户名不含空格（`RE_SEAT` 是 `(\S+)`）、金额也不含空格，所以前端按空格切开后「偶数位 = 演员」是可靠的。


## 打包成绿色版 exe

`bash scripts/build-sea.sh` → `dist/my-h2n.exe`（约 84MB，已 gitignore）。单文件发给别人双击即用：起服务 + 用默认浏览器打开 localhost:3000，数据库建在 **exe 同目录的 `data/`**。

路线是 Node SEA：esbuild 把 ESM 打成单个 CJS（SEA 入口只支持 CJS）→ `node --experimental-sea-config sea-config.json` 生成 blob（`client/` 的 13 个文件作为 SEA assets 嵌进去）→ 复制 node.exe → postject 注入。esbuild / postject 都走 npx，**只是构建期工具，不进 dependencies**，运行时产物仍零依赖。

`index.js` 里靠 `isSea()` 分双支，非 SEA 分支行为与打包前逐字相同。四个必须记住的约束：

1. **SEA 分支绝不能碰 `import.meta.url`** —— esbuild 输出 CJS 时它被编译成 `undefined`，`fileURLToPath(undefined)` 直接抛 `ERR_INVALID_ARG_TYPE`。构建时那条 `empty-import-meta` 警告是预期的（该行只在开发模式执行）。
2. **asset key 一律正斜杠**。Windows 上 `normalize('/vendor/x.js')` 会给出 `vendor\x.js`，不转回 `/` 就取不到 `vendor/chart.umd.min.js`，表现为图表画不出来。
3. **`getAsset()` 找不到 key 是抛异常**（`ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND`），不是返回 undefined，必须 try/catch。
4. **postject 必须传 `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`**。Node 编译时覆盖了 postject 的默认 sentinel；不传则注入「成功」但 `isSea()` 永远 false，exe 表现为空跑退出。

新增 client 文件必须同步加进 `sea-config.json` 的 `assets`，否则开发模式好使、exe 里 404。`main-sea.js` 不能用顶层 await（`--format=cjs` 直接报错）。`disableExperimentalSEAWarning` + `execArgv:["--no-warnings"]` 一起用来消掉 SEA 和 `node:sqlite` 的实验性警告，去掉任一条对方开窗就会看到英文报警。

postject 注入后 node.exe 原有的 OpenJS Foundation 签名失效（构建时 `warning: The signature seems corrupted!` 是预期的），对方首次运行 SmartScreen 可能拦，需点「更多信息 → 仍要运行」。

## 已验证 / 未验证

已验证：

- 解析层 29,658 手 × 29 字段与 Python 全等，净盈亏 -393.19 一致，守恒 29658/29658
- `/api/hands` 汇总用 Python 基准交叉验算「全部」「3bet」两个子集，9 项指标全等
- `/api/report` 与 `poker_report.py` 递归比对：结构量全等（场次 28/28、by_day 13/13、牌型 169/169、曲线点 1186/1186），15 处数值差全部来自上面两处有意分歧
- 展示层：237 条渲染字符串与 Python f-string 逐条比对，0 不一致
- 两个页面用 DOM/Chart/fetch 桩做过无头冒烟
- `dist/my-h2n.exe` 在带空格和中文的空目录里跑通：10 个静态资源 HTTP 200 且字节数与磁盘全等、路径穿越被挡、上传管道（临时文件→流式解析→回滚→清理）完整、拷入真实库后 `/api/totals` 29658 手 / `/api/report` net -397.25 / by_day 13 / 牌型 169 / 场次 28 与基准逐项吻合、端口占用时有中文提示且不闪退、控制台无任何实验性警告

对手管道（走真实 HTTP，170 个文件 44MB，临时 `DATA_DIR`）：

- 全量入库 35,439 手 / 189,811 玩家行 / 578 人 / 21s；守恒 35,436/35,439（失败的 3 手是源数据 rake 异常，已核对原文）
- 与「直接调 writer」的那次结果**逐项相等**（手数/玩家行/人数/守恒），说明 HTTP 层没吞行
- VPIP / PFR / 手数用**另写一份纯文本扫描**（不共用解析器逻辑）对 4 个玩家交叉验算，全等
- `/api/opponents` 全量聚合 0.45s；筛选（`q` / `pos` / `stakes` / `from`-`to` / `minHands`）、分页、15 个排序键、空结果、非法 `sort=DROP TABLE` / `dir=xx` / `page=-5`（回落白名单与默认值）、`q=%`（LIKE 通配符被转义 → 0 命中）都验过
- 拖错区两个方向都返回 400 中文提示且**不留残留**（`upload_files` 不增行、两张对手表无孤儿行、`opp_hands` 无缺玩家行的手）
- sha256 重复文件返回 `duplicate_file` 且消息里带「对手牌谱」字样
- 老库（38,457 手、无 `kind` 列、无对手表）启动后自动迁移：补列、建表、原数据与 `/api/report` `/api/hands` 不受影响；无对手数据时 `/api/opponents` `/api/opp-totals` 返回空结构而不是报错
- hero 管道回归：18MB / 15,777 手、守恒 100%、`kind='hero'`，与对手数据同库共存
- `reset.js` 在「有对手表」和「无对手表（老库）」两种库上都跑通
- `sea-config.json` 的 assets 与 `client/` 实际文件逐一对上（只差有意不打包的 `README.md` 和 0 字节死文件 `src/index.js`），blob 能正常生成

对手复盘（加了 16 列新字段 + `/api/opp-hands` 之后）：

- `reimport-opp.js` 重导 170 个文件 37s：35,439 手 / 189,811 玩家行 / 578 人 / 守恒 35,436 —— 与加字段之前**逐位相同**，说明新字段没碰坏原有口径
- 新列落盘自洽：`cards` 非空 9,043 行、`hand_group` 同为 9,043（一一对应）、`sdw IS NOT NULL` 11,271 == `wtsd` 11,271、`sdw=1` 5,498 == `sd_won` 5,498、`seq_json` 无一行是默认 `'{}'`、`act` 35,439 手全非空
- 同一玩家不加筛选，`/api/opp-hands` 的 summary 与 `/api/opponents` 的 hands / VPIP / PFR / bb100 / net / W$SD **逐项相等**（RiverDeuce：6,670 手 / 22.68% / 18.23% / +4.209 / 280.77 / 62.55%）
- 46 组筛选/排序/分页参数逐个打过：SQL 全部不报错，互斥项两两相加等于总数（`join` 1678+4992、`agg` 931+5739、`def` 578+6092 都 = 6670）
- 抽一手真手牌（`#114567800283`）把 `act` 与原始牌谱**逐行对照**：7 个翻前动作的顺序/金额、三条街的 `b`/`c`、河牌全下的 `!` 后缀、`pot`/`rake`、6 个人的位置（button 座位 → BTN、SB 贴小盲）、`opp_cards` 全部吻合
- 缺 `player` 返回 400；`sort=net_cents;DROP` 回落到默认排序；未知 `grp` 返回中文错误；不存在的玩家返回空结构（`total` / `playerTotal` 0、`bb100` null）而不是报错
- 真实老库上跑 `openDb()` 自动补列：`opp_hands` 18→21 列、`opp_player_hands` 31→44 列，`hands` 38,457 手不动
- hero 侧回归：`/api/totals`（38,457 手 / +102.89）、`/api/hands`、`/api/report` 输出与改动前一致（`hands.js` 只加了 `export`）
- `opp-review.js` 引用的 36 个 DOM id 与 `opp-review.html` 全部对得上；两个新文件语法检查通过、HTTP 200

**没验证**：真实浏览器里的图表绘制、热图点击弹窗、筛选器交互（exe 里同样没验证，只确认了 Chart.js 的字节流对得上）。**对手页的表格/chip/分页/排序渲染、上传页两个拖拽区的交互也没在浏览器里验证过。对手复盘页（`opp-review`）整页渲染 —— 复盘按钮跳转、30 个筛选项、点行展开动作流与同桌清单、排序翻页、未摊牌显示 `—` —— 全部没在浏览器里验证过。** 动前端渲染的话，改完让用户开页面确认，别声称已测。

## 坑

- **`test_poker/` 已删除**，两个 Python 脚本（`poker_report.py` / `hand_browser.py`）不在仓库里了。它们只是口径基准，运行时不依赖。`server/scripts/verify.js` 需要 Python 基准 JSON 才能跑，现在跑不了 —— 别指望它当回归测试。
- **Windows / MSYS bash**：`node -e` 里写 `/tmp/x.json` 会被翻译成 `D:\tmp\x.json` 导致 ENOENT。临时产物写到 `server/data/`（项目内且已 gitignore）。
- **清库走 SQL 不删文件**（`reset.js` 用 DELETE + VACUUM），因为 Windows 上服务端占着 db 文件删不掉；这样服务端也不用停。
- 改完服务端记得**重启进程**，否则 API 还是旧的。端口占用查 `netstat -ano | grep ":3000"`，杀进程 `taskkill //PID <pid> //F`。
- 数据页 4 张图的 canvas id：`cumChart dailyChart posChart posVpipChart`（`cumBBChart` / `hourChart` 已按要求删掉，但服务端仍返回 `cumulative.bb` 和 `by_hour`）；热图键的推法是 `i===j ? r1+r2 : i<j ? r1+r2+'s' : r2+r1+'o'`，手数 <15 画灰点，配色 ±150 截断。
- 数据页带筛选后**整页会重渲染**：图表必须先 `destroy()`（都记在 `charts[]`，用 `mkChart()` 创建），热图点击必须委托到 `#heatmap`（表格每次重建），热图弹窗缓存必须 `cache.clear()`，弹窗请求必须带上当前的 `from`/`to`/`stakes` 才能跟格子数字对上。
- 复盘页没有 header（已按要求删掉），库存概要在 `#sumbar` 汇总条里。
- **上传的格式校验只在解析出 0 手时才报错**（`wrongFormat && stats.total === 0`）。判定是流式过程中顺手做的：见到 `CoinPoker Hand` 开头的行就比 `isOppHeader(line)` 和当前 `kind`。别改成「一发现不匹配就中断」—— 那样混了个别脏行的正常文件会整份传不上去。
- **文件级 sha256 去重排在格式校验之前**。同一个文件先传对区、再拖错区，拿到的是 `duplicate_file`（200）而不是格式错误（400）—— 这是有意的，重复文件本来就不该重新解析。
- **对手页的分页页码是 1 基**（`page=1` 起，与服务端一致），跟复盘页 / 对手复盘页的 0 基**不一样**。改分页逻辑时别照抄 `review.js`。
- 对手页的颜色区间 `BAND` 只是「显著偏离常见 NL100 6-max 区间」的提示，**不代表好坏**，也不参与任何计算。改口径时记得同步 `opponents.html` 底部的图例文案。
- **`opp-review.js` 是 `review.js` 的副本**（差四处：请求 `/api/opp-hands` 带 `player`、级别 chips 取 `/api/opp-totals`、未摊牌手牌渲染 `—`、动作流按「偶数位=演员」切分并高亮当前玩家 + 同桌清单）。改复盘页的标签/详情/参数拼装时先想清楚要不要同步过去 —— 刻意不抽公共文件。
- **对手侧加解析字段不会自动回填老数据**：原始 txt 上传完就删了，只能拿源文件夹跑 `server/scripts/reimport-opp.js` 重导（170 个文件约 37s）。老库启动只会 `ALTER TABLE` 补列拿默认值，**不 DROP 重建**，所以老手牌在对手复盘页只是没底牌没动作流。
- `/api/opp-hands` 是两张 opp 表 JOIN，**`file_id` / `ts` / `ts_text` / `stakes` / `bb_cents` 五列两边都有**，写筛选条件时必须带 `p.` / `h.` 前缀，否则 sqlite 报 ambiguous。其余列各只在一边，裸名可用 —— 这正是能复用 `hands.js` 那四组 SQL 片段的前提。
