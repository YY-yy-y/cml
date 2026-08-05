// ============================================================================
//  particles.js — фоновая анимация «тёплая золотая пыльца и светлячки».
//
//  Слои:
//    1. Крупные размытые боке-круги (глубина).
//    2. Светлячки — светящиеся частицы, всплывают вверх, «дышат», иногда
//       дают вспышку-блик четырёхлучевой звездой.
//    3. Падающие лепестки с покачиванием и вращением.
//
//  Особенности производительности:
//    - requestAnimationFrame с ограничением delta-time;
//    - учёт devicePixelRatio, корректный ресайз;
//    - пауза при document.hidden;
//    - объекты частиц переиспользуются (никакого мусора в горячем цикле);
//    - salute(x, y) — короткий «салют» для находки/финала.
// ============================================================================

const TAU = Math.PI * 2;

// Тёплая палитра: золото, шампань, бледно-розовый.
const WARM_COLORS = [
  [255, 214, 140], // золото
  [255, 235, 190], // шампань
  [255, 200, 175], // тёплый розовый
  [255, 246, 224], // тёплый белый
];

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function rand(a, b) { return a + Math.random() * (b - a); }

export class ParticleField {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { count, petals, bokeh, reducedMotion }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.count = opts.count ?? 75;
    this.petalCount = opts.petals ?? 8;
    this.bokehCount = opts.bokeh ?? 6;
    this.reduced = !!opts.reducedMotion;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = 0; this.h = 0;
    this.running = false;
    this.lastT = 0;
    this.sparkTimer = 0;
    this.sparks = [];          // временные вспышки-салют

    this._onResize = this._resize.bind(this);
    this._onVis = () => { if (document.hidden) this.pause(); else this.resume(); };

    this._resize();
    this._initParticles();

    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVis);
  }

  _resize() {
    const oldW = this.w, oldH = this.h;
    const r = this.canvas.getBoundingClientRect();
    // Если по какой-то причине холст ещё без размеров (ранняя инициализация,
    // особенности браузера ТВ) — берём размер окна, чтобы не остаться 300×150.
    this.w = Math.max(1, r.width || this.canvas.clientWidth || window.innerWidth || 1);
    this.h = Math.max(1, r.height || this.canvas.clientHeight || window.innerHeight || 1);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Пропорционально переносим уже существующие частицы. Иначе, если размер
    // холста изменился ПОСЛЕ инициализации (частый случай на ТВ — сначала
    // маленький кадр, потом полноэкранный), частицы остаются сбитыми в угол.
    if (oldW && oldH && (oldW !== this.w || oldH !== this.h)) {
      const sx = this.w / oldW, sy = this.h / oldH;
      const scale = (arr) => { if (arr) for (const p of arr) { p.x *= sx; p.y *= sy; } };
      scale(this.fireflies); scale(this.bokeh); scale(this.petals);
    }
  }

  // Заново равномерно раскидать все частицы по холсту.
  // Вызываем, когда сцена уже точно видна и размеры финальные.
  rescatter() {
    if (this.fireflies) for (const p of this.fireflies) { p.x = rand(0, this.w); p.y = rand(0, this.h); }
    if (this.bokeh) for (const p of this.bokeh) { p.x = rand(0, this.w); p.y = rand(0, this.h); }
    if (this.petals) for (const p of this.petals) { p.x = rand(0, this.w); p.y = rand(-this.h, this.h); }
  }

  _initParticles() {
    // Светлячки
    this.fireflies = [];
    for (let i = 0; i < this.count; i++) this.fireflies.push(this._makeFirefly());
    // Боке
    this.bokeh = [];
    for (let i = 0; i < this.bokehCount; i++) this.bokeh.push(this._makeBokeh());
    // Лепестки
    this.petals = [];
    for (let i = 0; i < this.petalCount; i++) this.petals.push(this._makePetal(true));
  }

  _makeFirefly(atBottom = false) {
    const c = pick(WARM_COLORS);
    return {
      x: rand(0, this.w),
      y: atBottom ? this.h + rand(0, 40) : rand(0, this.h),
      r: rand(1.2, 3.4),
      glow: rand(6, 18),
      vy: rand(6, 20),               // px/сек вверх
      driftAmp: rand(8, 30),
      driftFreq: rand(0.15, 0.5),
      phase: rand(0, TAU),
      breath: rand(0.4, 0.9),        // частота «дыхания»
      breathPhase: rand(0, TAU),
      baseA: rand(0.35, 0.9),
      cr: c[0], cg: c[1], cb: c[2],
    };
  }

  _resetFirefly(p) {
    const c = pick(WARM_COLORS);
    p.x = rand(0, this.w);
    p.y = this.h + rand(0, 40);
    p.r = rand(1.2, 3.4);
    p.glow = rand(6, 18);
    p.vy = rand(6, 20);
    p.driftAmp = rand(8, 30);
    p.driftFreq = rand(0.15, 0.5);
    p.phase = rand(0, TAU);
    p.breath = rand(0.4, 0.9);
    p.breathPhase = rand(0, TAU);
    p.baseA = rand(0.35, 0.9);
    p.cr = c[0]; p.cg = c[1]; p.cb = c[2];
  }

  _makeBokeh() {
    const c = pick(WARM_COLORS);
    return {
      x: rand(0, this.w),
      y: rand(0, this.h),
      r: rand(60, 160),
      vx: rand(-4, 4),
      vy: rand(-4, 4),
      a: rand(0.04, 0.12),
      cr: c[0], cg: c[1], cb: c[2],
    };
  }

  _makePetal(spread = false) {
    return {
      x: rand(0, this.w),
      y: spread ? rand(-this.h, this.h) : rand(-60, -10),
      size: rand(7, 15),
      vy: rand(18, 42),
      sway: rand(14, 34),
      swayFreq: rand(0.3, 0.8),
      phase: rand(0, TAU),
      rot: rand(0, TAU),
      rotSpeed: rand(-1.2, 1.2),
      tilt: rand(0, TAU),
      tiltSpeed: rand(0.6, 1.6),
      hue: rand(28, 44),
      a: rand(0.25, 0.55),
    };
  }

  // Короткий «салют» из центра (или из указанной точки).
  salute(x, y, amount = 60) {
    const cx = x ?? this.w / 2;
    const cy = y ?? this.h / 2;
    for (let i = 0; i < amount; i++) {
      const ang = rand(0, TAU);
      const speed = rand(80, 340);
      const c = pick(WARM_COLORS);
      this.sparks.push({
        x: cx, y: cy,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed - rand(0, 60),
        r: rand(1.5, 3.8),
        life: rand(0.9, 1.6),
        t: 0,
        cr: c[0], cg: c[1], cb: c[2],
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    this._loop = this._frame.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  pause() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  resume() {
    if (this.running) return;
    if (document.hidden) return;
    this.lastT = performance.now();
    this.start();
  }

  _frame(now) {
    if (!this.running) return;
    // Ограничиваем delta-time, чтобы после паузы не было скачков.
    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (dt > 0.05) dt = 0.05;

    this._update(dt);
    this._draw();

    this._raf = requestAnimationFrame(this._loop);
  }

  _update(dt) {
    const { w, h } = this;

    // Боке
    for (const b of this.bokeh) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -b.r) b.x = w + b.r; else if (b.x > w + b.r) b.x = -b.r;
      if (b.y < -b.r) b.y = h + b.r; else if (b.y > h + b.r) b.y = -b.r;
    }

    // Светлячки
    const motion = this.reduced ? 0.4 : 1;
    for (const p of this.fireflies) {
      p.phase += p.driftFreq * dt;
      p.breathPhase += p.breath * dt;
      p.y -= p.vy * dt * motion;
      p.x += Math.sin(p.phase) * p.driftAmp * dt * motion;
      if (p.y < -20) this._resetFirefly(p);
      if (p.x < -20) p.x = w + 20; else if (p.x > w + 20) p.x = -20;
    }

    // Лепестки
    for (const p of this.petals) {
      p.phase += p.swayFreq * dt;
      p.y += p.vy * dt * motion;
      p.x += Math.sin(p.phase) * p.sway * dt * motion;
      p.rot += p.rotSpeed * dt;
      p.tilt += p.tiltSpeed * dt;
      if (p.y > h + 30) {
        // Переиспользуем объект — сбрасываем наверх.
        p.y = rand(-60, -10);
        p.x = rand(0, w);
      }
    }

    // Салют-вспышки
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.t += dt;
      s.vy += 120 * dt;             // лёгкая гравитация
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.t >= s.life) this.sparks.splice(i, 1);
    }

    // Периодические вспышки-блики у случайных светлячков.
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0 && !this.reduced) {
      this.sparkTimer = rand(3, 6);
      const p = this.fireflies[(Math.random() * this.fireflies.length) | 0];
      if (p) { p._flash = 0.001; p._flashDur = rand(0.5, 0.9); }
    }
    for (const p of this.fireflies) {
      if (p._flash != null) {
        p._flash += dt;
        if (p._flash >= p._flashDur) p._flash = null;
      }
    }
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // --- Слой боке (мягкая глубина) ---
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.bokeh) {
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, `rgba(${b.cr},${b.cg},${b.cb},${b.a})`);
      g.addColorStop(1, `rgba(${b.cr},${b.cg},${b.cb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fill();
    }

    // --- Слой светлячков ---
    for (const p of this.fireflies) {
      const breath = 0.5 + 0.5 * Math.sin(p.breathPhase);
      const alpha = p.baseA * (0.5 + 0.5 * breath);
      const glow = p.glow * (0.8 + 0.4 * breath);

      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
      g.addColorStop(0, `rgba(${p.cr},${p.cg},${p.cb},${alpha})`);
      g.addColorStop(1, `rgba(${p.cr},${p.cg},${p.cb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, glow, 0, TAU);
      ctx.fill();

      // Яркое ядро
      ctx.fillStyle = `rgba(255,255,245,${alpha * 0.9})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();

      // Вспышка-блик четырёхлучевой звездой
      if (p._flash != null) {
        const k = Math.sin((p._flash / p._flashDur) * Math.PI); // 0→1→0
        const len = glow * (2.2 + 2 * k);
        ctx.strokeStyle = `rgba(255,240,210,${0.7 * k})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x - len, p.y); ctx.lineTo(p.x + len, p.y);
        ctx.moveTo(p.x, p.y - len); ctx.lineTo(p.x, p.y + len);
        ctx.stroke();
      }
    }

    // --- Слой салюта ---
    for (const s of this.sparks) {
      const k = 1 - s.t / s.life;
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
      g.addColorStop(0, `rgba(${s.cr},${s.cg},${s.cb},${0.9 * k})`);
      g.addColorStop(1, `rgba(${s.cr},${s.cg},${s.cb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * 4, 0, TAU);
      ctx.fill();
    }

    // --- Слой лепестков (обычное смешивание) ---
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.petals) {
      // Имитация трёхосного вращения: ширина сжимается по tilt.
      const wobble = Math.abs(Math.cos(p.tilt));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(0.35 + 0.65 * wobble, 1);
      ctx.globalAlpha = p.a * (0.5 + 0.5 * wobble);
      ctx.fillStyle = `hsl(${p.hue}, 70%, 82%)`;
      // Простая двухсегментная форма лепестка.
      ctx.beginPath();
      ctx.moveTo(0, -p.size);
      ctx.quadraticCurveTo(p.size * 0.7, 0, 0, p.size);
      ctx.quadraticCurveTo(-p.size * 0.7, 0, 0, -p.size);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  destroy() {
    this.pause();
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVis);
  }
}
