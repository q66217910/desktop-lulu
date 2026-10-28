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

/* ---------- 对话事件联动：事件 → 动作 + 内容 ----------
 * 关联 WorkBuddy 对话生命周期：每个事件配一套动作序列和噜噜口吻的台词。
 * 睡觉中的噜璐会先被叫醒（wake），再执行事件动作。 */
const CHAT_EVENTS = {
  // 新对话开启 / 用户回来开工
  open: {
    actions: [], // 唤醒由 ensureAwake 统一处理
    lines: ['来啦？呜~坐吧', '新对话…开摸', '哦…又是你，坐吧', '开工开工，不慌'],
  },
  // 对话被命名 / 设置标题（{t} 会被替换成标题）
  rename: {
    actions: ['jump'],
    lines: ['「{t}」？记下了', '这题叫「{t}」…慢慢来', '好嘞，「{t}」…', '「{t}」…不费脑子的样子'],
  },
  // 对话里的任务完成 / 交付成果
  done: {
    actions: ['celebrate'],
    lines: ['搞定！噜噜给你撒花~', '又完成一件…厉害厉害', '收工！去泡温泉？', '哼唧…还不错嘛'],
  },
  // 长任务进行中，噜噜值守
  busy: {
    actions: [],
    lines: ['去吧去吧，我看包', '不催…我守着', '慢慢跑，桌我看着'],
  },
  // 任务失败：构建/测试/部署翻车（安慰，不庆祝）
  fail: {
    actions: [],
    lines: ['挂了？不急…噜噜在呢', '呜~翻车了，摸摸头', '别慌…看看日志再说', '哼唧，错的不是你是环境'],
  },
  // 对话收尾 / 用户暂别
  bye: {
    actions: [],
    lines: ['走了？呜~见', '去忙吧…噜噜在', '晚安…记得回来'],
  },
  // 开始学习新主题/课题（{t} 会被替换成课题名）
  study: {
    actions: ['jump'],
    lines: ['今日课题「{t}」…记下了', '「{t}」？慢慢来', '开讲啦？噜噜拿笔记'],
  },
  // 学习打卡：答对/答错（动作和台词在 lulu_chat 处理器里按 correct 动态生成）
  quiz: { actions: [], lines: [] },
  // 盯盘：股票涨跌播报（动作和台词按 changePct 动态生成）
  stock: { actions: [], lines: [] },
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* 睡觉中就叫醒；醒着则不动。返回是否执行了唤醒 */
async function ensureAwake() {
  try {
    const s = await request('GET', '/status');
    if (s && s.sleeping) {
      await request('POST', '/act', { action: 'wake' }, readToken());
      return true;
    }
  } catch { /* 状态查询失败不阻塞，按醒着处理 */ }
  return false;
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
  '让噜噜做一个动作。celebrate=开心跳跃撒花(任务完成时用), jump=弹一下, think=思考中(💭气泡+缓摆,持续到下一个动作), sleep=去睡觉, wake=叫醒, walk=屏幕底部散步, idle=待机。',
  {
    action: z.enum(['celebrate', 'jump', 'think', 'sleep', 'wake', 'walk', 'idle']).describe('动作名称'),
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

server.tool(
  'lulu_chat',
  '关联 WorkBuddy 对话事件：让噜噜做出与对话场景配套的动作+台词。open=新对话开启/用户回来, rename=对话命名或设置标题(传 title), done=对话中任务完成, busy=跑长任务时噜噜值守, bye=对话收尾暂别, study=开始学习新课题(传 title), quiz=学习打卡(传 correct 是否答对), stock=股票涨跌播报(传 title 股票名 + changePct 涨跌幅，大涨庆祝大跌安慰), fail=任务失败/构建测试报错(安慰不庆祝)。',
  {
    event: z.enum(['open', 'rename', 'done', 'busy', 'bye', 'study', 'quiz', 'stock', 'fail']).describe('对话事件类型'),
    title: z.string().max(50).optional().describe('rename/study/stock 事件用：对话标题/课题名/股票名'),
    changePct: z.number().optional().describe('stock 事件用：涨跌幅百分比，如 3.2 或 -1.5'),
    correct: z.boolean().optional().describe('quiz 事件用：用户是否答对'),
    text: z.string().max(200).optional().describe('自定义台词，覆盖随机台词'),
    ms: z.number().int().min(1000).max(30000).optional().describe('气泡停留毫秒数，默认 4200'),
  },
  async ({ event, title, text, ms, changePct, correct }) => {
    await ensurePet();
    const conf = CHAT_EVENTS[event];
    await ensureAwake(); // 睡觉中的噜噜先叫醒，别对着趴姿说话
    let actions = conf.actions;
    let line = text;
    if (event === 'stock') {
      // 盯盘：大涨庆祝、大跌安慰（A 股红涨绿跌）
      const pct = typeof changePct === 'number' ? changePct : 0;
      const nm = String(title || '它').slice(0, 10);
      if (pct >= 5) { actions = ['celebrate']; line = line || `「${nm}」涨停？！噜噜给你撒花~`; }
      else if (pct >= 2) { actions = ['celebrate']; line = line || `「${nm}」红红火火，呜~`; }
      else if (pct <= -5) { actions = []; line = line || `「${nm}」…不急，噜噜在呢`; }
      else if (pct <= -2) { actions = []; line = line || `「${nm}」绿了一点…摸摸头`; }
      else { actions = []; line = line || `「${nm}」…风平浪静，喝茶`; }
    } else if (event === 'quiz') {
      // 学习打卡：答对庆祝、答错安慰
      if (correct) {
        actions = ['celebrate'];
        line = line || pick(['答对啦！哼唧，厉害嘛', '对！噜噜记小本本', '漂亮~这题稳了']);
      } else {
        actions = [];
        line = line || pick(['错啦？不急…下一题', '呜~这题坑，跳过', '哼唧…错的不是你是题']);
      }
    } else if (event === 'rename' || event === 'study') {
      line = line || pick(conf.lines).replace('{t}', String(title || (event === 'study' ? '新知识' : '这个对话')).slice(0, 10));
    } else {
      line = line || pick(conf.lines);
    }
    for (const a of actions) {
      await request('POST', '/act', { action: a }, readToken());
    }
    await request('POST', '/say', { text: line, ms: ms || 4200 }, readToken());
    const actPart = actions.length ? actions.join('+') + ' + ' : '';
    return { content: [{ type: 'text', text: `【对话事件 ${event}】噜噜 ${actPart}说：「${line}」` }] };
  }
);

server.tool(
  'lulu_focus',
  '番茄钟：让噜噜值守指定分钟数，期间它安静待命，结束时自动庆祝并提醒休息（完成 +5 好感度）。',
  {
    minutes: z.number().int().min(1).max(120).default(25).describe('专注时长（分钟），默认 25'),
  },
  async ({ minutes }) => {
    await ensurePet();
    const r = await request('POST', '/focus', { minutes }, readToken());
    return { content: [{ type: 'text', text: r.ok ? `好嘞，${minutes} 分钟值守开始，噜噜给你看着时间` : `失败：${r.error}` }] };
  }
);

server.tool(
  'lulu_remind',
  '到点提醒：让噜噜在指定时间提醒用户一件事（气泡 + 托盘闪烁，噜噜睡着也会被叫醒，重启不丢）。minutes=N 表示 N 分钟后提醒（1-1440）；daily="HH:MM" 表示每天该时刻提醒（如 09:30 开盘提醒、18:00 下班提醒）。',
  {
    text: z.string().max(100).describe('提醒内容，简短口语化，如「开会啦」「该打卡了」'),
    minutes: z.number().int().min(1).max(1440).optional().describe('多少分钟后提醒（1-1440），与 daily 二选一'),
    daily: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional().describe('每天定时提醒，"HH:MM" 24 小时制，与 minutes 二选一'),
  },
  async ({ text, minutes, daily }) => {
    if (!minutes && !daily) {
      return { content: [{ type: 'text', text: '失败：必须指定 minutes 或 daily 之一' }] };
    }
    await ensurePet();
    const r = await request('POST', '/remind', { text, minutes, daily }, readToken());
    if (!r.ok) return { content: [{ type: 'text', text: `失败：${r.error || 'unknown'}` }] };
    const when = r.daily ? `每天 ${r.daily}` : `${r.atText}`;
    return { content: [{ type: 'text', text: `好嘞，${when} 提醒你：「${r.text}」` }] };
  }
);

server.tool(
  'lulu_bond',
  '查看/管理噜噜对你的好感度（养成系统）。status=查看等级/饥饿度/喂食记录；feed=远程喂食（food: orange 橘子 / milk 牛奶 / bath 温泉）；rename=设置它对你的称呼（name）。',
  {
    action: z.enum(['status', 'feed', 'rename']).describe('操作类型'),
    food: z.enum(['orange', 'milk', 'bath']).optional().describe('feed 时用：食物'),
    name: z.string().max(20).optional().describe('rename 时用：主人称呼'),
  },
  async ({ action, food, name }) => {
    await ensurePet();
    if (action === 'status') {
      const b = await request('GET', '/bond');
      if (!b.ok) return { content: [{ type: 'text', text: `失败：${b.error || 'unknown'}` }] };
      const foodMap = { orange: '橘子', milk: '牛奶', bath: '温泉' };
      const feedStr = Object.entries(b.feeds || {}).map(([k, v]) => `${foodMap[k] || k}x${v}`).join('，') || '还没喂过';
      return { content: [{ type: 'text', text: `好感度 ${b.bond}（Lv.${b.level} ${b.levelName}）｜饥饿度 ${b.hunger}/100｜喂食：${feedStr}｜称呼：${b.name || '未设置'}` }] };
    }
    if (action === 'feed') {
      const r = await request('POST', '/feed', { food }, readToken());
      const foodMap = { orange: '橘子', milk: '牛奶', bath: '温泉' };
      return { content: [{ type: 'text', text: r.ok ? `投喂${foodMap[r.food] || r.food}成功，好感度 +5（当前 ${r.bond} · ${r.level}）` : `失败：${r.error}` }] };
    }
    const r = await request('POST', '/name', { name: String(name || '').trim() }, readToken());
    return { content: [{ type: 'text', text: r.ok ? `好，以后叫你「${r.name}」` : `失败：${r.error}` }] };
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
