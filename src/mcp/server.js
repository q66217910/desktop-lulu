/* ===== 噜噜 MCP Server（stdio）=====
 * 由 WorkBuddy 通过 ~/.workbuddy/mcp.json 拉起。
 * 职责：把 AI 的工具调用转发给桌宠的本地 HTTP 控制端；桌宠没起时负责唤醒它。 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 18731;
const BASE = `http://127.0.0.1:${PORT}`;
// server.js 位于 <项目根>/src/mcp/，项目根往上两级
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const TOKEN_FILE = path.join(APPDATA, 'lulu-pet', 'lulu-token.txt');

/* ---------- 与桌宠通信 ---------- */
function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${urlPath}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-lulu-token': token } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data || '{}')); }
          catch { resolve({ ok: false, error: 'bad json' }); }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isPetRunning() {
  try { await request('GET', '/ping'); return true; } catch { return false; }
}

/* 找到桌宠可执行文件：已安装的单文件 exe > 开发模式 electron > 打包产物 */
function resolvePetExecutable() {
  // 1. install.js --exe 安装到用户目录的单文件版（便携分发场景）
  const homeExe = path.join(process.env.USERPROFILE || process.env.HOME || '', '.lulu-pet', 'lulu-pet.exe');
  if (fs.existsSync(homeExe)) return { exe: homeExe, args: [] };
  // 2. 开发模式：electron + 项目根
  const devExe = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(devExe)) return { exe: devExe, args: [PROJECT_ROOT] };
  // 3. electron-builder 产物
  const local = path.join(PROJECT_ROOT, 'dist', 'lulu-pet.exe');
  if (fs.existsSync(local)) return { exe: local, args: [] };
  const beside = path.join(PROJECT_ROOT, 'lulu-pet.exe');
  if (fs.existsSync(beside)) return { exe: beside, args: [] };
  return null;
}

async function ensurePet() {
  if (await isPetRunning()) return { started: false };
  const target = resolvePetExecutable();
  if (!target) throw new Error('找不到噜噜的启动文件，请先运行 npm start 或打包后的 lulu-pet.exe');
  // 关键：清除 ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化为普通 node
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(target.exe, target.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  for (let i = 0; i < 40; i++) { // 最多等 20 秒
    await sleep(500);
    if (await isPetRunning()) return { started: true };
  }
  throw new Error('噜噜启动超时');
}

function readToken() {
  const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!t) throw new Error('token 文件为空，请先手动启动一次桌宠');
  return t;
}

/* ---------- MCP 工具 ---------- */
const server = new McpServer({ name: 'lulu-pet', version: '1.0.0' });

server.tool(
  'lulu_say',
  '让桌面宠物水豚噜噜说出一句话（屏幕气泡展示）。适合：任务完成的祝贺、提醒休息、卖萌互动。',
  {
    text: z.string().max(200).describe('要让噜噜说的话，简体中文，尽量简短口语化'),
    ms: z.number().int().min(1000).max(30000).optional().describe('气泡停留毫秒数，默认 3600'),
  },
  async ({ text, ms }) => {
    await ensurePet();
    await request('POST', '/say', { text, ms }, readToken());
    return { content: [{ type: 'text', text: `噜噜收到了：「${text}」` }] };
  }
);

server.tool(
  'lulu_act',
  '让噜噜做一个动作。celebrate=开心跳跃撒花(任务完成时用), jump=弹一下, sleep=去睡觉, wake=叫醒, walk=屏幕底部散步, idle=待机。',
  {
    action: z.enum(['celebrate', 'jump', 'sleep', 'wake', 'walk', 'idle']).describe('动作名称'),
  },
  async ({ action }) => {
    await ensurePet();
    const r = await request('POST', '/act', { action }, readToken());
    return { content: [{ type: 'text', text: r.ok ? `噜噜正在 ${action}` : `失败：${r.error}` }] };
  }
);

server.tool(
  'lulu_status',
  '查询噜噜当前状态：是否在桌面上运行、屏幕坐标、是否在睡觉。',
  {},
  async () => {
    const running = await isPetRunning();
    if (!running) {
      return { content: [{ type: 'text', text: JSON.stringify({ running: false, hint: '调用 lulu_act 或 lulu_say 可自动唤醒噜噜' }) }] };
    }
    const s = await request('GET', '/status');
    return { content: [{ type: 'text', text: JSON.stringify(s) }] };
  }
);

server.tool(
  'lulu_joke',
  '让噜噜讲一个关于水豚的冷笑话（随机）。',
  {},
  async () => {
    const jokes = [
      '为什么水豚不喜欢排队？因为它总是被“卡皮巴拉~”卡住！',
      '我的心情就像水温：不烫不凉，刚刚好。',
      '橘子是我的，牛奶也是我的，你？可以考虑。',
      '据说盯着我看三分钟的人，都会变得很平静。',
      '今天也没有烦恼，因为头发……啊我是毛。',
    ];
    const joke = jokes[Math.floor(Math.random() * jokes.length)];
    await ensurePet();
    await request('POST', '/say', { text: joke }, readToken());
    return { content: [{ type: 'text', text: joke }] };
  }
);

/* ---------- 启动 ---------- */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 注意：stdio 模式下严禁 console.log，会污染协议流
  console.error('[lulu-mcp] server ready');
  // MCP 一连上就尝试唤醒桌宠：用户在连接器页启用 lulu-pet 即自动出现
  // 失败只记日志，不影响 MCP 工具本身
  ensurePet().then(
    (r) => console.error('[lulu-mcp] ensurePet:', JSON.stringify(r)),
    (e) => console.error('[lulu-mcp] ensurePet failed:', e.message)
  );
}

main().catch((e) => {
  console.error('[lulu-mcp] fatal:', e);
  process.exit(1);
});
