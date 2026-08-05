// ============================================================================
//  tv.js — логика экрана телевизора.
//  Состояния: A «заставка» (idle) → B «QR» (qr) → C «охота» (hunt) → «финал» (final).
// ============================================================================

import { CONFIG } from './config.js';
import { ParticleField } from './particles.js';
import { buildCollage, revealCollage } from './collage.js';
import { createHost } from './connection.js';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

// --- Элементы ---
const stage = document.getElementById('stage');
const preloader = document.getElementById('preloader');
const preloaderFill = document.getElementById('preloader-fill');
const collageEl = document.getElementById('collage');
const fxCanvas = document.getElementById('fx');
const heroH1 = document.getElementById('hero-h1');
const heroSub = document.getElementById('hero-sub');
const qrCodeEl = document.getElementById('qr-code');
const linkStatus = document.getElementById('link-status');
const huntEl = document.getElementById('hunt');
const instructionEl = document.getElementById('instruction');
const instr1 = document.getElementById('instr-1');
const instr2 = document.getElementById('instr-2');
const aimRing = document.getElementById('aim-ring');
const aimFill = document.getElementById('aim-fill');
const huntMessage = document.getElementById('hunt-message');
const cellsEl = document.getElementById('cells');
const progressFill = document.getElementById('progress-fill');
const progressCount = document.getElementById('progress-count');
const finalEl = document.getElementById('final');
const finalText = document.getElementById('final-text');
const foundRibbon = document.getElementById('found-ribbon');
const cornerTrigger = document.getElementById('corner-trigger');
const offlineNote = document.getElementById('offline-note');
const debugPanel = document.getElementById('debug-panel');

const RING_CIRC = 2 * Math.PI * 46; // длина окружности кольца (r=46)

// --- Состояние приложения ---
const state = {
  mode: 'idle',
  foundList: [],          // индексы найденных фото (0..4), в порядке находок
  instructionShown: false,
  finalTimer: null,
  particles: null,
  host: null,
  connected: false,
};

// ============================================================================
//  Инициализация
// ============================================================================
async function init() {
  // Тексты заголовка
  buildTitle();
  heroSub.textContent = CONFIG.subtitle;
  instr1.textContent = CONFIG.instruction.line1;
  instr2.textContent = CONFIG.instruction.line2;

  // Прогресс-бар: ячейки
  buildCells();
  updateAimRing(0);

  // Частицы
  state.particles = new ParticleField(fxCanvas, {
    count: CONFIG.particles.count,
    petals: CONFIG.particles.petals,
    bokeh: CONFIG.particles.bokeh,
    reducedMotion: REDUCED,
  });

  // Коллаж + прелоадер
  fakePreloaderProgress();
  await buildCollage(collageEl);
  preloaderFill.style.width = '100%';

  // Плавно убираем прелоадер и показываем сцену
  await wait(300);
  preloader.classList.add('is-hidden');
  revealCollage(collageEl);
  state.particles.start();
  // Сцена теперь точно видна и размеры финальные — пересчитываем холст
  // и равномерно раскидываем частицы, чтобы они не сбивались в угол.
  requestAnimationFrame(() => {
    state.particles._resize();
    state.particles.rescatter();
  });

  // Связь (хост)
  setupConnection();

  // Ввод
  setupInput();

  // Отладка
  if (DEBUG) {
    debugPanel.classList.add('show');
    updateDebug();
  }
}

// Заголовок по словам (учитываем \n как перенос строки).
function buildTitle() {
  heroH1.innerHTML = '';
  const lines = CONFIG.title.split('\n');
  let wi = 0;
  lines.forEach((line, li) => {
    const words = line.split(' ').filter(Boolean);
    words.forEach((w) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = w;
      span.style.setProperty('--word-delay', `${0.15 + wi * 0.12}s`);
      heroH1.appendChild(span);
      heroH1.appendChild(document.createTextNode(' '));
      wi++;
    });
    if (li < lines.length - 1) heroH1.appendChild(document.createElement('br'));
  });
}

// Имитация прогресса прелоадера, пока грузятся фото.
function fakePreloaderProgress() {
  let p = 0;
  const t = setInterval(() => {
    p = Math.min(90, p + Math.random() * 18);
    preloaderFill.style.width = p + '%';
    if (p >= 90) clearInterval(t);
  }, 180);
}

// Ячейки прогресс-бара (5 штук).
function buildCells() {
  cellsEl.innerHTML = '';
  const { previewPath, previewPrefix, ext } = CONFIG.ar;
  for (let i = 0; i < CONFIG.ar.targetCount; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.index = i;
    cell.innerHTML = `
      <div class="cell__inner">
        <div class="cell__face cell__front">?</div>
        <div class="cell__face cell__back">
          <img src="${previewPath}${previewPrefix}${i + 1}${ext}" alt="" />
        </div>
      </div>`;
    cellsEl.appendChild(cell);
  }
}

// ============================================================================
//  Смена состояний
// ============================================================================
function setMode(mode) {
  state.mode = mode;
  stage.dataset.mode = mode;
  updateDebug();
}

// A → B: показать QR
function showQR() {
  if (state.mode === 'qr') return;
  if (state.mode === 'hunt' || state.mode === 'final') return; // не мешаем охоте
  setMode('qr');
}

// B → A: вернуться на заставку
function backToIdle() {
  setMode('idle');
}

// → C: режим охоты (по hello от телефона или отладке)
function startHunt() {
  if (state.mode === 'hunt' || state.mode === 'final') return;
  setMode('hunt');

  // Инструкция появляется по словам один раз
  if (!state.instructionShown) {
    state.instructionShown = true;
    animateWords(instr1, CONFIG.instruction.line1, 0.1);
    animateWords(instr2, CONFIG.instruction.line2, 0.5);
    // Через 6 секунд инструкция уезжает наверх
    setTimeout(() => instructionEl.classList.add('minimized'), 6000);
  }
}

// ============================================================================
//  Находки и поздравления
// ============================================================================
function registerFound(index) {
  index = Number(index);
  if (index < 0 || index >= CONFIG.ar.targetCount) return;
  if (state.foundList.includes(index)) return; // уже найдено

  // Убедимся, что мы в режиме охоты
  if (state.mode !== 'hunt') startHunt();

  state.foundList.push(index);
  hideAimRing();

  // Отметить ячейку (flip)
  const cell = cellsEl.querySelector(`.cell[data-index="${index}"]`);
  if (cell) cell.classList.add('found');

  // Обновить полосу и счётчик
  const n = state.foundList.length;
  progressFill.style.width = (n / CONFIG.ar.targetCount * 100) + '%';
  progressCount.innerHTML = `<span class="num">${n}</span> из ${CONFIG.ar.targetCount}`;

  // Салют из центра
  saluteCenter();

  // Показать следующий по порядку текст (не привязан к фото)
  showMessage(CONFIG.texts[n - 1]);

  // Синхронизация с телефоном
  sendState();

  // Финал?
  if (n >= CONFIG.ar.targetCount) {
    setTimeout(triggerFinal, 1400);
  }

  updateDebug();
}

// Показать очередной кусок поздравления по строкам.
function showMessage(text) {
  if (!text) return;
  // Предыдущее сообщение уходит вверх
  if (huntMessage.dataset.hasContent === '1') {
    const old = huntMessage.cloneNode(true);
    old.classList.remove('breathing');
    old.classList.add('leaving');
    huntEl.appendChild(old);
    setTimeout(() => old.remove(), 600);
  }

  huntMessage.classList.remove('breathing');
  huntMessage.innerHTML = '';
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    const span = document.createElement('span');
    span.className = 'msg-line';
    span.textContent = line;
    span.style.setProperty('--line-delay', `${i * 0.12}s`);
    huntMessage.appendChild(span);
  });
  huntMessage.dataset.hasContent = '1';
  // После появления — мягкое «дыхание»
  setTimeout(() => huntMessage.classList.add('breathing'), lines.length * 120 + 800);
}

// ============================================================================
//  Живое кольцо наведения
// ============================================================================
function updateAimRing(ratio) {
  aimFill.setAttribute('stroke-dasharray', String(RING_CIRC));
  const offset = RING_CIRC * (1 - Math.max(0, Math.min(1, ratio)));
  aimFill.setAttribute('stroke-dashoffset', String(offset));
}
function showAimRing(ratio) {
  aimRing.classList.add('show');
  updateAimRing(ratio);
}
function hideAimRing() {
  aimRing.classList.remove('show');
  setTimeout(() => updateAimRing(0), 300);
}

// ============================================================================
//  Финал
// ============================================================================
function triggerFinal() {
  setMode('final');

  // Подсветить все ячейки и пульсировать по очереди
  const cells = [...cellsEl.querySelectorAll('.cell')];
  cells.forEach((c, i) => {
    setTimeout(() => {
      c.classList.add('pulse');
      setTimeout(() => c.classList.remove('pulse'), 700);
    }, 400 + i * 250);
  });

  // Финальный текст по строкам
  finalText.innerHTML = '';
  const lines = String(CONFIG.finalText).split('\n');
  lines.forEach((line, i) => {
    const span = document.createElement('span');
    span.className = 'msg-line';
    span.textContent = line;
    span.style.setProperty('--line-delay', `${0.3 + i * 0.15}s`);
    finalText.appendChild(span);
  });

  // Мощный салют на 4–5 секунд
  bigSalute();

  // Сообщить телефону
  if (state.host) state.host.send('finished', {});

  // Через 12 секунд — возврат на заставку с лентой найденных
  clearTimeout(state.finalTimer);
  state.finalTimer = setTimeout(returnToIdleWithRibbon, 12000);
}

function bigSalute() {
  if (!state.particles) return;
  let n = 0;
  const total = REDUCED ? 3 : 10;
  const iv = setInterval(() => {
    const x = Math.random() * fxCanvas.clientWidth;
    const y = Math.random() * fxCanvas.clientHeight * 0.6;
    state.particles.salute(x, y, REDUCED ? 30 : 70);
    if (++n >= total) clearInterval(iv);
  }, 450);
}

function saluteCenter() {
  if (!state.particles) return;
  const cx = fxCanvas.clientWidth / 2;
  const cy = fxCanvas.clientHeight / 2;
  state.particles.salute(cx, cy, REDUCED ? 30 : 60);
}

// Возврат на заставку с лентой найденных фото в углу.
function returnToIdleWithRibbon() {
  setMode('idle');
  instructionEl.classList.remove('minimized');

  // Лента найденных
  foundRibbon.innerHTML = '';
  const { previewPath, previewPrefix, ext } = CONFIG.ar;
  state.foundList.forEach((idx) => {
    const img = document.createElement('img');
    img.src = `${previewPath}${previewPrefix}${idx + 1}${ext}`;
    foundRibbon.appendChild(img);
  });
  foundRibbon.classList.add('show');
}

// ============================================================================
//  Связь
// ============================================================================
function setupConnection() {
  state.host = createHost(onMessage, onStatus);
  // Генерируем QR сразу, зная id
  renderQR();
}

function onMessage(type, payload) {
  switch (type) {
    case 'hello':
      startHunt();
      sendState();
      break;
    case 'found':
      if (payload && typeof payload.index === 'number') registerFound(payload.index);
      break;
    case 'progress':
      if (payload && typeof payload.ratio === 'number') showAimRing(payload.ratio);
      break;
    case 'lost':
      hideAimRing();
      break;
    case 'finished':
      if (state.mode !== 'final') triggerFinal();
      break;
  }
  updateDebug();
}

function onStatus(s) {
  state.connected = (s === 'connected');
  if (s === 'connected') {
    linkStatus.textContent = 'подключено ✓';
    linkStatus.classList.add('ok');
  } else if (s === 'online') {
    linkStatus.textContent = 'ожидание…';
    linkStatus.classList.remove('ok');
  } else if (s === 'offline') {
    offlineNote.classList.add('show');
    linkStatus.textContent = 'офлайн-режим';
  } else if (s === 'reconnecting') {
    linkStatus.textContent = 'переподключение…';
    linkStatus.classList.remove('ok');
  }
  updateDebug();
}

function sendState() {
  if (state.host) state.host.send('state', { foundList: state.foundList.slice() });
}

// Динамический URL телефона (без хардкода домена) + id сессии в хэше.
function phoneUrl() {
  const url = new URL('phone.html', location.href);
  return url.href + '#id=' + encodeURIComponent(state.host ? state.host.id : '');
}

function renderQR() {
  const url = phoneUrl();
  qrCodeEl.innerHTML = '';
  if (typeof QRCode === 'undefined') return;
  // Высокое разрешение для чёткости (CSS масштабирует под контейнер),
  // высокий уровень коррекции и хороший контраст — иначе камера не считает с ТВ.
  new QRCode(qrCodeEl, {
    text: url,
    width: 900,
    height: 900,
    colorDark: '#1a1012',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H,
  });
}

// ============================================================================
//  Ввод: скрытые триггеры QR, аварийные клавиши, отладка
// ============================================================================
function setupInput() {
  // Одиночный тап/клик по экрану заставки показывает QR (повторный — скрывает).
  // toggleQR сам игнорирует режимы охоты/финала, чтобы не сбить праздник.
  document.addEventListener('click', () => toggleQR());

  // Клавиши пульта + аварийный ручной ввод + отладка
  document.addEventListener('keydown', (e) => {
    const k = e.key;

    // Отладка
    if (DEBUG) {
      if (k === 'R' || k === 'r') { resetAll(); return; }
      if (k === 'F' || k === 'f') { triggerFinal(); return; }
      if (k === '9') { startHunt(); return; } // имитация подключения телефона
    }

    // Вызов/скрытие QR пультом
    if (k === 'Enter' || k === ' ' || k === 'Spacebar' ||
        k === 'ArrowRight' || k === '0') {
      e.preventDefault();
      toggleQR();
      return;
    }

    // Escape — назад на заставку
    if (k === 'Escape') {
      if (state.mode === 'qr') backToIdle();
      else if (state.mode === 'hunt' || state.mode === 'final') returnToIdleWithRibbon();
      return;
    }

    // Клавиши 1–5:
    //  - в debug засчитывают фото (как ручной ввод),
    //  - без debug работают как АВАРИЙНЫЙ ручной ввод (см. п.4).
    if (k >= '1' && k <= '5') {
      registerFound(Number(k) - 1);
    }
  });
}

function toggleQR() {
  if (state.mode === 'idle') showQR();
  else if (state.mode === 'qr') backToIdle();
  // в режиме охоты/финала — игнорируем, чтобы не сбить праздник
}

// Полный сброс (для отладки и ручного рестарта).
function resetAll() {
  clearTimeout(state.finalTimer);
  state.foundList = [];
  state.instructionShown = false;
  cellsEl.querySelectorAll('.cell').forEach((c) => c.classList.remove('found', 'pulse'));
  progressFill.style.width = '0%';
  progressCount.innerHTML = `<span class="num">0</span> из ${CONFIG.ar.targetCount}`;
  huntMessage.innerHTML = '';
  huntMessage.dataset.hasContent = '';
  instructionEl.classList.remove('minimized');
  foundRibbon.classList.remove('show');
  foundRibbon.innerHTML = '';
  hideAimRing();
  setMode('idle');
  sendState();
}

// ============================================================================
//  Утилиты
// ============================================================================
function animateWords(el, text, baseDelay) {
  el.innerHTML = '';
  const words = String(text).split(' ');
  words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'reveal-word';
    span.textContent = w;
    span.style.setProperty('--word-delay', `${baseDelay + i * 0.08}s`);
    el.appendChild(span);
    el.appendChild(document.createTextNode(' '));
  });
}

function updateDebug() {
  if (!DEBUG) return;
  debugPanel.innerHTML = `
    <div><b>DEBUG</b></div>
    <div>id: <b>${state.host ? state.host.id : '—'}</b></div>
    <div>состояние: <b>${state.mode}</b></div>
    <div>связь: <b>${state.connected ? 'подключено' : 'нет'}</b></div>
    <div>найдено: <b>${state.foundList.length}/${CONFIG.ar.targetCount}</b> [${state.foundList.join(',')}]</div>
    <div style="margin-top:.6vmin;opacity:.7">1–5 фото · 0 QR · 9 телефон · R сброс · F финал</div>`;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Старт
init().catch((e) => console.error(e));
