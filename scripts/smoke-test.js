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

  console.log('6) tools/call lulu_chat rename ...');
  const chat = await call('tools/call', {
    name: 'lulu_chat',
    arguments: { event: 'rename', title: '修个 bug' },
  });
  console.log('   ', chat.result.content[0].text);

  console.log('7) tools/call lulu_act think ...');
  const think = await call('tools/call', { name: 'lulu_act', arguments: { action: 'think' } });
  console.log('   ', think.result.content[0].text);

  console.log('8) tools/call lulu_act idle（复位，避免卡在思考姿势）...');
  const idle = await call('tools/call', { name: 'lulu_act', arguments: { action: 'idle' } });
  console.log('   ', idle.result.content[0].text);

  console.log('9) tools/call lulu_bond status（养成系统）...');
  const bond = await call('tools/call', { name: 'lulu_bond', arguments: { action: 'status' } });
  console.log('   ', bond.result.content[0].text);

  console.log('10) tools/call lulu_chat stock（盯盘：+3.2% 应庆祝）...');
  const stock = await call('tools/call', { name: 'lulu_chat', arguments: { event: 'stock', title: '测试股', changePct: 3.2 } });
  console.log('   ', stock.result.content[0].text);

  console.log('11) tools/call lulu_chat fail（失败应安慰不庆祝）...');
  const fail = await call('tools/call', { name: 'lulu_chat', arguments: { event: 'fail' } });
  console.log('   ', fail.result.content[0].text);

  console.log('12) tools/call lulu_remind（1 分钟后提醒，验证注册）...');
  const remind = await call('tools/call', { name: 'lulu_remind', arguments: { text: '测试提醒', minutes: 1 } });
  console.log('   ', remind.result.content[0].text);

  console.log('13) tools/call lulu_remind（每天 09:30，验证注册）...');
  const remindDaily = await call('tools/call', { name: 'lulu_remind', arguments: { text: '开盘啦', daily: '09:30' } });
  console.log('   ', remindDaily.result.content[0].text);

  console.log('\n全部通过 ✔  桌宠现在应该正在屏幕上跳。');
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  child.kill();
  process.exit(1);
});
