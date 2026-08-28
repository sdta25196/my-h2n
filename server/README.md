# my-h2n-服务端

牌谱入库 + 查询服务端：把 CoinPoker 现金桌牌谱 txt 解析成一手一行存进 sqlite，对外提供 JSON API，并顺带托管 `client/` 的静态页。

**两套牌谱、两条平行管道**：「我的牌谱」（Hero 视角，`hands` 表）和「对手牌谱」（整桌视角，`opp_hands` + `opp_player_hands`）。CoinPoker 这两种导出的行文法不同，各有一个解析器，靠上传时的 `?kind=` 分流，详见「两种格式」。

**零外部依赖**是硬约束：只用 `node:http` / `node:sqlite` / `node:readline` / `node:crypto` / `node:fs` / `node:stream` / `node:path` / `node:url`。没有 npm 依赖、没有构建步骤、没有框架。ESM（`"type": "module"`），要求 **Node ≥ 22.5**（`node:sqlite` 的起始版本）。

人类向的项目介绍见 [README-HUMAN.md](../README-HUMAN.md)，给 AI 看的约定与坑见 [README-AI.md](../README-AI.md)。

## 快速开始

```bash
node server/src/index.js          # http://localhost:3000
cd server && npm start            # 等价

cd server && npm run reset        # 清库预演（只报数，不删）
cd server && npm run reset -- --yes   # 确认清空

# 对手侧加了新列之后重导（原始 txt 已被删掉的话，得留着源文件夹）
node server/scripts/reimport-opp.js <牌谱文件夹>          # 预演，只报将删多少行
node server/scripts/reimport-opp.js <牌谱文件夹> --yes    # 真删真重导
```

启动后控制台会打印监听地址和数据库路径。前端静态页由同一个进程托管，直接开 http://localhost:3000 即可。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `server/data` | 数据库与上传临时文件目录，启动时自动 `mkdir -p` |

```bash
PORT=8080 DATA_DIR=/data/h2n node server/src/index.js
```

数据库文件是 `$DATA_DIR/poker.db`（已 gitignore），上传中的临时文件落在 `$DATA_DIR/tmp/`，解析完成或失败都会删掉。

> **注意**：服务端没有任何认证、鉴权、CORS 限制或速率限制，`listen(PORT)` 会绑定所有网卡。这是本机单人工具的定位，**不要直接暴露到公网**。

## 目录

```
server/
  package.json          三个脚本：start / verify / reset
  src/
    index.js    228 行  HTTP 路由 + 上传接收（含格式校验）+ 静态托管
    parser.js   499 行  我的牌谱解析器（Hero 视角，状态机，逐行喂）
    opp-parser.js 413 行 对手牌谱解析器（整桌视角，每手每人一行事实 + 复盘字段）
    db.js       292 行  schema + 两层去重 + 批量事务写入 + 老库补列
    opp-db.js   230 行  对手两张表的 schema + 批量写入 + 库存汇总
    hands.js    357 行  GET /api/hands：SQL 筛选 / 排序 / 分页 / 汇总
    opp-hands.js 321 行 GET /api/opp-hands：把某个对手当 Hero 的逐手复盘
    report.js   416 行  GET /api/report：实时聚合（build_stats 移植）
    opponents.js 183 行 GET /api/opponents：HUD 指标 SQL 聚合
  scripts/
    reset.js            清库（DELETE + VACUUM，不删文件，含对手两张表）
    reimport-opp.js     只清对手侧并从源文件夹重导（加了新列后用）
    verify.js           解析器对拍（需 Python 基准 JSON，现已跑不了）
  data/                 运行时生成，gitignore
```

模块依赖是一条单向链，没有环：`index.js` → `{parser, opp-parser, db, opp-db, hands, opp-hands, report, opponents}`，`db.js` → `opp-db.js`（建表 + 回滚），`db.js` / `report.js` / `opp-parser.js` → `parser.js`（取 `POS_ORDER` / `toRecord` / `positionsFor` / `handGroup`），`opp-hands.js` → `hands.js`（取四组 SQL 片段常量，见下）。

两个解析器**只共享 `positionsFor()`**（按钮座位 → 位置名的推导，两种格式的座位规则是同一套）。其余逐字独立，别去合并。

## 数据流

```
POST /api/upload[?kind=opp]  (请求体 = txt 原文)
  │
  ├─ 边收边算 sha256，同时 pipeline 写入 data/tmp/<uuid>.txt
  ├─ sha256 命中 upload_files → 直接返回 duplicate_file，不解析
  ├─ beginUpload({..., kind}) 先插 upload_files 占位行拿 file_id
  ├─ readline 逐行喂 createStreamParser / createOppStreamParser
  │     每识别出一手 → parseHand()/parseOppHand() → writer.add()
  │     writer 每 1000（hero）/ 500（opp）手一个事务 INSERT OR IGNORE
  │     顺带比对每个 header 行的格式与 kind 是否一致（isOppHeader）
  ├─ 解析到 0 手 → abortUpload() 回滚删占位行，返回 400
  │     若同时发现格式不匹配 → 400 并提示该拖到哪个上传区
  ├─ finishUpload() 回填 hands_total / hands_new / check_total / check_passed
  └─ 删临时文件，返回统计（含两侧库存 totals / opp）
```

要点：

- **不走 multipart**。请求体就是 txt 本体，文件名放在 `x-filename` 头里（`encodeURIComponent` 编码，缺省 `unnamed.txt`）。前端多选文件时是逐个串行发请求。
- **全程流式**。`readline` 逐行读，解析器一手一个回调，写入器分批提交，内存占用与文件大小无关。样本 35MB / 29,658 手约 3 秒；对手侧 44MB / 35,439 手 / 189,811 玩家行约 21 秒。不要改成 `readFileSync().split('\n')`。
- **上传体上限 500MB**，靠 `content-length` 预检，超了直接 413。
- 入库必须**先有 `upload_files` 行**才能填 `file_id`，所以拆成 begin / finish 两步；中途异常走 `writer.rollback()` + `abortUpload()`（后者连带清掉本次写进对手两张表的行）。
- **格式校验只在解析出 0 手时才报错**（`wrongFormat && stats.total === 0`）。混了个别脏行的正常文件不会因此整份被拒。
- **sha256 去重排在格式校验之前**：同一个文件先传对区、再拖错区，得到的是 `duplicate_file`（200）而不是 400。重复文件本来就不该重新解析。

## API

所有响应都是 `application/json; charset=utf-8`。出错统一返回 `{ "error": "..." }`，路由层有 try/catch 兜底成 500。`/api/` 开头的未知路径返回 404；非 GET 且非上传的请求返回 405。

### `POST /api/upload[?kind=opp]`

请求体为牌谱原文，头 `x-filename: <URL 编码的文件名>`。`kind=opp` 走对手管道，其余（含缺省）走 hero 管道。

成功：

```json
{
  "status": "ok",
  "kind": "hero",
  "file": { "id": 1, "filename": "...", "sha256": "...", "size": 36700160,
            "hands_total": 29658, "hands_new": 29658,
            "check_total": 29658, "check_passed": 29658,
            "uploaded_at": "2026-...", "kind": "hero" },
  "stats": { "total": 29658, "inserted": 29658, "checkTotal": 29658, "checkPassed": 29658,
             "duplicated": 0, "checkRate": 100, "elapsedMs": 2980 },
  "totals": { "...": "同 /api/totals" },
  "opp": { "...": "同 /api/opp-totals" }
}
```

`kind=opp` 时 `stats` 多一个 `players`（本次写入的玩家-手牌行数）。

文件重复（sha256 命中）：`status` 为 `duplicate_file`，带 `message`（含该文件当初是「我的牌谱」还是「对手牌谱」）和已有的 `file` 行，**不解析**。

错误码：`413` 超过 500MB；`400` 接收失败 / 未解析到任何手牌 / **格式与上传区不匹配**（错误文案会指明该拖哪个区）；`500` 解析入库失败。

### `GET /api/files`

`{ files: [...upload_files 全部行（含 kind），id DESC], totals: {...}, opp: {...} }`

### `GET /api/totals`

```json
{ "hands": 29658, "net_cents": -39319,
  "first_ts": "2026-07-01 20:11:03", "last_ts": "2026-08-13 03:47:55",
  "stakes_count": 3,
  "by_stakes": [ { "stakes": "NL10", "hands": 12034, "net": -120.5 } ] }
```

空库时 `hands` 为 0、`first_ts` / `last_ts` 为 `null`。

### `GET /api/opp-totals`

对手侧库存，给上传页的第二组概览药丸和对手页的空状态判断用：

```json
{ "hands": 35439, "players": 578,
  "first_ts": "2026-08-19 00:00:55", "last_ts": "2026-08-19 23:57:53",
  "stakes_count": 1, "check_passed": 35436,
  "by_stakes": [ { "stakes": "NL100", "hands": 35439 } ] }
```

`players` 是 `COUNT(DISTINCT player)`。空库时 `hands` 为 0，前端靠这个提示「还没上传对手牌谱」。

### `GET /api/opponents`

一行一个对手的 HUD，筛选 / 排序 / 分页全在 SQL 里。参数见 `opponents.js` 的 `buildWhere()`：

| 分类 | 参数 | 说明 |
|---|---|---|
| 玩家名 | `q` | 模糊匹配，`LIKE ? ESCAPE '\'`，`%` 和 `_` 已转义成字面量 |
| 样本量 | `minHands` | **默认 30**，走 `HAVING COUNT(*) >= ?`（不是 WHERE） |
| 时间 | `from` `to` | `YYYY-MM-DD`，比较 `ts_text`，含首尾整天，口径同 `/api/hands` |
| 级别位置 | `stakes` `pos` | 逗号分隔多选；`pos` 传 `POS_ORDER` 下标（0~5） |
| 分页 | `page` `per` | `page` **从 1 起**，`per` 默认 50、上限 500 |
| 排序 | `sort` `dir` | 白名单 15 键，见下；非法值退回 `hands` |

`sort` 白名单：`hands` `player` `net` `bb100` `vpip` `pfr` `t3b` `f3b` `steal` `cbet` `fcb` `wtsd` `wsd` `wwsf` `af`。排序尾巴恒定 `, hands DESC, player ASC` 保证稳定，且前面加 `(表达式 IS NULL)` 把没样本的行沉底。

```json
{ "page": 1, "per": 50, "total": 202, "pages": 5, "minHands": 30,
  "filters": { "stakes": "", "pos": "", "from": "", "to": "", "q": "" },
  "summary": { "rows": 189811, "players": 578, "hands": 35439,
               "vpip": 29.2, "pfr": 20.7, "t3b": 11.1, "wtsd": 31.6 },
  "rows": [ { "player": "RiverDeuce", "hands": 6670, "vpip": 22.7, "...": "..." } ] }
```

**`summary` 受 WHERE 影响但不受 `minHands` 影响** —— 前端用 `total` / `summary.players` 显示「符合条件 X 人 / 池子共 Y 人」，筛完为空时也还能看到池子规模。

指标一律 `SUM(分子) / SUM(分母)`，**分母为 0 返回 `null` 而不是 0**（`pct()` 里的 `CASE WHEN ... ELSE NULL`）。前端渲染 `—`。口径：

| 指标 | 分子 ÷ 分母 |
|---|---|
| `vpip` `pfr` | `vpip` / `pfr` ÷ 总手数 |
| `t3b` | `t3b` ÷ `t3b_opp`（面对且仅面对 1 次加注） |
| `f3b` | `f3b` ÷ `f3b_opp`（开池者被 3bet 后**紧接的那个动作**是弃牌） |
| `steal` | `steal` ÷ `steal_opp`（CO/BTN/SB 且前面无人自愿入池） |
| `cbet` | `cbet` ÷ `cbet_opp`（翻前最后加注者且进了翻牌） |
| `fcb` | `fcb` ÷ `fcb_opp`（面对翻牌 cbet） |
| `wtsd` | `wtsd` ÷ `saw_flop` |
| `wsd` | `sd_won` ÷ `wtsd` |
| `wwsf` | `wwsf` ÷ `saw_flop` |
| `af` | `agg_bets` ÷ `agg_calls`（翻后三街下注+加注 ÷ 跟注） |
| `bb100` | `100 * SUM(net_cents / bb_cents) / COUNT(*)` |

`net` 已除 100。全量 578 人聚合约 0.45s。

所有值走占位符绑定，`sort` 走白名单映射 —— **不要改成拼接列名**。

### `GET /api/hands`

复盘页的筛选 / 排序 / 分页 / 汇总，**全部在 SQL 里完成**，前端只持有当前一页。参数见 `hands.js` 的 `buildWhere()`：

| 分类 | 参数 | 说明 |
|---|---|---|
| 级别位置 | `stakes` `pos` | 逗号分隔多选；`pos` 传 `POS_ORDER` 下标 |
| 手牌编号 | `hid` | 逗号分隔多个 `hand_id` 精确匹配，容忍 `#123456` 前缀 |
| 时间 | `from` `to` | `YYYY-MM-DD`，比较 `ts_text`，含首尾整天 |
| 小时 | `h1` `h2` | 可跨天，如 `21`~`6`；`0`~`23` 视为不筛选 |
| 翻前 | `pa` | `F/C/R/X`，Hero 翻前首动作 |
| 翻前 | `rt` | 加注类型：`open`(rn=0) / `3b`(rn=1) / `4b`(rn≥2)，隐含 `pa='R'` |
| 翻前 | `fc` | 面对：`open`(rba≥1) / `un`(rba=0) |
| 翻前 | `f3` `join` | 是否被 3bet；`join=yes/no` 即 `pa<>'F'` / `pa='F'` |
| 手牌 | `cards` | 逗号/空格分隔 token：4 字符匹配具体两张（`AhKd`），3 字符匹配 `hand_group`（`AKs`），2 字符对儿匹配 `hand_group`、非对儿匹配前两位（`AK` 含 s 和 o） |
| 手牌 | `grp` | `pair` `brdy` `bs` `bo` `conn` `gap1` `axs`，未知值抛错 |
| 过程 | `st` `sd` `sdw` `ai` `nf` | 到达街道 / 有摊牌 / 摊牌结果(1赢 0输 2平) / 全下 / 进翻人数（`nf>=4` 归一档） |
| 结果 | `res` `bbMin` `bbMax` `potMin` `potMax` | `res=win/lose`；bb / 底池 bb 区间 |
| 其他 | `opp` | 对手摊牌牌串模糊匹配（`instr`） |
| 其他 | `fileId` | 限定某次上传 |
| 分页 | `page` `per` | `per` 默认 100、**上限 500**；`page` 从 1 起 |
| 排序 | `sort` `dir` | `sort` 白名单 `t\|potbb\|net\|bb`，非法值退回 `ts`；`dir=asc/desc`，`ts` 默认 desc、其他默认 asc，末尾恒定 `, ts DESC` 保证稳定 |

所有值都走占位符绑定，`sort` 走白名单映射 —— **不要改成拼接列名**。

响应：

```json
{ "page": 1, "per": 100, "total": 1234, "pages": 13,
  "summary": { "hands": 1234, "net": -12.34, "bb100": -1.2, "vpip": 24.5, "pfr": 18.1,
               "sawFlop": 27.3, "showdowns": 210, "wsd": 52.4, "allin": 1.8 },
  "rows": [ { "id": "...", "t": 29876543, "...": "..." } ] }
```

`summary` 口径与 `hand_browser.py` 的 `summary()` 一致；样本为 0 时百分比字段为 `null` 而不是 0。

行字段全是缩写，前端直接按这套用：

```
id t ts lv bl pos cd hg pa rba rn f3 st sd sdw ai nf
pot potbb net bb inv col rk sp fl tu ri opp act
```

`t` 是分钟戳，`ts` 是 `'YYYY-MM-DD HH:MM:SS'` 文本；金额字段在出口除 100 转元，`potbb` 保留 1 位、`bb` 保留 2 位。

### `GET /api/opp-hands?player=<用户名>`

对手复盘页的数据源：**把某个对手当成 Hero** 的逐手复盘。`player` 必填（区分大小写），缺了路由层直接 400 —— 没有它这个接口没有意义。

`FROM opp_player_hands p JOIN opp_hands h USING (hand_id)`，一行 = 这个玩家的一手。**列前缀规矩**：两张表都有的 `file_id` / `ts` / `ts_text` / `stakes` / `bb_cents` 必须写 `p.`（或 `h.`），其余列各只出现在一边，裸名即可。这正是能把 `hands.js` 的 `GROUP_SQL` / `FLOP_SQL` / `SEQ_SQL` / `HA_STREETS` **原样 import 复用**的前提（它们引用的 `hand_group` / `flop` / `seq_json` 都是无歧义裸名）—— 别把牌型判定再抄一遍。

参数名与 `/api/hands` **逐个对齐**（前端因此能照抄 `review.js`），实现上的对应关系：

| 参数 | 对手侧实现 | 参数 | 对手侧实现 |
|---|---|---|---|
| `stakes` `pos` `hid` `from` `to` `h1` `h2` | 同 `/api/hands`，歧义列带 `p.` | `st` `sd` | `h.st` / `h.sd`，**手牌级**（牌局走到哪街 / 这手有没有摊牌） |
| `pa` | `pa` 列（`F/C/R/X`） | `sdw` | `sdw` 列，三态 `1赢 / 0输 / 2平`，未摊牌 `NULL` |
| `rt` | `pa='R'` + `rn = 0 / 1 / >=2` | `ai` | `allin` |
| `f3` | `f3b_opp` | `nf` | `nf`（`nf>=4` 归一档） |
| `join` | `pa <> 'F'` / `pa = 'F'` | `ip` | `nf=2 AND saw_flop=1 AND flop_first = 0/1` |
| `agg` `def` | `pf_agg` / `pf_def` | `ha` + `hs` | `SEQ_SQL` 打在 `seq_json` 上，`hs` 省略则四街 OR |
| `h4b` | `pf4b` | `res` `bbMin/Max` `potMin/Max` | `net_cents` / `pot_cents` ÷ `p.bb_cents` |
| `cards` `grp` | `cards` / `hand_group`（复用 `GROUP_SQL`） | `opp` | `instr(upper(opp_cards), ?) > 0` |
| `fb` | 复用 `FLOP_SQL`，打在 `h.flop` | `fileId` `page` `per` `sort` `dir` | 同 `/api/hands`（`sort` 白名单 `t\|potbb\|net\|bb`） |

`/api/hands` 的 `fc`（面对开池/无人开池）**没有对应参数** —— 复盘页前端也不发它，`rba` 列存了但只用来渲染「面开」标签。

**底牌类筛选（`cards` / `grp`）只对摊牌过的手有效**：对手牌谱只在摊牌时亮牌，没摊牌的手 `cards` / `hand_group` 是 `''`，会被这些条件筛掉。当前样本 35,439 手里有 9,043 条玩家行带底牌。

响应字段名也与 `/api/hands` 对齐，**两处有意差异**：

1. **没有 `sp`**（促销注入）—— 对手牌谱格式里不存在这项。
2. **`summary.sawFlop` 用玩家级 `saw_flop`**（这人真的进了翻牌），不是 Hero 侧的 `st >= 1`（那其实是「牌局走到了翻牌」，Hero 翻前弃牌也算）。这两个口径不一样，别照 Hero 侧对数。

另外多两项：

- `playerTotal` — 该玩家**不带任何筛选**的总手数，分页条「命中 X 手 / 该玩家共 Y 手」用；也是前端判断「库里有没有这个人」的依据（为 0 就提示名字拼错）。
- `rows[].ps` — 本页每手的同桌清单 `[{n, pos, net}]`，一条 `WHERE hand_id IN (...) ORDER BY seat` 查出来（100 手约 540 行）。`act` 里的演员是**真实用户名**，没有这份清单读不出谁在什么位置。

```json
{ "player": "RiverDeuce", "page": 1, "per": 100, "total": 6670, "pages": 67,
  "playerTotal": 6670,
  "summary": { "hands": 6670, "net": 280.77, "bb100": 4.209, "vpip": 22.68, "pfr": 18.23,
               "sawFlop": 25.1, "showdowns": 275, "wsd": 62.55, "allin": 0.9 },
  "rows": [ { "id": "114567800283", "cd": "", "act": "Name1 r3 Name2 f | ...",
              "ps": [ { "n": "Name1", "pos": 3, "net": 12.5 } ] } ] }
```

**`sdw` 是从 `wtsd` 派生的，不是从「有没有 shows 行」派生的**：`SUM(sdw = 1) / SUM(sdw IS NOT NULL)` 因此恰好等于 `/api/opponents` 的 `sd_won / wtsd`，两个页面的 W$SD 不会打架（实测同一玩家逐项相等）。改这列前先想清楚这条。

### `GET /api/report?minHands=100&from=&to=&stakes=`

`poker_report.py` 的 `build_stats()` 移植版，**每次请求实时全量聚合**（约 0.4s / 29,658 手），不落中间表，所以新上传立刻反映到数据页。

筛选参数（数据页的时间 / 级别筛选条用）：

| 参数 | 说明 |
|---|---|
| `from` `to` | `YYYY-MM-DD`，比较 `ts_text` 含首尾整天，口径与 `/api/hands` 完全一致 |
| `stakes` | 逗号分隔多选，`stakes IN (...)` |
| `minHands` | 手数不足的级别整体剔除，被剔的记在 `meta.dropped` |

**`minHands` 的默认值是动态的**（见 `index.js` 的路由）：无筛选时 `100`（保持全量视图的原有行为），一旦带了 `from`/`to`/`stakes` 就默认 `0`。否则用户筛到一个窄区间时，每个级别都可能不足 100 手而被全部剔掉，接口返回 `{empty:true}`，页面看起来像坏了。显式传 `minHands` 始终优先。

筛选条件会回显在 `meta.filters`（`{from,to,stakes}`），`empty` 响应里也带，前端靠它区分「库是空的」和「筛没了」两种提示文案。

顶层结构：

| 键 | 内容 |
|---|---|
| `meta` | `player`（牌谱文件名按 `_` 取第 2 段，沿用 Python 取法）、`sources`、日期范围、`generated`、`min_hands`、`dropped`、`filters` |
| `overview` | 手数 / 净盈亏 / 总 bb / bb100 / `rake_est` / 场次数 / 时长 / 每小时手数 |
| `overall` | 全量指标（`fin()` 输出：VPIP、PFR、3bet、4bet、fold3bet、限进、walk、bbdef、steal、WTSD、W$SD、WWSF、check-raise、三条街 cbet / fold-to-cbet / AFq，都带分母 `*_opp`） |
| `by_stakes` `by_pos` | 同上结构，按级别 / 按 `POS_ORDER` 六个位置 |
| `by_day` `by_hour` | 每日（含分级别净额 `stk`）、24 小时分布 |
| `groups` | 169 个起手牌型 → `{hands, net, bb100}`，喂 13×13 热图 |
| `top_wins` `top_losses` | 各 10 手最大盈 / 亏 |
| `sessions` | 场次明细（相邻两手间隔 **> 60 分钟**切新场次，单场时长下限 1 分钟） |
| `cumulative` | 累计曲线，**每 25 手一个点**：`{x, all, sd, nsd, bb:{级别:[...]}}` |
| `stakes` | 排序后的级别列表 |

空库或全被 `minHands` 剔掉时返回 `{ empty: true }`（后者带 `dropped`）。

### 静态托管

非 `/api/` 的 GET 走 `serveStatic()`：根路径映射到 `client/index.html`，`normalize()` 后校验 `startsWith(CLIENT_DIR)` 防目录穿越，MIME 只认 `.html .js .css .json .svg .ico`（其余按 `application/octet-stream`），统一 `cache-control: no-cache`。

## 库表

`upload_files(id, filename, sha256 UNIQUE, size, hands_total, hands_new, check_total, check_passed, uploaded_at, kind)`

`kind` 是 `'hero'`（缺省）或 `'opp'`。**老库自动迁移**：`openDb()` 里的 `addMissingColumns(db, table, specs)` 用 `PRAGMA table_info` 探测缺哪些列，缺的就 `ALTER TABLE ... ADD COLUMN`（带默认值），对 `upload_files` / `opp_hands` / `opp_player_hands` 三张表各调一次，并补建对手两张表。已在 38,457 手的真实老库上验证过（补 `kind` 列 + 建表 + 18→21 / 31→44 补列，原数据和接口都不受影响）。

**是补列，不是 DROP 重建** —— 老行的新列拿默认值（`''` / `0` / `NULL`），HUD 指标照常，只是这些老手牌在对手复盘页没有底牌和动作流；要补全得跑 `scripts/reimport-opp.js` 重导。**任何情况下都别为了「schema 干净」去 DROP 用户数据。**

`hands(hand_id PK, file_id, ts, ts_text, stakes, blinds, sb/bb/ante_cents, pos, cards, hand_group, pa, rba, rn, faced_3bet, st, sd, sdw, ai, nf, pot/net/inv/col/rake/splash_drop_cents, flop, turn, river, opp, act, seq_json, street_agg_json, facing_bet_json, raises_pf_json, rake_share_cents, saw_flop, remaining, folded_to_hero, walk, folded_to_3bet, hero_folded_street, check_ok)`

- `pos` 是 `POS_ORDER = ['UTG','MP','CO','BTN','SB','BB']` 的下标，`-1` = 未识别。
- `ts` 是分钟戳（与前端 `t` 一致，用于排序）；**日期筛选用 `ts_text`**。
- `_cents` 结尾的都是整数分；`rake_share_cents` 是按投入占比分摊的抽水，唯一的 REAL。
- 四个 `*_json` 列存报表页需要的派生结构（Hero 动作序列、每街最后加注者、每街首个下注者、翻前加注时的加注计数），`report.js` 读的时候 `JSON.parse`。
- 索引：`ts` / `(stakes, ts)` / `pos` / `hand_group` / `file_id`。
- 连接参数：`journal_mode = WAL` + `synchronous = NORMAL`。

**加字段要同步改三处**：`SCHEMA`、`INSERT_HAND`（含 `Array(44)` 的占位符数量）、`handRow()` 的返回数组 —— 三处顺序必须一一对应。

### 对手侧两张表（`opp-db.js`）

`opp_hands(hand_id PK, file_id, ts, ts_text, stakes, blinds, sb/bb/ante_cents, table_name, seats, nf, pot/rake_cents, flop, turn, river, st, sd, act, check_ok)` —— 一手一行，21 列。这张表只存「桌面事实」，不含任何玩家指标。

- `st`（到达的最后一街 0..3）/ `sd`（这手有没有摊牌）/ `act`（动作流）是**手牌级**的，为逐手复盘加的。
- `act` 的格式：四街以 `|` 连接，段内 `演员 动作码 演员 动作码 …` 单空格分隔，**演员是真实用户名**（用户名不含空格、动作码里也没有空格，所以「偶数位 = 演员、奇数位 = 动作」的切分是可靠的）。动作码沿用 hero 侧 `lg()`：`f` / `x` / `c<额>` / `b<额>` / `r<到额>`，全下后缀 `!`。盲注和 ante 不记。

`opp_player_hands(hand_id, player, file_id, ts, ts_text, stakes, bb_cents, pos, inv/col/net_cents, vpip, pfr, t3b_opp, t3b, f3b_opp, f3b, steal_opp, steal, saw_flop, wtsd, sd_won, wwsf, cbet_opp, cbet, fcb_opp, fcb, agg_bets, agg_calls, allin, folded_street, seat, cards, hand_group, opp_cards, pa, rn, rba, pf4b, pf_agg, pf_def, sdw, flop_first, seq_json, PRIMARY KEY(hand_id, player))` —— 一手每个在座玩家一行，44 列。6-max 样本约 5.4 行/手。

- 指标列全是 **0/1 计数**（`*_opp` 是分母、同名列是分子），聚合时直接 `SUM`。**不预先算比率**，比率一律查询时算 —— 这样任意筛选组合下的分母都是对的。
- `ts` / `ts_text` / `stakes` / `bb_cents` / `pos` 在玩家表里**故意反范式**：`/api/opponents` 的筛选和聚合因此只扫这一张表，不用 JOIN `opp_hands`。
- `folded_street` 记这人在哪一街弃牌（`-1` = 没弃）。
- **表尾 13 列是「逐手复盘明细」**，只给 `/api/opp-hands` 用，列名与 Hero 侧同名列同口径（好让 `hands.js` 的筛选 SQL 原样复用）：`cards` / `hand_group` / `opp_cards` **只在摊牌亮牌时才有值**（否则空串）；`pa` 翻前首动作（整手没动过的 BB walk 也记 `X`）；`rn` 自己首次加注的层级（没加注过 `NULL`）；`rba` 首次决策前的加注数（渲染「面开」标签）；`pf4b` / `pf_agg` / `pf_def` 翻前角色位；`sdw` 摊牌结果三态；`flop_first` 翻牌第一个动作是不是自己（判 IP/OOP，比 Hero 侧从 `act` 里 `substr` 稳）；`seq_json` 自己每街的动作种类序列，喂 `SEQ_SQL`。
- 写入顺序是**先 `opp_hands` 再玩家行**，靠 `INSERT OR IGNORE` 的 `r.changes === 0` 判断这手是重复的、直接跳过玩家行。**别调换这个顺序**，否则重复手牌会留下孤儿玩家行。
- 索引：`player` / `ts` / `stakes` / `file_id` / `(player, ts)`（最后这个是单玩家复盘查询走的）。

**加字段同样要改三处**：`OPP_SCHEMA`、`INSERT_OPP_PLAYER` 的占位符数量（现在 `Array(44)`）、writer 里 `stP.run()` 的实参顺序。`opp_hands` 那张表同理三处（`OPP_SCHEMA` / `INSERT_OPP_HAND` / `stH.run()`）。

## 两种格式

同一个 CoinPoker 导出的两套文法，**两个解析器，不要合并**：

| | 我的牌谱（hero） | 对手牌谱（opp） |
|---|---|---|
| 头行 | `... Hand #...: NLH (₮0.05/₮0.10) 2026/08/06 20:14:31 CST` | `... Hand #...: Hold'em No Limit (₮0.50/₮1.00) - 2026/08/19 15:57:11 +00` |
| 时间 | 无 `-` 分隔，`CST` | 有 `-` 分隔，`+00` |
| ante | `(₮x/₮y)` + `posts ante` | 头行 `(₮x/₮y - Ante ₮z CPCC)` + `posts the ante` |
| 玩家名 | `Hero` + `P1..P5` 匿名 | 真实用户名，**没有 Hero** |
| 底牌 | `Dealt to Hero [Ah Kd]` | 只有摊牌才亮牌 |
| 全下 | 单独一行 `ALLIN ₮x` | 动作行后缀 ` and is all-in` |
| 退还 | `RETURN ₮x` | `Uncalled bet (₮x) returned to <name>` |
| 摊牌 | `*** SHOWDOWN ***` | `*** SHOW DOWN ***`（**中间有空格**） |
| 促销 | `SPLASH` 注入 | 无，但 ante 会被抽一部分进彩池 |

判定用 `isOppHeader(line)`。对手格式的行型是**封闭集合**（170 个文件全量枚举，27 种行型），没有 straddle / AUTOBB / SPLASH / run it twice。

**对手格式不满足整桌零和**：`Σnet == -rake` 在 35,439 手里有 259 手不成立（其中 256 手带 ante），因为 CPCC ante 有一部分被抽进彩池、不进底池 —— 和 hero 格式的 SPLASH 是同一类东西。所以护栏只用每手筹码守恒，**别再加零和断言**。

## 解析器

`parser.js` 是逐行喂的状态机，对外三个入口：

- `createStreamParser(onHand)` — `line(text)` 逐行喂、`end()` 收尾；见到 header 行就 flush 上一手。
- `parseHand(lines)` — 解析单手行块，格式非法返回 `null`。
- `toRecord(h)` — 拍平成 29 字段数组，顺序与 `hand_browser.py` 的 `to_record` / 前端 `K` 常量一致。

覆盖的牌谱行：header（含 ante 三档盲注）、`Table ... is the button`、`Seat`、`posts ante/small blind/big blind`、`folds/checks/calls/bets/raises to`、`ALLIN`、`AUTOBB`、`STRADDLE`、`RETURN`、`collected from pot`、`shows`、`Total pot | Rake | Splash Fee`、`SPLASH dropped`、`Seat n: Hero showed ... and won/lost`，以及 run-it-twice 的 `*** FIRST/SECOND FLOP/TURN/RIVER`（第二块牌面用 `; ` 拼接进同一列）。

位置推导：从按钮座位顺时针 `BTN → SB → BB`，余下按人数摊成 `UTG / MP / CO`（只剩 1 人则记 UTG）。对手名字匿名化成 `P1 P2 ...`，Hero 记 `H`，写进 `act` 动作日志。

### `opp-parser.js`

同样的流式三入口：`createOppStreamParser(onHand)` / `parseOppHand(lines)` / `isOppHeader(line)`。位置推导**复用 `parser.js` 的 `positionsFor()`**（唯一共享的东西）。

每手产出 `{...桌面字段, players: [每人一份事实]}`，玩家事实里除了投入/收回/净额，就是那批 0/1 指标位。几个容易写错的地方：

- **弃3Bet 只认紧接的那个动作**。3bet 发生时记 `f3bPending = 开池者`，只有这人**下一个动作**是弃牌才计 `f3b = 1`。若按「标记后见到弃牌就算」，开池者 4bet 之后在河牌弃牌会被误计。
- **ante 不进 `committed`**（与 hero 侧 AUTOBB / ante 同口径），否则其后 `raises to X` 的比较基准就错了。
- **`Uncalled bet` 退还按负投入累加**进同一个守恒和里。只累加正投入的话通过率从 99.98% 掉到 99.94%。
- `cbet` 的归属是**翻前最后一个加注者**（`pfAgg`），不是开池者。
- `wtsd` = 有摊牌且这人没弃牌；`sd_won` = `wtsd` 且净额 > 0；`wwsf` = 看到翻牌且净额 > 0。

复盘用的那批字段是在**同一趟循环**里顺手攒的，位置很讲究（这是个状态机，`decided` / `raises` / `opener` / `pfAgg` / `f3bPending` / `flopBetBy` 的时序不能动）：

- `pa` / `rba` 写在 `!decided.has(who)` 分支里（首次决策那一刻的现场），`rn` 写在 `kind === 'raise'` 且 `p.rn === null` 时（取当时的 `raises`）。
- `oppCards` / `pfAggFlag` / `pfDef` / `sdw` 只能在**末尾派生阶段**算：`shows` 行在河牌动作之后才到，`pfAgg` 循环里还会变，`sdw` 依赖已经算好的 `wtsd` 和净额。
- `sdw` 用 `wtsd` 判定（走到摊牌），**不是**「有没有 `shows` 行」—— 这样 `/api/opp-hands` 的 W$SD 和 `/api/opponents` 才对得上。
- 摊牌亮出的底牌顺手过一遍 `parser.js` 的 `handGroup()` 存成 `hand_group`，起手牌型筛选因此能复用 hero 侧的 SQL。


## 不变量（改代码前必读）

1. **金额一律用「分」整数累加**，只在输出层除 100。浮点累加会让筹码守恒校验挂掉。
2. **`pyRound()` 是 Python 的银行家舍入**（`.5` 进偶数），不要换成 `Math.round`，数字会跟 Python 基准口径分叉。`report.js` 和前端 `data.js` 各有一份。
3. **两层去重**：文件级 `upload_files.sha256` UNIQUE（命中直接跳过，不重复解析）；手牌级 `hands.hand_id` / `opp_hands.hand_id` 主键 + `INSERT OR IGNORE`（重叠时段的牌谱可放心叠加上传）。
4. **筹码守恒校验**：每手「全桌净投入和 + SPLASH 注入 == Total pot」（容差 3 分），结果存 `hands.check_ok` / `opp_hands.check_ok`，上传响应里报通过率。当前样本 hero 29658/29658、对手 35436/35439（失败的 3 手是源数据 rake 异常，已核对原文，不是解析 bug）。这是解析正确性的主要护栏，**别绕过**。
5. 解析必须**流式**，样本就有 35MB / 44MB。
6. `AUTOBB` 与 ante 同口径：**计入投入但不计入 committed**（其后 `raises to X` 的 X 不含 AUTOBB）。对手格式的 CPCC ante 同理。
7. **两套格式两个解析器**，只共享 `positionsFor()`。别为了「省代码」合并成一个状态机。
8. **对手指标只存 0/1 计数，不存比率**，比率在查询时算。分母为 0 时一路 `null` 到前端，**任何一层都不许拿 0 冒充「没数据」**。

## 与 poker_report.py 的两处有意分歧

以 `hand_browser.py` 为解析基准（更严格且有守恒校验），因此：

1. **AUTOBB 计入投入但不计入 committed**，`poker_report.py` 计入 → 金额类差约 0.25₮（total net -397.25 vs -397.00，rake_est 403.57 vs 403.63）
2. **翻前 ALLIN 开池算 raise**（report 记作 bet）→ 偷盲 / 大盲防守的分母把「全下开池」也算进去，`bbdef` 差 0.1~0.2 个点

看到 `/api/report` 与旧 Python 输出有数值差，先对照这两条，**别当 bug 修**。

## 脚本

```bash
npm run reset            # 预演：只报当前多少手牌 / 多少份上传记录
npm run reset -- --yes   # 真删
```

`reset.js` 走 `DELETE` + 重置 `sqlite_sequence` + `VACUUM`，**不删文件**（Windows 上服务端占着 db 文件删不掉），所以服务端不用停，下一次请求就能看到空库。服务端正在写入时 `VACUUM` 拿不到锁只会打印提示，数据已经清了。

```bash
node scripts/reimport-opp.js <牌谱文件夹>          # 预演：报将删多少行、将读多少文件
node scripts/reimport-opp.js <牌谱文件夹> --yes    # 真删真重导
```

`reimport-opp.js` 是**给对手侧加了新列之后用的**：上传接口收到的原始 txt 解析完就删了，库里不留原文，所以新增解析字段没法「就地回填」，只能拿源文件夹重导一遍。它

1. 只动对手侧三处：`opp_player_hands` / `opp_hands` / `upload_files WHERE kind='opp'`。**hero 的 `hands` 表和 hero 的 upload 记录一行不碰。**
2. 逐个 `*.txt`（文件名排序）走与 `handleUpload` **完全相同**的路径：`sha256(文件内容)` + `size` → `beginUpload({kind:'opp'})` → `readline` + `createOppStreamParser` + `createOppWriter` → `finishUpload`。所以重导出来的 `upload_files` 行和网页上传出来的一模一样，`/api/files` 看不出区别。
3. 每个文件打印手数 / 玩家行 / 守恒率，末尾打印库存汇总与耗时；中途失败走 `writer.rollback()` + `abortUpload()`。

170 个文件 44MB 约 37s。重导前后的数字必须逐位一致（见「验证状态」），不一致说明新字段动坏了原有口径。

```bash
node scripts/verify.js <牌谱.txt> <python_data.json>
```

`verify.js` 是历史对拍工具：逐手逐字段比 Node 解析器与 Python 基准的 29 个字段（除法字段容许 1 个末位单位的舍入差），全等才 exit 0。**Python 脚本已不在仓库里，基准 JSON 也没有，现在跑不了 —— 别指望它当回归测试。**

## 验证状态

Hero 管线已验证：

- 解析层 29,658 手 × 29 字段与 Python 全等，净盈亏 -393.19 一致，守恒 29658/29658
- `/api/hands` 汇总用 Python 基准交叉验算「全部」「3bet」两个子集，9 项指标全等
- `/api/report` 与 `poker_report.py` 递归比对：结构量全等（场次 28/28、by_day 13/13、牌型 169/169、曲线点 1186/1186），15 处数值差全部来自上面两处有意分歧

对手管线已验证（隔离的 `DATA_DIR`，170 个真实文件 44MB，全程走 HTTP）：

- 170 个文件全部 200，21s 写完：35,439 手 / 189,811 玩家行 / 578 个玩家 / 170 条 `upload_files`，与直接调 writer 的数字逐位相同（HTTP 层没丢东西）
- 守恒 35,436 / 35,439（99.992%）。3 手不过的**是源数据错**（如 #114731000243 底池 ₮34.14 记了 ₮18.65 抽水），不是解析 bug；同批 ante 桌其余手抽水一律 ₮0.10
- `/api/opponents` 跑了 11 组场景：15 个排序键、日期/位置/`q`/翻页过滤、`q=%` 通配符转义、`sort=DROP TABLE` 注入回落默认、负数页码、空结果、NULL 排序沉底、summary 受 WHERE 影响但不受 `minHands` 影响 —— 全部符合预期
- 拖错区两个方向都返回 400 + 中文提示，且**零残留**（`upload_files` 不变、两张 opp 表孤儿行 0、无手牌缺玩家行）；同文件重传走 sha256 去重返回 `duplicate_file`
- 老库迁移：拿 38,457 手的真实库副本启动，自动补 `kind` 列（回填 `'hero'`）并建 opp 表，原 hero 数据与接口无影响，空的 opp 接口返回空结构而非报错
- Hero 回归：在同一个已有对手数据的库里传真实 hero 文件，15,777 手 / 守恒 100% / 1.7s，`/api/report`、`/api/hands`、`/api/files` 均正常，两种 `kind` 共存
- `scripts/reset.js` 在「有 opp 表」和「没有 opp 表」两种库上都试过（dry-run 与 `--yes`）
- `sea-config.json` 资产清单与 `client/` 逐项对齐，blob 能生成

对手复盘（新增 16 列字段 + `/api/opp-hands` 之后）已验证：

- `scripts/reimport-opp.js` 重导 170 个文件（37s）：**35,439 手 / 189,811 玩家行 / 578 玩家 / 守恒 35,436 与加字段之前逐位一致** —— 新字段没碰坏原有口径
- 新列自洽：`cards` 非空 9,043 行 = `hand_group` 非空 9,043 行；`sdw IS NOT NULL` 11,271 = `SUM(wtsd)` 11,271；`sdw = 1` 5,498 = `SUM(sd_won)` 5,498；`act` 35,439 手全非空；`seq_json` 没有一行是 `'{}'`
- **与 `/api/opponents` 对拍**：同一玩家（RiverDeuce，6,670 手）不加筛选时 VPIP 22.68 / PFR 18.23 / bb100 +4.209 / net 280.77 / W$SD 62.55%（275 次摊牌）两个接口逐项相等
- 46 组筛选 / 排序 / 翻页参数逐个打过：SQL 不报错，互斥筛选相加等于总数（`join` 1,678+4,992=6,670、`agg` 931+5,739、`def` 578+6,092）
- 抽真手牌 #114567800283 把 `act` 与原始牌谱**逐行对照**：动作顺序、金额、全下 `!`、牌面、底池 309.92 / rake 5.10、三个位置、`opp_cards` 全部吻合
- 边界：缺 `player` → 400；`sort=net_cents;DROP...` → 白名单回落；`grp=zzz` → 500 中文报错；库里没有的玩家 → 空结构（`total` / `playerTotal` 为 0，`bb100` 为 `null`）
- 老库迁移：真实库副本上自动补列（`opp_hands` 18→21、`opp_player_hands` 31→44），老 HUD 数据与 `/api/opponents` 输出不变
- Hero 侧回归：`/api/totals`（38,457 手 / +102.89）、`/api/hands`、`/api/report` 输出不变（`hands.js` 只加了 `export`）

**前端渲染与交互没有自动化验证**（上传页两个拖拽区、对手页表格/筹码条/翻页/排序、**对手复盘页整页**），按项目规矩要人在浏览器里确认。

没有测试框架，也没有 lint / 构建；验证靠手跑脚本和浏览器。

## 坑

- 改完服务端记得**重启进程**，否则 API 还是旧的。查端口占用 `netstat -ano | grep ":3000"`，杀进程 `taskkill //PID <pid> //F`。
- **Windows / MSYS bash**：`node -e` 里写 `/tmp/x.json` 会被翻译成 `D:\tmp\x.json` 导致 ENOENT。临时产物写到 `server/data/`（项目内且已 gitignore）。
- `node:sqlite` 的整数会以 BigInt 形式回来，所有读取处都显式 `Number(...)` 包了一层 —— 新增查询别忘。
- `/api/report` 是全表扫 + 内存聚合，手数量级再涨一个数量级需要改成增量或落中间表。
- **格式校验只在「一手都没解析出来」时才报 400**（`wrongFormat && stats.total === 0`）。混合内容的文件会按主格式吃进去，不会拦。
- **sha256 去重排在格式校验之前**：同一个文件拖错区，返回的是 `duplicate_file` 200 而不是 400。测格式校验要用没传过的内容。
- 新增 `client/` 下的文件必须同步登记进 `sea-config.json` 的 assets，否则打包出来的 exe 少页面。
- **给对手解析器加字段不会自动回填老数据**：原始 txt 上传完就删了，只能跑 `scripts/reimport-opp.js` 拿源文件夹重导。加完字段先在隔离的 `DATA_DIR` 上重导一遍对数，别直接在主库上删。
- `/api/opp-hands` 里两张 opp 表 JOIN，**`file_id` / `ts` / `ts_text` / `stakes` / `bb_cents` 五个列两边都有**，不带前缀 sqlite 会报 ambiguous。新增筛选条件时先确认列在哪张表。
