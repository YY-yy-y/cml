// ============================================================================
//  phone.js — логика телефона: приветствие, камера, AR (MindAR), механика
//  «засчитывания» с удержанием и grace-периодом, автономный режим.
// ============================================================================

import { CONFIG } from './config.js';
import { ParticleField } from './particles.js';
import { joinHost } from './connection.js';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';

// id хоста из хэша (#id=...)
function readHostId() {
  const m = location.hash.match(/id=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
const HOST_ID = readHostId();

// --- Элементы ---
const fxCanvas = document.getElementById('fx');
const arFxCanvas = document.getElementById('ar-fx');
const connBadge = document.getElementById('conn-badge');
const startBtn = document.getElementById('start-btn');
const retryBtn = document.getElementById('retry-btn');
const arContainer = document.getElementById('ar-container');
const dotsEl = document.getElementById('ar-dots');
const holdRing = document.getElementById('hold-ring');
const holdFill = document.getElementById('hold-fill');
const holdLabel = document.getElementById('hold-label');
const softHint = document.getElementById('soft-hint');
const arBottom = document.getElementById('ar-bottom');
const foundFlash = document.getElementById('found-flash');
const foundCongrat = document.getElementById('found-congrat');
const goldFlash = document.getElementById('gold-flash');
const phoneFinalLine = document.getElementById('phone-final-line');
const debugControls = document.getElementById('debug-controls');

const RING_CIRC = 2 * Math.PI * 46;
const TOTAL = CONFIG.ar.targetCount;

// --- Состояние ---
const S = {
  foundSet: new Set(),
  connected: false,
  link: null,
  particles: null,
  arParticles: null,
  mindar: null,
  arActive: false,
  paused: false,           // пауза после находки
  wakeLock: null,

  // Механика удержания
  visibleTarget: null,     // какая цель сейчас в кадре (0..4) или null
  holdTarget: null,        // цель, для которой копим время
  heldMs: 0,               // накоплено удержания
  lostSince: 0,            // когда цель пропала (для grace)
  lastVibrStep: 0,
  lastTick: 0,
  loopId: null,
};

// ============================================================================
//  Инициализация
// ============================================================================
function init() {
  buildDots();
  phoneFinalLine.textContent = CONFIG.finalText;

  // Частицы приветствия (в ~3 раза меньше ради батареи)
  S.particles = new ParticleField(fxCanvas, {
    count: Math.round(CONFIG.particles.count / 3),
    petals: 3,
    bokeh: 3,
    reducedMotion: REDUCED,
  });
  S.particles.start();

  // Связь с ТВ
  if (HOST_ID) {
    S.link = joinHost(HOST_ID, onMessage, onStatus);
  } else {
    onStatus('offline');
  }

  startBtn.addEventListener('click', onStart);
  retryBtn.addEventListener('click', onStart);

  if (DEBUG) setupDebug();
}

function buildDots() {
  dotsEl.innerHTML = '';
  for (let i = 0; i < TOTAL; i++) {
    const d = document.createElement('div');
    d.className = 'dot';
    d.dataset.index = i;
    dotsEl.appendChild(d);
  }
}

// ============================================================================
//  Старт поиска
// ============================================================================
async function onStart() {
  showScreen('ar-screen');
  requestWakeLock();

  if (DEBUG) {
    // Режим отладки: без камеры, только кнопки-заглушки.
    debugControls.classList.add('show');
    initArParticles();
    updateBottom();
    return;
  }

  try {
    await startAR();
  } catch (e) {
    console.warn('AR/camera error:', e);
    showScreen('camera-error');
  }
}

// Wake Lock — не даём экрану гаснуть. Оборачиваем в try/catch.
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      S.wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (S.wakeLock === null && document.visibilityState === 'visible') {
          try { S.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
        }
      });
    }
  } catch (e) { /* не критично */ }
}

function initArParticles() {
  if (S.arParticles) return;
  S.arParticles = new ParticleField(arFxCanvas, {
    count: 0, petals: 0, bokeh: 0, reducedMotion: REDUCED,
  });
  S.arParticles.start();
}

// ============================================================================
//  MindAR
// ============================================================================
async function startAR() {
  // MindAR — ES-модуль, грузим его динамически (только когда реально нужна камера),
  // чтобы тяжёлый бандл не тормозил приветственный экран.
  const { MindARThree } = await import('mindar-image-three');

  S.mindar = new MindARThree({
    container: arContainer,
    imageTargetSrc: CONFIG.ar.mindFile,
    maxTrack: 1,
    // Сглаживание и допуски под изогнутую поверхность шарика:
    filterMinCF: 0.0001,
    filterBeta: 0.001,
    warmupTolerance: 2,
    missTolerance: 10,
    // Свой UI — стандартные оверлеи MindAR выключаем:
    uiScanning: false,
    uiLoading: false,
    uiError: false,
  });

  const { renderer, scene, camera } = S.mindar;

  // Пустые якоря 0..4 — 3D-объекты не нужны, только колбэки.
  for (let i = 0; i < TOTAL; i++) {
    const anchor = S.mindar.addAnchor(i);
    anchor.onTargetFound = () => onTargetVisible(i);
    anchor.onTargetLost = () => onTargetHidden(i);
  }

  await S.mindar.start();
  renderer.setAnimationLoop(() => renderer.render(scene, camera));

  S.arActive = true;
  initArParticles();
  updateBottom();
  startHoldLoop();
}

function onTargetVisible(i) {
  if (S.paused) return;
  S.visibleTarget = i;
}
function onTargetHidden(i) {
  if (S.visibleTarget === i) S.visibleTarget = null;
}

// ============================================================================
//  Цикл удержания (grace-период, вибрация, кольцо)
// ============================================================================
function startHoldLoop() {
  S.lastTick = performance.now();
  const loop = (now) => {
    S.loopId = requestAnimationFrame(loop);
    let dt = now - S.lastTick;
    S.lastTick = now;
    if (dt > 100) dt = 100; // защита от скачков
    tickHold(now, dt);
  };
  S.loopId = requestAnimationFrame(loop);
}

function tickHold(now, dt) {
  if (S.paused) return;

  const vis = S.visibleTarget;

  // Навели на уже найденную — мягкая подсказка, не считаем.
  if (vis !== null && S.foundSet.has(vis)) {
    softHint.classList.add('show');
    if (S.holdTarget !== null) resetHold(true);
    return;
  }
  softHint.classList.remove('show');

  if (vis !== null) {
    S.lostSince = 0;
    // Новая цель — начинаем отсчёт заново.
    if (S.holdTarget !== vis) {
      S.holdTarget = vis;
      S.heldMs = 0;
      S.lastVibrStep = 0;
    }
    S.heldMs += dt;
    const ratio = Math.min(1, S.heldMs / CONFIG.ar.holdDurationMs);
    showHoldRing(ratio);
    sendProgress(vis, ratio);

    // Лёгкая вибрация на каждых 25%
    const step = Math.floor(ratio / 0.25);
    if (step > S.lastVibrStep && step < 4) {
      S.lastVibrStep = step;
      vibrate(10);
    }

    if (S.heldMs >= CONFIG.ar.holdDurationMs) {
      completeTarget(vis);
    }
  } else {
    // Цель пропала — grace-период.
    if (S.holdTarget !== null) {
      if (S.lostSince === 0) S.lostSince = now;
      if (now - S.lostSince > CONFIG.ar.graceMs) {
        resetHold(true); // grace истёк — сброс
      }
      // иначе держим кольцо и накопленное время
    }
  }
}

function resetHold(sendLostMsg) {
  S.holdTarget = null;
  S.heldMs = 0;
  S.lostSince = 0;
  S.lastVibrStep = 0;
  hideHoldRing();
  if (sendLostMsg) sendLost();
}

// ============================================================================
//  Кольцо удержания
// ============================================================================
function showHoldRing(ratio) {
  holdRing.classList.add('show');
  holdRing.classList.remove('done');
  holdFill.setAttribute('stroke-dashoffset', String(RING_CIRC * (1 - ratio)));
  // Цвет от белого к золотому по мере заполнения
  const c = mixWhiteGold(ratio);
  holdFill.setAttribute('stroke', c);
  holdLabel.textContent = 'Держите ровно…';
}
function hideHoldRing() {
  holdRing.classList.remove('show', 'done');
  holdFill.setAttribute('stroke-dashoffset', String(RING_CIRC));
}
function mixWhiteGold(t) {
  // белый (255,255,255) → золото (243,201,107)
  const r = Math.round(255 + (243 - 255) * t);
  const g = Math.round(255 + (201 - 255) * t);
  const b = Math.round(255 + (107 - 255) * t);
  return `rgb(${r},${g},${b})`;
}

// ============================================================================
//  Находка
// ============================================================================
function completeTarget(index) {
  if (S.foundSet.has(index)) return;
  S.foundSet.add(index);

  // Кольцо схлопывается в галочку
  holdRing.classList.add('done');
  holdFill.setAttribute('stroke-dashoffset', '0');
  holdLabel.textContent = '✓';

  // Сильная вибрация
  vibrate([40, 60, 120]);

  // Золотая вспышка + разлёт частиц
  goldFlash.classList.remove('fire');
  void goldFlash.offsetWidth; // рестарт анимации
  goldFlash.classList.add('fire');
  if (S.arParticles) {
    S.arParticles.salute(arFxCanvas.clientWidth / 2, arFxCanvas.clientHeight / 2, REDUCED ? 25 : 55);
  }

  // Обновить точки и низ
  markDot(index);
  updateBottom();

  // Экран находки. В автономном режиме показываем текст сами.
  const n = S.foundSet.size;
  if (!S.connected) {
    foundCongrat.textContent = CONFIG.texts[n - 1] || '';
  } else {
    foundCongrat.textContent = '';
  }
  foundFlash.classList.add('show');

  // Отправить на ТВ
  sendFound(index);

  // Сбросить удержание
  S.holdTarget = null;
  S.heldMs = 0;
  S.lostSince = 0;
  S.visibleTarget = null;

  // Финал?
  if (n >= TOTAL) {
    setTimeout(showPhoneFinal, 1800);
    return;
  }

  // Пауза AR на pauseAfterFoundMs, затем автоматически возобновляем.
  S.paused = true;
  setTimeout(() => {
    foundFlash.classList.remove('show');
    hideHoldRing();
    S.paused = false;
    S.lastTick = performance.now();
  }, CONFIG.ar.pauseAfterFoundMs);
}

function markDot(index) {
  const d = dotsEl.querySelector(`.dot[data-index="${index}"]`);
  if (d) d.classList.add('filled');
}

function updateBottom() {
  const left = TOTAL - S.foundSet.size;
  arBottom.textContent = left > 0 ? `Осталось найти: ${left}` : 'Найдено всё 💛';
}

function showPhoneFinal() {
  showScreen('phone-final');
  if (S.arParticles) S.arParticles.salute(null, null, REDUCED ? 40 : 80);
}

// ============================================================================
//  Связь
// ============================================================================
function sendFound(index) { if (S.link) S.link.send('found', { index }); }
function sendProgress(index, ratio) { if (S.link) S.link.send('progress', { index, ratio }); }
function sendLost() { if (S.link) S.link.send('lost', {}); }

function onMessage(type, payload) {
  if (type === 'state' && payload && Array.isArray(payload.foundList)) {
    // Синхронизация: если ТВ засчитал что-то вручную — отражаем на телефоне.
    payload.foundList.forEach((idx) => {
      if (!S.foundSet.has(idx)) { S.foundSet.add(idx); markDot(idx); }
    });
    updateBottom();
  } else if (type === 'finished') {
    if (S.foundSet.size < TOTAL) {
      // догоняем состояние
      for (let i = 0; i < TOTAL; i++) { S.foundSet.add(i); markDot(i); }
      updateBottom();
    }
    showPhoneFinal();
  }
}

function onStatus(s) {
  S.connected = (s === 'connected');
  if (!connBadge) return;
  if (s === 'connected') connBadge.textContent = 'связь с ТВ ✓';
  else if (s === 'offline') connBadge.textContent = 'офлайн-режим';
  else if (s === 'reconnecting') connBadge.textContent = 'переподключение…';
  else connBadge.textContent = '';

  // При установлении связи — здороваемся, чтобы ТВ ушёл в режим охоты.
  if (s === 'connected') {
    if (S.link) S.link.send('hello', {});
  }
}

// ============================================================================
//  Утилиты / отладка
// ============================================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}

function setupDebug() {
  debugControls.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.t);
      if (S.foundSet.has(i)) { softHint.classList.add('show'); setTimeout(() => softHint.classList.remove('show'), 1200); return; }
      completeTarget(i);
    });
  });
}

// Старт
init();
