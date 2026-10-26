/* ===== 水豚噜噜渲染进程：状态机 + 交互（姿势图切换版） ===== */
const { ipcRenderer } = require('electron');

const stage = document.getElementById('stage');
const petImg = document.getElementById('pet-img');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const sparkles = document.getElementById('sparkles');
const zzz = document.getElementById('zzz');
const thought = document.getElementById('thought');

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
  think:     'assets/say.png',       // 思考（张臂姿势 + 💭 气泡 + 缓摆）
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
const STATE = { IDLE: 'idle', CLICK: 'click', DRAG: 'drag', WALK: 'walk', SLEEP: 'sleep', CELEBRATE: 'celebrate', THINK: 'think' };
/* think 自动收尾时长：AI 思考态展示 30 秒，无后续动作自动回待机 */
const THINK_MS = 30000;
let currentState = STATE.IDLE;
let stateTimer = null;
let thoughtTimer = null; // think 自动收尾定时器：30 秒无后续动作回待机（setState 里会 clear）

function setState(next, duration = 0) {
  clearTimeout(stateTimer);
  stage.className = '';
  thought.classList.add('hidden'); // 思考气泡不与其他状态叠加
  clearTimeout(thoughtTimer);
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
  // 思考气泡同理：仅思考状态显示
  if (next === STATE.THINK) thought.classList.remove('hidden');
  else thought.classList.add('hidden');
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
  if (currentState === STATE.THINK) setState(STATE.IDLE); // 说话时退出思考，避免两个动画叠加
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

/* ---------- 好感度飘字 ---------- */
function floatBond(amount) {
  const el = document.createElement('div');
  el.className = 'bond-float';
  el.textContent = `好感度 +${amount} ♥`;
  stage.appendChild(el);
  setTimeout(() => el.remove(), 1300);
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
    case 'think':
      // 思考态：💭 气泡 + 缓摆。30 秒无后续动作自动回待机——
      // 对话/任务结束时不会卡在思考里；超长任务中 AI 再次调用即为"续杯"
      if (currentState === STATE.SLEEP) ipcRenderer.send('pet-sleep-state', false);
      setState(STATE.THINK);
      clearTimeout(thoughtTimer);
      thoughtTimer = setTimeout(() => {
        if (currentState === STATE.THINK) setState(STATE.IDLE);
      }, THINK_MS);
      break;
    case 'eat':
      // 喂食：咀嚼动画（睡觉中被喂食先醒来）
      if (currentState === STATE.SLEEP) setState(STATE.IDLE);
      swapPose('click');
      stage.classList.add('state-eat');
      setTimeout(() => stage.classList.remove('state-eat'), 1000);
      break;
    case 'bond':
      floatBond((payload && payload.amount) || 1);
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
    // 视为点击：开心一下 + 攒好感度
    setState(STATE.CLICK, 600);
    ipcRenderer.send('pet-bond', 1);
    const quips = ['别慌~', '哼唧，再摸一下', '有橘子吗？', '活着挺好~', '情绪稳定！', '不慌，都能过去', '呜~慢热，别急'];
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
