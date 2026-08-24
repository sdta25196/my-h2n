// SEA（单文件 exe）专用入口：只做「起服务 + 开默认浏览器」，业务逻辑全在 index.js。
// 开发模式（node server/src/index.js）不会加载本文件。
//
// 约束：本文件会被 esbuild 打成 CJS，所以不能用顶层 await（--format=cjs 直接报错），
// 也不能用 import.meta.url（会被编译成 undefined）。
import { spawn } from 'node:child_process';
import { server } from './index.js';

const PORT = +(process.env.PORT || 3000);
const url = `http://localhost:${PORT}`;

const openBrowser = () => {
  // start 的第一个引号参数是窗口标题，必须留空，否则 URL 会被当成标题吞掉
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
};

server.on('error', (err) => {
  const msg =
    err.code === 'EADDRINUSE'
      ? `端口 ${PORT} 已被占用（可能 my-h2n 已经在运行了；换端口可先执行 set PORT=3001）`
      : err.message;
  // 不 resume stdin 的话控制台会闪退，对方看不到任何提示
  console.error(`\n启动失败：${msg}\n\n按回车键关闭窗口...`);
  process.stdin.resume();
});

if (server.listening) openBrowser();
else server.once('listening', openBrowser);
