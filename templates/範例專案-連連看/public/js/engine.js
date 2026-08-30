/**
 * 四川省麻將連連看 - 核心邏輯引擎 (Engine)
 * 負責盤面座標系統、直線/一折/二折射線路徑搜尋演算法
 */

export const ROWS = 8;
export const COLS = 14;
export const PADDED_ROWS = ROWS + 2; // 10
export const PADDED_COLS = COLS + 2; // 16

/**
 * 檢查兩點是否在同一條無障礙水平線上
 * @param {Array<Array<string|null>>} grid 擴展矩陣 (10x16)
 * @param {number} r 共同列
 * @param {number} c1 起點欄
 * @param {number} c2 終點欄
 * @returns {boolean}
 */
export function isHorizontalClear(grid, r, c1, c2) {
  const minC = Math.min(c1, c2);
  const maxC = Math.max(c1, c2);
  for (let c = minC + 1; c < maxC; c++) {
    if (grid[r][c] !== null && grid[r][c] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * 檢查兩點是否在同一條無障礙垂直線上
 * @param {Array<Array<string|null>>} grid 擴展矩陣 (10x16)
 * @param {number} c 共同欄
 * @param {number} r1 起點列
 * @param {number} r2 終點列
 * @returns {boolean}
 */
export function isVerticalClear(grid, c, r1, r2) {
  const minR = Math.min(r1, r2);
  const maxR = Math.max(r1, r2);
  for (let r = minR + 1; r < maxR; r++) {
    if (grid[r][c] !== null && grid[r][c] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * 檢查格子是否為空格
 * @param {Array<Array<string|null>>} grid
 * @param {number} r
 * @param {number} c
 * @returns {boolean}
 */
export function isEmpty(grid, r, c) {
  return grid[r][c] === null || grid[r][c] === 0;
}

/**
 * 0 折直線連接判定
 * @param {Array<Array<string|null>>} grid
 * @param {number} r1
 * @param {number} c1
 * @param {number} r2
 * @param {number} c2
 * @returns {Array<{r: number, c: number}> | null} 成功則回傳路徑節點，失敗回傳 null
 */
export function check0Turn(grid, r1, c1, r2, c2) {
  if (r1 === r2 && isHorizontalClear(grid, r1, c1, c2)) {
    return [{ r: r1, c: c1 }, { r: r2, c: c2 }];
  }
  if (c1 === c2 && isVerticalClear(grid, c1, r1, r2)) {
    return [{ r: r1, c: c1 }, { r: r2, c: c2 }];
  }
  return null;
}

/**
 * 1 折 L 型連接判定
 * @param {Array<Array<string|null>>} grid
 * @param {number} r1
 * @param {number} c1
 * @param {number} r2
 * @param {number} c2
 * @returns {Array<{r: number, c: number}> | null}
 */
export function check1Turn(grid, r1, c1, r2, c2) {
  // 轉折點 1: (r1, c2)
  if (isEmpty(grid, r1, c2)) {
    if (isHorizontalClear(grid, r1, c1, c2) && isVerticalClear(grid, c2, r1, r2)) {
      return [{ r: r1, c: c1 }, { r: r1, c: c2 }, { r: r2, c: c2 }];
    }
  }

  // 轉折點 2: (r2, c1)
  if (isEmpty(grid, r2, c1)) {
    if (isVerticalClear(grid, c1, r1, r2) && isHorizontalClear(grid, r2, c1, c2)) {
      return [{ r: r1, c: c1 }, { r: r2, c: c1 }, { r: r2, c: c2 }];
    }
  }

  return null;
}

/**
 * 2 折 Z/U 型連接判定 (透過水平與垂直射線掃描)
 * @param {Array<Array<string|null>>} grid
 * @param {number} r1
 * @param {number} c1
 * @param {number} r2
 * @param {number} c2
 * @returns {Array<{r: number, c: number}> | null}
 */
export function check2Turn(grid, r1, c1, r2, c2) {
  // 1. 水平射線掃描：從 (r1, c1) 往左右發射射線至所有可達空格 (r1, c)
  // 向左發射
  for (let c = c1 - 1; c >= 0; c--) {
    if (!isEmpty(grid, r1, c)) break;
    // 檢查轉折點 1: (r1, c)，轉折點 2: (r2, c)
    if (isEmpty(grid, r2, c) || (r2 === r1 && c === c2)) {
      if (isVerticalClear(grid, c, r1, r2) && isHorizontalClear(grid, r2, c, c2)) {
        return [{ r: r1, c: c1 }, { r: r1, c: c }, { r: r2, c: c }, { r: r2, c: c2 }];
      }
    }
  }
  // 向右發射
  for (let c = c1 + 1; c < PADDED_COLS; c++) {
    if (!isEmpty(grid, r1, c)) break;
    if (isEmpty(grid, r2, c) || (r2 === r1 && c === c2)) {
      if (isVerticalClear(grid, c, r1, r2) && isHorizontalClear(grid, r2, c, c2)) {
        return [{ r: r1, c: c1 }, { r: r1, c: c }, { r: r2, c: c }, { r: r2, c: c2 }];
      }
    }
  }

  // 2. 垂直射線掃描：從 (r1, c1) 往上下發射射線至所有可達空格 (r, c1)
  // 向上發射
  for (let r = r1 - 1; r >= 0; r--) {
    if (!isEmpty(grid, r, c1)) break;
    // 檢查轉折點 1: (r, c1)，轉折點 2: (r, c2)
    if (isEmpty(grid, r, c2) || (r === r2 && c1 === c2)) {
      if (isHorizontalClear(grid, r, c1, c2) && isVerticalClear(grid, c2, r, r2)) {
        return [{ r: r1, c: c1 }, { r: r, c: c1 }, { r: r, c: c2 }, { r: r2, c: c2 }];
      }
    }
  }
  // 向下發射
  for (let r = r1 + 1; r < PADDED_ROWS; r++) {
    if (!isEmpty(grid, r, c1)) break;
    if (isEmpty(grid, r, c2) || (r === r2 && c1 === c2)) {
      if (isHorizontalClear(grid, r, c1, c2) && isVerticalClear(grid, c2, r, r2)) {
        return [{ r: r1, c: c1 }, { r: r, c: c1 }, { r: r, c: c2 }, { r: r2, c: c2 }];
      }
    }
  }

  return null;
}

/**
 * 總合判斷兩點是否能在 <= 2 折內連通
 * @param {Array<Array<string|null>>} grid
 * @param {number} r1 起點列 (1..ROWS)
 * @param {number} c1 起點欄 (1..COLS)
 * @param {number} r2 終點列 (1..ROWS)
 * @param {number} c2 終點欄 (1..COLS)
 * @returns {Array<{r: number, c: number}> | null} 成功則回傳路徑節點陣列，失敗回傳 null
 */
export function findPath(grid, r1, c1, r2, c2) {
  // 同一點不可連
  if (r1 === r2 && c1 === c2) return null;

  // 兩張牌圖案必須相同
  if (!grid[r1][c1] || !grid[r2][c2] || grid[r1][c1] !== grid[r2][c2]) {
    return null;
  }

  // 1. 直線 (0 折)
  let path = check0Turn(grid, r1, c1, r2, c2);
  if (path) return path;

  // 2. 一折 (1 折 L 型)
  path = check1Turn(grid, r1, c1, r2, c2);
  if (path) return path;

  // 3. 二折 (2 折 Z/U 型)
  path = check2Turn(grid, r1, c1, r2, c2);
  if (path) return path;

  return null;
}
