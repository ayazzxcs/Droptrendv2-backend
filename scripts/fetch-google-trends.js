import { chromium } from "playwright";
import { readJson, writeJson, extractKeywords, sleep } from "./utils.js";

const products = readJson("products.json", []);
const limit = Number(process.env.GOOGLE_TRENDS_LIMIT || 120);
const keywords = extractKeywords(products, limit);
writeJson("trend-keywords.json", keywords);

async function fetchTrendForKeyword(page, keyword) {
  const url = "https://trends.google.com/trends/explore?date=today%203-m&q=" + encodeURIComponent(keyword);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);

  const bodyText = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
  const hasData = !/not enough data|hmm, your search doesn't have enough data/i.test(bodyText);

  let growthPercent = 0;
  const match = bodyText.match(/(\+?\-?\d{1,4})%/);
  if (match) growthPercent = Number(match[1].replace("+", ""));

  const positiveGrowth = Math.max(0, growthPercent);
  const score = hasData ? Math.min(100, Math.max(35, 55 + Math.round(positiveGrowth / 4))) : 0;

  return {
    keyword,
    score,
    rawScore: score,
    growthPercent,
    match: hasData ? 1 : 0,
    source: "google-trends-playwright",
    fetchedAt: new Date().toISOString()
  };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1365, height: 768 },
  locale: "en-US",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
});
const page = await context.newPage();

const signals = [];
for (const item of keywords) {
  const keyword = item.keyword;
  try {
    console.log("Google Trends:", keyword);
    const signal = await fetchTrendForKeyword(page, keyword);
    if (signal.match) signals.push(signal);
    await sleep(1500 + Math.floor(Math.random() * 1500));
  } catch (err) {
    console.log("Google Trends failed for", keyword, "-", err.message);
  }
}

await browser.close();

writeJson("google-trends.json", signals);
console.log(`Saved ${signals.length} Google Trends signals from ${keywords.length} attempted keywords.`);
