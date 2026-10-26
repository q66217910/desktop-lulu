/* ===== 启动器：清理 ELECTRON_RUN_AS_NODE 后启动桌宠 =====
 * 部分机器全局设置了 ELECTRON_RUN_AS_NODE=1，会让 electron.exe 退化为
 * 普通 node（require('electron') 拿不到 app）。这里统一兜底清除。 */
const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const exe = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(exe, [PROJECT_ROOT], { stdio: 'inherit', env, windowsHide: true });
child.on('exit', (code) => process.exit(code == null ? 0 : code));
