/* ===== 一键安装：skill 安装 + mcp.json 接入 + 唤醒桌宠 ===== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOME = process.env.USERPROFILE;
const SKILL_DST = path.join(HOME, '.workbuddy', 'skills', 'lulu-pet');
const MCP_FILE = path.join(HOME, '.workbuddy', 'mcp.json');
const SERVER_JS = path.join(PROJECT_ROOT, 'src', 'mcp', 'server.js');
const PORT = 18731;

function log(...a) { console.log('[install]', ...a); }

/* 1. 安装 skill（整包：SKILL.md + .codebuddy-plugin 元数据 + _user_meta.json 注册标记）
    注意：_user_meta.json 是 WorkBuddy 识别"已安装技能"的标记，
    早年只拷 SKILL.md 会导致技能不被注册、AI 永远加载不到规则（表现：桌宠对消息无反应） */
function installSkill() {
  fs.mkdirSync(SKILL_DST, { recursive: true });
  // 1a. SKILL.md 主体
  fs.copyFileSync(path.join(PROJECT_ROOT, 'skill', 'lulu-pet', 'SKILL.md'), path.join(SKILL_DST, 'SKILL.md'));
  // 1b. .codebuddy-plugin 插件元数据
  const pluginSrc = path.join(PROJECT_ROOT, 'skill', 'lulu-pet', '.codebuddy-plugin');
  if (fs.existsSync(pluginSrc)) {
    const pluginDst = path.join(SKILL_DST, '.codebuddy-plugin');
    fs.mkdirSync(pluginDst, { recursive: true });
    for (const f of fs.readdirSync(pluginSrc)) {
      fs.copyFileSync(path.join(pluginSrc, f), path.join(pluginDst, f));
    }
  }
  // 1c. _user_meta.json 注册标记（对齐 qiankun 等已安装技能的结构）
  fs.writeFileSync(
    path.join(SKILL_DST, '_user_meta.json'),
    JSON.stringify({ name: 'lulu-pet', installedAt: Date.now(), source: 'userImport' }, null, 2) + '\n'
  );
  log('skill 已安装 →', SKILL_DST);
}

/* 2. 选一个稳定的 node：优先用户 PATH 里的（排除 WorkBuddy 自带的），
      且版本 >= 18；退回当前 node */
function pickNode() {
  const { spawnSync } = require('child_process');
  const candidates = [];
  try {
    // Git Bash 下 where 不可用，显式调用 where.exe；cmd 输出为 GBK 中文，需按 GBK 解码
    const buf = execSync('where.exe node', { encoding: 'buffer', shell: 'cmd.exe' });
    let out;
    try { out = new TextDecoder('gbk').decode(buf); }
    catch { out = buf.toString('utf8'); }
    candidates.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch { /* where 失败就用当前 node */ }
  candidates.push(process.execPath);

  const ok = [];
  for (const p of candidates) {
    if (!fs.existsSync(p) || ok.includes(p)) continue;
    const v = spawnSync(p, ['-v'], { encoding: 'utf8' });
    const m = /v(\d+)/.exec(v.stdout || '');
    if (m && Number(m[1]) >= 18) ok.push(p);
  }
  // 优先非 .workbuddy 的用户 node（WorkBuddy 升级会换路径）
  return ok.find((p) => !p.toLowerCase().includes('.workbuddy')) || ok[0] || process.execPath;
}

/* 3. 合并 mcp.json（先备份） */
function installMcp(nodePath) {
  let cfg = { mcpServers: {} };
  if (fs.existsSync(MCP_FILE)) {
    cfg = JSON.parse(fs.readFileSync(MCP_FILE, 'utf8'));
    const bak = `${MCP_FILE}.bak.${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    fs.copyFileSync(MCP_FILE, bak);
    log('原配置已备份 →', bak);
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['lulu-pet'] = {
    command: nodePath,
    args: [SERVER_JS],
  };
  fs.writeFileSync(MCP_FILE, JSON.stringify(cfg, null, 2));
  log('mcp.json 已写入 lulu-pet server →', MCP_FILE);
}

/* 4. 唤醒桌宠（开发模式：electron + 项目根） */
function wakePet() {
  const exe = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) {
    log('未找到 electron，跳过唤醒（可手动 npm start）');
    return;
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 否则 electron.exe 退化为普通 node
  const child = spawn(exe, [PROJECT_ROOT], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.unref();
  log('桌宠启动指令已发出');
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/ping`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  // --exe <path>：把打包好的单文件桌宠安装到 ~/.lulu-pet/lulu-pet.exe
  const exeArgIdx = process.argv.indexOf('--exe');
  if (exeArgIdx >= 0 && process.argv[exeArgIdx + 1]) {
    const src = path.resolve(process.argv[exeArgIdx + 1]);
    const dstDir = path.join(HOME, '.lulu-pet');
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, path.join(dstDir, 'lulu-pet.exe'));
    log('单文件桌宠已安装 →', path.join(dstDir, 'lulu-pet.exe'));
  }
  installSkill();
  const nodePath = pickNode();
  log('选用 node →', nodePath);
  installMcp(nodePath);
  if (!(await ping())) wakePet();
  log('完成。重启 WorkBuddy 后生效，试试对它说"任务完成啦，庆祝一下"。');
})();
