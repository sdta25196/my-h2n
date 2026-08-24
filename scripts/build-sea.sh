#!/usr/bin/env bash
# 打包成单文件绿色版 exe（Node SEA）。用法：bash scripts/build-sea.sh
#
# 构建期需要 npx 拉 esbuild 和 postject —— 两者都不进运行时，产物仍是零依赖。
# 用 NODE_EXE=/path/to/node.exe 可指定用哪个 node 当外壳。
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_EXE="${NODE_EXE:-$(which node)}"
# Node 编译时把 postject 的 sentinel 覆盖成了这个值，不传 --sentinel-fuse
# 会导致注入「成功」但 isSea() 永远返回 false，exe 表现为空跑退出。
FUSE=NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

rm -rf dist && mkdir -p dist

echo "==> esbuild: ESM -> 单个 CJS（SEA 入口只支持 CommonJS）"
npx --yes esbuild server/src/main-sea.js --bundle --platform=node --format=cjs \
  --external:node:* --outfile=dist/main.cjs --log-level=warning

echo "==> 生成 SEA blob（含 client/ 静态资源）"
"$NODE_EXE" --experimental-sea-config sea-config.json

echo "==> 复制 node.exe 并注入 blob"
cp "$NODE_EXE" dist/my-h2n.exe
npx --yes postject dist/my-h2n.exe NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse "$FUSE" --overwrite

rm -f dist/sea-prep.blob dist/main.cjs
echo "==> 完成: dist/my-h2n.exe ($(du -h dist/my-h2n.exe | cut -f1))"
echo "    单独把这个 exe 发给别人即可，数据库会建在 exe 同目录的 data/ 下。"
