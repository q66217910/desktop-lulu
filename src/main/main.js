/* ===== 水豚噜噜主进程 ===== */
const { app, BrowserWindow, Menu, screen, ipcMain } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WIN_W = 240;
const WIN_H = 300; // 上部留给对话气泡，宠物图片底部锚定
const HTTP_PORT = 18731;
// 水豚在窗口内的可交互区域（透明区允许鼠标穿透到桌面）
// 与 pet.css 中 #pet-img（bottom:12px, max-height:208px, 水平居中）对应
const PET_BOX = { x: 12, y: 76, w: 216, h: 212 };

const userDataDir = app.getPath('userData');
const posFile = path.join(userDataDir, 'lulu-pos.json');
const tokenFile = path.join(userDataDir, 'lulu-token.txt');

let win = null;
let walkTimer = null;
let dragging = false;
let controlServer = null;

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

/* ---------- 右键菜单 ---------- */
function showMenu() {
  const autoLaunch = app.getLoginItemSettings().openAtLogin;
  const tpl = [
    { label: '摸摸头', click: () => sendCmd({ action: 'click' }) },
    { label: '讲个笑话', click: () => sendCmd({ action: 'say', payload: { text: pickJoke() } }) },
    { label: '散散步', click: () => sendCmd({ action: 'walk' }) },
    { label: '睡觉 / 唤醒', click: () => sendCmd({ action: currentSleeping() ? 'wake' : 'sleep' }) },
    { type: 'separator' },
    { label: autoLaunch ? '取消开机自启' : '开机自启', click: () => {
        app.setLoginItemSettings({ openAtLogin: !autoLaunch });
      } },
    { label: '回到屏幕右下角', click: () => {
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        win.setPosition(area.x + area.width - WIN_W - 40, area.y + area.height - WIN_H - 24);
        savePos();
      } },
    { type: 'separator' },
    { label: '再见，噜噜…', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}
let sleeping = false;
function currentSleeping() { return sleeping; }
function pickJoke() {
  const jokes = [
    '为什么水豚不喜欢排队？因为它总是被“卡皮巴拉~”卡住！',
    '我的心情就像水温：不烫不凉，刚刚好。',
    '橘子是我的，牛奶也是我的，你？可以考虑。',
    '据说盯着我看三分钟的人，都会变得很平静。',
    '今天也没有烦恼，因为头发……啊我是毛。',
  ];
  return jokes[Math.floor(Math.random() * jokes.length)];
}

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

/* ---------- HTTP 控制端（127.0.0.1，MCP 通过它逗宠） ---------- */
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
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, running: true, sleeping, x, y }));
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
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'POST' && url.pathname === '/act') {
        const allowed = ['celebrate', 'jump', 'sleep', 'wake', 'walk', 'idle', 'click'];
        if (!allowed.includes(data.action)) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
        }
        if (data.action === 'walk') {
          stopWalk();
          sendCmd({ action: 'walk' });
        } else {
          stopWalk();
          sendCmd({ action: data.action });
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, action: data.action }));
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
    createWindow();
    startControlServer();
  });
  app.on('second-instance', () => {
    if (win) win.show();
  });
  app.on('window-all-closed', () => { /* 桌宠常驻，不退出 */ });
  app.on('before-quit', () => { stopWalk(); savePos(); });
}
