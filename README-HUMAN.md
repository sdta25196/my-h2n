# my-h2n

牌谱分析：把导出的牌谱 txt 上传入库，然后看数据统计和逐手复盘。

## 技术栈

数据库:sqlite；用内置 node:sqlite
后端：nodejs
前端:html js css

无 npm 依赖、无构建步骤，`git clone` 完直接跑。需要 Node ≥ 22.5（用到内置 `node:sqlite`）。

## 启动

```bash
node server/src/index.js
```

浏览器打开 http://localhost:3000 ，静态页由服务端一起托管。也可以在 `server/` 目录下用 npm 脚本：

```bash
cd server
npm start                # 同上，启动服务
npm run reset            # 清空数据库（只报数，预演）
npm run reset -- --yes   # 确认清空
```

改端口或数据库位置：`PORT=8080 DATA_DIR=/some/dir node server/src/index.js`。数据库文件在 `server/data/poker.db`（已 gitignore）。

## 怎么用

1. **上传页**（首页）— 把牌谱 `.txt` 拖进去，可多选。同一个文件重复上传会跳过；不同文件里时间段重叠的手牌按手牌编号自动去重，所以可以放心叠加上传。每份文件会报新增/重复手数和筹码守恒校验通过率。
2. **数据页** — 整体统计报表：KPI 卡、级别对比、6 张图（累计盈亏、每日、按小时、按位置）、翻前翻后指标、13×13 起手牌热图（点格子看该牌型的每一手）、场次明细、最大底池。
3. **复盘页** — 逐手浏览：7 组筛选器（级别/位置/时间、翻前动作、手牌、翻牌面牌型、过程、结果、对手摊牌牌）、可排序表格，点任意一行展开这手的逐街动作、金额和对手摊牌。

## 项目架构

```
server/
  src/
    index.js    HTTP 服务：API 路由 + 上传 + 托管前端静态文件
    parser.js   牌谱解析器：逐行流式读取，一手一手产出结构化记录
    db.js       sqlite 建表、去重、批量写入
    hands.js    /api/hands —— 复盘页的筛选、排序、分页、汇总
    report.js   /api/report —— 数据页的统计聚合
  scripts/
    reset.js    清库
    verify.js   解析器对拍（历史校验用，需要 Python 基准文件）
  data/         数据库文件（自动生成，不入库）
client/
  index.html  upload.js   上传页
  data.html   data.js     数据页
  review.html review.js   复盘页
  *.css                   各页样式
  vendor/chart.umd.min.js Chart.js（本地引用，不走 CDN）
```

数据走向很简单：**上传的 txt → 解析成一手一行存进 sqlite → 前端 fetch API 拿数据渲染**。所有统计都是每次请求实时算的，不落中间表，所以新上传的牌谱立刻反映到两个页面上。前端页面本身不含数据，纯 fetch。

## 性能

35MB / 29,658 手的牌谱：上传到入库完成约 3 秒；数据页全量聚合约 0.4 秒；复盘页任意筛选毫秒级。

## 数据准确性

解析器是从原先的两个 Python 脚本移植的，做过逐手对拍：29,658 手 × 29 个字段与 Python 输出完全一致，筹码守恒校验 29658/29658 通过。金额在内部一律用「分」做整数运算，不存在浮点误差累积。

有两处口径跟旧的 `poker_report.py` 有意不同（以更严格的 `hand_browser.py` 为准），会让金额类数字差约 0.25₮、大盲防守率差 0.1~0.2 个点，细节见 `README-AI.md`。
