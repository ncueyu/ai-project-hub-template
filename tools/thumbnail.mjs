// @ts-check

/**
 * 專案縮圖的偵測與搬運。
 *
 * 使用者只需要做一件事：把首頁截圖放進專案資料夾的根目錄。
 * 其餘（找到它、改名、搬到 Hub、登錄網址）都由這裡處理。
 *
 * ## 為什麼不做影像處理
 *
 * 原本的計畫（2026-08-17 D17）是「頂端裁切 16:10 → 縮到 1280×800 → 轉 WebP」。
 * 實作時發現 Node 沒有內建影像處理，要做就得加 `sharp`——原生二進位、約 30 MB，
 * 而且**空白殼的使用者也得裝**。這與「教材要能被別人照做」直接衝突：
 * 多一個重量級依賴就少一批能照做的人。
 *
 * 改用零依賴的解法：`gallery.css` 的 `object-fit` 從 `cover` 改成 `contain`。
 * 任何比例的截圖都完整顯示，上下或左右留白，底色與卡片一致。
 * **不裁切、不縮放、不轉檔，也就不需要任何影像處理程式庫。**
 *
 * 代價是卡片的視覺不如統一裁切那麼整齊，但換來的是「使用者隨便截一張圖都能用」，
 * 而且完整看得到網站長什麼樣——對展示中心來說，後者更重要。
 *
 * ## 為什麼不限定檔名
 *
 * 原本要求檔名必須是 `thumbnail.png` 或 `縮圖.png`。第一次實測時使用者放的是
 * `工丙-量測版焊接模擬程式截圖.png`——**真實使用者就是會用描述性檔名**。
 * 要求記住特定檔名，違背了「使用者只要放進去，其他都給你處理」。
 * 因此改成：認得專案根目錄的任何圖片檔。
 */

import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/** 認得的圖片副檔名。 */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

/** 檔名含這些字樣時優先採用（使用者若刻意命名，就尊重他的意圖）。 */
const PREFERRED_WORDS = ["thumbnail", "縮圖", "截圖", "screenshot", "preview", "預覽"];

/** 超過這個大小就提醒壓縮。縮圖只是卡片上的一小塊，不需要原始截圖的完整解析度。 */
export const THUMBNAIL_WARN_BYTES = 500 * 1024;

/**
 * 在專案根目錄找縮圖來源。
 *
 * 只看**根目錄**，不遞迴。理由：`public/`（或其他產物目錄）裡的圖片是網站內容，
 * 不是縮圖；把它們也當候選會讓有大量圖片的專案（例如題庫的 588 張圖）完全無法判斷。
 *
 * @param {string} projectDir
 * @returns {{ path: string, name: string, bytes: number } | null}
 */
export function findThumbnailSource(projectDir) {
  /** @type {{ path: string, name: string, bytes: number }[]} */
  const candidates = [];

  let entries;

  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (!IMAGE_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
      continue;
    }

    const full = join(projectDir, entry.name);

    let bytes = 0;

    try {
      bytes = statSync(full).size;
    } catch {
      continue;
    }

    candidates.push({ path: full, name: entry.name, bytes });
  }

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  // 多張時先看檔名有沒有明確意圖，沒有就取最大的那張——
  // 截圖通常比 logo、icon 之類的裝飾圖大。
  const preferred = candidates.find((candidate) => {
    const lower = candidate.name.toLowerCase();

    return PREFERRED_WORDS.some((word) => lower.includes(word.toLowerCase()));
  });

  if (preferred !== undefined) {
    return preferred;
  }

  return candidates.reduce((largest, candidate) => (candidate.bytes > largest.bytes ? candidate : largest));
}

/**
 * 產生給使用者看的縮圖狀態說明。
 *
 * @param {string} projectDir
 * @returns {{ found: boolean, detail: string, source: { path: string, name: string, bytes: number } | null }}
 */
export function describeThumbnail(projectDir) {
  const source = findThumbnailSource(projectDir);

  if (source === null) {
    return {
      found: false,
      source: null,
      detail: "找不到縮圖。展示中心的卡片會顯示「此專案尚無預覽圖」。\n"
        + `      要加上縮圖：把網站首頁的截圖放進 ${projectDir}\n`
        + "      檔名不限（例如「我的專案截圖.png」都可以），只要放在專案根目錄、不要放進 public\\。\n"
        + "      任何比例都可以，畫面會完整顯示不裁切。",
    };
  }

  const kb = Math.round(source.bytes / 1024);
  const oversized = source.bytes > THUMBNAIL_WARN_BYTES;

  return {
    found: true,
    source,
    detail: `找到 ${source.name}（${kb} KB）`
      + (oversized
        ? `\n      檔案偏大（超過 ${Math.round(THUMBNAIL_WARN_BYTES / 1024)} KB）。縮圖在卡片上只佔一小塊，`
          + "建議壓縮後再放，否則每個訪客都要下載這個大小。"
        : ""),
  };
}
