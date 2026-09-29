/**
 * Редактор углов: фото, затемнение вне документа, контур и 4 маркера.
 * Порт ui/corner_editor.py (CornerCanvas) под пальцы.
 *
 * Устройство слоёв:
 *   <img>    — исходник (sourcePreview), вписан в область с сохранением пропорций;
 *   <svg>    — затемнение, контур и маркеры в экранных пикселях области;
 *   <canvas> — лупа, видна только во время перетаскивания.
 *
 * Углы хранятся НОРМИРОВАННЫМИ [0..1]: размер экрана меняется (поворот
 * телефона), а углы пересчитывать не нужно — перевод в пиксели при отрисовке.
 */
import { orderPoints } from '../core/geometry.js';
import { h } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HANDLE_R = 11;   // видимый радиус маркера (диаметр ~22 px)
const HIT_R = 34;      // радиус «захвата» пальцем: палец неточный, 44+ px по рекомендации Apple
const MARGIN = 26;     // поля вокруг фото — чтобы угол у самого края кадра было за что взять
const MAG_R = 55;      // радиус лупы (диаметр 110 px)
const MAG_ZOOM = 2.5;  // увеличение лупы относительно того, что видно на экране
const FINGER_GAP = 48; // лупа выше пальца на столько — иначе палец её закроет

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export class CornerEditor {
  /**
   * @param {{onChange: (corners: number[][]) => void}} opts
   *   onChange вызывается, когда палец ОТПУЩЕН (не на каждое движение):
   *   результат в это время не виден, пересчитывать его незачем.
   */
  constructor({ onChange }) {
    this.onChange = onChange;
    this.corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    this.rect = null;       // где лежит фото внутри области: {x, y, w, h}
    this.drag = null;       // {index, pointerId, offX, offY, fx, fy} во время перетаскивания
    this.frame = 0;         // requestAnimationFrame — не рисуем чаще частоты экрана

    this.img = h('img', { class: 'ce-image', alt: '', draggable: 'false' });
    this.shade = svg('path', { class: 'ce-shade', 'fill-rule': 'evenodd' });
    this.quad = svg('polygon', { class: 'ce-quad' });
    this.handles = [0, 1, 2, 3].map(() => svg('circle', { class: 'ce-handle', r: HANDLE_R }));
    this.svg = svg('svg', { class: 'ce-overlay' });
    this.svg.append(this.shade, this.quad, ...this.handles);
    this.mag = h('canvas', { class: 'ce-magnifier', hidden: true });
    this.el = h('div', { class: 'ce-stage' }, this.img, this.svg, this.mag);

    this.img.addEventListener('load', () => this.layout());
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onUp(e));
    // Safari: жест «щипок» масштабировал бы всю страницу, пока тянем угол.
    this.el.addEventListener('gesturestart', (e) => e.preventDefault());
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.el);
  }

  /** Показать фото (object URL исходника). */
  setImage(url) {
    this.img.src = url;
  }

  setCorners(corners) {
    this.corners = corners.map(([x, y]) => [clamp01(x), clamp01(y)]);
    this.drag = null;
    this.mag.hidden = true;
    this.draw();
  }

  getCorners() {
    return this.corners.map((p) => [...p]);
  }

  destroy() {
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
  }

  // ---------- геометрия ----------
  /** Вписать фото в область с полями MARGIN. */
  layout() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    const iw = this.img.naturalWidth;
    const ih = this.img.naturalHeight;
    if (!W || !H || !iw || !ih) return;
    const scale = Math.min((W - 2 * MARGIN) / iw, (H - 2 * MARGIN) / ih);
    const w = iw * scale;
    const h2 = ih * scale;
    this.rect = { x: (W - w) / 2, y: (H - h2) / 2, w, h: h2 };
    Object.assign(this.img.style, {
      left: `${this.rect.x}px`, top: `${this.rect.y}px`, width: `${w}px`, height: `${h2}px`,
    });
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.draw();
  }

  /** Нормированная точка -> пиксели области. */
  toScreen([x, y]) {
    const r = this.rect;
    return [r.x + x * r.w, r.y + y * r.h];
  }

  /** Координаты события относительно области. */
  local(e) {
    const b = this.el.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  }

  /** Индекс ближайшего маркера в радиусе захвата или -1. */
  handleAt(px, py) {
    let best = -1;
    let bestD = HIT_R;
    this.corners.forEach((c, i) => {
      const [sx, sy] = this.toScreen(c);
      const d = Math.hypot(sx - px, sy - py);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  // ---------- палец ----------
  onDown(e) {
    if (!this.rect || this.drag) return; // второй палец игнорируем
    const [px, py] = this.local(e);
    const index = this.handleAt(px, py);
    if (index < 0) return;
    e.preventDefault();
    // Захват указателя: движения приходят нам, даже если палец ушёл за пределы области.
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // Указатель уже исчез (палец успел подняться) — перетаскивание просто не начнётся.
    }
    const [sx, sy] = this.toScreen(this.corners[index]);
    // Смещение «палец -> маркер»: маркер не прыгает под палец, а едет вместе с ним.
    this.drag = { index, pointerId: e.pointerId, offX: sx - px, offY: sy - py, fx: px, fy: py };
    this.draw();
  }

  onMove(e) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    e.preventDefault();
    const [px, py] = this.local(e);
    const r = this.rect;
    this.drag.fx = px;
    this.drag.fy = py;
    this.corners[this.drag.index] = [
      clamp01((px + this.drag.offX - r.x) / r.w),
      clamp01((py + this.drag.offY - r.y) / r.h),
    ];
    this.scheduleDraw();
  }

  onUp(e) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    this.mag.hidden = true;
    // Углы могли «перекреститься» (левый верхний утащили вправо) —
    // переупорядочиваем, чтобы индексы снова значили TL, TR, BR, BL.
    this.corners = orderPoints(this.corners);
    this.draw();
    this.onChange?.(this.getCorners());
  }

  // ---------- отрисовка ----------
  scheduleDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    const r = this.rect;
    if (!r) return;
    const pts = this.corners.map((c) => this.toScreen(c));
    const poly = pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
    // Два контура с правилом evenodd: прямоугольник фото минус четырёхугольник документа.
    this.shade.setAttribute('d',
      `M${r.x},${r.y}h${r.w}v${r.h}h${-r.w}Z M${pts.map((p) => p.join(',')).join('L')}Z`);
    this.quad.setAttribute('points', poly);
    this.handles.forEach((c, i) => {
      c.setAttribute('cx', pts[i][0]);
      c.setAttribute('cy', pts[i][1]);
      c.classList.toggle('active', this.drag?.index === i);
    });
    if (this.drag) this.drawMagnifier();
  }

  /**
   * Лупа — над пальцем (палец закрывает сам угол, ради этого лупа и нужна);
   * у верхнего края области переносим её под палец.
   */
  drawMagnifier() {
    const W = this.el.clientWidth;
    const { fx, fy, index } = this.drag;
    let cy = fy - FINGER_GAP - MAG_R;
    if (cy - MAG_R < 4) cy = fy + FINGER_GAP + MAG_R;
    const cx = Math.min(Math.max(fx, MAG_R + 4), W - MAG_R - 4);

    const dpr = window.devicePixelRatio || 1;
    const size = MAG_R * 2;
    const canvas = this.mag;
    if (canvas.width !== size * dpr) {
      canvas.width = canvas.height = size * dpr;
      canvas.style.width = canvas.style.height = `${size}px`;
    }
    canvas.style.transform = `translate(${cx - MAG_R}px, ${cy - MAG_R}px)`;
    canvas.hidden = false;

    const ctx = canvas.getContext('2d');
    const iw = this.img.naturalWidth;
    const ih = this.img.naturalHeight;
    // Пикселей экрана на пиксель исходника, умноженное на увеличение.
    const k = (this.rect.w / iw) * MAG_ZOOM;
    const [nx, ny] = this.corners[index];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(MAG_R, MAG_R, MAG_R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#222'; // там, где лупа вылезает за фото
    ctx.fillRect(0, 0, size, size);
    // Рисуем исходник (а не уменьшенную экранную копию) через трансформацию:
    // точка угла в пикселях фото -> центр лупы.
    ctx.translate(MAG_R, MAG_R);
    ctx.scale(k, k);
    ctx.translate(-nx * iw, -ny * ih);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.img, 0, 0);
    // Стороны контура внутри лупы — видно, ровно ли линия легла на край листа.
    ctx.beginPath();
    this.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x * iw, y * ih) : ctx.moveTo(x * iw, y * ih)));
    ctx.closePath();
    ctx.lineWidth = 1.5 / k; // толщина в пикселях экрана независимо от масштаба
    ctx.strokeStyle = '#0a84ff';
    ctx.stroke();
    ctx.restore();

    // Перекрестие и рамка.
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MAG_R - 14, MAG_R);
    ctx.lineTo(MAG_R + 14, MAG_R);
    ctx.moveTo(MAG_R, MAG_R - 14);
    ctx.lineTo(MAG_R, MAG_R + 14);
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(MAG_R, MAG_R, MAG_R - 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
