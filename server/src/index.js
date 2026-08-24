// my-h2n 服务端：牌谱上传入库 + 查询 API + 静态托管 client
// 零外部依赖：node:http + node:sqlite
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamParser } from './parser.js';
import { abortUpload, beginUpload, createWriter, finishUpload, findFileBySha, listFiles, openDb, totals } from './db.js';
import { queryHands } from './hands.js';
import { buildReport } from './report.js';
import { isSea, getAsset } from 'node:sea';

// 打包成单文件 exe（Node SEA）后：前端资源嵌在 exe 里，数据落 exe 同目录
// 注意 SEA 分支不能碰 import.meta.url —— esbuild 输出 CJS 时它会变成 undefined
const IN_SEA = isSea();
const PORT = +(process.env.PORT || 3000);

let CLIENT_DIR = null; // SEA 下为 null，静态资源改从 sea assets 读
let DATA_DIR;
if (IN_SEA) {
  DATA_DIR = process.env.DATA_DIR || join(dirname(process.execPath), 'data');
} else {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(HERE, '..', '..');
  CLIENT_DIR = join(ROOT, 'client');
  DATA_DIR = process.env.DATA_DIR || join(ROOT, 'server', 'data');
}
const TMP_DIR = join(DATA_DIR, 'tmp');
const MAX_UPLOAD = 500 * 1024 * 1024;

mkdirSync(TMP_DIR, { recursive: true });
const db = openDb(join(DATA_DIR, 'poker.db'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sendJson = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
};

function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^[/\\]+/, '');
  const send404 = () => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  };

  if (IN_SEA) {
    // asset 的 key 一律正斜杠，而 Windows 上 normalize() 会把 / 变成 \，得转回来
    const key = rel.replace(/\\/g, '/');
    if (key.split('/').includes('..')) return send404();
    let buf;
    try {
      buf = Buffer.from(getAsset(key));
    } catch {
      return send404(); // asset 不存在时 getAsset 是抛异常，不是返回 undefined
    }
    res.writeHead(200, {
      'content-type': MIME[extname(key)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-cache',
    });
    return res.end(buf);
  }

  const file = join(CLIENT_DIR, rel);
  if (!file.startsWith(CLIENT_DIR) || !existsSync(file) || !statSync(file).isFile()) return send404();
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

function safeUnlink(file) {
  try {
    unlinkSync(file);
  } catch {
    /* 临时文件已不存在 */
  }
}

// 上传：请求体为牌谱原文（不走 multipart），文件名放在 x-filename 头里
async function handleUpload(req, res) {
  const declared = +(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) return sendJson(res, 413, { error: '文件过大（上限 500MB）' });

  const filename = decodeURIComponent(req.headers['x-filename'] || '') || 'unnamed.txt';
  const tmp = join(TMP_DIR, randomUUID() + '.txt');
  const hash = createHash('sha256');
  let bytes = 0;

  try {
    req.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    await pipeline(req, createWriteStream(tmp));
  } catch (err) {
    safeUnlink(tmp);
    return sendJson(res, 400, { error: '接收文件失败: ' + err.message });
  }

  const sha256 = hash.digest('hex');
  const dup = findFileBySha(db, sha256);
  if (dup) {
    safeUnlink(tmp);
    return sendJson(res, 200, {
      status: 'duplicate_file',
      message: `该文件已于 ${dup.uploaded_at} 上传过（${dup.filename}），跳过解析`,
      file: dup,
      totals: totals(db),
    });
  }

  const fileId = beginUpload(db, { filename, sha256, size: bytes });
  const writer = createWriter(db, fileId);
  const t0 = Date.now();
  try {
    const parser = createStreamParser((h) => writer.add(h));
    const rl = createInterface({ input: createReadStream(tmp, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) parser.line(line);
    parser.end();
    const stats = writer.commit();
    if (stats.total === 0) {
      abortUpload(db, fileId);
      safeUnlink(tmp);
      return sendJson(res, 400, { error: '未解析到任何手牌，请确认是 CoinPoker 现金桌牌谱' });
    }
    const file = finishUpload(db, fileId, stats);
    safeUnlink(tmp);
    sendJson(res, 200, {
      status: 'ok',
      file,
      stats: {
        ...stats,
        duplicated: stats.total - stats.inserted,
        checkRate: stats.checkTotal ? (100 * stats.checkPassed) / stats.checkTotal : 0,
        elapsedMs: Date.now() - t0,
      },
      totals: totals(db),
    });
  } catch (err) {
    writer.rollback();
    abortUpload(db, fileId);
    safeUnlink(tmp);
    sendJson(res, 500, { error: '解析入库失败: ' + err.message });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/upload') return void handleUpload(req, res);
    if (req.method === 'GET' && p === '/api/files') return sendJson(res, 200, { files: listFiles(db), totals: totals(db) });
    if (req.method === 'GET' && p === '/api/totals') return sendJson(res, 200, totals(db));
    if (req.method === 'GET' && p === '/api/hands') return sendJson(res, 200, queryHands(db, url.searchParams));
    if (req.method === 'GET' && p === '/api/report') {
      const sp = url.searchParams;
      const from = sp.get('from') || '';
      const to = sp.get('to') || '';
      const stakes = (sp.get('stakes') || '').split(',').map((s) => s.trim()).filter(Boolean);
      // 有筛选时默认不再按手数剔除级别：用户明确要看的区间不该被悄悄丢掉
      // （显式传 minHands 仍然优先，全量视图保持 100 手门槛不变）
      const mh = sp.get('minHands');
      const minHands = mh !== null && mh !== '' ? Number(mh) : from || to || stakes.length ? 0 : 100;
      return sendJson(res, 200, buildReport(db, { minHands, from, to, stakes }));
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: '未知接口 ' + p });
    if (req.method === 'GET') return serveStatic(res, p);
    sendJson(res, 405, { error: '不支持的方法 ' + req.method });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`my-h2n 服务端已启动: http://localhost:${PORT}`);
  console.log(`数据库: ${join(DATA_DIR, 'poker.db')}`);
});

export { server };
