/* ===== 冒烟测试：模拟 WorkBuddy 通过 stdio 调用 MCP server ===== */
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const SERVER = path.resolve(__dirname, '..', 'src', 'mcp', 'server.js');
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
});
child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 25000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('1) initialize ...');
  const init = await call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  console.log('   serverInfo =', JSON.stringify(init.result.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log('2) tools/list ...');
  const tools = await call('tools/list');
  console.log('   工具 =', tools.result.tools.map((t) => t.name).join(', '));

  console.log('3) tools/call lulu_status（首次会自动唤醒桌宠）...');
  await sleep(500);
  const st = await call('tools/call', { name: 'lulu_status', arguments: {} });
  console.log('   ', st.result.content[0].text);

  console.log('4) tools/call lulu_say ...');
  const say = await call('tools/call', {
    name: 'lulu_say',
    arguments: { text: '你好，我是噜噜！', ms: 4000 },
  });
  console.log('   ', say.result.content[0].text);

  console.log('5) tools/call lulu_act celebrate ...');
  const act = await call('tools/call', { name: 'lulu_act', arguments: { action: 'celebrate' } });
  console.log('   ', act.result.content[0].text);

  console.log('\n全部通过 ✔  桌宠现在应该正在屏幕上跳。');
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  child.kill();
  process.exit(1);
});
