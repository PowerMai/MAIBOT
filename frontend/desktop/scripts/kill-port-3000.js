#!/usr/bin/env node
// 同步释放 3000 端口，供 electron:dev:fresh 在启动 Vite 前执行（仅 macOS/Linux 有效）
const c = require('child_process');
try {
  const out = c.execSync('lsof -ti3000 2>/dev/null', { encoding: 'utf8' });
  const pid = (out && out.trim());
  if (pid) {
    c.execSync('kill -9 ' + pid);
    console.log('[kill-port-3000] 已释放 3000 端口 (pid ' + pid + ')');
  }
} catch (_) {
  // 无进程占用或非 Unix
}
