# my-h2n-客户端

四个静态页面：**上传**、**数据**、**复盘**、**对手**，外加一个从对手表点进去的详情页 **对手复盘**（不占导航位）。没有框架、没有构建步骤、没有 npm 依赖 —— 就是 html + css + `<script src>` 直接引的普通脚本（非 ESM，不用 `import`）。

页面本身**不内嵌任何数据**，全部靠 `fetch` 打服务端 API。这是相对原先两个 Python 脚本（生成自带数据的单体 HTML）唯一的架构差异。

服务端说明见 [server/README.md](../server/README.md)，人类向的项目介绍见 [README-HUMAN.md](../README-HUMAN.md)，给 AI 看的约定与坑见 [README-AI.md](../README-AI.md)。

## 怎么打开

静态页由服务端一起托管，**不要用 `file://` 直接开**（相对路径的 `/api/...` 会打不到）：

```bash
node server/src/index.js     # 然后开 http://localhost:3000
```

`/` 映射到 `index.html`，四个页面之间靠顶部导航的普通 `<a href>` 跳转，没有前端路由。`opp-review.html` 不在导航里，只能从对手表行末的「复盘」按钮进（`target="_blank"`，带 `?player=` 参数）。

## 文件

```
index.html   upload.js   8.2K   上传页（暗色）
data.html    data.js    22.8K   数据页（暗色，1:1 复刻 poker_report.py）
review.html  review.js  11.2K   复盘页（浅色，1:1 复刻 hand_browser.py）
opponents.html opponents.js 7.5K 对手页（暗色，HUD 表，行末「复盘」按钮）
opp-review.html opp-review.js 13.1K 对手复盘页（浅色，把某个对手当 Hero）

app.css      3.9K   上传页样式（对手页也引它当暗色底）
data.css     6.6K   数据页样式
review.css   4.1K   复盘页样式（对手复盘页也引它，尾部几条是那页专用）
opponents.css 2.5K  对手页样式（只写本页独有的筛选条/排序表头/分页/按钮）
vendor/chart.umd.min.js   196K   Chart.js 4.4.1（本地引用，不走 CDN）
src/index.js  0 B   空文件，死文件，可删
```

每个页面一个 html + 一个 js，**五套页面互不共享 JS**。`$`、`esc()`、`POS`、`SU`（花色符号表）这几个小工具在各文件里各有一份副本 —— 这是有意的，避免为几个页面引入模块化/打包。`opp-review.js` 是 `review.js` 的**近似逐行副本**（差异只有四处，见下），改复盘页的渲染逻辑时记得看一眼要不要同步。

CSS 有两处共用：**对手页同时引 `app.css` + `opponents.css`**（前者给暗色变量和 `.topnav` / `table` / `.card` 这些基础件），**对手复盘页直接引 `review.css`**（没有单独的 css 文件，那页专用的三四条规则追加在 `review.css` 尾部）。

### 配色

上传页、数据页、对手页共用一套暗色变量（`app.css` / `data.css` 里各写一份，同名同值；`--violet` 只有 `data.css` 有；`opponents.css` 不重写，直接用 `app.css` 的）：

```
--bg #0b1220   --card #121b2d   --card2 #0f1727   --line #22304a
--tx #dbe4f3   --dim #8194b3
--green #22c55e  --red #ef4444  --blue #38bdf8  --amber #f59e0b  [--violet #a78bfa]
```

复盘页与对手复盘页是**浅色**主题，另一套变量（`review.css`）：`--bg #f2f4f8`、`--card #fff`、`--tx #1c2430`、`--mut #69758a`、`--red #d0453e`、`--grn #178a4c`、`--blu #2f6fd0`。两套配色是刻意的（沿用两个 Python 脚本各自的风格），不要统一。

## 上传页 `index.html` + `upload.js`

拖拽或选择 `.txt` → 串行上传 → 刷新概览。

**两个拖拽区**（`.drops` 两列网格，窄屏塌成一列）：`#drop` = 我的牌谱（Hero 视角，蓝），`#dropOpp` = 对手牌谱（整桌视角，琥珀）。两区共用同一条上传队列，job 上带 `kind` 字段决定请求打 `/api/upload` 还是 `/api/upload?kind=opp`，任务行左边用 `.tag.hero` / `.tag.opp` 小药丸标出去向。**拖错区服务端会 400 并告诉你该拖哪个区**，前端只负责把 `error` 原样显示。

- **拖拽区**：`dragenter/dragover` 加 `.hot` 高亮，`dragleave` 时用 `drop.contains(e.relatedTarget)` 排除子元素冒泡造成的误消失；drop 的文件用 `/\.txt$/i` 过滤。两个区的这套逻辑抽成了 `wireDrop(dropId, pickId, pickerId, kind)`，调两次 —— **这是本页唯一的复用**，别顺手把它抽到公共文件去。
- **上传用 `XMLHttpRequest` 而不是 `fetch`**，因为要 `xhr.upload.onprogress` 进度。原文直传：`content-type: text/plain`，文件名走 `x-filename: encodeURIComponent(name)`，**不走 multipart**。
- **队列串行**：`busy` 标志 + `pump()` 递归。`jobs.unshift()` 让最新的排在最上面显示，但 `pump()` 用 `[...jobs].reverse().find(wait)` 取最早入队的先传，即「显示倒序、执行正序」。
- **进度条分三段**：上传阶段占 0–90%，`upload.onload` 后跳 92% 显示「服务端解析入库中…」，响应到达 100%。因为解析耗时在服务端，浏览器侧拿不到进度。
- **三种结果态**：`ok`（报解析/新增/重复跳过/守恒校验通过率/耗时，对手牌谱多报一项「玩家记录 N 条」）、`dup`（整份 sha256 重复，显示服务端的 `message`）、`err`（显示 `body.error`，网络错误提示「服务端是否在运行？」）。
- 每个任务结束都 `refresh()`：并发拉 `/api/files` 和 `/api/hands?per=10&sort=t&dir=desc`，渲染**两组**库存概览药丸（我的牌谱取 `filesRes.totals`，对手牌谱取 `filesRes.opp` 渲染到 `#oppTotals`）、上传历史表（多一列「类型」，重复手数 = `hands_total - hands_new`）、最近 10 手抽查表（用来肉眼确认数据真的可查）。
- 库存概览的「份数」按 `kind` 分开数：我的牌谱那组要 `files.filter(f => f.kind !== 'opp')`，**别直接用 `files.length`**。

## 数据页 `data.html` + `data.js`

`init()` 先拉 `/api/totals` 存进 `LIB`（用来生成级别 chip 和「全部」预设的日期边界），再 `reload()` 打 `/api/report` 把聚合结果存进全局 `S`，然后分四步渲染：`renderHead()` → `renderTables()` → `renderHeatmap()` → `renderCharts()`。

加载中显示 `#loading`，成功后 `hidden` 切换到 `#page`；`S.empty` 时提示去上传页（若有 `S.dropped` 会一并说明哪些级别因样本不足被剔除）。

### 时间 / 级别筛选条

`#dfilters` 里两行：日期范围 `#fFrom` `#fTo` + 四个快捷预设（最近 7 天 / 最近 30 天 / 本月 / 全部），级别是按 `LIB.by_stakes` 动态生成的多选 chip。状态存在 `F = { from, to, stakes }`，改动即 `reload()`（**不防抖**，因为 report 是重聚合，靠 `seq` 序号丢弃过期响应 + `#dfilters.busy` 禁交互来兜住连点）。

几个不能踩的点：

- **`minHands` 不再硬编码**。`reportUrl()` 只在「无任何筛选」时带 `minHands=100`；一旦带了 `from`/`to`/`stakes` 就不带，服务端会默认成 `0`（不剔除）。否则一选窄时间段，所有级别都掉到 100 手以下，页面直接空成一片，看着像坏了。
- **每次 `reload()` 必须 `cache.clear()`**。热图弹窗的明细缓存是按牌型键的，不含筛选条件；不清就会拿上一组筛选的明细。
- **`renderCharts()` 开头要销毁旧实例**。4 张图记在 `charts[]` 里（`mkChart()` 包一层 `new Chart` 顺手 push），重渲染前逐个 `destroy()`，否则 Chart.js 报「canvas already in use」。
- **热图点击用事件委托**，挂在稳定的 `#heatmap` 容器上而不是每次重建的 `#hmTable`，否则第二次渲染后格子就点不动了。
- 预设按钮和日期框是**双向同步**的：`applyPreset()` 写日期，`markPreset()` 反过来在日期恰好等于某个预设区间时点亮对应按钮。「全部」的边界取 `LIB.last_ts` 而不是 `new Date()`，因为牌谱可能是历史数据。
- 筛完没数据时（`S.empty` 且有筛选）文案是「当前筛选条件下没有手牌」并**保留筛选条可见**，让用户能改回来；服务端靠 `meta.filters` 回显筛选条件，前端用它区分「库是空的」和「筛没了」。

### 数字格式化（三套，别混用）

服务端 `report.js` 已经用银行家舍入算过一遍，展示层还要再格式化一次，所以 `data.js` 里**又有一份 `pyRound()`**（Python 的四舍六入五取偶）。在此之上三个函数：

| 函数 | 对应 Python | 用途 |
|---|---|---|
| `nfmt(v, nd)` | `f'{v:,.Nf}'` | 无符号、**带千分位** |
| `sfmt(v, nd)` | `f'{v:+,.Nf}'` | 带符号、**带千分位**（bb 总量） |
| `sfix(v, nd)` | `f'{v:+.Nf}'` | 带符号、**不带千分位**（bb/100 用这个） |

曾经因为 bb/100 误用了带千分位的版本，出现 `+1,237.9` vs 脚本的 `+1237.9`。另外 `signOf(r, v)` 会在舍入后为 0 但原值为负时仍输出 `-`，跟 Python 的行为一致。

### 四张图

Chart.js 全局默认色在 `renderCharts()` 里统一改过（`Chart.defaults.color/borderColor/font.family`），零刻度线用 `GZ` 回调加深，调色板 `PAL` 8 色循环。canvas id：

| id | 图 |
|---|---|
| `cumChart` | 累计盈亏（总利润 / 摊牌 / 非摊牌三条填充线） |
| `dailyChart` | 每日盈亏，按级别堆叠柱 |
| `posChart` | 各位置 bb/100 |
| `posVpipChart` | 各位置 VPIP / PFR 双柱 |

原本还有「分级别累计 bb」（`cumBBChart`）和「按小时盈亏与手数」（`hourChart`）两张，**已按要求删掉**。服务端 `/api/report` 仍然返回 `cumulative.bb` 和 `by_hour`，只是前端不再用 —— 想加回来的话数据是现成的。

所有图 `maintainAspectRatio: false`，高度由 `.chart-wrap` / `.tall` 的 CSS 控制。

### 13×13 热图 + 明细弹窗

格子键的推法（行列都按 `A K Q J T 9 8 7 6 5 4 3 2`）：

```js
i === j ? r1 + r2 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o'
```

即**右上三角同花、左下三角杂色、对角线对子**。手数 `< 15` 画灰点 `·`，否则底色按 `bb100` 在 **±150 截断**后映射绿/红透明度。

点格子调 `showGroup(key)`：`GET /api/hands?cards=<牌型>&per=500&sort=t&dir=asc&stakes=<报表保留的级别>&from=&to=`，结果拍平成 8 列数组存进 `cache`（同一牌型只拉一次，末列是 `hand_id`）。弹窗内的排序是**前端本地排序**（`sortBy()` 对 `curRows` 原地 sort），不再打服务端。关闭：`×` 按钮 / 点遮罩 / `Esc`。

弹窗最后一列「编号」是 `hand_id`，点它在新标签打开 `review.html?hid=<编号>`，复盘页会自动预填手牌编号筛选。

**弹窗合计必须和热图格子对得上**，所以三个参数都不能漏：`stakes` 带 `S.stakes`（报表实际保留的级别，否则被 `minHands` 剔掉的级别会混进来），`from` / `to` 带当前筛选的日期范围（否则筛了时间的热图格子点开会看到范围外的手牌）。改 `fetchGroup()` 时对着 `/api/report` 的 `groups` 复核一遍手数和净盈亏。

支持 hash 深链：打开 `data.html#g=AKs` 会自动弹出该牌型明细。

### 牌面渲染

`ch()` / `chs()` 与复盘页 `review.js` 完全同一套写法（`♠♥♦♣` + 按花色着色），用在热图弹窗的手牌/公共牌/对手牌，以及「最大底池」两张表的手牌/公共牌。热图格子里的 `AKs` 是**牌型**不是具体牌，保持纯文本。

配色不能照抄 `review.css`：复盘页是浅色主题，黑桃 `#252b36` 在数据页暗底上等于看不见，所以 `data.css` 里的 `.cd.*` 是调亮过的一套。

对手牌用 `chsOpp()`：`opp` 字段是空格分隔的裸牌串，多个对手 `join(' ')` 后分组信息就丢了（3 家摊牌 = `'Kc 9d Ac Kh Tc Jh'`）。因为 parser 的 `RE_SHOWS` 每人固定抓 2 张，所以**按 2 张一组切**就能还原每个对手，组间用 `/` 分隔。别用 `split(' ')` 逐张切 —— 那会渲染成 `K♣ / 9♦ / A♣ / …`，看着像 6 个对手。

## 复盘页 `review.html` + `review.js`

筛选 / 排序 / 分页**全部交给服务端 SQL**，前端只持有当前一页（`CUR`）。

- **6 组筛选器**放在 `<details>` 折叠块里：基础（级别/位置/日期/小时/手牌编号）、翻前、手牌、过程、结果、对手摊牌牌。级别和位置是动态生成的多选 chip（级别取自 `/api/totals` 的 `by_stakes`，位置取 `POS`），其余是 `select` / `input`。
- **URL 预填**：初始化时读 `location.search` 的 `hid` 填进 `#hidTxt`，供数据页热图弹窗跳转过来用。这是这页唯一的 URL 状态，改筛选不回写 URL。
- **参数拼装**在 `params()`：`put()` 会跳过空串和 `'any'`，所以「不限」不会进 query；小时只在非 `0~23` 时才带上。
- **防抖 180ms**（`apply()`），避免输入框每个字符打一次请求。翻页和排序不防抖，直接 `load()`。
- **慢响应淘汰**：`reqSeq` 自增，响应回来时 `seq !== reqSeq` 就丢弃 —— 快速改筛选时不会被先发后到的旧响应覆盖。
- **页码基数要注意**：前端 `page` 是 **0 基**（沿用原脚本），发请求时 `page + 1`，收到响应后 `page = data.page - 1`。
- **排序**只认表头上 `data-k` 的四个键 `t / potbb / net / bb`（与服务端白名单一致）；同键再点反向，换键时 `t` 默认降序、其他默认升序。
- **点行展开**：在 `tr.hr` 后面插一个 `tr.det`，再点同一行则移除。详情由 `det(r)` 渲染：拆 `r.act` 的 `|` 得到四条街的动作串，把开头的 `H` / `P1` 玩家标记包成 `.ak` 高亮，配上各街牌面、投入/收回/净盈亏/整桌底池/rake+splash/促销注入，以及对手摊牌牌。
- **标签渲染**三个函数：`pfTag()`（弃/跟/过/开池/3bet/4bet/5bet+，附「面开」「被3b」）、`stTag()`（到达街道 + 摊 + 全下）、`resTag()`（摊牌赢/输/平、未摊赢、翻前弃/弃牌/平）。
- **汇总条** `#sumbar` 由 `/api/hands` 的 `summary` 直接渲染，随筛选实时变。百分比为 `null` 时显示 `—`。
- 这页**没有 header**（已按要求删掉），库存概要就在汇总条里。

## 对手页 `opponents.html` + `opponents.js`

一行一个对手的 HUD 表。和复盘页同构：筛选 / 排序 / 分页**全部交给服务端 SQL**，前端只持有当前一页。

`init()` 先拉 `/api/opp-totals`：`hands === 0` 就在 `#loading` 里提示去上传页把对手牌谱拖进「对手牌谱」区，**直接 return 不再建表**（没有对手数据时整页不该出现空表头）。有数据才生成级别 chip（按 `by_stakes`）和位置 chip（按 `POS`），然后 `load()`。

- **筛选状态** `F = { q, minHands, from, to, stakes, pos }`，`minHands` 默认 **30**（服务端同默认值）。名字搜索和最少手数**防抖 180ms**，chip 和日期立即生效。任何筛选变化都 `page = 1` —— 否则筛窄了会停在一个不存在的页码上，表格空成一片。
- **页码是 1 基**，和服务端一致。**这点和复盘页的 0 基不同**，改分页时别照抄 `review.js`。
- **慢响应淘汰**：同 `reqSeq` 套路。
- **15 列 15 个排序键**，表头 `th.s` 上挂 `data-k`，与服务端白名单一一对应。同键再点反向；换键时**只有「玩家」默认升序**，其余（都是数值列）默认降序。当前排序列加 `.sorted`（蓝 + `▾`/`▴`）。第 16 列「明细」是行末的「复盘」按钮，**不可排序**（没有 `th.s`），空态的 `colspan` 是 16。
- **行末「复盘」按钮**：`<a class="btn-sm" href="opp-review.html?player=<encodeURIComponent(玩家名)>" target="_blank" rel="noopener">`。玩家名可能含任何字符，**必须 `encodeURIComponent`**（href 里）+ `esc()`（正文里），两个都不能省。
- **`null` 一律渲染成 `—`**（`p1()` / `sfix1()` 里判 `v == null`）。服务端在分母为 0 时给的就是 `null`，**别在前端拿 0 兜底** —— 「没机会 3bet」和「有机会但从不 3bet」是两件事。
- **偏离上色**：`BAND` 里是常见 NL100 6-max 的参考区间，高于上界标 `.hi`（琥珀）、低于下界标 `.lo`（蓝）。这**只是提示**，不判断好坏、不参与计算；改了区间记得同步 html 底部的图例。
- **汇总条** `#sumbar` 用 `/api/opponents` 的 `summary`：`total` 是「符合筛选且手数达标」的人数，`summary.players` 是「符合筛选」的总人数，两者一起显示成「≥N 手：X / Y 人」。注意 `summary` 不受 `minHands` 影响，所以筛完为空时仍能看到池子有多少人。
- 玩家名列 `td.name` 允许 `word-break: break-all` 换行（真实用户名可以很长），其余数值列用 `tabular-nums` 对齐。
- 玩家名是**牌谱里的真实用户名**，渲染前必须 `esc()`。

## 对手复盘页 `opp-review.html` + `opp-review.js`

把某个对手当成 Hero 的逐手复盘。**没有导航入口**，只能从对手表行末的「复盘」按钮进来（新标签），玩家名走 `?player=`。数据源是 `/api/opp-hands`，筛选 / 排序 / 分页同样全在服务端。

结构上是 `review.html` + `review.js` 的副本：**6 组筛选器的控件 id 全部照用**（`g_lv` `g_pos` `d1` `d2` `h1` `h2` `hidTxt` `paSel` `rtSel` …），css 直接引 `review.css`。差异只有四处，想同步改动时照这四处找：

1. **请求 `/api/opp-hands` 且必带 `player`**；分页条的「库内总手数」取响应里的 `playerTotal`（不是 `/api/totals`）。玩家名输入框 `#plTxt` 放在「基础」组第一行，**改它就等于换个人复盘**，所以每次 `load()` 都重读它，并同步刷新 `#who` 标题和 `document.title`。「重置」按钮**故意不清 `#plTxt`** —— 清掉这页就废了。
2. **级别 chips 来自 `/api/opp-totals`**（复盘页是 `/api/totals`）。库里没有对手牌谱时提示去上传页。
3. **手牌列可能为空**：对手牌谱只在摊牌亮牌时才有底牌，空的渲染成 `—`（`.mut`），详情头里写「未摊牌（无底牌数据）」。因此**手牌 / 牌型筛选只能筛出摊过牌的手**，html 的提示里也写了这句。
4. **`det()` 的动作流是真实用户名**：`r.act` 按 `|` 拆四街，段内按空格切分后 **偶数位 = 演员、奇数位 = 动作码**（动作码里没有空格、用户名也不含空格，所以位置固定可靠）。命中当前玩家的名字加 `.ak.me` 高亮。详情末尾额外渲染 `r.ps` 的同桌清单（`.who`：谁在什么位置、净盈亏多少）—— 没有它读不出真实用户名对应哪个位置。

另外两个小差异：`summary` 里没有促销注入（对手格式不存在 splash），`st` / `sd` 是**手牌级**的（牌局走到哪街 / 这手有没有摊牌），不是「这个人走到哪街」—— 他可能翻前就弃了。

**页码基数沿用复盘页的 0 基**（发请求 `page + 1`）。别照抄对手页的 1 基。

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

五个页面共同约定：

- `POS = ['UTG','MP','CO','BTN','SB','BB']`，`pos` 是下标，`-1` 渲染成 `?`。五个 js 各有一份常量。
- 金额字段服务端已除 100，前端只做格式化，**不做二次运算**（除了 `data.js` 弹窗里的合计求和）。
- `SU = { s:'♠', h:'♥', d:'♦', c:'♣' }`，两张牌的字符串按每 2 字符切开渲染。
- 所有插进 `innerHTML` 的服务端字符串都过 `esc()`（转义 `& < > "`）—— 文件名、牌面、对手牌、动作日志、**对手玩家名**都来自牌谱文本，**新增拼串处别忘了套 `esc()`**。
- 百分比/比率字段服务端在**分母为 0 时给 `null`**（不是 0），前端统一渲染 `—`。`/api/hands` 的 `summary` 和 `/api/opponents` 的行与 `summary` 都遵守这条。

### `/api/opponents` 行字段

```
player 玩家名（真实用户名，必须 esc）   hands 手数
vpip pfr    翻前入池率 / 加注率
t3b f3b     3Bet / 弃3Bet
steal       偷盲（ATS）
cbet fcb    翻牌持续下注 / 弃持续下注
wtsd wsd    看摊牌率 / 摊牌胜率
wwsf        看到翻牌后赢下比例
af          翻后激进度（下注+加注 ÷ 跟注）
bb100 net   bb/100、净盈亏 ₮（已除 100）
```

除 `player` / `hands` / `net` 外**都可能是 `null`**。

### `/api/opp-hands` 行字段

与 `/api/hands` **逐个同名**（所以 `opp-review.js` 能照抄 `review.js` 的渲染），只有三处不同：

```
没有 sp（促销注入）—— 对手牌谱格式里不存在
cd / hg   未摊牌时是空串（不是 null），渲染 —
ps        本手同桌清单 [{n:用户名, pos:POS 下标, net:净盈亏 ₮}]，按座位序
act       演员是真实用户名，不是 H / P1..P5
```

顶层多一个 `playerTotal`（该玩家不带筛选的总手数），`summary` 与 `/api/hands` 同结构但 `sawFlop` 是**这个人真的进了翻牌**的比例（Hero 侧那个其实是「牌局走到了翻牌」）。

## 坑

- 五个页面都是**字符串拼 `innerHTML`**，没有虚拟 DOM。改渲染时注意 `esc()` 和引号闭合。
- `data.js` 的 `pyRound()` 和 `server/src/report.js` 的是**两份独立实现**，改一处要改两处，否则展示层数字和 API 数字会分叉。
- `review.js` 和 `opp-review.js` 也是**两份独立实现**（后者是前者的副本，差四处）。改复盘页的标签/详情/参数拼装时，先想清楚要不要同步过去。
- `minHands` 在两处含义不同：数据页由 `reportUrl()` 决定带不带（无筛选带 `100`，有筛选不带，服务端默认 `0`，没有 UI）；对手页是**用户可填的输入框**（默认 `30`，服务端同默认值）。别把两处的默认值混着改。
- **分页页码基数不统一**：复盘页与对手复盘页 0 基，对手页 1 基。这是历史原因（复盘页沿用原 Python 脚本），改分页逻辑时先确认在哪一页。
- Chart.js 是唯一第三方，已 vendor 到 `vendor/`。**不要改成 CDN**，也不要再引入别的库。数据页的图会被反复重建，新增图表记得走 `mkChart()` 而不是 `new Chart()`，否则重渲染时炸。对手页与对手复盘页**都没有图表**，别为了加图把 Chart.js 引进来。
- 新增任何 client 文件都必须同步加进 `../sea-config.json` 的 `assets`，否则开发模式好使、打包出来的 exe 里 404。（`opp-review.html` / `opp-review.js` 已登记；它引的 `review.css` 本来就在。）
- `src/index.js` 是 0 字节死文件，留着没用。
- **没有在真实浏览器里验证过**图表绘制、热图点击弹窗、筛选器交互、**对手页表格/chip/分页/排序/「复盘」按钮跳转**、**对手复盘页整页**（30 个筛选项、点行展开动作流与同桌清单、排序翻页、未摊牌显示 `—`）、**上传页两个拖拽区的拖放**（只用 DOM/Chart/fetch 桩做过无头冒烟，接口层走真实 HTTP 验过）。动这些渲染的话，改完让用户开页面确认，别声称已测。
