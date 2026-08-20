# my-h2n-客户端

三个静态页面：**上传**、**数据**、**复盘**。没有框架、没有构建步骤、没有 npm 依赖 —— 就是 html + css + `<script src>` 直接引的普通脚本（非 ESM，不用 `import`）。

页面本身**不内嵌任何数据**，全部靠 `fetch` 打服务端 API。这是相对原先两个 Python 脚本（生成自带数据的单体 HTML）唯一的架构差异。

服务端说明见 [server/README.md](../server/README.md)，人类向的项目介绍见 [README-HUMAN.md](../README-HUMAN.md)，给 AI 看的约定与坑见 [README-AI.md](../README-AI.md)。

## 怎么打开

静态页由服务端一起托管，**不要用 `file://` 直接开**（相对路径的 `/api/...` 会打不到）：

```bash
node server/src/index.js     # 然后开 http://localhost:3000
```

`/` 映射到 `index.html`，三个页面之间靠顶部导航的普通 `<a href>` 跳转，没有前端路由。

## 文件

```
index.html   upload.js   6.7K   上传页（暗色）
data.html    data.js    18.2K   数据页（暗色，1:1 复刻 poker_report.py）
review.html  review.js  10.3K   复盘页（浅色，1:1 复刻 hand_browser.py）

app.css      3.6K   上传页样式
data.css     5.1K   数据页样式
review.css   3.6K   复盘页样式
vendor/chart.umd.min.js   196K   Chart.js 4.4.1（本地引用，不走 CDN）
src/index.js  0 B   空文件，死文件，可删
```

每个页面一个 html + 一个 js + 一个 css，**三套页面互不共享 JS**。`$`、`esc()`、`POS`、`SU`（花色符号表）这几个小工具在三个文件里各有一份副本 —— 这是有意的，避免为三个页面引入模块化/打包。

### 配色

上传页与数据页共用一套暗色变量（`app.css` / `data.css` 里各写一份，同名同值；`--violet` 只有 `data.css` 有）：

```
--bg #0b1220   --card #121b2d   --card2 #0f1727   --line #22304a
--tx #dbe4f3   --dim #8194b3
--green #22c55e  --red #ef4444  --blue #38bdf8  --amber #f59e0b  [--violet #a78bfa]
```

复盘页是**浅色**主题，另一套变量（`review.css`）：`--bg #f2f4f8`、`--card #fff`、`--tx #1c2430`、`--mut #69758a`、`--red #d0453e`、`--grn #178a4c`、`--blu #2f6fd0`。两套配色是刻意的（沿用两个 Python 脚本各自的风格），不要统一。

## 上传页 `index.html` + `upload.js`

拖拽或选择 `.txt` → 串行上传 → 刷新概览。

- **拖拽区**：`dragenter/dragover` 加 `.hot` 高亮，`dragleave` 时用 `drop.contains(e.relatedTarget)` 排除子元素冒泡造成的误消失；drop 的文件用 `/\.txt$/i` 过滤。
- **上传用 `XMLHttpRequest` 而不是 `fetch`**，因为要 `xhr.upload.onprogress` 进度。原文直传：`content-type: text/plain`，文件名走 `x-filename: encodeURIComponent(name)`，**不走 multipart**。
- **队列串行**：`busy` 标志 + `pump()` 递归。`jobs.unshift()` 让最新的排在最上面显示，但 `pump()` 用 `[...jobs].reverse().find(wait)` 取最早入队的先传，即「显示倒序、执行正序」。
- **进度条分三段**：上传阶段占 0–90%，`upload.onload` 后跳 92% 显示「服务端解析入库中…」，响应到达 100%。因为解析耗时在服务端，浏览器侧拿不到进度。
- **三种结果态**：`ok`（报解析/新增/重复跳过/守恒校验通过率/耗时）、`dup`（整份 sha256 重复，显示服务端的 `message`）、`err`（显示 `body.error`，网络错误提示「服务端是否在运行？」）。
- 每个任务结束都 `refresh()`：并发拉 `/api/files` 和 `/api/hands?per=10&sort=t&dir=desc`，渲染库存概览药丸、上传历史表（重复手数 = `hands_total - hands_new`）、最近 10 手抽查表（用来肉眼确认数据真的可查）。

## 数据页 `data.html` + `data.js`

一次 `GET /api/report?minHands=100` 拿全部聚合结果存进全局 `S`，然后分四步渲染：`renderHead()` → `renderTables()` → `renderHeatmap()` → `renderCharts()`，最后 `wireModal()` 挂交互。

加载中显示 `#loading`，成功后 `hidden` 切换到 `#page`；`S.empty` 时提示去上传页（若有 `S.dropped` 会一并说明哪些级别因样本不足被剔除）。

### 数字格式化（三套，别混用）

服务端 `report.js` 已经用银行家舍入算过一遍，展示层还要再格式化一次，所以 `data.js` 里**又有一份 `pyRound()`**（Python 的四舍六入五取偶）。在此之上三个函数：

| 函数 | 对应 Python | 用途 |
|---|---|---|
| `nfmt(v, nd)` | `f'{v:,.Nf}'` | 无符号、**带千分位** |
| `sfmt(v, nd)` | `f'{v:+,.Nf}'` | 带符号、**带千分位**（bb 总量） |
| `sfix(v, nd)` | `f'{v:+.Nf}'` | 带符号、**不带千分位**（bb/100 用这个） |

曾经因为 bb/100 误用了带千分位的版本，出现 `+1,237.9` vs 脚本的 `+1237.9`。另外 `signOf(r, v)` 会在舍入后为 0 但原值为负时仍输出 `-`，跟 Python 的行为一致。

### 六张图

Chart.js 全局默认色在 `renderCharts()` 里统一改过（`Chart.defaults.color/borderColor/font.family`），零刻度线用 `GZ` 回调加深，调色板 `PAL` 8 色循环。canvas id：

| id | 图 |
|---|---|
| `cumChart` | 累计盈亏（总利润 / 摊牌 / 非摊牌三条填充线） |
| `cumBBChart` | 分级别累计 bb |
| `dailyChart` | 每日盈亏，按级别堆叠柱 |
| `hourChart` | 按小时盈亏（柱，正负分色）+ 手数（线，右轴 `y1`） |
| `posChart` | 各位置 bb/100 |
| `posVpipChart` | 各位置 VPIP / PFR 双柱 |

`hourChart` 只画有手数的小时（`by_hour.filter(hands > 0)`）。所有图 `maintainAspectRatio: false`，高度由 `.chart-wrap` / `.tall` 的 CSS 控制。

### 13×13 热图 + 明细弹窗

格子键的推法（行列都按 `A K Q J T 9 8 7 6 5 4 3 2`）：

```js
i === j ? r1 + r2 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o'
```

即**右上三角同花、左下三角杂色、对角线对子**。手数 `< 15` 画灰点 `·`，否则底色按 `bb100` 在 **±150 截断**后映射绿/红透明度。

点格子调 `showGroup(key)`：`GET /api/hands?cards=<牌型>&per=500&sort=t&dir=asc&stakes=<报表保留的级别>`，结果拍平成 7 列数组存进 `cache`（同一牌型只拉一次）。弹窗内的排序是**前端本地排序**（`sortBy()` 对 `curRows` 原地 sort），不再打服务端。关闭：`×` 按钮 / 点遮罩 / `Esc`。

`stakes` 必须带上 `S.stakes`，否则弹窗会把被 `minHands` 剔掉的级别也算进来，合计跟热图对不上。

支持 hash 深链：打开 `data.html#g=AKs` 会自动弹出该牌型明细。

## 复盘页 `review.html` + `review.js`

筛选 / 排序 / 分页**全部交给服务端 SQL**，前端只持有当前一页（`CUR`）。

- **6 组筛选器**放在 `<details>` 折叠块里：基础（级别/位置/日期/小时）、翻前、手牌、过程、结果、对手摊牌牌。级别和位置是动态生成的多选 chip（级别取自 `/api/totals` 的 `by_stakes`，位置取 `POS`），其余是 `select` / `input`。
- **参数拼装**在 `params()`：`put()` 会跳过空串和 `'any'`，所以「不限」不会进 query；小时只在非 `0~23` 时才带上。
- **防抖 180ms**（`apply()`），避免输入框每个字符打一次请求。翻页和排序不防抖，直接 `load()`。
- **慢响应淘汰**：`reqSeq` 自增，响应回来时 `seq !== reqSeq` 就丢弃 —— 快速改筛选时不会被先发后到的旧响应覆盖。
- **页码基数要注意**：前端 `page` 是 **0 基**（沿用原脚本），发请求时 `page + 1`，收到响应后 `page = data.page - 1`。
- **排序**只认表头上 `data-k` 的四个键 `t / potbb / net / bb`（与服务端白名单一致）；同键再点反向，换键时 `t` 默认降序、其他默认升序。
- **点行展开**：在 `tr.hr` 后面插一个 `tr.det`，再点同一行则移除。详情由 `det(r)` 渲染：拆 `r.act` 的 `|` 得到四条街的动作串，把开头的 `H` / `P1` 玩家标记包成 `.ak` 高亮，配上各街牌面、投入/收回/净盈亏/整桌底池/rake+splash/促销注入，以及对手摊牌牌。
- **标签渲染**三个函数：`pfTag()`（弃/跟/过/开池/3bet/4bet/5bet+，附「面开」「被3b」）、`stTag()`（到达街道 + 摊 + 全下）、`resTag()`（摊牌赢/输/平、未摊赢、翻前弃/弃牌/平）。
- **汇总条** `#sumbar` 由 `/api/hands` 的 `summary` 直接渲染，随筛选实时变。百分比为 `null` 时显示 `—`。
- 这页**没有 header**（已按要求删掉），库存概要就在汇总条里。

## 与服务端的数据契约

### `/api/hands` 行字段（缩写）

```
id  手牌号        t    分钟戳          ts   'YYYY-MM-DD HH:MM:SS'
lv  级别 NL10     bl   盲注 '0.05/0.1'  pos  POS 下标，-1 未识别
cd  具体两张      hg   牌型 AKs         pa   翻前首动作 F/C/R/X
rba 之前加注数    rn   Hero 加注时的加注计数（0 开池 / 1 3bet / …）
f3  是否被 3bet   st   到达街道 0..3    sd   整手是否有摊牌
sdw 摊牌结果 1赢/0输/2平，未摊牌 null   ai  Hero 是否全下   nf  进翻人数
pot 底池 ₮        potbb 底池 bb(1位)    net 净盈亏 ₮   bb  净盈亏 bb(2位)
inv 投入          col  收回             rk  rake+splash   sp  促销注入
fl  翻牌          tu   转牌             ri  河牌
opp 对手摊牌牌（空格分隔）    act  四街动作日志，'|' 分街
```

三个页面共同约定：

- `POS = ['UTG','MP','CO','BTN','SB','BB']`，`pos` 是下标，`-1` 渲染成 `?`。三个 js 各有一份常量。
- 金额字段服务端已除 100，前端只做格式化，**不做二次运算**（除了 `data.js` 弹窗里的合计求和）。
- `SU = { s:'♠', h:'♥', d:'♦', c:'♣' }`，两张牌的字符串按每 2 字符切开渲染。
- 所有插进 `innerHTML` 的服务端字符串都过 `esc()`（转义 `& < > "`）—— 文件名、牌面、对手牌、动作日志都来自牌谱文本，**新增拼串处别忘了套 `esc()`**。

## 坑

- 三个页面都是**字符串拼 `innerHTML`**，没有虚拟 DOM。改渲染时注意 `esc()` 和引号闭合。
- `data.js` 的 `pyRound()` 和 `server/src/report.js` 的是**两份独立实现**，改一处要改两处，否则展示层数字和 API 数字会分叉。
- `minHands=100` 在 `data.js` 里是**硬编码**的，没有 UI 可调。
- Chart.js 是唯一第三方，已 vendor 到 `vendor/`。**不要改成 CDN**，也不要再引入别的库。
- `src/index.js` 是 0 字节死文件，留着没用。
- **没有在真实浏览器里验证过**图表绘制、热图点击弹窗、筛选器交互（只用 DOM/Chart/fetch 桩做过无头冒烟）。动这三块渲染的话，改完让用户开页面确认，别声称已测。
