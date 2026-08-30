// @ts-check

/**
 * 影像格式辨識。
 *
 * 規格（階段二計畫第 10.5 節）明確要求：不信任副檔名，也不信任瀏覽器送來的
 * Content-Type，必須實際檢查檔案開頭的位元組特徵（Magic Bytes）。
 *
 * 只允許 PNG、JPEG、WebP、AVIF 四種。SVG 一律拒絕——它是可以內嵌
 * JavaScript 的 XML 文件，當作圖片直接提供會造成跨站指令碼風險。
 */

/** 允許的影像 MIME 類型。 */
export const ALLOWED_IMAGE_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
]);

/** 應用層的檔案大小上限：5 MiB。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSIONS = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
});

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function ascii(bytes, offset, length) {
  let out = "";

  for (let i = offset; i < offset + length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }

  return out;
}

/**
 * 依檔案開頭的位元組判斷真實格式。
 *
 * @param {Uint8Array} bytes
 * @returns {string | null} MIME 類型，無法辨識或不允許時回傳 null
 */
export function detectImageType(bytes) {
  if (!bytes || bytes.length < 12) {
    return null;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // WebP: "RIFF" ????  "WEBP"
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }

  // AVIF: ???? "ftyp" 之後是 major brand
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);

    if (brand === "avif" || brand === "avis") {
      return "image/avif";
    }
  }

  return null;
}

/**
 * @param {string} contentType
 * @returns {string}
 */
export function extensionFor(contentType) {
  return /** @type {Record<string, string>} */ (EXTENSIONS)[contentType] ?? "bin";
}

/**
 * 產生不可猜測的物件名稱。
 *
 * 規格要求不得使用原始檔名：原始檔名可能夾帶路徑、可被猜測，
 * 也可能洩漏使用者電腦上的資訊。
 *
 * @param {string} contentType
 * @returns {string}
 */
export function createObjectKey(contentType) {
  return `${crypto.randomUUID()}.${extensionFor(contentType)}`;
}

/**
 * 物件名稱的合法形狀。用於 GET 路徑，避免路徑穿越之類的輸入。
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isValidObjectKey(key) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|avif)$/.test(key);
}
