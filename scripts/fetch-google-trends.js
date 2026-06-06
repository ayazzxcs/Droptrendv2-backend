// DropTrend Google Trends RSS matcher
// Replaces fragile Playwright Google Trends Explore scraping.
// It fetches Google Daily Trending Searches RSS feeds and matches those topics
// against CJ product keywords. Output stays compatible: google-trends.json

import { readJson, writeJson, extractKeywords, sleep } from "./utils.js";

const products = readJson("products.json", []);
const limit = Number(process.env.GOOGLE_TRENDS_LIMIT || 120);
const keywords = extractKeywords(products, limit);

const GEOS = String(process.env.GOOGLE_TRENDS_GEOS || "US,IN,GB")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

writeJson("trend-keywords.json", keywords);

const STOP_WORDS = new Set([
  "new", "hot", "sale", "fashion", "style", "quality", "good", "latest",
  "product", "products", "dropshipping", "wholesale", "supplier",
  "solid", "color", "colors", "mini", "large", "small", "piece", "pieces",
  "set", "sets", "with", "for", "and", "the", "this", "that",
  "2024", "2025", "2026", "plus", "size", "best", "high"
]);

const CATEGORY_EXPANSIONS = {
  sofa: ["furniture", "home", "living room", "couch", "sectional"],
  chair: ["furniture", "home", "dining", "office chair"],
  table: ["furniture", "home", "coffee table", "dining table"],
  storage: ["home organization", "organizer", "storage", "home storage"],
  organizer: ["home organization", "storage", "organizer"],
  kitchen: ["kitchen", "home", "cooking", "kitchen storage"],
  dress: ["fashion", "women fashion", "summer fashion", "dress"],
  pants: ["fashion", "wide leg pants", "trousers", "jeans"],
  jeans: ["fashion", "denim", "jeans"],
  sandals: ["sandals", "summer fashion", "women sandals", "shoes"],
  slippers: ["slippers", "shoes", "footwear"],
  shoes: ["shoes", "footwear", "sneakers"],
  pet: ["pet", "dog", "cat", "pet care", "pet supplies"],
  dog: ["dog", "pet", "pet care", "dog toys"],
  cat: ["cat", "pet", "cat toys", "pet supplies"],
  bracelet: ["jewelry", "bracelet", "fashion accessories"],
  ring: ["jewelry", "ring", "fashion accessories"],
  necklace: ["jewelry", "necklace", "fashion accessories"],
  watch: ["watch", "fashion accessories", "smart watch"],
  bag: ["bag", "handbag", "fashion accessories"],
  lamp: ["lamp", "lighting", "home decor"],
  toy: ["toy", "kids toys", "pet toys"],
  makeup: ["makeup", "beauty", "cosmetics"],
  skincare: ["skincare", "beauty", "skin care"],
  phone: ["phone accessories", "mobile accessories", "smartphone"],
  car: ["car accessories", "auto accessories", "vehicle"],
  baby: ["baby products", "baby care", "kids"],
  fitness: ["fitness", "gym", "workout"],
  bottle: ["water bottle", "bottle", "kitchen"],
  shower: ["bathroom", "shower", "home improvement"],
  mat: ["mat", "floor mat", "yoga mat", "pet mat"],
  blanket: ["blanket", "home", "bedding"],
  jacket: ["jacket", "fashion", "outerwear"],
  hoodie: ["hoodie", "fashion", "sweatshirt"],
  cap: ["cap", "hat", "fashion accessories"],
  hat: ["hat", "cap", "fashion accessories"],
  shelf: ["shelf", "storage", "home organization"],
  rack: ["rack", "storage", "home organization"]
};

function cleanText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, " and ")
    .replace(/&quot;/g, " ")
    .replace(/&#39;/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return cleanText(text)
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function keywordVariants(keyword) {
  const words = tokens(keyword);
  if (!words.length) return [];

  const variants = new Set([
    words.join(" "),
    words.slice(0, 3).join(" "),
    words.slice(0, 2).join(" "),
    words.slice(-2).join(" "),
    words[0],
    words[words.length - 1]
  ].filter(Boolean));

  for (const w of words) {
    if (CATEGORY_EXPANSIONS[w]) {
      for (const v of CATEGORY_EXPANSIONS[w]) variants.add(v);
    }
  }

  return [...variants].filter(v => v.length >= 3).slice(0, 12);
}

function escapeXml(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractTagBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks = [];
  let m;
  while ((m = re.exec(xml))) blocks.push(m[1]);
  return blocks;
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? escapeXml(m[1].replace(/<!\\[CDATA\\[|\\]\\]>/g, "").trim()) : "";
}

function extractApproxTraffic(text) {
  const cleaned = String(text || "").replace(/,/g, "");
  const m = cleaned.match(/(\d+(\.\d+)?)\s*(k|m|million|thousand)?/i);
  if (!m) return 0;
  let n = Number(m[1]);
  const suffix = (m[3] || "").toLowerCase();
  if (suffix === "k" || suffix === "thousand") n *= 1000;
  if (suffix === "m" || suffix === "million") n *= 1000000;
  return Math.round(n);
}

async function fetchRss(geo) {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 DropTrendBot/1.0",
      "Accept": "application/rss+xml,text/xml,application/xml"
    }
  });

  if (!res.ok) throw new Error(`Google Trends RSS ${geo} HTTP ${res.status}`);
  const xml = await res.text();

  const items = extractTagBlocks(xml, "item");
  return items.map((item, index) => {
    const title = extractTag(item, "title");
    const description = extractTag(item, "description");
    const traffic = extractTag(item, "ht:approx_traffic") || extractTag(item, "approx_traffic");
    const newsTitles = extractTagBlocks(item, "ht:news_item_title").map(x => escapeXml(x));
    const relatedQueries = extractTagBlocks(item, "ht:news_item_snippet").map(x => escapeXml(x));
    const text = [title, description, traffic, ...newsTitles, ...relatedQueries].join(" ");

    return {
      geo,
      rank: index + 1,
      title,
      description,
      approxTrafficText: traffic,
      approxTraffic: extractApproxTraffic(traffic),
      text,
      source: "google-trends-rss"
    };
  });
}

function matchScore(keyword, topic) {
  const variants = keywordVariants(keyword);
  const topicText = cleanText(topic.text);
  const topicTokens = new Set(tokens(topic.text));

  let best = 0;
  let bestVariant = "";

  for (const variant of variants) {
    const vTokens = tokens(variant);
    if (!vTokens.length) continue;

    const phraseHit = topicText.includes(cleanText(variant));
    const hits = vTokens.filter(t => topicTokens.has(t)).length;
    const ratio = hits / vTokens.length;

    let score = 0;
    if (phraseHit) score += 70;
    score += Math.round(ratio * 55);

    // Broad category match should be useful but not too strong.
    if (vTokens.length === 1 && hits) score = Math.max(score, 45);

    // More traffic + higher rank = stronger trend signal.
    const trafficBoost = Math.min(20, Math.log10((topic.approxTraffic || 0) + 1) * 4);
    const rankBoost = Math.max(0, 15 - topic.rank);

    score += Math.round(trafficBoost + rankBoost);
    score = Math.min(100, score);

    if (score > best) {
      best = score;
      bestVariant = variant;
    }
  }

  return {
    score: best,
    matchedVariant: bestVariant
  };
}

const topics = [];
for (const geo of GEOS) {
  try {
    console.log(`Fetching Google Trends RSS for ${geo}...`);
    const geoTopics = await fetchRss(geo);
    console.log(`Loaded ${geoTopics.length} Google RSS topics for ${geo}.`);
    topics.push(...geoTopics);
    await sleep(500);
  } catch (err) {
    console.log(`Google Trends RSS failed for ${geo}: ${err.message}`);
  }
}

const signals = [];

for (const item of keywords) {
  const keyword = item.keyword;
  let bestTopic = null;
  let bestMatch = { score: 0, matchedVariant: "" };

  for (const topic of topics) {
    const score = matchScore(keyword, topic);
    if (score.score > bestMatch.score) {
      bestMatch = score;
      bestTopic = topic;
    }
  }

  if (bestTopic && bestMatch.score >= 45) {
    const rawScore = bestMatch.score;
    const trafficBoost = Math.min(25, Math.log10((bestTopic.approxTraffic || 0) + 1) * 5);
    const googleTrendScore = Math.round(Math.min(100, Math.max(rawScore, rawScore + trafficBoost)));

    signals.push({
      keyword,
      usedKeyword: bestMatch.matchedVariant,
      topic: bestTopic.title,
      geo: bestTopic.geo,
      rank: bestTopic.rank,
      approxTraffic: bestTopic.approxTraffic,
      approxTrafficText: bestTopic.approxTrafficText,
      score: googleTrendScore,
      rawScore,
      growthPercent: 100,
      match: 1,
      source: "google-trends-rss",
      fetchedAt: new Date().toISOString()
    });

    console.log(`Google RSS match: ${keyword} -> ${bestTopic.title} (${bestTopic.geo}) score ${googleTrendScore}`);
  }
}

signals.sort((a, b) => b.score - a.score);

writeJson("google-trends.json", signals);
writeJson("google-trends-meta.json", {
  updatedAt: new Date().toISOString(),
  source: "google-trends-rss",
  geos: GEOS,
  attemptedKeywordCount: keywords.length,
  topicCount: topics.length,
  savedSignalCount: signals.length,
  note: "Matches CJ product keywords against Google Daily Trending Searches RSS topics. This is more stable than Playwright Google Trends Explore scraping."
});

console.log(`Saved ${signals.length} Google Trends RSS signals from ${keywords.length} attempted keywords and ${topics.length} RSS topics.`);
