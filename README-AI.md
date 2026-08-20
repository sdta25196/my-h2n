# my-h2n

给 AI 看的项目说明：结构、约定、不变量、坑。人类向的介绍见 `README-HUMAN.md`。

## 技术栈

数据库:sqlite；用内置 node:sqlite
后端：nodejs
前端:html js css

**零外部依赖**是硬约束：只用 `node:http` / `node:sqlite` / `node:readline` / `node:crypto` / `node:fs`。没有 npm 依赖、没有构建步骤、没有框架。改代码时不要引入任何包（Chart.js 是唯一第三方，已 vendor 到 `client/vendor/chart.umd.min.js`）。ESM（`"type": "module"`），要求 Node ≥ 22.5（`node:sqlite` 起始版本），本机 v24.19.0。

## 跑起来

```bash
node server/src/index.js        # http://localhost:3000 ，静态页由服务端一起托管
cd server && npm start          # 等价
cd server && npm run reset      # 清库预演（只报数）；加 -- --yes 才真删
```

数据库落在 `server/data/poker.db`（gitignore），可用 `DATA_DIR` / `PORT` 环境变量覆盖。没有测试框架，也没有 lint/构建；验证靠手跑脚本和浏览器。

## 目录

```
server/src/parser.js   478 行  牌谱解析器（状态机，逐行喂）
server/src/db.js       257 行  schema + 两层去重 + 批量事务写入
server/src/hands.js    259 行  GET /api/hands：SQL 筛选/分页/汇总
server/src/report.js   398 行  GET /api/report：实时聚合（build_stats 移植）
server/src/index.js    150 行  路由 + 上传 + 静态托管
server/scripts/verify.js       解析器对拍（需 Python 基准 JSON，见下）
server/scripts/reset.js        清库
client/index.html+upload.js    上传页
client/data.html+data.js       数据页（暗色，1:1 复刻 poker_report.py）
client/review.html+review.js   复盘页（浅色，1:1 复刻 hand_browser.py）
client/vendor/chart.umd.min.js Chart.js 4.4.1
```

死文件（留着没用，可删）：`client/src/index.js`（空）。前端细节见 `client/README.md`。

## 数据流

上传原文（`POST /api/upload`，请求体就是 txt 本体，文件名在 `x-filename` 头里，**不走 multipart**）→ 落临时文件同时算 sha256 → `readline` 逐行喂 `createStreamParser` → 每手 `toRecord` 化 → 1000 手一个事务 `INSERT OR IGNORE`。35MB / 29,658 手约 3 秒。

前端只 fetch API，页面里不内嵌数据。这是相对两个 Python 脚本唯一的架构差异（README 既定）：

- 数据页热图弹窗原本内嵌全量明细（1.8MB HTML 的大头），现在点击时才 `GET /api/hands?cards=<牌型>&stakes=<报表保留的级别>`
- 复盘页筛选/排序/分页从前端全量数组换成服务端 SQL，前端只持有当前一页

## 不变量（改代码前必读）

1. **金额一律用「分」整数累加**，只在输出层除 100。浮点累加会让筹码守恒校验挂掉。列名带 `_cents` 的都是整数分。
2. **`pyRound()` 是 Python 的银行家舍入**（`.5` 进偶数），`report.js` 和 `data.js` 各有一份。不要换成 `Math.round`，数字会跟脚本口径分叉。
3. **两套格式化函数别混用**：`nfmt/sfmt` 带千分位（对应 Python `f"{v:,.2f}"`），`sfix` 不带（对应 `f"{v:+.1f}"`，bb/100 用这个）。曾经因为 bb/100 用了带千分位的版本出现 `+1,237.9` vs `+1237.9`。
4. **两层去重**：文件级 `upload_files.sha256` UNIQUE（命中直接跳过，不重复解析）；手牌级 `hands.hand_id` 主键 + `INSERT OR IGNORE`（重叠时段的牌谱可放心叠加）。
5. **筹码守恒校验**：每手「净投入和 + SPLASH == Total pot」（±0.03），结果存 `hands.check_ok`，上传返回里报通过率。当前样本 29658/29658。这个校验是解析正确性的主要护栏，别绕过。
6. 解析必须**流式**（`readline` 逐行）。不要 `readFileSync().split('\n')`，样本就有 35MB。

## 与 poker_report.py 的两处有意分歧

以 `hand_browser.py` 为解析基准（更严格且有守恒校验），因此：

1. **AUTOBB 计入投入但不计入 committed**，`poker_report.py` 计入 → 金额类差约 0.25₮（total net -397.25 vs -397.00，rake_est 403.57 vs 403.63）
2. **翻前 ALLIN 开池算 raise**（report 记作 bet）→ 偷盲/大盲防守的分母把「全下开池」也算进去，`bbdef` 差 0.1~0.2 个点

看到 `/api/report` 与旧 Python 输出有数值差，先对照这两条，别当 bug 修。

## API

| 接口 | 说明 |
|---|---|
| `POST /api/upload` | 原文直传，返回 `{status, file, stats{total,inserted,duplicated,checkRate,elapsedMs}, totals}`；`status` 可能是 `duplicate_file` |
| `GET /api/files` | 上传历史 + 库存 |
| `GET /api/totals` | 手数/净盈亏/时间范围/分级别明细 |
| `GET /api/hands` | 20+ 筛选参数 + `page/per/sort/dir`，返回 `{page,per,total,pages,summary,rows}` |
| `GET /api/report?minHands=100&from=&to=&stakes=` | `build_stats()` 聚合，全量约 0.4s；筛选参数下推到 SQL |

`/api/hands` 参数（全部走 SQL，见 `hands.js` 的 `buildWhere`）：`stakes` `pos`（逗号分隔）、`hid`（`hand_id` 精确匹配，逗号分隔，容忍 `#` 前缀）、`from` `to`、`h1` `h2`（小时可跨天如 21~6）、`pa` `rt` `fc` `f3` `join`、`cards`（2/3/4 字符 token，逗号分隔）、`grp`（`pair|brdy|bs|bo|conn|gap1|axs`）、`st` `sd` `sdw` `ai` `nf`、`res` `bbMin` `bbMax` `potMin` `potMax`、`opp`、`fileId`。`sort` 只接受 `t|potbb|net|bb`（白名单，别改成拼接列名）；`per` 上限 500。

行字段是缩写（`id t ts lv bl pos cd hg pa rba rn f3 st sd sdw ai nf pot potbb net bb inv col rk sp fl tu ri opp act`），前端直接按这套用。

`/api/report` 顶层：`meta / overview / overall / by_stakes / by_pos / by_day / by_hour / groups / top_wins / top_losses / sessions / cumulative / stakes`；空库返回 `{empty:true}`。`meta.player` 从牌谱文件名按 `_` 取第 2 段（沿用 Python 取法）。

`/api/report` 的筛选参数：`from` `to`（`YYYY-MM-DD`，按 `ts_text` 整天闭区间，口径和 `hands.js` 一致）、`stakes`（逗号分隔），都在 `loadHands()` 里下推到 SQL WHERE，不是聚合完再过滤。**`minHands` 的默认值是动态的**（在 `index.js` 的路由里算）：无筛选 `100`，带了任一筛选就 `0` —— 否则一选窄时间段所有级别都掉到 100 手以下，整份报表被剔空。显式传 `minHands` 仍然优先。筛选条件回显在 `meta.filters`，`{empty:true}` 响应里也带，前端靠它区分「库是空的」和「筛没了」。

## 库表

`upload_files(id, filename, sha256 UNIQUE, size, hands_total, hands_new, check_total, check_passed, uploaded_at)`

`hands(hand_id PK, file_id, ts, ts_text, stakes, blinds, sb/bb/ante_cents, pos, cards, hand_group, pa, rba, rn, faced_3bet, st, sd, sdw, ai, nf, pot/net/inv/col/rake/splash_drop_cents, flop, turn, river, opp, act, seq_json, street_agg_json, facing_bet_json, raises_pf_json, rake_share_cents, saw_flop, remaining, folded_to_hero, walk, folded_to_3bet, hero_folded_street, check_ok)`

`pos` 是 `POS_ORDER=['UTG','MP','CO','BTN','SB','BB']` 的下标，`-1` = 未识别。`ts` 是分钟戳（与前端 `t` 一致），日期筛选用 `ts_text`。索引在 `ts` / `(stakes,ts)` / `pos` / `hand_group` / `file_id`。加字段要同步改三处：`SCHEMA`、`INSERT_HAND`（含 `Array(44)` 的占位数量）、`handRow()`。

## 已验证 / 未验证

已验证：

- 解析层 29,658 手 × 29 字段与 Python 全等，净盈亏 -393.19 一致，守恒 29658/29658
- `/api/hands` 汇总用 Python 基准交叉验算「全部」「3bet」两个子集，9 项指标全等
- `/api/report` 与 `poker_report.py` 递归比对：结构量全等（场次 28/28、by_day 13/13、牌型 169/169、曲线点 1186/1186），15 处数值差全部来自上面两处有意分歧
- 展示层：237 条渲染字符串与 Python f-string 逐条比对，0 不一致
- 两个页面用 DOM/Chart/fetch 桩做过无头冒烟

**没验证**：真实浏览器里的图表绘制、热图点击弹窗、筛选器交互。动前端渲染的话，改完让用户开页面确认，别声称已测。

## 坑

- **`test_poker/` 已删除**，两个 Python 脚本（`poker_report.py` / `hand_browser.py`）不在仓库里了。它们只是口径基准，运行时不依赖。`server/scripts/verify.js` 需要 Python 基准 JSON 才能跑，现在跑不了 —— 别指望它当回归测试。
- **Windows / MSYS bash**：`node -e` 里写 `/tmp/x.json` 会被翻译成 `D:\tmp\x.json` 导致 ENOENT。临时产物写到 `server/data/`（项目内且已 gitignore）。
- **清库走 SQL 不删文件**（`reset.js` 用 DELETE + VACUUM），因为 Windows 上服务端占着 db 文件删不掉；这样服务端也不用停。
- 改完服务端记得**重启进程**，否则 API 还是旧的。端口占用查 `netstat -ano | grep ":3000"`，杀进程 `taskkill //PID <pid> //F`。
- 数据页 4 张图的 canvas id：`cumChart dailyChart posChart posVpipChart`（`cumBBChart` / `hourChart` 已按要求删掉，但服务端仍返回 `cumulative.bb` 和 `by_hour`）；热图键的推法是 `i===j ? r1+r2 : i<j ? r1+r2+'s' : r2+r1+'o'`，手数 <15 画灰点，配色 ±150 截断。
- 数据页带筛选后**整页会重渲染**：图表必须先 `destroy()`（都记在 `charts[]`，用 `mkChart()` 创建），热图点击必须委托到 `#heatmap`（表格每次重建），热图弹窗缓存必须 `cache.clear()`，弹窗请求必须带上当前的 `from`/`to`/`stakes` 才能跟格子数字对上。
- 复盘页没有 header（已按要求删掉），库存概要在 `#sumbar` 汇总条里。
