// @ts-check

/**
 * 外部連結專案的「純偵測」部分（2026-08-30）。
 *
 * ## 為什麼與 tools/link.mjs 分成兩個檔案
 *
 * `tools/detect.mjs` 需要這幾個函式才能判斷出 `link` 型態，而 `link.mjs`
 * 為了完成登錄流程要 import `new-project.mjs`／`queries.mjs`／`register.mjs`。
 * 讓 `detect.mjs` 直接 import `link.mjs` 今天不會出問題（那條鏈目前是無環的），
 * 但只要日後有人讓 `new-project.mjs` 反過來 import `detect.mjs`——那是很自然的
 * 一步——就會出現循環相依，而 ESM 的循環相依故障是在執行期以
 * 「某個 import 的值是 undefined」的形式現身，看不出真正的原因。
 *
 * 這個檔案只依賴 node:fs 與 node:path，因此任何人都可以安全地 import 它。
 */

import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * 計畫書點名的三個檔名。這些**不是**唯一被接受的檔名（見檔頭），
 * 只是在一個資料夾裡有多個文字檔時的優先序。
 */
export const PREFERRED_LINK_FILENAMES = Object.freeze([
  "新增 文字文件.txt",
  "連結.txt",
  "網站連結.txt",
  "網址.txt",
  "link.txt",
  "url.txt",
]);

/** 會被當成「可能寫著網址」的副檔名。 */
const TEXT_EXTENSIONS = Object.freeze([".txt", ".md"]);

/**
 * 把檔案位元組解碼成文字。
 *
 * **為什麼不直接 `readFileSync(path, "utf8")`**：Windows 記事本的「另存新檔」
 * 提供 UTF-16 LE（選單上寫「Unicode」），而使用者很可能就是用記事本存的。
 * 以 utf8 讀一個 UTF-16 檔，每個字元中間會多一個 NUL——網址的正規表示式
 * 一個字元都比對不到，錯誤訊息卻只會是「這個檔案裡找不到網址」，
 * 而使用者明明看著檔案裡就有網址。
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeTextFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16 BE：Node 沒有內建這個編碼，先把每一對位元組對調再當 LE 讀。
    const swapped = Buffer.from(buffer.subarray(2));

    swapped.swap16();

    return swapped.toString("utf16le");
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }

  return buffer.toString("utf8");
}

/**
 * 從一段文字裡取出第一個 http(s) 網址。
 *
 * ## 網址在哪裡結束
 *
 * 使用者寫的是中文句子，網址夾在裡面：「網址：https://example.com/abc，謝謝」。
 * 只用空白斷字的話，後面那串中文會被 `new URL()` 百分比編碼成
 * `abc%EF%BC%8C%E8%AC%9D%E8%AC%9D` 收進網址裡——連結打不開，而畫面上顯示的
 * 網址看起來又跟使用者寫的一樣，錯在哪裡完全看不出來。
 *
 * 所以全形標點也算斷字元。**只有標點，不含一般中文字**：
 * `https://example.com/我的網頁` 是合法網址（Chrome 網址列複製出來就是這樣），
 * 把中文字也當斷字元會把它砍成半截。代價是「網址後面直接接中文而且沒有標點」
 * 這種寫法仍會出錯，但那比前者罕見得多。
 *
 * 尾端的標點另外再切一次：使用者常寫成「網址：https://example.com/。」，
 * 句號在斷字元裡雖然已經擋住了，但半形的 `.` `,` `;` 不能當斷字元
 * （它們是網址的合法內容），只能從尾端修掉。
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>"'`。，、；：！？（）「」『』《》【】]+/u);

  if (!match) {
    return null;
  }

  const trimmed = match[0].replace(/[.,;:!?)\]]+$/u, "");

  try {
    const parsed = new URL(trimmed);

    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * 在專案資料夾根目錄找出寫著網址的文字檔。
 *
 * 只看根目錄、不遞迴——與 `findThumbnailSource()` 同一個判斷：子目錄裡的
 * 文字檔是網站內容，不是給展示中心看的中介資料。
 *
 * @param {string} dir
 * @returns {{ path: string, name: string, url: string } | null}
 */
export function findLinkFile(dir) {
  /** @type {{ path: string, name: string, url: string }[]} */
  const found = [];

  let entries;

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !TEXT_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
      continue;
    }

    const path = join(dir, entry.name);

    let url;

    try {
      url = extractUrl(decodeTextFile(readFileSync(path)));
    } catch {
      continue;
    }

    if (url !== null) {
      found.push({ path, name: entry.name, url });
    }
  }

  if (found.length === 0) {
    return null;
  }

  // 使用者刻意用了計畫書點名的檔名 → 尊重他的意圖；否則取排序第一個，
  // 讓同一個資料夾每次跑出來的結果一致（readdir 的順序不保證穩定）。
  const preferred = found.find((item) => PREFERRED_LINK_FILENAMES.includes(item.name));

  return preferred ?? found.sort((a, b) => a.name.localeCompare(b.name))[0];
}

/**
 * 判斷一個資料夾是不是「外部連結專案」。
 *
 * 條件刻意收得很緊：**沒有任何根目錄 HTML**，而且有寫著網址的文字檔。
 * 有 HTML 的資料夾是要被部署的專案，即使裡面剛好也放了一個連結檔——
 * 把它判成外部連結，會讓 `hub ship` 拒絕一個本來部署得起來的專案。
 *
 * @param {string} dir
 * @returns {{ isLink: boolean, url: string | null, source: string | null }}
 */
export function detectLinkFolder(dir) {
  let entries;

  try {
    entries = readdirSync(dir);
  } catch {
    return { isLink: false, url: null, source: null };
  }

  if (entries.some((name) => /\.html?$/i.test(name))) {
    return { isLink: false, url: null, source: null };
  }

  const link = findLinkFile(dir);

  return link === null
    ? { isLink: false, url: null, source: null }
    : { isLink: true, url: link.url, source: link.name };
}
