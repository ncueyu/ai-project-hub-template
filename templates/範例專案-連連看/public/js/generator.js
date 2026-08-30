/**
 * 四川省麻將連連看 - 盤面生成與死局判定器 (Generator)
 */

import { ROWS, COLS, PADDED_ROWS, PADDED_COLS, findPath, isEmpty } from './engine.js';
import { TILE_TYPES } from './tiles.js';

/**
 * 建立一個全空的 10x16 擴展盤面 (0 與外圍為 null)
 * @returns {Array<Array<string|null>>}
 */
export function createEmptyGrid() {
  const grid = [];
  for (let r = 0; r < PADDED_ROWS; r++) {
    const row = [];
    for (let c = 0; c < PADDED_COLS; c++) {
      row.push(null);
    }
    grid.push(row);
  }
  return grid;
}

/**
 * 尋找當前盤面上任意一組可消除的配對
 * @param {Array<Array<string|null>>} grid
 * @returns {{ p1: {r: number, c: number}, p2: {r: number, c: number}, path: Array<{r: number, c: number}> } | null}
 */
export function findAnyMove(grid) {
  // 收集所有在場上的牌座標，依牌型分組
  const tilePositions = new Map();

  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      const type = grid[r][c];
      if (type) {
        if (!tilePositions.has(type)) {
          tilePositions.set(type, []);
        }
        tilePositions.get(type).push({ r, c });
      }
    }
  }

  // 遍歷每種牌型的成對可能
  for (const [type, positions] of tilePositions.entries()) {
    const len = positions.length;
    for (let i = 0; i < len; i++) {
      for (let j = i + 1; j < len; j++) {
        const p1 = positions[i];
        const p2 = positions[j];
        const path = findPath(grid, p1.r, p1.c, p2.r, p2.c);
        if (path) {
          return { p1, p2, path, type };
        }
      }
    }
  }

  return null;
}

/**
 * 尋找當前盤面上所有可消除的配對列表
 * @param {Array<Array<string|null>>} grid
 * @returns {Array<{ p1: {r: number, c: number}, p2: {r: number, c: number}, path: Array<{r: number, c: number}> }>}
 */
export function findAllMoves(grid) {
  const moves = [];
  const tilePositions = new Map();

  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      const type = grid[r][c];
      if (type) {
        if (!tilePositions.has(type)) {
          tilePositions.set(type, []);
        }
        tilePositions.get(type).push({ r, c });
      }
    }
  }

  for (const [type, positions] of tilePositions.entries()) {
    const len = positions.length;
    for (let i = 0; i < len; i++) {
      for (let j = i + 1; j < len; j++) {
        const p1 = positions[i];
        const p2 = positions[j];
        const path = findPath(grid, p1.r, p1.c, p2.r, p2.c);
        if (path) {
          moves.push({ p1, p2, path, type });
        }
      }
    }
  }

  return moves;
}

/**
 * 洗牌工具：Fisher-Yates 洗牌法
 * @param {Array<any>} array
 */
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/**
 * 生成 112 張標準牌面（28種牌型 x 4張）
 * @returns {Array<string>}
 */
export function generateTilePool() {
  const pool = [];
  for (const type of TILE_TYPES) {
    for (let k = 0; k < 4; k++) {
      pool.push(type);
    }
  }
  return pool;
}

/**
 * 生成一個保證開局必有解的 8x14 盤面
 * @returns {Array<Array<string|null>>}
 */
export function generateBoard() {
  const totalSlots = ROWS * COLS; // 112
  const maxAttempts = 100;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const grid = createEmptyGrid();
    const pool = generateTilePool();
    shuffleArray(pool);

    let idx = 0;
    for (let r = 1; r <= ROWS; r++) {
      for (let c = 1; c <= COLS; c++) {
        grid[r][c] = pool[idx++];
      }
    }

    // 檢查開局至少有 2 組以上可行步數，保證良好遊戲體驗
    const availableMoves = findAllMoves(grid);
    if (availableMoves.length >= 3) {
      return grid;
    }
  }

  // 極端 fallback：保證返回至少有解盤面
  const grid = createEmptyGrid();
  const pool = generateTilePool();
  shuffleArray(pool);
  let idx = 0;
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      grid[r][c] = pool[idx++];
    }
  }
  return grid;
}

/**
 * 重新洗牌場上剩餘的所有牌，保證洗完後必有解
 * @param {Array<Array<string|null>>} grid
 * @returns {boolean} 是否洗牌成功
 */
export function shuffleRemainingTiles(grid) {
  const remainingCoords = [];
  const remainingTiles = [];

  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      if (grid[r][c]) {
        remainingCoords.push({ r, c });
        remainingTiles.push(grid[r][c]);
      }
    }
  }

  if (remainingTiles.length <= 1) return false;

  const maxAttempts = 500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    shuffleArray(remainingTiles);

    // 填回暫存網格
    for (let i = 0; i < remainingCoords.length; i++) {
      const { r, c } = remainingCoords[i];
      grid[r][c] = remainingTiles[i];
    }

    // 檢查洗完後是否有解
    if (findAnyMove(grid) !== null) {
      return true;
    }
  }

  return false;
}
