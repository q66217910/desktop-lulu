/* ===== 水豚噜噜主进程 ===== */
const { app, BrowserWindow, Menu, screen, ipcMain, Tray, nativeImage, globalShortcut, powerMonitor } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WIN_W = 240;
const WIN_H = 300; // 上部留给对话气泡，宠物图片底部锚定
const HTTP_PORT = 18731;
// 水豚在窗口内的可交互区域（透明区允许鼠标穿透到桌面）
// 与 pet.css 中 #pet-img（bottom:12px, max-height:208px, 水平居中）对应
const PET_BOX = { x: 12, y: 76, w: 216, h: 212 };

const userDataDir = app.getPath('userData');
const posFile = path.join(userDataDir, 'lulu-pos.json');
const tokenFile = path.join(userDataDir, 'lulu-token.txt');
const bondFile = path.join(userDataDir, 'lulu-bond.json');
// 前台全屏监视：PowerShell 轮询脚本 + 状态文件（放临时目录，打包/开发模式通用）
const psFile = path.join(os.tmpdir(), 'lulu-fgwatch.ps1');
const fgFile = path.join(os.tmpdir(), 'lulu-fg.json');

let win = null;
let walkTimer = null;
let dragging = false;
let controlServer = null;
let tray = null;
let fgWatchProc = null;
let sleeping = false;
let userHidden = false;  // 用户主动隐藏（快捷键/托盘）
let autoHidden = false;  // 全屏应用运行时自动隐身

/* ===== 养成系统：好感度 / 喂食 / 记住你 ===== */
const LEVELS = [
  { bond: 0,   name: '点头之交' },
  { bond: 30,  name: '面熟' },
  { bond: 100, name: '酒肉朋友' },
  { bond: 300, name: '过命之交' },
  { bond: 800, name: '温泉搭子' },
];
const FOODS = {
  orange: { gain: 5, hunger: 40, lines: ['嘎吱嘎吱…橘子是我的！', '呜~头顶更香了', '橘子…half of happiness'] },
  milk:   { gain: 5, hunger: 35, lines: ['咕咚咕咚…嗝~', '牛奶味的心情~', '哼唧，温的就好'] },
  bath:   { gain: 8, hunger: 20, lines: ['咕噜咕噜…温泉赛高~', '泡汤…人生圆满', '呜~毛孔都张开了'] },
};
const DRINK_LINES = ['该喝水了，呜~', '喝水时间到，咕咚咕咚', '坐太久啦，腰都圆了', '起来走走？就一下下', '呜~润喉，然后继续'];
const CLOCK_LINES = ['{h}点啦，还顺利吗？', '呜~{h}点了，喝口水吧', '{h}点…时间慢慢过', '{h}点了，不慌都能过去'];
const HUNGRY_LINES = ['呜…头顶有点痒', '有橘子吗？', '饿了一起泡温泉？', '哼唧…肚子咕噜了一声'];
const JOKES = [
  '为什么水豚不喜欢排队？因为它总是被“卡皮巴拉~”卡住！',
  '我的心情就像水温：不烫不凉，刚刚好。',
  '橘子是我的，牛奶也是我的，你？可以考虑。',
  '据说盯着我看三分钟的人，都会变得很平静。',
  '今天也没有烦恼，因为头发……啊我是毛。',
];

const bond = {
  points: 0,        // 好感度点数
  lastSeen: 0,      // 上次互动时间（ms）
  name: '',         // 主人称呼
  hunger: 0,        // 饥饿度 0-100
  hungerAt: Date.now(),
  feeds: { orange: 0, milk: 0, bath: 0 },
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* ---------- 工具 ---------- */
function readToken() {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    const t = crypto.randomUUID();
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(tokenFile, t);
    return t;
  }
}

function loadPos() {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const def = { x: area.x + area.width - WIN_W - 40, y: area.y + area.height - WIN_H - 24 };
  try {
    const p = JSON.parse(fs.readFileSync(posFile, 'utf8'));
    if (typeof p.x === 'number' && typeof p.y === 'number') return p;
  } catch { /* 首次运行 */ }
  return def;
}

function savePos() {
  if (!win) return;
  const [x, y] = win.getPosition();
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(posFile, JSON.stringify({ x, y }));
}

/* ---------- 好感度持久化 ---------- */
function loadBond() {
  try {
    const saved = JSON.parse(fs.readFileSync(bondFile, 'utf8'));
    Object.assign(bond, saved);
    bond.feeds = Object.assign({ orange: 0, milk: 0, bath: 0 }, saved.feeds || {});
  } catch { /* 首次运行 */ }
}

let bondSaveTimer = null;
function saveBond() {
  clearTimeout(bondSaveTimer);
  bondSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(bondFile, JSON.stringify(bond));
    } catch { /* 磁盘异常不致命 */ }
  }, 250);
}

function bondLevel() {
  let lv = LEVELS[0];
  let idx = 0;
  LEVELS.forEach((l, i) => { if (bond.points >= l.bond) { lv = l; idx = i; } });
  return { name: lv.name, index: idx + 1 };
}

/* 饥饿度随时间增长：约每 10 分钟 +2，约 8 小时饿满 */
function refreshHunger() {
  const mins = (Date.now() - (bond.hungerAt || Date.now())) / 60000;
  if (mins >= 1) {
    bond.hunger = Math.min(100, (bond.hunger || 0) + Math.round(mins * 2));
    bond.hungerAt = Date.now();
    saveBond();
  }
}

function addBond(n) {
  if (!(n > 0)) return;
  bond.points += n;
  bond.lastSeen = Date.now();
  saveBond();
  sendCmd({ action: 'bond', payload: { amount: n } });
}

function touchSeen() {
  bond.lastSeen = Date.now();
  saveBond();
}

function feed(food) {
  const f = FOODS[food];
  if (!f) return { ok: false, error: 'unknown food' };
  refreshHunger();
  bond.hunger = Math.max(0, bond.hunger - f.hunger);
  bond.hungerAt = Date.now();
  bond.feeds[food] = (bond.feeds[food] || 0) + 1;
  touchSeen();
  addBond(f.gain);
  sendCmd({ action: 'eat' });
  sendCmd({ action: 'say', payload: { text: pick(f.lines), ms: 3600 } });
  const lv = bondLevel();
  return { ok: true, food, bond: bond.points, level: `${lv.index}.${lv.name}`, hunger: bond.hunger };
}

/* 开机问候：隔天/久别重逢的"记住你" */
function greetOnStart() {
  const now = Date.now();
  const last = bond.lastSeen || 0;
  let line = '';
  if (!last) line = '初次见面…呜~请多关照';
  else if (now - last > 3 * 864e5) line = '想你了！呜~去哪了';
  else if (now - last > 12 * 3600e3) line = bond.name ? `又见面啦，${bond.name}` : '又见面啦，呜~';
  else return;
  touchSeen();
  sendCmd({ action: 'say', payload: { text: line, ms: 4200 } });
}

/* ---------- 创建桌宠窗口 ---------- */
function createWindow() {
  const pos = loadPos();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'pet', 'index.html'));
  win.on('closed', () => { win = null; });
  win.on('moved', () => { /* 位置由 savePos 主动落盘 */ });

  startMousePassThrough();
}

/* ---------- 点击穿透轮询 ----------
   只有光标位于窗口内"水豚区域"时才接收鼠标事件，
   其余区域 setIgnoreMouseEvents + forward 让点击落到桌面。 */
function startMousePassThrough() {
  setInterval(() => {
    if (!win || dragging) return;
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const inside = cursor.x >= wx + PET_BOX.x && cursor.x <= wx + PET_BOX.x + PET_BOX.w &&
                   cursor.y >= wy + PET_BOX.y && cursor.y <= wy + PET_BOX.y + PET_BOX.h;
    win.setIgnoreMouseEvents(!inside, { forward: true });
  }, 90);
}

/* ---------- 沿屏幕底部散步 ---------- */
function startWalk() {
  stopWalk();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const dir = Math.random() > 0.5 ? 1 : -1;
  const groundY = area.y + area.height - WIN_H - 12;
  walkTimer = setInterval(() => {
    if (!win) return stopWalk();
    let [x, y] = win.getPosition();
    x += dir * 5;
    if (x <= area.x || x + WIN_W >= area.x + area.width) {
      clearInterval(walkTimer);
      walkTimer = null;
      win.webContents.send('cmd', { action: 'idle' });
      savePos();
      return;
    }
    win.setPosition(x, groundY);
  }, 33);
}
function stopWalk() {
  if (walkTimer) { clearInterval(walkTimer); walkTimer = null; }
}

/* ---------- 显示 / 隐藏（快捷键 & 托盘共用） ---------- */
function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
    userHidden = true;
  } else {
    win.show();
    userHidden = false;
    autoHidden = false;
  }
  if (tray) updateTrayMenu();
}

/* ---------- 前台全屏监视（游戏/视频/演示时自动隐身） ----------
   用 PowerShell 轮询前台窗口是否铺满虚拟屏幕，状态写入临时 JSON，
   主进程每 2s 读一次。零 npm 依赖，开发/打包模式通用。 */
const FGWATCH_PS = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class LuluFg {',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;',
  '  public static string Poll() {',
  '    IntPtr h = GetForegroundWindow();',
  '    if (h == IntPtr.Zero) return "false";',
  '    RECT r;',
  '    if (!GetWindowRect(h, out r)) return "false";',
  '    int x = GetSystemMetrics(SM_XVIRTUALSCREEN), y = GetSystemMetrics(SM_YVIRTUALSCREEN);',
  '    int w = GetSystemMetrics(SM_CXVIRTUALSCREEN), ht = GetSystemMetrics(SM_CYVIRTUALSCREEN);',
  '    bool full = r.Left <= x && r.Top <= y && r.Right >= x + w && r.Bottom >= y + ht;',
  '    return full ? "true" : "false";',
  '  }',
  '}',
  '"@',
  "$out = Join-Path $env:TEMP 'lulu-fg.json'",
  'while ($true) {',
  '  $fs = [LuluFg]::Poll()',
  '  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
  "  Set-Content -Path $out -Value ('{\"fullscreen\":' + $fs + ',\"ts\":' + $ts + '}') -Encoding ASCII",
  '  Start-Sleep -Milliseconds 1200',
  '}',
].join('\n');

function startFullscreenWatch() {
  try {
    fs.writeFileSync(psFile, FGWATCH_PS);
    fgWatchProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { windowsHide: true, stdio: 'ignore' });
    fgWatchProc.on('error', (e) => console.error('[lulu] 全屏监视启动失败:', e.message));
    fgWatchProc.unref();
  } catch (e) {
    console.error('[lulu] 全屏监视不可用:', e.message);
    return;
  }
  setInterval(() => {
    let full = false;
    try {
      const j = JSON.parse(fs.readFileSync(fgFile, 'utf8'));
      if (j && typeof j.ts === 'number' && Date.now() / 1000 - j.ts < 8) full = !!j.fullscreen;
    } catch { /* 状态文件还没生成 */ }
    if (full && win && win.isVisible() && !userHidden && !sleeping) {
      win.hide();
      autoHidden = true;
      console.log('[lulu] 检测到全屏应用，噜噜暂时隐身');
    } else if (!full && autoHidden) {
      autoHidden = false;
      if (win && !userHidden) win.show();
    }
  }, 2000);
}

/* ---------- 自主提醒：整点 / 喝水 / 饿了（不依赖 AI 也活着） ---------- */
let lastDrinkAt = Date.now();
let lastClockHour = -1;
let lastHungryAt = 0;
function startReminders() {
  setInterval(() => {
    if (!win || !win.isVisible() || sleeping) return;
    const now = new Date();
    if (now.getMinutes() === 0 && now.getHours() !== lastClockHour) {
      lastClockHour = now.getHours();
      sendCmd({ action: 'say', payload: { text: pick(CLOCK_LINES).replace('{h}', String(now.getHours())), ms: 4200 } });
    }
    if (Date.now() - lastDrinkAt > 45 * 60 * 1000) {
      lastDrinkAt = Date.now();
      sendCmd({ action: 'say', payload: { text: pick(DRINK_LINES), ms: 4200 } });
    }
    if (Date.now() - lastHungryAt > 20 * 60 * 1000) {
      refreshHunger();
      if (bond.hunger >= 70) {
        lastHungryAt = Date.now();
        sendCmd({ action: 'say', payload: { text: pick(HUNGRY_LINES), ms: 3600 } });
      }
    }
  }, 30 * 1000);
}

/* ---------- 久坐提醒：基于系统空闲时间（而非"没人摸宠物"） ---------- */
let sedentaryNotified = false;
function startSedentaryWatch() {
  setInterval(() => {
    if (!win || !win.isVisible() || sleeping) return;
    let idleSec = 0;
    try { idleSec = powerMonitor.getSystemIdleTime() || 0; } catch { /* 平台不支持 */ }
    if (idleSec > 25 * 60 && !sedentaryNotified) {
      sedentaryNotified = true;
      sendCmd({ action: 'say', payload: { text: '坐太久啦，腰都圆了…', ms: 5000 } });
    }
    if (idleSec < 60) sedentaryNotified = false;
  }, 60 * 1000);
}

/* ---------- 番茄钟 ---------- */
let focusTimer = null;
function startFocus(minutes) {
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    focusTimer = null;
    if (!sleeping && win && win.isVisible()) {
      sendCmd({ action: 'celebrate' });
      sendCmd({ action: 'say', payload: { text: '铃！到点啦，休息一下~', ms: 5000 } });
    }
    addBond(5);
  }, Math.max(1, minutes) * 60 * 1000);
  sendCmd({ action: 'say', payload: { text: `好，${minutes} 分钟噜噜值守，去吧去吧`, ms: 4200 } });
  return { ok: true, minutes };
}

/* ---------- 到点提醒：N 分钟后 / 每天定时 ----------
 * 数据落 lulu-reminders.json，重启不丢；daily 的到点后自动重排到明天。 */
const remindFile = path.join(userDataDir, 'lulu-reminders.json');
let reminders = []; // { id, text, at, daily }  at=下次触发时间戳(ms), daily='HH:MM' 或 null
let remindSeq = 1;

function loadReminders() {
  try {
    const saved = JSON.parse(fs.readFileSync(remindFile, 'utf8'));
    if (Array.isArray(saved)) {
      reminders = saved.filter((r) => r && typeof r.text === 'string' && r.text && typeof r.at === 'number');
      remindSeq = reminders.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
    }
  } catch { /* 首次运行 */ }
}

function saveReminders() {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(remindFile, JSON.stringify(reminders));
  } catch { /* 磁盘异常不致命 */ }
}

/* daily='HH:MM' 时计算下一次触发的时间戳（已过则算明天） */
function nextDailyAt(daily) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(daily || ''));
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function addReminder({ text, minutes, daily }) {
  const t = String(text || '').trim().slice(0, 100);
  if (!t) return { ok: false, error: 'empty text' };
  let at = null;
  let dailyVal = null;
  if (daily) {
    at = nextDailyAt(daily);
    if (!at) return { ok: false, error: 'bad daily format, expect HH:MM' };
    dailyVal = daily;
  } else {
    const mins = Math.min(1440, Math.max(1, parseInt(minutes, 10) || 5));
    at = Date.now() + mins * 60 * 1000;
  }
  const r = { id: remindSeq++, text: t, at, daily: dailyVal };
  reminders.push(r);
  saveReminders();
  scheduleReminder(r);
  const when = new Date(at);
  const atText = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return { ok: true, id: r.id, text: t, at, daily: dailyVal, atText };
}

const remindTimers = new Map();
function scheduleReminder(r) {
  if (remindTimers.has(r.id)) { clearTimeout(remindTimers.get(r.id)); remindTimers.delete(r.id); }
  const timer = setTimeout(() => fireReminder(r.id), Math.max(0, r.at - Date.now()));
  if (typeof timer.unref === 'function') timer.unref(); // 不拖住进程退出
  remindTimers.set(r.id, timer);
}

function fireReminder(id) {
  remindTimers.delete(id);
  const idx = reminders.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const r = reminders[idx];
  if (r.daily) {
    r.at = nextDailyAt(r.daily); // 每天重复：重排到明天同一时刻
    saveReminders();
    scheduleReminder(r);
  } else {
    reminders.splice(idx, 1);
    saveReminders();
  }
  if (sleeping) sendCmd({ action: 'wake' }); // 别对着趴姿提醒
  sendCmd({ action: 'jump' });
  sendCmd({ action: 'say', payload: { text: `铃！${r.text}`, ms: 8000 } });
  flashTray(); // 窗口藏着时靠托盘闪烁引起注意
}

/* 托盘闪烁：16x16 图标/空图标交替，6 次后恢复 */
let trayFlashTimer = null;
function flashTray() {
  if (!tray) return;
  let icon = nativeImage.createFromPath(path.join(__dirname, '..', 'pet', 'assets', 'idle.png'));
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  const empty = nativeImage.createEmpty();
  clearInterval(trayFlashTimer);
  let n = 0;
  trayFlashTimer = setInterval(() => {
    n++;
    tray.setImage(n % 2 === 0 ? icon : empty);
    if (n >= 6) {
      clearInterval(trayFlashTimer);
      trayFlashTimer = null;
      tray.setImage(icon);
    }
  }, 400);
}

/* ---------- 托盘 ---------- */
function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'pet', 'assets', 'idle.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('噜噜 · 水豚桌宠');
    tray.on('click', () => toggleWindow());
    updateTrayMenu();
  } catch (e) {
    console.error('[lulu] 托盘创建失败:', e.message);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const lv = bondLevel();
  const menu = Menu.buildFromTemplate([
    { label: win && win.isVisible() ? '藏起噜噜' : '叫出噜噜', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '摸摸头', click: () => sendCmd({ action: 'click' }) },
    { label: '散散步', click: () => sendCmd({ action: 'walk' }) },
    { label: '喂橘子', click: () => { feed('orange'); updateTrayMenu(); } },
    { label: '请喝牛奶', click: () => { feed('milk'); updateTrayMenu(); } },
    { label: '泡温泉', click: () => { feed('bath'); updateTrayMenu(); } },
    { type: 'separator' },
    { label: `好感度 Lv.${lv.index} · ${lv.name}（${bond.points}）`, enabled: false },
    { label: '再见，噜噜…', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

/* ---------- 右键菜单 ---------- */
function showMenu() {
  const autoLaunch = app.getLoginItemSettings().openAtLogin;
  const lv = bondLevel();
  const tpl = [
    { label: '摸摸头', click: () => sendCmd({ action: 'click' }) },
    { label: '讲个笑话', click: () => sendCmd({ action: 'say', payload: { text: pick(JOKES) } }) },
    { label: '散散步', click: () => sendCmd({ action: 'walk' }) },
    { label: '睡觉 / 唤醒', click: () => sendCmd({ action: currentSleeping() ? 'wake' : 'sleep' }) },
    { type: 'separator' },
    { label: '喂橘子', click: () => feed('orange') },
    { label: '请喝牛奶', click: () => feed('milk') },
    { label: '泡温泉', click: () => feed('bath') },
    { type: 'separator' },
    { label: `好感度 Lv.${lv.index} · ${lv.name}（${bond.points}）`, enabled: false },
    { label: autoLaunch ? '取消开机自启' : '开机自启', click: () => {
        app.setLoginItemSettings({ openAtLogin: !autoLaunch });
      } },
    { label: '回到屏幕右下角', click: () => {
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        win.setPosition(area.x + area.width - WIN_W - 40, area.y + area.height - WIN_H - 24);
        savePos();
      } },
    { label: '藏起噜噜（Ctrl+Alt+L 叫回）', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '再见，噜噜…', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}
function currentSleeping() { return sleeping; }

function sendCmd(data) {
  if (win) win.webContents.send('cmd', data);
  if (data.action === 'sleep') sleeping = true;
  if (data.action === 'wake') sleeping = false;
}

/* ---------- IPC ---------- */
ipcMain.on('pet-move-by', (e, dx, dy) => {
  if (!win) return;
  stopWalk(); // 用户手动拖拽时中断散步，避免抢位置
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
});
ipcMain.on('pet-sleep-state', (e, flag) => { sleeping = !!flag; });
ipcMain.on('pet-error', (e, msg) => console.error('[lulu render error]', msg));
ipcMain.on('pet-save-pos', savePos);
ipcMain.on('pet-walk', startWalk);
ipcMain.on('pet-menu', showMenu);
/* 点击宠物攒好感度（节流 10 秒，防刷） */
let lastClickBondAt = 0;
ipcMain.on('pet-bond', (e, n) => {
  if (Date.now() - lastClickBondAt > 10 * 1000) {
    lastClickBondAt = Date.now();
    addBond(Number(n) > 0 ? Number(n) : 1);
  }
});

/* ---------- HTTP 控制端（127.0.0.1，MCP 通过它逗宠） ---------- */
let lastSayBondAt = 0;
let lastActBondAt = 0;
function startControlServer() {
  const token = readToken();
  controlServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, name: 'lulu' }));
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const [x, y] = win ? win.getPosition() : [0, 0];
      const lv = bondLevel();
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true, running: true, sleeping, x, y,
        hidden: win ? !win.isVisible() : false,
        bond: bond.points, level: `${lv.index}.${lv.name}`,
      }));
    }
    if (req.method === 'GET' && url.pathname === '/bond') {
      refreshHunger();
      const lv = bondLevel();
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true, bond: bond.points, level: lv.index, levelName: lv.name,
        hunger: bond.hunger, name: bond.name, feeds: bond.feeds, lastSeen: bond.lastSeen,
      }));
    }

    // 以下需要 token
    if (req.headers['x-lulu-token'] !== token) {
      res.writeHead(401);
      return res.end(JSON.stringify({ ok: false, error: 'invalid token' }));
    }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { /* 忽略 */ }
      if (req.method === 'POST' && url.pathname === '/say') {
        sendCmd({ action: 'say', payload: { text: String(data.text || '').slice(0, 200), ms: data.ms } });
        if (Date.now() - lastSayBondAt > 30 * 1000) { lastSayBondAt = Date.now(); addBond(1); }
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'POST' && url.pathname === '/act') {
        const allowed = ['celebrate', 'jump', 'sleep', 'wake', 'walk', 'idle', 'click', 'think', 'eat'];
        if (!allowed.includes(data.action)) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
        }
        stopWalk();
        sendCmd({ action: data.action });
        // 互动攒好感度（节流：celebrate 15s，其余 20s）
        if (data.action === 'celebrate' && Date.now() - lastActBondAt > 15 * 1000) {
          lastActBondAt = Date.now();
          addBond(2);
        } else if ((data.action === 'click' || data.action === 'jump') && Date.now() - lastActBondAt > 20 * 1000) {
          lastActBondAt = Date.now();
          addBond(1);
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, action: data.action }));
      }
      if (req.method === 'POST' && url.pathname === '/feed') {
        const r = feed(String(data.food || ''));
        res.writeHead(r.ok ? 200 : 400);
        return res.end(JSON.stringify(r));
      }
      if (req.method === 'POST' && url.pathname === '/name') {
        bond.name = String(data.name || '').trim().slice(0, 20);
        touchSeen();
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, name: bond.name }));
      }
      if (req.method === 'POST' && url.pathname === '/focus') {
        const minutes = Math.min(120, Math.max(1, parseInt(data.minutes, 10) || 25));
        const r = startFocus(minutes);
        res.writeHead(200);
        return res.end(JSON.stringify(r));
      }
      if (req.method === 'POST' && url.pathname === '/remind') {
        const r = addReminder({ text: data.text, minutes: data.minutes, daily: data.daily });
        res.writeHead(r.ok ? 200 : 400);
        return res.end(JSON.stringify(r));
      }
      if (req.method === 'GET' && url.pathname === '/reminders') {
        res.writeHead(200);
        return res.end(JSON.stringify({
          ok: true,
          reminders: reminders.map((r) => ({ id: r.id, text: r.text, at: r.at, daily: r.daily })),
        }));
      }
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    });
  });
  controlServer.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[lulu] control server on http://127.0.0.1:${HTTP_PORT}`);
  });
  controlServer.on('error', (e) => console.error('[lulu] control server error:', e.message));
}

/* ---------- 启动 ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    loadBond();
    refreshHunger();
    loadReminders();
    createWindow();
    startControlServer();
    createTray();
    // 提醒重载：daily 的重算到下一个时刻（不错过停机期间的）；一次性的到点即触发（补提醒）
    for (const r of reminders) {
      if (r.daily) r.at = nextDailyAt(r.daily);
      scheduleReminder(r);
    }
    saveReminders();
    try {
      globalShortcut.register('Ctrl+Alt+L', () => toggleWindow());
    } catch (e) {
      console.error('[lulu] 全局快捷键注册失败（可能被占用）:', e.message);
    }
    startFullscreenWatch();
    startReminders();
    startSedentaryWatch();
    setTimeout(greetOnStart, 1800); // 等窗口渲染完再打招呼
  });
  app.on('second-instance', () => {
    if (win) { win.show(); userHidden = false; }
  });
  app.on('window-all-closed', () => { /* 桌宠常驻，不退出 */ });
  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    stopWalk();
    savePos();
    if (fgWatchProc) { try { fgWatchProc.kill(); } catch { /* 已退出 */ } }
  });
}
