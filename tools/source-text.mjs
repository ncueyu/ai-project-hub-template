/**
 * 原始碼的文字處理。
 *
 * 存在的理由只有一個：**用字串比對檢查原始碼時，註解會造成誤判**。
 * 這個坑在本專案踩過三次——說明「為何不使用 X」的註解本身就含有 X。
 * `scripts/verify-stage2.mjs` 已經處理過一次，這裡把同一個處理抽出來給
 * Secret 掃描共用。
 *
 * 與 verify-stage2 的差別：那裡把註解換成單一空白就夠了，這裡**必須保留
 * 換行**——Secret 掃描要回報「哪個檔案第幾行」，行號一旦位移，使用者會
 * 被指到錯誤的位置，比不報還糟。
 */

/**
 * 把註解內容換成空白，保留每一個換行。
 *
 * 逐字元掃描而不是用正規表示式：註解符號可以合法地出現在字串裡
 * （網址的 `//`、正規表示式中的 `/*`），正規表示式無法區分兩者。
 *
 * @param {string} source
 * @returns {string} 與輸入等長、行數相同的字串
 */
export function blankComments(source) {
  let out = "";
  let index = 0;

  /** @type {"code" | "line" | "block" | "single" | "double" | "template"} */
  let state = "code";
  let escaped = false;

  /**
   * @param {string} char
   */
  function blank(char) {
    // 換行一律保留，其餘一律換成空白，長度與行號因此完全不變。
    out += char === "\n" ? "\n" : " ";
  }

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        blank(char);
        index += 1;
        continue;
      }

      if (char === "/" && next === "*") {
        state = "block";
        blank(char);
        blank(next);
        index += 2;
        continue;
      }

      if (char === "'" || char === '"' || char === "`") {
        state = char === "'" ? "single" : char === '"' ? "double" : "template";
        out += char;
        index += 1;
        continue;
      }

      out += char;
      index += 1;
      continue;
    }

    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
        index += 1;
        continue;
      }

      blank(char);
      index += 1;
      continue;
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        blank(char);
        blank(next);
        index += 2;
        continue;
      }

      blank(char);
      index += 1;
      continue;
    }

    // 字串內部：原樣保留。金鑰通常就寫在字串裡，這正是要掃描的目標。
    out += char;

    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (
      (state === "single" && char === "'")
      || (state === "double" && char === '"')
      || (state === "template" && char === "`")
    ) {
      state = "code";
    } else if (char === "\n" && state !== "template") {
      // 未收尾的引號不該把後面整份檔案都當成字串。
      state = "code";
    }

    index += 1;
  }

  return out;
}

/**
 * 移除 SQL 與 shell 風格的行註解（`--`、`#`），同樣保留換行。
 *
 * @param {string} source
 * @returns {string}
 */
export function blankHashComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const match = line.match(/(^|\s)(--|#)/);

      if (!match || match.index === undefined) {
        return line;
      }

      const start = match.index + match[1].length;

      return line.slice(0, start) + " ".repeat(line.length - start);
    })
    .join("\n");
}

/**
 * 由字元位置換算成行號與欄號（皆從 1 起算）。
 *
 * @param {string} source
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
export function toLineColumn(source, offset) {
  const before = source.slice(0, offset);
  const lines = before.split("\n");

  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}
