/**
 * 四川省麻將連連看 - 畫面與連線動畫渲染器 (Renderer)
 * 負責 DOM 麻將網格建立、透明 Canvas 發光連線路徑與消去粒子效果
 */

import { ROWS, COLS } from './engine.js';
import { getTileSVG } from './tiles.js';

export class GameRenderer {
  constructor(boardElement, canvasElement) {
    this.boardEl = boardElement;
    this.canvasEl = canvasElement;
    this.ctx = canvasElement.getContext('2d');

    this.particles = [];
    this.activeLines = [];
    this.animationFrameId = null;

    this.tileElements = new Map(); // key: "r,c" -> DOM Element
    this.resizeObserver = null;

    this.initCanvasResize();
    this.startAnimationLoop();
  }

  initCanvasResize() {
    const updateCanvasSize = () => {
      const rect = this.boardEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvasEl.width = rect.width * dpr;
      this.canvasEl.height = rect.height * dpr;
      this.canvasEl.style.width = `${rect.width}px`;
      this.canvasEl.style.height = `${rect.height}px`;
      this.ctx.scale(dpr, dpr);
    };

    this.resizeObserver = new ResizeObserver(() => {
      updateCanvasSize();
    });
    this.resizeObserver.observe(this.boardEl);
    updateCanvasSize();
  }

  /**
   * 建立或全量重繪 8x14 DOM 網格
   * @param {Array<Array<string|null>>} grid
   * @param {Function} onTileClick (r, c) => void
   */
  renderGrid(grid, onTileClick) {
    this.boardEl.innerHTML = '';
    this.tileElements.clear();

    for (let r = 1; r <= ROWS; r++) {
      for (let c = 1; c <= COLS; c++) {
        const type = grid[r][c];
        const cell = document.createElement('div');
        cell.className = 'tile-slot';
        cell.dataset.row = r;
        cell.dataset.col = c;

        if (type) {
          const tile = document.createElement('button');
          tile.className = 'mahjong-tile';
          tile.dataset.row = r;
          tile.dataset.col = c;
          tile.dataset.type = type;
          tile.innerHTML = getTileSVG(type);

          tile.addEventListener('click', (e) => {
            e.preventDefault();
            onTileClick(r, c);
          });

          cell.appendChild(tile);
          this.tileElements.set(`${r},${c}`, tile);
        }

        this.boardEl.appendChild(cell);
      }
    }
  }

  /**
   * 單格更新（消除或變更）
   */
  removeTile(r, c) {
    const key = `${r},${c}`;
    const el = this.tileElements.get(key);
    if (el) {
      el.classList.add('tile-eliminating');
      setTimeout(() => {
        el.remove();
        this.tileElements.delete(key);
      }, 160);
    }
  }

  /**
   * 設定選取狀態
   */
  setSelected(r, c, isSelected) {
    const el = this.tileElements.get(`${r},${c}`);
    if (el) {
      if (isSelected) {
        el.classList.add('tile-selected');
      } else {
        el.classList.remove('tile-selected');
      }
    }
  }

  /**
   * 清除所有選取狀態
   */
  clearAllSelected() {
    this.tileElements.forEach((el) => {
      el.classList.remove('tile-selected');
    });
  }

  /**
   * 設定提示高亮
   */
  setHint(p1, p2, isHinted) {
    const el1 = this.tileElements.get(`${p1.r},${p1.c}`);
    const el2 = this.tileElements.get(`${p2.r},${p2.c}`);
    [el1, el2].forEach((el) => {
      if (el) {
        if (isHinted) {
          el.classList.add('tile-hint');
        } else {
          el.classList.remove('tile-hint');
        }
      }
    });
  }

  /**
   * 取得內部座標對應的 Canvas 像素座標
   * @param {number} r 0..9 (含 padding)
   * @param {number} c 0..15 (含 padding)
   * @returns {{x: number, y: number}}
   */
  getCanvasPoint(r, c) {
    const boardRect = this.boardEl.getBoundingClientRect();
    const cellW = boardRect.width / COLS;
    const cellH = boardRect.height / ROWS;

    let x = 0;
    let y = 0;

    if (c >= 1 && c <= COLS) {
      x = (c - 1 + 0.5) * cellW;
    } else if (c === 0) {
      x = -cellW * 0.4;
    } else if (c === COLS + 1) {
      x = boardRect.width + cellW * 0.4;
    }

    if (r >= 1 && r <= ROWS) {
      y = (r - 1 + 0.5) * cellH;
    } else if (r === 0) {
      y = -cellH * 0.4;
    } else if (r === ROWS + 1) {
      y = boardRect.height + cellH * 0.4;
    }

    return { x, y };
  }

  /**
   * 繪製發光連線軌跡
   * @param {Array<{r: number, c: number}>} path
   */
  animateConnection(path) {
    if (!path || path.length < 2) return;

    const points = path.map((pt) => this.getCanvasPoint(pt.r, pt.c));
    this.activeLines.push({
      points,
      opacity: 1.0,
      createdAt: performance.now(),
      duration: 380 // 毫秒
    });

    // 在起點與終點噴灑消去粒子
    this.spawnParticles(points[0].x, points[0].y);
    this.spawnParticles(points[points.length - 1].x, points[points.length - 1].y);
  }

  /**
   * 產生消去爆炸微光粒子
   */
  spawnParticles(x, y) {
    const colors = ['#38BDF8', '#34D399', '#FBBF24', '#F43F5E', '#A855F7'];
    for (let i = 0; i < 18; i++) {
      const angle = (Math.PI * 2 * i) / 18 + (Math.random() - 0.5) * 0.5;
      const speed = 1.5 + Math.random() * 3.5;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: colors[Math.floor(Math.random() * colors.length)],
        radius: 2 + Math.random() * 3,
        alpha: 1.0,
        decay: 0.02 + Math.random() * 0.02
      });
    }
  }

  startAnimationLoop() {
    const loop = () => {
      this.renderCanvas();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  renderCanvas() {
    const boardRect = this.boardEl.getBoundingClientRect();
    this.ctx.clearRect(0, 0, boardRect.width, boardRect.height);

    const now = performance.now();

    // 1. 繪製連線光束
    for (let i = this.activeLines.length - 1; i >= 0; i--) {
      const line = this.activeLines[i];
      const elapsed = now - line.createdAt;
      const progress = elapsed / line.duration;

      if (progress >= 1) {
        this.activeLines.splice(i, 1);
        continue;
      }

      const alpha = 1.0 - Math.pow(progress, 2);
      this.ctx.save();
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      // 外層發光霓虹 (Glow)
      this.ctx.strokeStyle = `rgba(56, 189, 248, ${alpha * 0.5})`;
      this.ctx.lineWidth = 10;
      this.ctx.shadowColor = '#38BDF8';
      this.ctx.shadowBlur = 14;

      this.ctx.beginPath();
      this.ctx.moveTo(line.points[0].x, line.points[0].y);
      for (let p = 1; p < line.points.length; p++) {
        this.ctx.lineTo(line.points[p].x, line.points[p].y);
      }
      this.ctx.stroke();

      // 核心亮白光束 (Core)
      this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.95})`;
      this.ctx.lineWidth = 3.5;
      this.ctx.shadowBlur = 0;
      this.ctx.stroke();

      this.ctx.restore();
    }

    // 2. 繪製粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05; // 些許重力感
      p.alpha -= p.decay;

      if (p.alpha <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      this.ctx.save();
      this.ctx.globalAlpha = p.alpha;
      this.ctx.fillStyle = p.color;
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }
  }

  destroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }
}
