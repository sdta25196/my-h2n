# my-h2n-服务端

牌谱入库 + 查询服务端：把 CoinPoker 现金桌牌谱 txt 解析成一手一行存进 sqlite，对外提供 JSON API，并顺带托管 `client/` 的静态页。

**零外部依赖**是硬约束：只用 `node:http` / `node:sqlite` / `node:readline` / `node:crypto` / `node:fs` / `node:stream` / `node:path` / `node:url`。没有 npm 依赖、没有构建步骤、没有框架。ESM（`"type": "module"`），要求 **Node ≥ 22.5**（`node:sqlite` 的起始版本）。

人类向的项目介绍见 [README-HUMAN.md](../README-HUMAN.md)，给 AI 看的约定与坑见 [README-AI.md](../README-AI.md)。

## 快速开始

```bash
node server/src/index.js          # http://localhost:3000
cd server && npm start            # 等价

cd server && npm run reset        # 清库预演（只报数，不删）
cd server && npm run reset -- --yes   # 确认清空
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
    index.js    150 行  HTTP 路由 + 上传接收 + 静态托管
    parser.js   478 行  牌谱解析器（状态机，逐行喂）
    db.js       257 行  schema + 两层去重 + 批量事务写入
    hands.js    259 行  GET /api/hands：SQL 筛选 / 排序 / 分页 / 汇总
    report.js   398 行  GET /api/report：实时聚合（build_stats 移植）
  scripts/
    reset.js            清库（DELETE + VACUUM，不删文件）
    verify.js           解析器对拍（需 Python 基准 JSON，现已跑不了）
  data/                 运行时生成，gitignore
```

模块依赖是一条单向链，没有环：`index.js` → `{parser, db, hands, report}`，`db.js` 和 `report.js` → `parser.js`（取 `POS_ORDER` / `toRecord`）。

## 数据流

```
POST /api/upload (请求体 = txt 原文)
  │
  ├─ 边收边算 sha256，同时 pipeline 写入 data/tmp/<uuid>.txt
  ├─ sha256 命中 upload_files → 直接返回 duplicate_file，不解析
  ├─ beginUpload() 先插 upload_files 占位行拿 file_id
  ├─ readline 逐行喂 createStreamParser
  │     每识别出一手 → parseHand() → writer.add()
  │     writer 每 1000 手一个事务 INSERT OR IGNORE
  ├─ 解析到 0 手 → abortUpload() 回滚删占位行，返回 400
  ├─ finishUpload() 回填 hands_total / hands_new / check_total / check_passed
  └─ 删临时文件，返回统计
```

要点：

- **不走 multipart**。请求体就是 txt 本体，文件名放在 `x-filename` 头里（`encodeURIComponent` 编码，缺省 `unnamed.txt`）。前端多选文件时是逐个串行发请求。
- **全程流式**。`readline` 逐行读，解析器一手一个回调，写入器分批提交，内存占用与文件大小无关。样本 35MB / 29,658 手约 3 秒。不要改成 `readFileSync().split('\n')`。
- **上传体上限 500MB**，靠 `content-length` 预检，超了直接 413。
- 入库必须**先有 `upload_files` 行**才能填 `hands.file_id`，所以拆成 begin / finish 两步；中途异常走 `writer.rollback()` + `abortUpload()`。

## API

所有响应都是 `application/json; charset=utf-8`。出错统一返回 `{ "error": "..." }`，路由层有 try/catch 兜底成 500。`/api/` 开头的未知路径返回 404；非 GET 且非上传的请求返回 405。

### `POST /api/upload`

请求体为牌谱原文，头 `x-filename: <URL 编码的文件名>`。

成功：

```json
{
  "status": "ok",
  "file": { "id": 1, "filename": "...", "sha256": "...", "size": 36700160,
            "hands_total": 29658, "hands_new": 29658,
            "check_total": 29658, "check_passed": 29658, "uploaded_at": "2026-..." },
  "stats": { "total": 29658, "inserted": 29658, "checkTotal": 29658, "checkPassed": 29658,
             "duplicated": 0, "checkRate": 100, "elapsedMs": 2980 },
  "totals": { "...": "同 /api/totals" }
}
```

文件重复（sha256 命中）：`status` 为 `duplicate_file`，带 `message` 和已有的 `file` 行，**不解析**。

错误码：`413` 超过 500MB；`400` 接收失败 / 未解析到任何手牌；`500` 解析入库失败。

### `GET /api/files`

`{ files: [...upload_files 全部行，id DESC], totals: {...} }`

### `GET /api/totals`

```json
{ "hands": 29658, "net_cents": -39319,
  "first_ts": "2026-07-01 20:11:03", "last_ts": "2026-08-13 03:47:55",
  "stakes_count": 3,
  "by_stakes": [ { "stakes": "NL10", "hands": 12034, "net": -120.5 } ] }
```

空库时 `hands` 为 0、`first_ts` / `last_ts` 为 `null`。

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

`upload_files(id, filename, sha256 UNIQUE, size, hands_total, hands_new, check_total, check_passed, uploaded_at)`

`hands(hand_id PK, file_id, ts, ts_text, stakes, blinds, sb/bb/ante_cents, pos, cards, hand_group, pa, rba, rn, faced_3bet, st, sd, sdw, ai, nf, pot/net/inv/col/rake/splash_drop_cents, flop, turn, river, opp, act, seq_json, street_agg_json, facing_bet_json, raises_pf_json, rake_share_cents, saw_flop, remaining, folded_to_hero, walk, folded_to_3bet, hero_folded_street, check_ok)`

- `pos` 是 `POS_ORDER = ['UTG','MP','CO','BTN','SB','BB']` 的下标，`-1` = 未识别。
- `ts` 是分钟戳（与前端 `t` 一致，用于排序）；**日期筛选用 `ts_text`**。
- `_cents` 结尾的都是整数分；`rake_share_cents` 是按投入占比分摊的抽水，唯一的 REAL。
- 四个 `*_json` 列存报表页需要的派生结构（Hero 动作序列、每街最后加注者、每街首个下注者、翻前加注时的加注计数），`report.js` 读的时候 `JSON.parse`。
- 索引：`ts` / `(stakes, ts)` / `pos` / `hand_group` / `file_id`。
- 连接参数：`journal_mode = WAL` + `synchronous = NORMAL`。

**加字段要同步改三处**：`SCHEMA`、`INSERT_HAND`（含 `Array(44)` 的占位符数量）、`handRow()` 的返回数组 —— 三处顺序必须一一对应。

## 解析器

`parser.js` 是逐行喂的状态机，对外三个入口：

- `createStreamParser(onHand)` — `line(text)` 逐行喂、`end()` 收尾；见到 header 行就 flush 上一手。
- `parseHand(lines)` — 解析单手行块，格式非法返回 `null`。
- `toRecord(h)` — 拍平成 29 字段数组，顺序与 `hand_browser.py` 的 `to_record` / 前端 `K` 常量一致。

覆盖的牌谱行：header（含 ante 三档盲注）、`Table ... is the button`、`Seat`、`posts ante/small blind/big blind`、`folds/checks/calls/bets/raises to`、`ALLIN`、`AUTOBB`、`STRADDLE`、`RETURN`、`collected from pot`、`shows`、`Total pot | Rake | Splash Fee`、`SPLASH dropped`、`Seat n: Hero showed ... and won/lost`，以及 run-it-twice 的 `*** FIRST/SECOND FLOP/TURN/RIVER`（第二块牌面用 `; ` 拼接进同一列）。

位置推导：从按钮座位顺时针 `BTN → SB → BB`，余下按人数摊成 `UTG / MP / CO`（只剩 1 人则记 UTG）。对手名字匿名化成 `P1 P2 ...`，Hero 记 `H`，写进 `act` 动作日志。

## 不变量（改代码前必读）

1. **金额一律用「分」整数累加**，只在输出层除 100。浮点累加会让筹码守恒校验挂掉。
2. **`pyRound()` 是 Python 的银行家舍入**（`.5` 进偶数），不要换成 `Math.round`，数字会跟 Python 基准口径分叉。`report.js` 和前端 `data.js` 各有一份。
3. **两层去重**：文件级 `upload_files.sha256` UNIQUE（命中直接跳过，不重复解析）；手牌级 `hands.hand_id` 主键 + `INSERT OR IGNORE`（重叠时段的牌谱可放心叠加上传）。
4. **筹码守恒校验**：每手「全桌净投入和 + SPLASH 注入 == Total pot」（容差 3 分），结果存 `hands.check_ok`，上传响应里报通过率。当前样本 29658/29658。这是解析正确性的主要护栏，**别绕过**。
5. 解析必须**流式**，样本就有 35MB。
6. `AUTOBB` 与 ante 同口径：**计入投入但不计入 committed**（其后 `raises to X` 的 X 不含 AUTOBB）。

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
node scripts/verify.js <牌谱.txt> <python_data.json>
```

`verify.js` 是历史对拍工具：逐手逐字段比 Node 解析器与 Python 基准的 29 个字段（除法字段容许 1 个末位单位的舍入差），全等才 exit 0。**Python 脚本已不在仓库里，基准 JSON 也没有，现在跑不了 —— 别指望它当回归测试。**

## 验证状态

已验证：

- 解析层 29,658 手 × 29 字段与 Python 全等，净盈亏 -393.19 一致，守恒 29658/29658
- `/api/hands` 汇总用 Python 基准交叉验算「全部」「3bet」两个子集，9 项指标全等
- `/api/report` 与 `poker_report.py` 递归比对：结构量全等（场次 28/28、by_day 13/13、牌型 169/169、曲线点 1186/1186），15 处数值差全部来自上面两处有意分歧

没有测试框架，也没有 lint / 构建；验证靠手跑脚本和浏览器。

## 坑

- 改完服务端记得**重启进程**，否则 API 还是旧的。查端口占用 `netstat -ano | grep ":3000"`，杀进程 `taskkill //PID <pid> //F`。
- **Windows / MSYS bash**：`node -e` 里写 `/tmp/x.json` 会被翻译成 `D:\tmp\x.json` 导致 ENOENT。临时产物写到 `server/data/`（项目内且已 gitignore）。
- `node:sqlite` 的整数会以 BigInt 形式回来，所有读取处都显式 `Number(...)` 包了一层 —— 新增查询别忘。
- `/api/report` 是全表扫 + 内存聚合，手数量级再涨一个数量级需要改成增量或落中间表。
