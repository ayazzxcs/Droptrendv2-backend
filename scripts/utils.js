import fs from "fs";

export function readJson(path, fallback = []) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
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
  "new","2026","2025","2024","for","with","and","the","hot","sale","style",
  "wholesale","supplier","cross","border","dropshipping","product","products",
  "high","quality","good","latest","best","top","trending","viral","free",
  "piece","pieces","set","sets","pack","pcs","lot","bulk","use","using"
]);

const INTENT_MODIFIERS = new Set([
  "men","mens","male","man","women","womens","woman","female","ladies","girl","girls","boy","boys","kids","baby",
  "summer","winter","spring","autumn","portable","foldable","waterproof","wireless","rechargeable","electric","smart",
  "led","usb","silicone","leather","cotton","metal","wood","wooden","iron","steel","plastic","glass",
  "mini","large","small","adjustable","automatic","multifunctional","dog","cat","pet","car","kitchen","bathroom","office","home","garden","outdoor","travel","camping"
]);

const CORE_PRODUCT_TERMS = new Set([
  "shirt","shirts","tshirt","tshirts","dress","dresses","pants","jeans","shorts","jacket","hoodie","coat","suit","suits","blazer","top","tops",
  "sandals","slippers","shoes","sneakers","boots","bag","bags","backpack","wallet","watch","watches",
  "ring","rings","bracelet","bracelets","necklace","earrings","jewelry",
  "sofa","chair","table","desk","lamp","light","lights","shelf","rack","storage","organizer","cabinet","drawer","mat","rug","blanket","pillow","cover","curtain",
  "bottle","cup","mug","cooker","pan","knife","tool","tools","brush","roller","massager","mirror","comb",
  "toy","toys","bed","beds","case","holder","stand","charger","cable","camera","speaker","headphones","earbuds",
  "makeup","skincare","cream","serum","mask","shower","faucet","filter","pump","sprayer","collar","leash","harness","bowl","feeder","litter","cage"
]);

function normalizeToken(token) {
  const t = String(token || "").toLowerCase();
  const map = {
    mens:"men", man:"men", male:"men",
    womens:"women", woman:"women", female:"women", ladies:"women",
    tshirts:"tshirt", dresses:"dress", watches:"watch", bracelets:"bracelet",
    rings:"ring", bags:"bag", toys:"toy", beds:"bed", lights:"light", wooden:"wood"
  };
  return map[t] || t;
}

export function tokenizeProductText(text) {
  const s = cleanProductName(text).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  return s.split(/\s+/).map(normalizeToken).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function unique(list) {
  return [...new Set(list.filter(Boolean).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function makeKeyword(text) {
  const words = tokenizeProductText(text);
  return words.slice(0, 4).join(" ").trim();
}

export function makeSpecificKeywords(text, category = "") {
  const words = tokenizeProductText(`${category} ${text}`);
  const productWords = words.filter(w => CORE_PRODUCT_TERMS.has(w));
  const modifierWords = words.filter(w => INTENT_MODIFIERS.has(w));
  const keywords = [];

  for (const mod of modifierWords) {
    for (const core of productWords) {
      if (mod !== core) keywords.push(`${mod} ${core}`);
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    keywords.push(`${words[i]} ${words[i + 1]}`);
  }

  for (let i = 0; i < words.length - 2; i++) {
    const phrase = words.slice(i, i + 3).join(" ");
    if (phrase.length >= 8) keywords.push(phrase);
  }

  const full = words.slice(0, 4).join(" ");
  if (full) keywords.push(full);

  for (const core of productWords) keywords.push(core);

  return unique(keywords)
    .filter(k => k.length >= 4)
    .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)
    .slice(0, 10);
}

export function extractKeywords(products, limit = 120) {
  const counts = new Map();

  for (const p of products) {
    const rawName = p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "";
    const category = p.category || p.categoryName || p.raw?.categoryName || "";
    const candidates = [
      ...makeSpecificKeywords(rawName, category),
      ...makeSpecificKeywords(category, rawName)
    ];

    for (const kw of candidates) {
      if (!kw || kw.length < 4) continue;
      const wordCount = kw.split(/\s+/).length;
      const weight = wordCount >= 3 ? 5 : wordCount === 2 ? 3 : 1;
      counts.set(kw, (counts.get(kw) || 0) + weight);
    }
  }

  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1] || b[0].split(/\s+/).length - a[0].split(/\s+/).length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}
