/* ===== 水豚噜噜渲染进程：状态机 + 交互（姿势图切换版） ===== */
const { ipcRenderer } = require('electron');

const stage = document.getElementById('stage');
const petImg = document.getElementById('pet-img');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const sparkles = document.getElementById('sparkles');
const zzz = document.getElementById('zzz');

/* ---------- 姿势图映射 ---------- */
const POSES = {
  idle:      'assets/idle.png',      // 站立正面微笑
  click:     'assets/click.png',     // 叉腰
  drag:      'assets/drag.png',      // 双手举起（被拎起来）
  walk:      'assets/walk.png',      // 前扑迈步
  sleep:     'assets/sleep.png',     // 趴着睡觉
  celebrate: 'assets/celebrate.png', // 跳跃欢呼
  say:       'assets/say.png',       // 双手张开
  error:     'assets/error.png',     // 生气 X 眼
  idle2:     'assets/idle2.png',     // 站立（待机微动备用）
};

/* 启动即预加载全部姿势，切换零延迟 */
Object.values(POSES).forEach((src) => { const im = new Image(); im.src = src; });

let currentPose = 'idle';
let swapToken = 0;

function swapPose(name) {
  if (!POSES[name] || name === currentPose) return;
  currentPose = name;
  const token = ++swapToken;
  petImg.classList.add('swapping');
  setTimeout(() => {
    if (token !== swapToken) return; // 已被更新的切换抢占
    petImg.src = POSES[name];
    petImg.classList.remove('swapping');
  }, 90);
}

/* ---------- 状态机 ---------- */
const STATE = { IDLE: 'idle', CLICK: 'click', DRAG: 'drag', WALK: 'walk', SLEEP: 'sleep', CELEBRATE: 'celebrate' };
let currentState = STATE.IDLE;
let stateTimer = null;

function setState(next, duration = 0) {
  clearTimeout(stateTimer);
  stage.className = '';
  // 重新触发 CSS 动画：先 reflow 再加 class
  void stage.offsetWidth;
  if (next === STATE.IDLE) {
    stage.classList.add('state-idle');
  } else {
    stage.classList.add('state-' + next);
  }
  currentState = next;
  swapPose(next);
  // Zzz 显隐不能只靠 CSS（.hidden 带 !important），由状态机直接控制
  if (next === STATE.SLEEP) zzz.classList.remove('hidden');
  else zzz.classList.add('hidden');
  if (duration > 0) {
    stateTimer = setTimeout(() => setState(STATE.IDLE), duration);
  }
}

/* ---------- 待机小动作：歪头 + 换姿势张望 ---------- */
function scheduleTilt() {
  stage.classList.add('tilt');
  setTimeout(() => stage.classList.remove('tilt'), 1000);
  setTimeout(scheduleTilt, 6000 + Math.random() * 8000);
}
scheduleTilt();

/* 每隔一会儿换成备用站姿 1.6s，再切回，制造"张望"感 */
function scheduleFidget() {
  setTimeout(() => {
    if (currentState === STATE.IDLE && currentPose === 'idle') {
      swapPose('idle2');
      setTimeout(() => {
        if (currentState === STATE.IDLE && currentPose === 'idle2') swapPose('idle');
      }, 1600);
    }
    scheduleFidget();
  }, 7000 + Math.random() * 6000);
}
scheduleFidget();

/* ---------- 对话气泡 ---------- */
let bubbleTimer = null;
function say(text, ms = 3600) {
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
  // 重启弹入动画
  bubble.style.animation = 'none';
  void bubble.offsetWidth;
  bubble.style.animation = '';
  stage.classList.add('state-say'); // 说话时配点头动画
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.classList.add('hidden');
    stage.classList.remove('state-say');
  }, ms);
}

/* ---------- 庆祝星星（DOM 粒子） ---------- */
function sparkleBurst() {
  const colors = ['#FFB03A', '#FFD34E', '#FF8A5C', '#FFC65C', '#FF9E4D'];
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('div');
    const angle = (Math.PI * 2 * i) / 10 + Math.random() * 0.5;
    const dist = 40 + Math.random() * 45;
    s.className = 'sparkle';
    s.style.background = colors[i % colors.length];
    s.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
    s.style.setProperty('--dy', (Math.sin(angle) * dist - 30) + 'px');
    sparkles.appendChild(s);
    setTimeout(() => s.remove(), 950);
  }
}

/* ---------- 动作入口（HTTP / MCP 调用） ---------- */
function doAction(action, payload) {
  switch (action) {
    case 'celebrate':
      setState(STATE.CELEBRATE, 1600);
      sparkleBurst();
      break;
    case 'jump':
    case 'click':
      setState(STATE.CLICK, 600);
      break;
    case 'sleep':
      setState(STATE.SLEEP);
      ipcRenderer.send('pet-sleep-state', true);
      break;
    case 'wake':
      if (currentState === STATE.SLEEP) setState(STATE.IDLE);
      ipcRenderer.send('pet-sleep-state', false);
      say('呜~睡饱啦！');
      break;
    case 'walk':
      setState(STATE.WALK);
      ipcRenderer.send('pet-walk');
      break;
    case 'idle':
      setState(STATE.IDLE);
      break;
    case 'say':
      say(String(payload && payload.text ? payload.text : ''), payload && payload.ms ? payload.ms : 3600);
      break;
  }
}

/* ---------- 鼠标交互：拖拽 / 点击 ---------- */
let mouseDown = false;
let dragMoved = 0;
let last = null;

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  mouseDown = true;
  dragMoved = 0;
  last = { x: e.screenX, y: e.screenY };
  setState(STATE.DRAG);
});

window.addEventListener('mousemove', (e) => {
  if (!mouseDown) return;
  const dx = e.screenX - last.x;
  const dy = e.screenY - last.y;
  dragMoved += Math.abs(dx) + Math.abs(dy);
  last = { x: e.screenX, y: e.screenY };
  ipcRenderer.send('pet-move-by', dx, dy);
});

window.addEventListener('mouseup', () => {
  if (!mouseDown) return;
  mouseDown = false;
  if (dragMoved < 6) {
    // 视为点击：开心一下
    setState(STATE.CLICK, 600);
    const quips = ['别慌~', '哼唧，再摸一下', '噜噜开心！', '有橘子吗？', '活着挺好~', '情绪稳定！'];
    say(quips[Math.floor(Math.random() * quips.length)], 1800);
  } else {
    setState(STATE.IDLE);
    ipcRenderer.send('pet-save-pos');
  }
});

stage.addEventListener('dblclick', () => doAction('celebrate'));
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('pet-menu');
});

/* ---------- 主进程指令 ---------- */
ipcRenderer.on('cmd', (evt, data) => doAction(data.action, data.payload));
ipcRenderer.on('wake-if-sleep', () => {
  if (currentState === STATE.SLEEP) setState(STATE.IDLE);
});

/* 渲染层错误上报到主进程终端 */
window.addEventListener('error', (e) => {
  ipcRenderer.send('pet-error', `${e.message} @ ${e.filename}:${e.lineno}`);
});

/* 待机 5 分钟自动打瞌睡（若已是睡眠则不重复） */
let idleTimer = setTimeout(() => setState(STATE.SLEEP), 5 * 60 * 1000);
['mousedown', 'mousemove', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, () => {
    clearTimeout(idleTimer);
    if (currentState === STATE.SLEEP && ev === 'mousedown') setState(STATE.IDLE);
    idleTimer = setTimeout(() => setState(STATE.SLEEP), 5 * 60 * 1000);
  })
);
