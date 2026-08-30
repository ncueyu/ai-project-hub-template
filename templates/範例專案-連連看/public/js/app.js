/**
 * 萬用連連看 (Shisen-Sho) - 多主題與多盤面規格引擎
 * 支援 5x5 (快速休閒) 與 10x5 (進階挑戰)
 * 支援 3 種主題：烘焙甜點 (預設)、科技符號、魔法藥水
 * 100% 自包含腳本，支援 file:/// 本機直接執行與展示中心部署
 */

(function () {
  'use strict';

  // ==========================================
  // 1. 核心網格與路徑演算法 (Engine)
  // ==========================================
  function isHorizontalClear(grid, r, c1, c2) {
    const minC = Math.min(c1, c2);
    const maxC = Math.max(c1, c2);
    for (let c = minC + 1; c < maxC; c++) {
      if (grid[r][c] !== null && grid[r][c] !== 0) {
        return false;
      }
    }
    return true;
  }

  function isVerticalClear(grid, c, r1, r2) {
    const minR = Math.min(r1, r2);
    const maxR = Math.max(r1, r2);
    for (let r = minR + 1; r < maxR; r++) {
      if (grid[r][c] !== null && grid[r][c] !== 0) {
        return false;
      }
    }
    return true;
  }

  function isEmpty(grid, r, c) {
    return grid[r][c] === null || grid[r][c] === 0;
  }

  function check0Turn(grid, r1, c1, r2, c2) {
    if (r1 === r2 && isHorizontalClear(grid, r1, c1, c2)) {
      return [{ r: r1, c: c1 }, { r: r2, c: c2 }];
    }
    if (c1 === c2 && isVerticalClear(grid, c1, r1, r2)) {
      return [{ r: r1, c: c1 }, { r: r2, c: c2 }];
    }
    return null;
  }

  function check1Turn(grid, r1, c1, r2, c2) {
    if (isEmpty(grid, r1, c2)) {
      if (isHorizontalClear(grid, r1, c1, c2) && isVerticalClear(grid, c2, r1, r2)) {
        return [{ r: r1, c: c1 }, { r: r1, c: c2 }, { r: r2, c: c2 }];
      }
    }
    if (isEmpty(grid, r2, c1)) {
      if (isVerticalClear(grid, c1, r1, r2) && isHorizontalClear(grid, r2, c1, c2)) {
        return [{ r: r1, c: c1 }, { r: r2, c: c1 }, { r: r2, c: c2 }];
      }
    }
    return null;
  }

  function check2Turn(grid, r1, c1, r2, c2, paddedRows, paddedCols) {
    // 水平射線
    for (let c = c1 - 1; c >= 0; c--) {
      if (!isEmpty(grid, r1, c)) break;
      if (isEmpty(grid, r2, c) || (r2 === r1 && c === c2)) {
        if (isVerticalClear(grid, c, r1, r2) && isHorizontalClear(grid, r2, c, c2)) {
          return [{ r: r1, c: c1 }, { r: r1, c: c }, { r: r2, c: c }, { r: r2, c: c2 }];
        }
      }
    }
    for (let c = c1 + 1; c < paddedCols; c++) {
      if (!isEmpty(grid, r1, c)) break;
      if (isEmpty(grid, r2, c) || (r2 === r1 && c === c2)) {
        if (isVerticalClear(grid, c, r1, r2) && isHorizontalClear(grid, r2, c, c2)) {
          return [{ r: r1, c: c1 }, { r: r1, c: c }, { r: r2, c: c }, { r: r2, c: c2 }];
        }
      }
    }

    // 垂直射線
    for (let r = r1 - 1; r >= 0; r--) {
      if (!isEmpty(grid, r, c1)) break;
      if (isEmpty(grid, r, c2) || (r === r2 && c1 === c2)) {
        if (isHorizontalClear(grid, r, c1, c2) && isVerticalClear(grid, c2, r, r2)) {
          return [{ r: r1, c: c1 }, { r: r, c: c1 }, { r: r, c: c2 }, { r: r2, c: c2 }];
        }
      }
    }
    for (let r = r1 + 1; r < paddedRows; r++) {
      if (!isEmpty(grid, r, c1)) break;
      if (isEmpty(grid, r, c2) || (r === r2 && c1 === c2)) {
        if (isHorizontalClear(grid, r, c1, c2) && isVerticalClear(grid, c2, r, r2)) {
          return [{ r: r1, c: c1 }, { r: r, c: c1 }, { r: r, c: c2 }, { r: r2, c: c2 }];
        }
      }
    }
    return null;
  }

  function findPath(grid, r1, c1, r2, c2, paddedRows, paddedCols) {
    if (r1 === r2 && c1 === c2) return null;
    if (!grid[r1][c1] || !grid[r2][c2] || grid[r1][c1] !== grid[r2][c2]) {
      return null;
    }

    let path = check0Turn(grid, r1, c1, r2, c2);
    if (path) return path;

    path = check1Turn(grid, r1, c1, r2, c2);
    if (path) return path;

    path = check2Turn(grid, r1, c1, r2, c2, paddedRows, paddedCols);
    if (path) return path;

    return null;
  }

  // ==========================================
  // 2. 多主題圖標庫 (Theme Tile System)
  // ==========================================
  const THEME_DATA = {
    dessert: {
      name: '🧁 烘焙甜點',
      types: [
        'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7',
        'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7',
        'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7',
        'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'
      ],
      names: {
        C1: '草莓蛋糕', C2: '藍莓起司', C3: '巧克力磚', C4: '檸檬塔',
        C5: '蘋果派', C6: '提拉米蘇', C7: '杯子蛋糕',
        B1: '法式可頌', B2: '法國長棍', B3: '肉桂捲', B4: '甜甜圈',
        B5: '脆皮泡芙', B6: '楓糖鬆餅', B7: '厚煎鬆餅',
        F1: '粉紅馬卡龍', F2: '抹茶馬卡龍', F3: '焦糖布丁', F4: '烤布蕾',
        F5: '瑪德蓮', F6: '費南雪', F7: '可麗露',
        D1: '聖代冰品', D2: '甜筒霜淇淋', D3: '西瓜雪糕', D4: '焦糖咖啡',
        D5: '珍珠奶茶', D6: '抹茶拿鐵', D7: '蜜桃氣泡'
      },
      tag: '🍰',
      bgClass: 'theme-dessert'
    },
    tech: {
      name: '⚡ 科技符號',
      types: [
        'T_ATOM', 'T_BOLT', 'T_ORBIT', 'T_CHIP', 'T_GEAR', 'T_SHIELD', 'T_KEY',
        'T_GLOBE', 'T_ROCKET', 'T_SAT', 'T_UFO', 'T_BATTERY', 'T_RADAR', 'T_DNA',
        'T_COMPASS', 'T_MAGNET', 'T_BULB', 'T_TARGET', 'T_CUBE', 'T_HOLE', 'T_METEOR',
        'T_FLARE', 'T_DIAMOND', 'T_PRISM', 'T_AI'
      ],
      names: {
        T_ATOM: '原子核', T_BOLT: '高壓電', T_ORBIT: '土星環', T_CHIP: '量子晶片',
        T_GEAR: '機械齒輪', T_SHIELD: '防護力場', T_KEY: '密碼鑰匙', T_GLOBE: '全球網格',
        T_ROCKET: '穿梭火箭', T_SAT: '人造衛星', T_UFO: '飛碟艦艇', T_BATTERY: '離子核心',
        T_RADAR: '探測雷達', T_DNA: '基因螺旋', T_COMPASS: '星際羅盤', T_MAGNET: '磁力矩陣',
        T_BULB: '靈感光子', T_TARGET: '雷射準星', T_CUBE: '全息魔方', T_HOLE: '引力黑洞',
        T_METEOR: '彗星流星', T_FLARE: '太陽耀斑', T_DIAMOND: '奈米鑽石', T_PRISM: '光學菱鏡',
        T_AI: '神經中樞'
      },
      tag: '⚡',
      bgClass: 'theme-tech'
    },
    potion: {
      name: '🧪 魔法藥水',
      types: [
        'P_HP', 'P_MANA', 'P_POISON', 'P_RAGE', 'P_HOLY', 'P_INVIS', 'P_LAVA',
        'P_FROST', 'P_LIGHTNING', 'P_CURSE', 'P_DREAM', 'P_SUN', 'P_NATURE',
        'P_FLASK', 'P_DISTILL', 'P_SCROLL', 'P_ORB', 'P_CANDLE', 'P_KEY', 'P_WAND',
        'P_FEATHER', 'P_BLOOD', 'P_MUSHROOM', 'P_STARDUST', 'P_EYE'
      ],
      names: {
        P_HP: '生命紅水', P_MANA: '魔力藍水', P_POISON: '劇毒綠水', P_RAGE: '狂暴紫水',
        P_HOLY: '神聖聖水', P_INVIS: '隱形幻水', P_LAVA: '熔岩烈水', P_FROST: '急凍冰水',
        P_LIGHTNING: '雷霆疾水', P_CURSE: '死靈咒水', P_DREAM: '夜影幻水', P_SUN: '日耀金水',
        P_NATURE: '翡翠甘露', P_FLASK: '鍊金燒瓶', P_DISTILL: '萃取精華', P_SCROLL: '古老卷軸',
        P_ORB: '占卜水晶', P_CANDLE: '秘儀蠟燭', P_KEY: '秘境銀匙', P_WAND: '奧術魔杖',
        P_FEATHER: '不死鳥羽', P_BLOOD: '龍族寶血', P_MUSHROOM: '迷幻魔菇', P_STARDUST: '星塵靈砂',
        P_EYE: '全知之眼'
      },
      tag: '🧪',
      bgClass: 'theme-potion'
    }
  };

  function getPotionBottleSVG(fluidColor, topColor = '#78350F', bubbleColor = '#FFFFFF') {
    return `
      <rect x="25" y="18" width="10" height="6" rx="1" fill="${topColor}"/>
      <rect x="27" y="24" width="6" height="8" fill="#CBD5E1"/>
      <path d="M27 32 L16 54 C15 58 18 62 23 62 L37 62 C42 62 45 58 44 54 L33 32 Z" fill="#E2E8F0" stroke="#94A3B8" stroke-width="1.5"/>
      <path d="M28 38 L18 55 C17 58 20 60 24 60 L36 60 C40 60 43 58 42 55 L32 38 Z" fill="${fluidColor}"/>
      <circle cx="26" cy="52" r="2" fill="${bubbleColor}" opacity="0.6"/>
      <circle cx="34" cy="46" r="1.5" fill="${bubbleColor}" opacity="0.6"/>
    `;
  }

  function getTileSVG(theme, type) {
    const themeInfo = THEME_DATA[theme] || THEME_DATA.dessert;
    const name = themeInfo.names[type] || type;
    let art = '';

    // 1. 甜點主題
    if (theme === 'dessert') {
      switch (type) {
        case 'C1': art = `<polygon points="12,58 48,58 48,38 12,48" fill="#FDE68A"/><polygon points="12,48 48,38 48,32 12,42" fill="#FFFFFF"/><polygon points="12,42 48,32 40,24 16,30" fill="#FDA4AF"/><circle cx="28" cy="22" r="7" fill="#E11D48"/><polygon points="28,14 26,17 30,17" fill="#15803D"/><circle cx="26" cy="22" r="0.8" fill="#FEF08A"/><circle cx="30" cy="24" r="0.8" fill="#FEF08A"/>`; break;
        case 'C2': art = `<polygon points="12,58 48,58 48,34 12,44" fill="#FCD34D"/><polygon points="12,44 48,34 40,26 16,32" fill="#FEF08A"/><path d="M16 32 Q30 28 40 26 Q35 34 26 36 Z" fill="#6D28D9"/><circle cx="26" cy="26" r="4.5" fill="#4C1D95"/><circle cx="34" cy="25" r="4" fill="#5B21B6"/><circle cx="27" cy="24" r="1.2" fill="#DDD6FE"/>`; break;
        case 'C3': art = `<rect x="14" y="24" width="32" height="34" rx="4" fill="#451A03"/><rect x="17" y="27" width="11" height="12" rx="2" fill="#78350F"/><rect x="32" y="27" width="11" height="12" rx="2" fill="#78350F"/><rect x="17" y="43" width="11" height="12" rx="2" fill="#78350F"/><rect x="32" y="43" width="11" height="12" rx="2" fill="#78350F"/>`; break;
        case 'C4': art = `<ellipse cx="30" cy="48" rx="20" ry="10" fill="#D97706"/><ellipse cx="30" cy="45" rx="18" ry="8" fill="#FBBF24"/><ellipse cx="30" cy="43" rx="14" ry="5.5" fill="#FEF08A"/><circle cx="30" cy="32" r="9" fill="#FACC15" stroke="#FFFFFF" stroke-width="1.5"/><line x1="30" y1="23" x2="30" y2="41" stroke="#FFFFFF" stroke-width="1"/><line x1="21" y1="32" x2="39" y2="32" stroke="#FFFFFF" stroke-width="1"/>`; break;
        case 'C5': art = `<ellipse cx="30" cy="46" rx="20" ry="12" fill="#B45309"/><ellipse cx="30" cy="43" rx="17" ry="9" fill="#D97706"/><line x1="18" y1="40" x2="42" y2="46" stroke="#FEF3C7" stroke-width="2.5"/><line x1="18" y1="46" x2="42" y2="40" stroke="#FEF3C7" stroke-width="2.5"/><line x1="24" y1="36" x2="36" y2="50" stroke="#FEF3C7" stroke-width="2.5"/><line x1="36" y1="36" x2="24" y2="50" stroke="#FEF3C7" stroke-width="2.5"/>`; break;
        case 'C6': art = `<rect x="14" y="28" width="32" height="30" rx="3" fill="#FEF3C7"/><rect x="14" y="36" width="32" height="6" fill="#78350F"/><rect x="14" y="48" width="32" height="6" fill="#78350F"/><rect x="13" y="25" width="34" height="6" rx="2" fill="#542308"/><path d="M30 25 Q35 18 40 22 Q35 27 30 25 Z" fill="#16A34A"/>`; break;
        case 'C7': art = `<polygon points="18,44 42,44 38,62 22,62" fill="#F43F5E"/><line x1="24" y1="44" x2="26" y2="62" stroke="#FDA4AF" stroke-width="1.5"/><line x1="30" y1="44" x2="30" y2="62" stroke="#FDA4AF" stroke-width="1.5"/><line x1="36" y1="44" x2="34" y2="62" stroke="#FDA4AF" stroke-width="1.5"/><circle cx="24" cy="40" r="8" fill="#FEF08A"/><circle cx="36" cy="40" r="8" fill="#FEF08A"/><circle cx="30" cy="32" r="9" fill="#FEF08A"/><circle cx="30" cy="22" r="4.5" fill="#E11D48"/><path d="M30 18 Q36 12 38 14" stroke="#78350F" stroke-width="1.5" fill="none"/>`; break;
        case 'B1': art = `<path d="M12 48 Q30 22 48 48 Q38 42 30 44 Q22 42 12 48 Z" fill="#D97706"/><path d="M18 46 Q30 26 42 46 Q34 38 30 40 Q26 38 18 46 Z" fill="#F59E0B"/><ellipse cx="30" cy="38" rx="7" ry="9" fill="#FBBF24"/>`; break;
        case 'B2': art = `<rect x="18" y="22" width="24" height="38" rx="12" transform="rotate(-25 30 40)" fill="#D97706"/><line x1="22" y1="28" x2="34" y2="24" stroke="#FEF3C7" stroke-width="2.5" stroke-linecap="round"/><line x1="24" y1="40" x2="36" y2="36" stroke="#FEF3C7" stroke-width="2.5" stroke-linecap="round"/><line x1="26" y1="52" x2="38" y2="48" stroke="#FEF3C7" stroke-width="2.5" stroke-linecap="round"/>`; break;
        case 'B3': art = `<circle cx="30" cy="42" r="18" fill="#D97706"/><circle cx="30" cy="42" r="14" fill="#FEF3C7"/><path d="M30 42 m -10 0 a 10 10 0 1 0 20 0 a 7 7 0 1 0 -14 0 a 4 4 0 1 0 8 0" stroke="#78350F" stroke-width="2.5" fill="none" stroke-linecap="round"/>`; break;
        case 'B4': art = `<circle cx="30" cy="42" r="18" fill="#D97706"/><path d="M30 24 Q36 22 42 28 Q48 34 46 42 Q48 50 42 56 Q36 60 30 58 Q24 60 18 56 Q12 50 14 42 Q12 34 18 28 Q24 22 30 24 Z" fill="#EC4899"/><circle cx="23" cy="28" r="1.5" fill="#FEF08A"/><circle cx="37" cy="28" r="1.5" fill="#38BDF8"/><circle cx="43" cy="42" r="1.5" fill="#A3E635"/><circle cx="17" cy="44" r="1.5" fill="#FEF08A"/><circle cx="26" cy="54" r="1.5" fill="#38BDF8"/><circle cx="30" cy="42" r="6.5" fill="#F8FAFC"/>`; break;
        case 'B5': art = `<circle cx="30" cy="46" r="17" fill="#F59E0B"/><path d="M15 42 Q30 20 45 42 Q40 46 30 44 Q20 46 15 42 Z" fill="#78350F"/><circle cx="26" cy="30" r="1" fill="#FFFFFF"/><circle cx="34" cy="28" r="1" fill="#FFFFFF"/><circle cx="30" cy="34" r="1" fill="#FFFFFF"/>`; break;
        case 'B6': art = `<rect x="14" y="24" width="32" height="32" rx="4" fill="#D97706"/><rect x="17" y="27" width="11" height="11" rx="1.5" fill="#F59E0B"/><rect x="32" y="27" width="11" height="11" rx="1.5" fill="#F59E0B"/><rect x="17" y="42" width="11" height="11" rx="1.5" fill="#F59E0B"/><rect x="32" y="42" width="11" height="11" rx="1.5" fill="#F59E0B"/><rect x="25" y="35" width="10" height="10" rx="1" fill="#FEF08A" stroke="#F59E0B" stroke-width="1"/>`; break;
        case 'B7': art = `<ellipse cx="30" cy="54" rx="18" ry="7" fill="#D97706"/><ellipse cx="30" cy="44" rx="18" ry="7" fill="#F59E0B"/><ellipse cx="30" cy="34" rx="18" ry="7" fill="#FCD34D"/><path d="M26 34 Q30 48 33 34" stroke="#B45309" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="26" y="26" width="8" height="6" rx="1" fill="#FEF08A"/>`; break;
        case 'F1': art = `<ellipse cx="30" cy="33" rx="17" ry="7" fill="#F43F5E"/><rect x="13" y="38" width="34" height="4" rx="2" fill="#FEF08A"/><ellipse cx="30" cy="47" rx="17" ry="7" fill="#F43F5E"/>`; break;
        case 'F2': art = `<ellipse cx="30" cy="33" rx="17" ry="7" fill="#15803D"/><rect x="13" y="38" width="34" height="4" rx="2" fill="#78350F"/><ellipse cx="30" cy="47" rx="17" ry="7" fill="#15803D"/>`; break;
        case 'F3': art = `<polygon points="16,56 44,56 38,32 22,32" fill="#FDE047"/><ellipse cx="30" cy="32" rx="8" ry="3.5" fill="#78350F"/><circle cx="30" cy="24" r="4" fill="#DC2626"/>`; break;
        case 'F4': art = `<ellipse cx="30" cy="46" rx="19" ry="11" fill="#F1F5F9" stroke="#CBD5E1" stroke-width="2"/><ellipse cx="30" cy="44" rx="16" ry="8" fill="#FDE047"/><ellipse cx="30" cy="43" rx="13" ry="6" fill="#B45309"/><path d="M22 43 Q28 40 38 44" stroke="#78350F" stroke-width="1.5" fill="none"/>`; break;
        case 'F5': art = `<path d="M30 22 C16 32 16 54 30 58 C44 54 44 32 30 22 Z" fill="#F59E0B"/><line x1="30" y1="28" x2="30" y2="56" stroke="#D97706" stroke-width="1.5"/><line x1="30" y1="28" x2="22" y2="52" stroke="#D97706" stroke-width="1.5"/><line x1="30" y1="28" x2="38" y2="52" stroke="#D97706" stroke-width="1.5"/>`; break;
        case 'F6': art = `<polygon points="14,48 40,48 46,30 20,30" fill="#F59E0B"/><polygon points="14,48 20,30 20,34 14,52" fill="#B45309"/><polygon points="14,52 40,52 40,48 14,48" fill="#D97706"/>`; break;
        case 'F7': art = `<path d="M18 56 L16 32 Q30 26 44 32 L42 56 Q30 60 18 56 Z" fill="#451A03"/><ellipse cx="30" cy="30" rx="12" ry="4" fill="#78350F"/><line x1="22" y1="32" x2="24" y2="56" stroke="#270F02" stroke-width="1.5"/><line x1="30" y1="30" x2="30" y2="58" stroke="#270F02" stroke-width="1.5"/><line x1="38" y1="32" x2="36" y2="56" stroke="#270F02" stroke-width="1.5"/>`; break;
        case 'D1': art = `<path d="M20 44 L26 62 L34 62 L40 44 Z" fill="#E2E8F0" stroke="#94A3B8" stroke-width="1.5"/><circle cx="24" cy="38" r="7" fill="#F43F5E"/><circle cx="36" cy="38" r="7" fill="#38BDF8"/><circle cx="30" cy="30" r="8" fill="#FEF08A"/><circle cx="30" cy="20" r="3.5" fill="#DC2626"/>`; break;
        case 'D2': art = `<polygon points="20,44 40,44 30,66" fill="#D97706"/><line x1="24" y1="44" x2="35" y2="55" stroke="#B45309" stroke-width="1"/><line x1="36" y1="44" x2="25" y2="55" stroke="#B45309" stroke-width="1"/><circle cx="30" cy="40" r="10" fill="#FDA4AF"/><circle cx="30" cy="30" r="8" fill="#FDA4AF"/><circle cx="30" cy="22" r="5" fill="#FDA4AF"/>`; break;
        case 'D3': art = `<rect x="27" y="52" width="6" height="14" rx="2" fill="#D97706"/><polygon points="14,48 46,48 30,18" fill="#E11D48"/><rect x="14" y="46" width="32" height="4" fill="#FFFFFF"/><rect x="14" y="50" width="32" height="4" rx="1" fill="#15803D"/><circle cx="28" cy="32" r="1" fill="#1E293B"/><circle cx="33" cy="36" r="1" fill="#1E293B"/><circle cx="27" cy="42" r="1" fill="#1E293B"/>`; break;
        case 'D4': art = `<path d="M18 30 L22 56 L38 56 L42 30 Z" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.5"/><path d="M41 36 Q48 36 48 44 Q48 50 39 50" stroke="#CBD5E1" stroke-width="2" fill="none"/><ellipse cx="30" cy="32" rx="9" ry="3" fill="#78350F"/><path d="M30 31 C28 29 26 31 30 34 C34 31 32 29 30 31 Z" fill="#FEF3C7"/>`; break;
        case 'D5': art = `<polygon points="18,26 42,26 38,58 22,58" fill="#FDE68A" stroke="#E2E8F0" stroke-width="1.5"/><line x1="28" y1="16" x2="33" y2="40" stroke="#F43F5E" stroke-width="3" stroke-linecap="round"/><circle cx="26" cy="54" r="2.5" fill="#1E293B"/><circle cx="32" cy="54" r="2.5" fill="#1E293B"/><circle cx="29" cy="49" r="2.5" fill="#1E293B"/><circle cx="35" cy="50" r="2.5" fill="#1E293B"/><circle cx="23" cy="50" r="2.5" fill="#1E293B"/>`; break;
        case 'D6': art = `<polygon points="18,26 42,26 38,58 22,58" fill="#86EFAC" stroke="#E2E8F0" stroke-width="1.5"/><ellipse cx="30" cy="26" rx="12" ry="4" fill="#15803D"/><ellipse cx="30" cy="25" rx="8" ry="2.5" fill="#FFFFFF"/><line x1="28" y1="16" x2="33" y2="38" stroke="#16A34A" stroke-width="3" stroke-linecap="round"/>`; break;
        case 'D7': art = `<polygon points="18,24 42,24 38,60 22,60" fill="#FDA4AF" stroke="#E2E8F0" stroke-width="1.5"/><line x1="30" y1="16" x2="30" y2="52" stroke="#F59E0B" stroke-width="2.5" stroke-linecap="round"/><circle cx="26" cy="48" r="1.5" fill="#FFFFFF" opacity="0.8"/><circle cx="34" cy="42" r="2" fill="#FFFFFF" opacity="0.8"/><circle cx="28" cy="34" r="1.5" fill="#FFFFFF" opacity="0.8"/>`; break;
        default: art = `<text x="30" y="46" font-size="14" text-anchor="middle" fill="#64748B">${type}</text>`;
      }
      return `
        <svg class="tile-svg" viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg" aria-label="${name}">
          <rect x="2" y="2" width="56" height="76" rx="8" ry="8" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1.5"/>
          <rect x="5" y="5" width="50" height="70" rx="6" ry="6" fill="#FFFBEB" opacity="0.6"/>
          <text x="7" y="15" font-size="8" opacity="0.7">🍰</text>
          ${art}
          <text x="30" y="71" font-family="-apple-system, BlinkMacSystemFont, 'Noto Sans TC', sans-serif" font-size="7.5" font-weight="700" text-anchor="middle" fill="#64748B">${name}</text>
        </svg>
      `;
    }

    // 2. 科技主題
    if (theme === 'tech') {
      switch (type) {
        case 'T_ATOM': art = `<circle cx="30" cy="40" r="5" fill="#38BDF8"/><ellipse cx="30" cy="40" rx="16" ry="6" stroke="#0284C7" stroke-width="1.8" fill="none" transform="rotate(30 30 40)"/><ellipse cx="30" cy="40" rx="16" ry="6" stroke="#0284C7" stroke-width="1.8" fill="none" transform="rotate(-30 30 40)"/><circle cx="42" cy="33" r="2" fill="#F43F5E"/><circle cx="18" cy="47" r="2" fill="#FBBF24"/>`; break;
        case 'T_BOLT': art = `<polygon points="32,18 18,38 28,38 24,60 42,34 32,34" fill="#FBBF24" stroke="#D97706" stroke-width="1.5"/>`; break;
        case 'T_ORBIT': art = `<circle cx="30" cy="40" r="12" fill="#F59E0B"/><ellipse cx="30" cy="40" rx="20" ry="6" stroke="#38BDF8" stroke-width="2.5" fill="none" transform="rotate(-20 30 40)"/>`; break;
        case 'T_CHIP': art = `<rect x="18" y="28" width="24" height="24" rx="3" fill="#0F172A" stroke="#38BDF8" stroke-width="2"/><rect x="24" y="34" width="12" height="12" rx="1" fill="#38BDF8"/><line x1="14" y1="34" x2="18" y2="34" stroke="#38BDF8" stroke-width="2"/><line x1="14" y1="46" x2="18" y2="46" stroke="#38BDF8" stroke-width="2"/><line x1="42" y1="34" x2="46" y2="34" stroke="#38BDF8" stroke-width="2"/><line x1="42" y1="46" x2="46" y2="46" stroke="#38BDF8" stroke-width="2"/>`; break;
        case 'T_GEAR': art = `<circle cx="30" cy="40" r="14" fill="#64748B"/><circle cx="30" cy="40" r="6" fill="#F8FAFC"/><rect x="27" y="20" width="6" height="40" rx="1" fill="#64748B"/><rect x="27" y="20" width="6" height="40" rx="1" fill="#64748B" transform="rotate(45 30 40)"/><rect x="27" y="20" width="6" height="40" rx="1" fill="#64748B" transform="rotate(90 30 40)"/><rect x="27" y="20" width="6" height="40" rx="1" fill="#64748B" transform="rotate(135 30 40)"/>`; break;
        case 'T_SHIELD': art = `<path d="M30 20 L44 26 C44 44 30 58 30 58 C30 58 16 44 16 26 Z" fill="#3B82F6" stroke="#1D4ED8" stroke-width="2"/><path d="M30 26 L38 30 C38 42 30 50 30 50 Z" fill="#93C5FD"/>`; break;
        case 'T_KEY': art = `<circle cx="24" cy="32" r="9" fill="none" stroke="#F59E0B" stroke-width="3"/><rect x="31" y="30" width="16" height="4" fill="#F59E0B"/><rect x="41" y="34" width="3" height="6" fill="#F59E0B"/><rect x="45" y="34" width="3" height="4" fill="#F59E0B"/>`; break;
        case 'T_GLOBE': art = `<circle cx="30" cy="40" r="16" fill="#0EA5E9"/><ellipse cx="30" cy="40" rx="8" ry="16" stroke="#FFFFFF" stroke-width="1.2" fill="none"/><line x1="14" y1="40" x2="46" y2="40" stroke="#FFFFFF" stroke-width="1.2"/><line x1="18" y1="30" x2="42" y2="30" stroke="#FFFFFF" stroke-width="1"/><line x1="18" y1="50" x2="42" y2="50" stroke="#FFFFFF" stroke-width="1"/>`; break;
        case 'T_ROCKET': art = `<path d="M30 18 C36 28 38 44 36 50 L24 50 C22 44 24 28 30 18 Z" fill="#EF4444"/><circle cx="30" cy="32" r="4" fill="#38BDF8"/><polygon points="24,42 16,52 24,50" fill="#64748B"/><polygon points="36,42 44,52 36,50" fill="#64748B"/><polygon points="27,50 30,62 33,50" fill="#F59E0B"/>`; break;
        case 'T_SAT': art = `<rect x="25" y="35" width="10" height="10" fill="#E2E8F0" stroke="#64748B" stroke-width="1.5"/><rect x="10" y="37" width="12" height="6" fill="#0284C7"/><rect x="38" y="37" width="12" height="6" fill="#0284C7"/><circle cx="30" cy="28" r="3" fill="#EF4444"/><line x1="30" y1="31" x2="30" y2="35" stroke="#64748B" stroke-width="1.5"/>`; break;
        case 'T_UFO': art = `<ellipse cx="30" cy="34" rx="10" ry="8" fill="#38BDF8"/><ellipse cx="30" cy="42" rx="20" ry="7" fill="#64748B"/><circle cx="20" cy="43" r="2" fill="#FBBF24"/><circle cx="30" cy="44" r="2" fill="#FBBF24"/><circle cx="40" cy="43" r="2" fill="#FBBF24"/>`; break;
        case 'T_BATTERY': art = `<rect x="20" y="24" width="20" height="34" rx="3" fill="#0F172A" stroke="#10B981" stroke-width="2"/><rect x="27" y="20" width="6" height="4" rx="1" fill="#10B981"/><rect x="24" y="38" width="12" height="16" rx="1" fill="#10B981"/>`; break;
        case 'T_RADAR': art = `<circle cx="30" cy="40" r="16" fill="#0F172A" stroke="#10B981" stroke-width="1.5"/><circle cx="30" cy="40" r="10" stroke="#10B981" stroke-width="1" fill="none" opacity="0.6"/><circle cx="30" cy="40" r="4" stroke="#10B981" stroke-width="1" fill="none" opacity="0.6"/><line x1="30" y1="40" x2="42" y2="28" stroke="#34D399" stroke-width="2"/>`; break;
        case 'T_DNA': art = `<path d="M22 22 Q30 32 38 42 Q30 52 22 62" stroke="#EC4899" stroke-width="3" fill="none"/><path d="M38 22 Q30 32 22 42 Q30 52 38 62" stroke="#38BDF8" stroke-width="3" fill="none"/><line x1="26" y1="28" x2="34" y2="28" stroke="#FBBF24" stroke-width="2"/><line x1="26" y1="56" x2="34" y2="56" stroke="#10B981" stroke-width="2"/>`; break;
        case 'T_COMPASS': art = `<circle cx="30" cy="40" r="16" fill="#1E293B" stroke="#F59E0B" stroke-width="2"/><polygon points="30,26 34,40 30,37" fill="#EF4444"/><polygon points="30,54 34,40 30,37" fill="#E2E8F0"/><polygon points="30,26 26,40 30,37" fill="#DC2626"/><polygon points="30,54 26,40 30,37" fill="#CBD5E1"/>`; break;
        case 'T_MAGNET': art = `<path d="M18 48 L18 32 C18 22 42 22 42 32 L42 48" stroke="#EF4444" stroke-width="8" fill="none"/><rect x="14" y="44" width="8" height="6" fill="#3B82F6"/><rect x="38" y="44" width="8" height="6" fill="#3B82F6"/>`; break;
        case 'T_BULB': art = `<path d="M22 36 C20 28 40 28 38 36 C36 42 34 44 34 48 L26 48 C26 44 24 42 22 36 Z" fill="#FBBF24"/><rect x="27" y="49" width="6" height="5" rx="1" fill="#64748B"/><line x1="30" y1="20" x2="30" y2="24" stroke="#F59E0B" stroke-width="2"/>`; break;
        case 'T_TARGET': art = `<circle cx="30" cy="40" r="16" stroke="#EF4444" stroke-width="2" fill="none"/><circle cx="30" cy="40" r="10" stroke="#EF4444" stroke-width="2" fill="none"/><circle cx="30" cy="40" r="3" fill="#EF4444"/><line x1="30" y1="20" x2="30" y2="60" stroke="#EF4444" stroke-width="1.5"/><line x1="10" y1="40" x2="50" y2="40" stroke="#EF4444" stroke-width="1.5"/>`; break;
        case 'T_CUBE': art = `<polygon points="30,22 46,30 30,38 14,30" fill="#38BDF8"/><polygon points="14,30 30,38 30,56 14,48" fill="#0284C7"/><polygon points="46,30 30,38 30,56 46,48" fill="#0369A1"/>`; break;
        case 'T_HOLE': art = `<circle cx="30" cy="40" r="16" fill="#0F172A"/><ellipse cx="30" cy="40" rx="16" ry="7" stroke="#A855F7" stroke-width="2.5" fill="none" transform="rotate(-15 30 40)"/><circle cx="30" cy="40" r="6" fill="#581C87"/>`; break;
        case 'T_METEOR': art = `<circle cx="38" cy="28" r="8" fill="#F97316"/><polygon points="38,20 16,56 30,36" fill="#FBBF24" opacity="0.8"/><circle cx="36" cy="26" r="2" fill="#FEF08A"/>`; break;
        case 'T_FLARE': art = `<circle cx="30" cy="40" r="10" fill="#F59E0B"/><line x1="30" y1="18" x2="30" y2="24" stroke="#EF4444" stroke-width="3" stroke-linecap="round"/><line x1="30" y1="56" x2="30" y2="62" stroke="#EF4444" stroke-width="3" stroke-linecap="round"/><line x1="8" y1="40" x2="14" y2="40" stroke="#EF4444" stroke-width="3" stroke-linecap="round"/><line x1="46" y1="40" x2="52" y2="40" stroke="#EF4444" stroke-width="3" stroke-linecap="round"/>`; break;
        case 'T_DIAMOND': art = `<polygon points="30,22 46,34 30,58 14,34" fill="#22D3EE" stroke="#0891B2" stroke-width="1.5"/><polygon points="30,22 46,34 30,34" fill="#A5F3FC"/><polygon points="30,34 14,34 30,58" fill="#06B6D4"/>`; break;
        case 'T_PRISM': art = `<polygon points="30,20 46,54 14,54" fill="none" stroke="#FFFFFF" stroke-width="2"/><line x1="10" y1="40" x2="25" y2="38" stroke="#FFFFFF" stroke-width="2"/><line x1="35" y1="42" x2="52" y2="36" stroke="#EF4444" stroke-width="1.5"/><line x1="35" y1="42" x2="52" y2="42" stroke="#10B981" stroke-width="1.5"/><line x1="35" y1="42" x2="52" y2="48" stroke="#3B82F6" stroke-width="1.5"/>`; break;
        case 'T_AI': art = `<rect x="18" y="24" width="24" height="24" rx="4" fill="#6366F1"/><circle cx="25" cy="32" r="2.5" fill="#FFFFFF"/><circle cx="35" cy="32" r="2.5" fill="#FFFFFF"/><path d="M25 40 Q30 44 35 40" stroke="#FFFFFF" stroke-width="2" fill="none"/><line x1="30" y1="18" x2="30" y2="24" stroke="#6366F1" stroke-width="2"/><circle cx="30" cy="16" r="2" fill="#F43F5E"/>`; break;
        default: art = `<text x="30" y="46" font-size="14" text-anchor="middle" fill="#64748B">${type}</text>`;
      }
      return `
        <svg class="tile-svg" viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg" aria-label="${name}">
          <rect x="2" y="2" width="56" height="76" rx="8" ry="8" fill="#0F172A" stroke="#38BDF8" stroke-width="1.5"/>
          <rect x="5" y="5" width="50" height="70" rx="6" ry="6" fill="#1E293B" opacity="0.8"/>
          <text x="7" y="15" font-size="8" opacity="0.7">⚡</text>
          ${art}
          <text x="30" y="71" font-family="-apple-system, BlinkMacSystemFont, 'Noto Sans TC', sans-serif" font-size="7.5" font-weight="700" text-anchor="middle" fill="#94A3B8">${name}</text>
        </svg>
      `;
    }

    // 3. 魔法藥水主題
    if (theme === 'potion') {
      switch (type) {
        case 'P_HP': art = getPotionBottleSVG('#EF4444'); break;
        case 'P_MANA': art = getPotionBottleSVG('#3B82F6'); break;
        case 'P_POISON': art = getPotionBottleSVG('#10B981'); break;
        case 'P_RAGE': art = getPotionBottleSVG('#A855F7'); break;
        case 'P_HOLY': art = getPotionBottleSVG('#FACC15', '#F59E0B'); break;
        case 'P_INVIS': art = getPotionBottleSVG('#E0E7FF', '#6366F1'); break;
        case 'P_LAVA': art = getPotionBottleSVG('#F97316'); break;
        case 'P_FROST': art = getPotionBottleSVG('#38BDF8'); break;
        case 'P_LIGHTNING': art = getPotionBottleSVG('#FBBF24') + `<polygon points="30,42 27,50 31,50 29,56 34,48 30,48" fill="#FFFFFF"/>`; break;
        case 'P_CURSE': art = getPotionBottleSVG('#1E1B4B', '#4338CA'); break;
        case 'P_DREAM': art = getPotionBottleSVG('#4C1D95'); break;
        case 'P_SUN': art = getPotionBottleSVG('#F59E0B'); break;
        case 'P_NATURE': art = getPotionBottleSVG('#059669'); break;
        case 'P_FLASK': art = `<rect x="26" y="18" width="8" height="5" fill="#78350F"/><rect x="28" y="23" width="4" height="10" fill="#CBD5E1"/><circle cx="30" cy="46" r="14" fill="#E2E8F0" stroke="#94A3B8" stroke-width="1.5"/><circle cx="30" cy="46" r="12" fill="#8B5CF6"/><circle cx="26" cy="42" r="2" fill="#FFFFFF" opacity="0.7"/>`; break;
        case 'P_DISTILL': art = `<ellipse cx="30" cy="48" rx="14" ry="10" fill="#F43F5E"/><path d="M30 20 L30 38" stroke="#94A3B8" stroke-width="3"/><circle cx="30" cy="20" r="3" fill="#D97706"/>`; break;
        case 'P_SCROLL': art = `<rect x="18" y="24" width="24" height="32" rx="2" fill="#FEF3C7" stroke="#D97706" stroke-width="1.5"/><line x1="22" y1="32" x2="38" y2="32" stroke="#B45309" stroke-width="1.5"/><line x1="22" y1="40" x2="38" y2="40" stroke="#B45309" stroke-width="1.5"/><line x1="22" y1="48" x2="32" y2="48" stroke="#B45309" stroke-width="1.5"/><circle cx="35" cy="48" r="3" fill="#DC2626"/>`; break;
        case 'P_ORB': art = `<ellipse cx="30" cy="56" rx="12" ry="5" fill="#78350F"/><circle cx="30" cy="38" r="14" fill="#C084FC" stroke="#9333EA" stroke-width="2"/><circle cx="26" cy="33" r="3" fill="#FFFFFF" opacity="0.8"/>`; break;
        case 'P_CANDLE': art = `<rect x="22" y="34" width="16" height="24" rx="2" fill="#F1F5F9"/><line x1="30" y1="34" x2="30" y2="28" stroke="#1E293B" stroke-width="1.5"/><path d="M30 20 Q34 26 30 28 Q26 26 30 20 Z" fill="#F59E0B"/>`; break;
        case 'P_KEY': art = `<circle cx="24" cy="32" r="8" fill="none" stroke="#E2E8F0" stroke-width="3"/><rect x="30" y="30" width="16" height="4" fill="#E2E8F0"/><rect x="40" y="34" width="3" height="6" fill="#E2E8F0"/>`; break;
        case 'P_WAND': art = `<line x1="16" y1="58" x2="40" y2="24" stroke="#78350F" stroke-width="3" stroke-linecap="round"/><polygon points="40,24 44,18 42,26 48,24 42,28 46,34 38,30" fill="#FACC15"/>`; break;
        case 'P_FEATHER': art = `<path d="M18 58 Q34 40 42 20 Q36 34 30 44 Q36 40 22 56" fill="#EF4444" stroke="#DC2626" stroke-width="1.5"/>`; break;
        case 'P_BLOOD': art = `<path d="M30 20 C20 36 18 48 30 58 C42 48 40 36 30 20 Z" fill="#DC2626"/><circle cx="26" cy="46" r="3" fill="#FEF2F2" opacity="0.6"/>`; break;
        case 'P_MUSHROOM': art = `<ellipse cx="30" cy="36" rx="16" ry="12" fill="#E11D48"/><rect x="26" y="38" width="8" height="18" rx="3" fill="#FEF3C7"/><circle cx="22" cy="32" r="2.5" fill="#FFFFFF"/><circle cx="34" cy="30" r="2.5" fill="#FFFFFF"/><circle cx="30" cy="40" r="2" fill="#FFFFFF"/>`; break;
        case 'P_STARDUST': art = `<rect x="22" y="28" width="16" height="26" rx="4" fill="#FEF08A" stroke="#F59E0B" stroke-width="2"/><polygon points="30,34 32,38 36,38 33,41 34,45 30,42 26,45 27,41 24,38 28,38" fill="#F59E0B"/>`; break;
        case 'P_EYE': art = `<path d="M14 40 Q30 24 46 40 Q30 56 14 40 Z" fill="#FFFFFF" stroke="#6366F1" stroke-width="2"/><circle cx="30" cy="40" r="7" fill="#4F46E5"/><circle cx="30" cy="40" r="3" fill="#0F172A"/>`; break;
        default: art = `<text x="30" y="46" font-size="14" text-anchor="middle" fill="#64748B">${type}</text>`;
      }
      return `
        <svg class="tile-svg" viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg" aria-label="${name}">
          <rect x="2" y="2" width="56" height="76" rx="8" ry="8" fill="#18181B" stroke="#A855F7" stroke-width="1.5"/>
          <rect x="5" y="5" width="50" height="70" rx="6" ry="6" fill="#27272A" opacity="0.8"/>
          <text x="7" y="15" font-size="8" opacity="0.7">🧪</text>
          ${art}
          <text x="30" y="71" font-family="-apple-system, BlinkMacSystemFont, 'Noto Sans TC', sans-serif" font-size="7.5" font-weight="700" text-anchor="middle" fill="#D4D4D8">${name}</text>
        </svg>
      `;
    }
  }

  // ==========================================
  // 3. 盤面生成與死局判定 (Generator)
  // ==========================================
  function createEmptyGrid(paddedRows, paddedCols) {
    const grid = [];
    for (let r = 0; r < paddedRows; r++) {
      const row = [];
      for (let c = 0; c < paddedCols; c++) {
        row.push(null);
      }
      grid.push(row);
    }
    return grid;
  }

  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  function findAnyMove(grid, rows, cols, paddedRows, paddedCols) {
    const tilePositions = new Map();
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        const type = grid[r][c];
        if (type && type !== '__HOLE__') {
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
          const path = findPath(grid, p1.r, p1.c, p2.r, p2.c, paddedRows, paddedCols);
          if (path) {
            return { p1, p2, path, type };
          }
        }
      }
    }
    return null;
  }

  function generateBoard(rows, cols, theme) {
    const paddedRows = rows + 2;
    const paddedCols = cols + 2;
    const themeInfo = THEME_DATA[theme] || THEME_DATA.dessert;
    const types = [...themeInfo.types];

    // 總牌數計算
    let totalSlots = rows * cols;
    let hasCenterHole = false;

    // 若為 5x5 (奇數格)，中央 (3,3) 為裝飾空位，可用牌數為 24 格 (12 對)
    if (rows === 5 && cols === 5) {
      totalSlots = 24;
      hasCenterHole = true;
    }

    const pairCount = totalSlots / 2;
    const maxAttempts = 100;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const grid = createEmptyGrid(paddedRows, paddedCols);
      if (hasCenterHole) {
        grid[3][3] = null; // 中央為天然通路
      }

      // 產生成對卡牌池
      const pool = [];
      shuffleArray(types);

      // 選取 pairCount 組花色
      let tIdx = 0;
      for (let p = 0; p < pairCount; p++) {
        const type = types[tIdx % types.length];
        pool.push(type, type);
        if (p % 2 === 1) tIdx++;
      }
      shuffleArray(pool);

      let idx = 0;
      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= cols; c++) {
          if (hasCenterHole && r === 3 && c === 3) {
            continue;
          }
          grid[r][c] = pool[idx++];
        }
      }

      if (findAnyMove(grid, rows, cols, paddedRows, paddedCols) !== null) {
        return grid;
      }
    }

    // Fallback
    const grid = createEmptyGrid(paddedRows, paddedCols);
    if (hasCenterHole) grid[3][3] = null;
    const pool = [];
    for (let p = 0; p < pairCount; p++) {
      const type = types[p % types.length];
      pool.push(type, type);
    }
    shuffleArray(pool);
    let idx = 0;
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        if (hasCenterHole && r === 3 && c === 3) continue;
        grid[r][c] = pool[idx++];
      }
    }
    return grid;
  }

  function shuffleRemainingTiles(grid, rows, cols, paddedRows, paddedCols) {
    const remainingCoords = [];
    const remainingTiles = [];

    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
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

      for (let i = 0; i < remainingCoords.length; i++) {
        const { r, c } = remainingCoords[i];
        grid[r][c] = remainingTiles[i];
      }

      if (findAnyMove(grid, rows, cols, paddedRows, paddedCols) !== null) {
        return true;
      }
    }
    return false;
  }

  // ==========================================
  // 4. Web Audio 原生音效合成 (Audio)
  // ==========================================
  class SoundEffects {
    constructor() {
      this.ctx = null;
      this.muted = localStorage.getItem('shisen_sound_muted') === 'true';
      this.comboFreqs = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50, 1174.66, 1318.51];
    }

    initContext() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.ctx = new AudioCtx();
        }
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    }

    setMuted(muted) {
      this.muted = !!muted;
      localStorage.setItem('shisen_sound_muted', this.muted ? 'true' : 'false');
    }

    isMuted() {
      return this.muted;
    }

    playClick() {
      if (this.muted) return;
      this.initContext();
      if (!this.ctx) return;

      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, t);
      osc.frequency.exponentialRampToValueAtTime(200, t + 0.05);

      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(t);
      osc.stop(t + 0.05);
    }

    playMatch(combo = 1) {
      if (this.muted) return;
      this.initContext();
      if (!this.ctx) return;

      const t = this.ctx.currentTime;
      const idx = Math.min((combo - 1) % this.comboFreqs.length, this.comboFreqs.length - 1);
      const baseFreq = this.comboFreqs[idx];

      const osc1 = this.ctx.createOscillator();
      const gain1 = this.ctx.createGain();
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(baseFreq, t);

      gain1.gain.setValueAtTime(0.3, t);
      gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.28);

      osc1.connect(gain1);
      gain1.connect(this.ctx.destination);
      osc1.start(t);
      osc1.stop(t + 0.28);

      const osc2 = this.ctx.createOscillator();
      const gain2 = this.ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(baseFreq * 2, t);

      gain2.gain.setValueAtTime(0.12, t);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

      osc2.connect(gain2);
      gain2.connect(this.ctx.destination);
      osc2.start(t);
      osc2.stop(t + 0.35);
    }

    playMismatch() {
      if (this.muted) return;
      this.initContext();
      if (!this.ctx) return;

      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, t);
      osc.frequency.exponentialRampToValueAtTime(110, t + 0.12);

      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(t);
      osc.stop(t + 0.12);
    }

    playHint() {
      if (this.muted) return;
      this.initContext();
      if (!this.ctx) return;

      const t = this.ctx.currentTime;
      const notes = [659.25, 880.00, 1046.50];
      notes.forEach((freq, i) => {
        const startTime = t + i * 0.06;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startTime);

        gain.gain.setValueAtTime(0.18, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.2);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + 0.2);
      });
    }

    playShuffle() {
      if (this.muted) return;
      this.initContext();
      if (!this.ctx) return;

      const t = this.ctx.currentTime;
      for (let i = 0; i < 8; i++) {
        const startTime = t + i * 0.035;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(400 + Math.random() * 300, startTime);

        gain.gain.setValueAtTime(0.15, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.04);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + 0.04);
      }
    }

    playVictory() {
      if (this.muted) return;
      this.initContext();
      if (!this.ctx) return;

      const t = this.ctx.currentTime;
      const chord = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50];
      chord.forEach((freq, i) => {
        const startTime = t + i * 0.09;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = i === chord.length - 1 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, startTime);

        const duration = i === chord.length - 1 ? 0.8 : 0.4;
        gain.gain.setValueAtTime(0.25, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + duration);
      });
    }
  }

  const sound = new SoundEffects();

  // ==========================================
  // 5. 畫面渲染與 Canvas 軌跡動畫 (Renderer)
  // ==========================================
  class GameRenderer {
    constructor(boardElement, canvasElement) {
      this.boardEl = boardElement;
      this.canvasEl = canvasElement;
      this.ctx = canvasElement.getContext('2d');

      this.particles = [];
      this.activeLines = [];
      this.animationFrameId = null;

      this.tileElements = new Map();
      this.currentRows = 5;
      this.currentCols = 5;
      this.currentTheme = 'dessert';

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
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
      };

      if (window.ResizeObserver) {
        this.resizeObserver = new ResizeObserver(() => updateCanvasSize());
        this.resizeObserver.observe(this.boardEl);
      }
      window.addEventListener('resize', updateCanvasSize);
      updateCanvasSize();
    }

    renderGrid(grid, rows, cols, theme, onTileClick) {
      this.currentRows = rows;
      this.currentCols = cols;
      this.currentTheme = theme;
      this.boardEl.innerHTML = '';
      this.tileElements.clear();

      // 動態調整網格行列
      this.boardEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      this.boardEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      this.boardEl.dataset.size = `${cols}x${rows}`;

      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= cols; c++) {
          const type = grid[r][c];
          const cell = document.createElement('div');
          cell.className = 'tile-slot';
          cell.dataset.row = r;
          cell.dataset.col = c;

          if (rows === 5 && cols === 5 && r === 3 && c === 3) {
            cell.classList.add('center-hole-slot');
            cell.innerHTML = `<div class="center-star">⭐</div>`;
          } else if (type) {
            const tile = document.createElement('button');
            tile.className = 'mahjong-tile';
            tile.dataset.row = r;
            tile.dataset.col = c;
            tile.dataset.type = type;
            tile.innerHTML = getTileSVG(theme, type);

            tile.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              onTileClick(r, c);
            });

            cell.appendChild(tile);
            this.tileElements.set(`${r},${c}`, tile);
          }

          this.boardEl.appendChild(cell);
        }
      }
    }

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

    clearAllSelected() {
      this.tileElements.forEach((el) => {
        el.classList.remove('tile-selected');
      });
    }

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

    getCanvasPoint(r, c) {
      const boardRect = this.boardEl.getBoundingClientRect();
      const cellW = boardRect.width / this.currentCols;
      const cellH = boardRect.height / this.currentRows;

      let x = 0;
      let y = 0;

      if (c >= 1 && c <= this.currentCols) {
        x = (c - 1 + 0.5) * cellW;
      } else if (c === 0) {
        x = -cellW * 0.4;
      } else if (c === this.currentCols + 1) {
        x = boardRect.width + cellW * 0.4;
      }

      if (r >= 1 && r <= this.currentRows) {
        y = (r - 1 + 0.5) * cellH;
      } else if (r === 0) {
        y = -cellH * 0.4;
      } else if (r === this.currentRows + 1) {
        y = boardRect.height + cellH * 0.4;
      }

      return { x, y };
    }

    animateConnection(path) {
      if (!path || path.length < 2) return;

      const points = path.map((pt) => this.getCanvasPoint(pt.r, pt.c));
      this.activeLines.push({
        points,
        opacity: 1.0,
        createdAt: performance.now(),
        duration: 380
      });

      this.spawnParticles(points[0].x, points[0].y);
      this.spawnParticles(points[points.length - 1].x, points[points.length - 1].y);
    }

    spawnParticles(x, y) {
      const colors = ['#FB7185', '#F43F5E', '#FBBF24', '#38BDF8', '#34D399', '#A855F7'];
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

        this.ctx.strokeStyle = `rgba(244, 63, 94, ${alpha * 0.6})`;
        this.ctx.lineWidth = 10;
        this.ctx.shadowColor = '#F43F5E';
        this.ctx.shadowBlur = 16;

        this.ctx.beginPath();
        this.ctx.moveTo(line.points[0].x, line.points[0].y);
        for (let p = 1; p < line.points.length; p++) {
          this.ctx.lineTo(line.points[p].x, line.points[p].y);
        }
        this.ctx.stroke();

        this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.95})`;
        this.ctx.lineWidth = 3.5;
        this.ctx.shadowBlur = 0;
        this.ctx.stroke();

        this.ctx.restore();
      }

      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05;
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
  }

  // ==========================================
  // 6. 遊戲主控制器 (Game Controller)
  // ==========================================
  class MahjongGame {
    constructor() {
      this.currentSize = localStorage.getItem('shisen_grid_size') || '5x5'; // '5x5' or '10x5'
      this.currentTheme = localStorage.getItem('shisen_theme') || 'dessert'; // 'dessert', 'tech', 'potion'

      this.rows = 5;
      this.cols = 5;
      this.updateDimensions();

      this.grid = null;
      this.selected = null;
      this.pairsLeft = 12;
      this.score = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.comboTimeout = null;

      this.timerSeconds = 0;
      this.timerInterval = null;
      this.isPlaying = false;

      this.hintsLeft = 3;
      this.shufflesLeft = 3;

      // DOM 元素
      this.boardEl = document.getElementById('game-board');
      this.canvasEl = document.getElementById('trail-canvas');
      this.scoreEl = document.getElementById('stat-score');
      this.timerEl = document.getElementById('stat-time');
      this.pairsEl = document.getElementById('stat-pairs');
      this.comboEl = document.getElementById('stat-combo');
      this.comboBadgeEl = document.getElementById('combo-badge');
      this.bestScoreEl = document.getElementById('stat-best');

      this.btnNewGame = document.getElementById('btn-new-game');
      this.btnRestart = document.getElementById('btn-restart');
      this.btnHint = document.getElementById('btn-hint');
      this.btnShuffle = document.getElementById('btn-shuffle');
      this.btnMute = document.getElementById('btn-mute');

      this.selectSize = document.getElementById('select-size');
      this.selectTheme = document.getElementById('select-theme');

      this.hintCountEl = document.getElementById('hint-count');
      this.shuffleCountEl = document.getElementById('shuffle-count');

      this.modalWin = document.getElementById('modal-win');
      this.winScoreEl = document.getElementById('win-score');
      this.winTimeEl = document.getElementById('win-time');
      this.winComboEl = document.getElementById('win-combo');
      this.btnPlayAgain = document.getElementById('btn-play-again');

      this.toastEl = document.getElementById('game-toast');

      this.renderer = new GameRenderer(this.boardEl, this.canvasEl);

      this.bindEvents();
      this.loadBestScore();
      this.updateMuteButtonUI();
      this.applyThemeStyle();
      this.startNewGame();
    }

    updateDimensions() {
      if (this.currentSize === '10x5') {
        this.rows = 5;
        this.cols = 10;
      } else {
        this.rows = 5;
        this.cols = 5;
      }
    }

    applyThemeStyle() {
      document.body.className = `theme-${this.currentTheme}`;
      if (this.selectTheme) this.selectTheme.value = this.currentTheme;
      if (this.selectSize) this.selectSize.value = this.currentSize;
    }

    bindEvents() {
      this.btnNewGame.addEventListener('click', () => this.startNewGame());
      this.btnRestart.addEventListener('click', () => this.startNewGame());

      this.btnHint.addEventListener('click', () => this.triggerHint());
      this.btnShuffle.addEventListener('click', () => this.triggerManualShuffle());

      this.btnMute.addEventListener('click', () => {
        sound.setMuted(!sound.isMuted());
        this.updateMuteButtonUI();
      });

      this.selectSize.addEventListener('change', (e) => {
        this.currentSize = e.target.value;
        localStorage.setItem('shisen_grid_size', this.currentSize);
        this.updateDimensions();
        this.startNewGame();
      });

      this.selectTheme.addEventListener('change', (e) => {
        this.currentTheme = e.target.value;
        localStorage.setItem('shisen_theme', this.currentTheme);
        this.applyThemeStyle();
        this.startNewGame();
      });

      this.btnPlayAgain.addEventListener('click', () => {
        this.modalWin.classList.remove('modal-visible');
        this.startNewGame();
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.mahjong-tile') && !e.target.closest('.action-btn') && !e.target.closest('.custom-select')) {
          if (this.selected) {
            this.renderer.setSelected(this.selected.r, this.selected.c, false);
            this.selected = null;
          }
        }
      });
    }

    updateMuteButtonUI() {
      if (sound.isMuted()) {
        this.btnMute.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <line x1="23" y1="9" x2="17" y2="15"></line>
            <line x1="17" y1="9" x2="23" y2="15"></line>
          </svg>
          <span>靜音</span>
        `;
        this.btnMute.classList.add('btn-active');
      } else {
        this.btnMute.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
          </svg>
          <span>音效</span>
        `;
        this.btnMute.classList.remove('btn-active');
      }
    }

    loadBestScore() {
      const key = `shisen_best_${this.currentSize}`;
      const best = localStorage.getItem(key) || 0;
      this.bestScoreEl.textContent = Number(best).toLocaleString();
    }

    startTimer() {
      this.stopTimer();
      this.timerSeconds = 0;
      this.updateTimerDisplay();
      this.timerInterval = setInterval(() => {
        this.timerSeconds++;
        this.updateTimerDisplay();
      }, 1000);
    }

    stopTimer() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
    }

    updateTimerDisplay() {
      const mins = Math.floor(this.timerSeconds / 60).toString().padStart(2, '0');
      const secs = (this.timerSeconds % 60).toString().padStart(2, '0');
      this.timerEl.textContent = `${mins}:${secs}`;
    }

    startNewGame() {
      this.stopTimer();
      this.clearCombo();
      this.loadBestScore();

      this.grid = generateBoard(this.rows, this.cols, this.currentTheme);
      this.selected = null;

      if (this.rows === 5 && this.cols === 5) {
        this.pairsLeft = 12; // 24 格 = 12 對
      } else {
        this.pairsLeft = (this.rows * this.cols) / 2; // 50 格 = 25 對
      }

      this.score = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.hintsLeft = 3;
      this.shufflesLeft = 3;
      this.isPlaying = true;

      this.updateStatsUI();
      this.renderer.renderGrid(this.grid, this.rows, this.cols, this.currentTheme, (r, c) => this.handleTileClick(r, c));
      this.startTimer();

      const themeName = THEME_DATA[this.currentTheme]?.name || '';
      this.showToast(`🎮 ${themeName} [${this.cols}×${this.rows}] 開始！`, 1800);
    }

    updateStatsUI() {
      this.scoreEl.textContent = this.score.toLocaleString();
      this.pairsEl.textContent = this.pairsLeft;
      this.comboEl.textContent = this.combo;
      this.hintCountEl.textContent = this.hintsLeft;
      this.shuffleCountEl.textContent = this.shufflesLeft;

      if (this.combo > 1) {
        this.comboBadgeEl.classList.add('combo-active');
        this.comboBadgeEl.textContent = `${this.combo} 連擊！+${(this.combo - 1) * 50}`;
      } else {
        this.comboBadgeEl.classList.remove('combo-active');
      }
    }

    handleTileClick(r, c) {
      if (!this.isPlaying) return;
      const tileType = this.grid[r][c];
      if (!tileType) return;

      sound.playClick();

      if (!this.selected) {
        this.selected = { r, c };
        this.renderer.setSelected(r, c, true);
        return;
      }

      if (this.selected.r === r && this.selected.c === c) {
        this.renderer.setSelected(r, c, false);
        this.selected = null;
        return;
      }

      const prevR = this.selected.r;
      const prevC = this.selected.c;

      if (this.grid[prevR][prevC] !== tileType) {
        sound.playMismatch();
        this.renderer.setSelected(prevR, prevC, false);
        this.selected = { r, c };
        this.renderer.setSelected(r, c, true);
        return;
      }

      const path = findPath(this.grid, prevR, prevC, r, c, this.rows + 2, this.cols + 2);
      if (path) {
        this.renderer.setSelected(prevR, prevC, false);
        this.selected = null;

        this.grid[prevR][prevC] = null;
        this.grid[r][c] = null;

        this.renderer.animateConnection(path);
        this.renderer.removeTile(prevR, prevC);
        this.renderer.removeTile(r, c);

        this.registerMatch();
      } else {
        sound.playMismatch();
        this.renderer.setSelected(prevR, prevC, false);
        this.selected = { r, c };
        this.renderer.setSelected(r, c, true);
      }
    }

    registerMatch() {
      this.pairsLeft--;
      this.combo++;
      if (this.combo > this.maxCombo) {
        this.maxCombo = this.combo;
      }

      const matchPoints = 100 + (this.combo - 1) * 50;
      this.score += matchPoints;

      sound.playMatch(this.combo);
      this.updateStatsUI();

      if (this.comboTimeout) clearTimeout(this.comboTimeout);
      this.comboTimeout = setTimeout(() => {
        this.clearCombo();
      }, 3200);

      if (this.pairsLeft === 0) {
        this.handleVictory();
      } else {
        this.checkAndAutoShuffle();
      }
    }

    clearCombo() {
      this.combo = 0;
      if (this.comboTimeout) clearTimeout(this.comboTimeout);
      this.updateStatsUI();
    }

    checkAndAutoShuffle() {
      const move = findAnyMove(this.grid, this.rows, this.cols, this.rows + 2, this.cols + 2);
      if (!move) {
        this.showToast('⚠️ 無路可消，正在為您自動重洗盤面...', 2000);
        sound.playShuffle();
        setTimeout(() => {
          const ok = shuffleRemainingTiles(this.grid, this.rows, this.cols, this.rows + 2, this.cols + 2);
          if (ok) {
            this.renderer.renderGrid(this.grid, this.rows, this.cols, this.currentTheme, (r, c) => this.handleTileClick(r, c));
            this.showToast('✨ 盤面重洗完成，繼續挑戰！', 1600);
          }
        }, 500);
      }
    }

    triggerHint() {
      if (!this.isPlaying) return;
      if (this.hintsLeft <= 0) {
        this.showToast('💡 提示次數已用盡！', 1600);
        return;
      }

      const move = findAnyMove(this.grid, this.rows, this.cols, this.rows + 2, this.cols + 2);
      if (move) {
        this.hintsLeft--;
        this.updateStatsUI();
        sound.playHint();

        this.renderer.setHint(move.p1, move.p2, true);
        this.renderer.animateConnection(move.path);

        setTimeout(() => {
          this.renderer.setHint(move.p1, move.p2, false);
        }, 1600);
      } else {
        this.showToast('盤面無解，正在自動洗牌...', 1500);
        this.checkAndAutoShuffle();
      }
    }

    triggerManualShuffle() {
      if (!this.isPlaying) return;
      if (this.shufflesLeft <= 0) {
        this.showToast('🔀 洗牌次數已用盡！', 1600);
        return;
      }

      this.shufflesLeft--;
      this.updateStatsUI();
      sound.playShuffle();

      if (this.selected) {
        this.renderer.setSelected(this.selected.r, this.selected.c, false);
        this.selected = null;
      }

      shuffleRemainingTiles(this.grid, this.rows, this.cols, this.rows + 2, this.cols + 2);
      this.renderer.renderGrid(this.grid, this.rows, this.cols, this.currentTheme, (r, c) => this.handleTileClick(r, c));
      this.showToast('🔀 盤面已手動重洗！', 1500);
    }

    handleVictory() {
      this.isPlaying = false;
      this.stopTimer();
      sound.playVictory();

      const key = `shisen_best_${this.currentSize}`;
      const currentBest = parseInt(localStorage.getItem(key) || '0', 10);
      if (this.score > currentBest) {
        localStorage.setItem(key, this.score.toString());
        this.loadBestScore();
      }

      const mins = Math.floor(this.timerSeconds / 60).toString().padStart(2, '0');
      const secs = (this.timerSeconds % 60).toString().padStart(2, '0');
      this.winTimeEl.textContent = `${mins}:${secs}`;
      this.winScoreEl.textContent = this.score.toLocaleString();
      this.winComboEl.textContent = `${this.maxCombo} 連擊`;

      setTimeout(() => {
        this.modalWin.classList.add('modal-visible');
      }, 400);
    }

    showToast(msg, duration = 2000) {
      if (!this.toastEl) return;
      this.toastEl.textContent = msg;
      this.toastEl.classList.add('toast-visible');
      setTimeout(() => {
        this.toastEl.classList.remove('toast-visible');
      }, duration);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.game = new MahjongGame();
    });
  } else {
    window.game = new MahjongGame();
  }
})();
