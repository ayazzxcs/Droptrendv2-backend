import fs from "fs";

export function readJson(path, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

export function num(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function cleanProductName(value) {
  let s = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value ?? "");
  s = s.trim();
  if ((s.startsWith("[") && s.endsWith("]")) || s.includes('","') || s.includes("','")) {
    try {
      const parsed = JSON.parse(s.replace(/'/g, '"'));
      if (Array.isArray(parsed)) s = parsed.filter(Boolean).join(" ");
    } catch {
      s = s.replace(/^\s*\[+/, "").replace(/\]+\s*$/, "").replace(/["']/g, "").replace(/,/g, " ");
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "new","2026","2025","2024","for","with","and","the","hot","sale","fashion","style",
  "men","mens","women","womens","woman","male","female","wholesale","supplier",
  "cross","border","dropshipping","product","products","high","quality","good",
  "summer","winter","spring","autumn","portable","multifunctional","solid","color","colors",
  "mini","large","small","piece","pieces","set","sets","plus","best","other","replacement",
  "parts","front","only","pickup"
]);

const PRODUCT_TERMS = new Set([
  "sofa","chair","table","storage","organizer","kitchen","dress","pants","jeans","sandals",
  "slippers","shoes","bracelet","necklace","watch","bag","lamp","toy","makeup","skincare",
  "phone","car","baby","fitness","bottle","shower","mat","blanket","jacket","hoodie","cap",
  "hat","shelf","rack","pet","dog","cat","ring","pillow","travel","office","home","beauty",
  "bathroom","bed","garden","outdoor","airplane","neck","purse","wallet","case","cover"
]);

export function normalizeKeyword(text) {
  return cleanProductName(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function cleanedWords(text) {
  return normalizeKeyword(text)
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

export function makeKeyword(text) {
  const words = cleanedWords(text);
  return words.slice(0, 4).join(" ").trim();
}

export function extractProductKeywords(product, maxKeywords = 8) {
  const rawName = product?.raw?.productNameEn || product?.productNameEn || product?.name || product?.productName || "";
  const category = product?.category || product?.categoryName || product?.raw?.categoryName || "";
  const existing = [
    ...(Array.isArray(product?.aiKeywords) ? product.aiKeywords : []),
    ...(Array.isArray(product?.specificKeywords) ? product.specificKeywords : [])
  ];

  const basePhrases = [
    rawName,
    category,
    `${category} ${rawName}`,
    ...existing
  ].map(cleanProductName).filter(Boolean);

  const collected = [];

  for (const phrase of basePhrases) {
    const words = cleanedWords(phrase);
    if (!words.length) continue;

    const joined = words.join(" ");
    if (joined) collected.push(joined);
    if (words.length >= 3) collected.push(words.slice(0, 3).join(" "));
    if (words.length >= 2) collected.push(words.slice(0, 2).join(" "));
    if (words.length >= 2) collected.push(words.slice(-2).join(" "));

    const importantWords = words.filter(w => PRODUCT_TERMS.has(w));
    if (importantWords.length >= 2) collected.push(importantWords.slice(0, 2).join(" "));
    if (importantWords.length >= 1) collected.push(importantWords[0]);
  }

  const scored = unique(collected)
    .map(keyword => {
      const words = keyword.split(/\s+/).filter(Boolean);
      const importantCount = words.filter(w => PRODUCT_TERMS.has(w)).length;
      const phraseBonus = words.length >= 2 && words.length <= 4 ? 3 : 0;
      const longPenalty = words.length > 5 ? -2 : 0;
      return {
        keyword,
        score: importantCount * 4 + phraseBonus + longPenalty + Math.min(3, words.length)
      };
    })
    .filter(item => item.keyword.length >= 3)
    .sort((a, b) => b.score - a.score || a.keyword.length - b.keyword.length || a.keyword.localeCompare(b.keyword))
    .slice(0, maxKeywords)
    .map(item => item.keyword);

  return scored;
}

export function extractKeywords(products, limit = 120) {
  const counts = new Map();

  for (const product of products) {
    for (const kw of extractProductKeywords(product, 8)) {
      counts.set(kw, (counts.get(kw) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}
