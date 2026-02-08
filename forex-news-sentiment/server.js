import express from "express";
import dotenv from "dotenv";
import vader from "vader-sentiment";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const TOP_PAIRS = ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"];

const CURRENCY_PROFILES = {
  USD: { terms: ["USD", "dollar", "Fed", "FOMC", "Treasury"] },
  EUR: { terms: ["EUR", "euro", "ECB", "Eurozone", "European Central Bank"] },
  JPY: { terms: ["JPY", "yen", "BoJ", "Bank of Japan", "Tokyo"] },
  GBP: { terms: ["GBP", "pound", "sterling", "BoE", "Bank of England"] },
  AUD: { terms: ["AUD", "Aussie", "RBA", "Reserve Bank of Australia", "Australia"] },
  CAD: { terms: ["CAD", "loonie", "BoC", "Bank of Canada", "Canada"] },
  CHF: { terms: ["CHF", "franc", "SNB", "Swiss National Bank", "Switzerland"] },
  NZD: { terms: ["NZD", "kiwi", "RBNZ", "Reserve Bank of New Zealand", "New Zealand"] },
};

/**
 * High-impact keyword groups.
 * Ако заглавие съдържа такива думи, даваме по-голяма тежест.
 */
const HIGH_IMPACT_GROUPS = [
  { name: "Rates/Decision", weight: 2.6, terms: ["rate hike", "rate cut", "hold rates", "interest rates", "policy decision", "rate decision", "meeting", "statement"] },
  { name: "CPI/Inflation", weight: 2.3, terms: ["CPI", "inflation", "core inflation", "PCE", "prices", "consumer prices"] },
  { name: "Jobs/NFP", weight: 2.3, terms: ["NFP", "nonfarm", "payrolls", "jobs report", "unemployment", "jobless claims", "wage growth"] },
  { name: "GDP/Growth", weight: 2.1, terms: ["GDP", "growth", "recession", "contraction", "expansion"] },
  { name: "PMI/Activity", weight: 2.0, terms: ["PMI", "manufacturing", "services PMI", "ISM"] },
  { name: "Central Bank Speak", weight: 2.0, terms: ["Fed chair", "Powell", "ECB president", "Lagarde", "BoE governor", "BoJ governor", "RBA governor", "BoC governor", "speech", "testimony"] },
];

/**
 * Минимален econ филтър (къс, за да не се чупи GDELT).
 */
const ECON_TERMS = ["rates", "inflation", "GDP", "central bank"];

function buildGdeltUrl({ query, timespan = "24h", maxrecords = 30, sort = "datedesc" }) {
  const base = "https://api.gdeltproject.org/api/v2/doc/doc";
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    format: "json",
    timespan,
    maxrecords: String(maxrecords),
    sort,
  });
  return `${base}?${params.toString()}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function vaderCompound(text) {
  const r = vader.SentimentIntensityAnalyzer.polarity_scores(text);
  return typeof r?.compound === "number" ? r.compound : 0;
}

function pickTopHeadlines(articles, limit = 10) {
  return articles
    .filter((a) => a?.title)
    .slice(0, limit)
    .map((a) => ({
      title: a.title,
      url: a.url,
      sourceCountry: a.sourceCountry,
      language: a.language,
      seendate: a.seendate,
      domain: a.domain,
    }));
}

function decide(delta) {
  if (delta >= 0.12) return "BULLISH_BUY";
  if (delta <= -0.12) return "BEARISH_SELL";
  return "NEUTRAL";
}

function prettyDecisionLabel(decision) {
  if (decision === "BULLISH_BUY") return "Bullish (Buy)";
  if (decision === "BEARISH_SELL") return "Bearish (Sell)";
  return "Neutral";
}

function topGroups(hitCountsByGroup, limit = 2) {
  const entries = Object.entries(hitCountsByGroup || {});
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, limit).map(([name, count]) => `${name} (${count})`);
}

function shortWhy(base, quote, baseW, quoteW, delta, decision) {
  const baseTop = topGroups(baseW.hitCountsByGroup, 2);
  const quoteTop = topGroups(quoteW.hitCountsByGroup, 2);

  // 1–2 примера headlines (само заглавия) – взимаме най-влиятелните
  const pickTitle = (w) => (w.topInfluencers?.[0]?.title ? `“${w.topInfluencers[0].title}”` : null);

  const baseExample = pickTitle(baseW);
  const quoteExample = pickTitle(quoteW);

  const direction =
    decision === "BULLISH_BUY"
      ? `More positive (weighted) news for ${base} than ${quote}`
      : decision === "BEARISH_SELL"
      ? `More positive (weighted) news for ${quote} than ${base}`
      : `No clear advantage between ${base} and ${quote}`;

  // кратко, “защо”
  const parts = [];
  parts.push(`${direction}, based on high-impact macro headlines (spread ${delta.toFixed(2)}).`);

  // добавяме кои групи са най-чести
  if (baseTop.length || quoteTop.length) {
    parts.push(
      `Top drivers: ${base} → ${baseTop.join(", ") || "none"}, ${quote} → ${quoteTop.join(", ") || "none"}.`
    );
  }

  // добавяме 1 пример headline (ако има)
  const exParts = [];
  if (baseExample) exParts.push(`${base}: ${baseExample}`);
  if (quoteExample) exParts.push(`${quote}: ${quoteExample}`);
  if (exParts.length) parts.push(`Example: ${exParts.join(" | ")}.`);

  // максимум 2–3 изречения, четими
  return parts.slice(0, 3).join(" ");
}


function buildSummary(pair, base, quote, baseAvg, quoteAvg, delta, decision, baseHi, quoteHi) {
  const direction =
    decision === "BULLISH_BUY" ? "tilts bullish" : decision === "BEARISH_SELL" ? "tilts bearish" : "looks mixed/neutral";

  return `For ${pair}, weighted headline sentiment for ${base} is ${baseAvg.toFixed(2)} vs ${quote} at ${quoteAvg.toFixed(
    2
  )} (spread ${delta.toFixed(2)}), so the signal ${direction}. High-impact hits: ${base}=${baseHi}, ${quote}=${quoteHi}.`;
}

function quoteIfNeeded(term) {
  const t = String(term).trim();
  if (!t) return t;
  if (/[^\w]/.test(t)) return `"${t}"`;
  return t;
}

/**
 * Къс query, за да не го отхвърля GDELT.
 */
function makeCurrencyQuery(code) {
  const profile = CURRENCY_PROFILES[code];
  const terms = profile?.terms?.length ? profile.terms : [code];
  const left = terms.map(quoteIfNeeded).join(" OR ");
  const right = ECON_TERMS.map(quoteIfNeeded).join(" OR ");
  return `(${left}) AND (${right})`;
}

/**
 * Връща weight + кои групи са ударили.
 */
function weightForTitle(title) {
  const t = String(title || "").toLowerCase();
  let weight = 1.0;
  const hits = [];

  for (const g of HIGH_IMPACT_GROUPS) {
    for (const term of g.terms) {
      if (t.includes(term.toLowerCase())) {
        // взимаме max тежест от групите, за да не “експлодира”
        weight = Math.max(weight, g.weight);
        hits.push(g.name);
        break;
      }
    }
  }

  // уникални имена
  const uniqHits = [...new Set(hits)];
  return { weight, hits: uniqHits };
}

/**
 * Weighted average sentiment:
 * sum(score * weight) / sum(weight)
 */
function weightedSentiment(articles) {
  let wSum = 0;
  let swSum = 0;

  let highImpactCount = 0;
  const hitCountsByGroup = {};

  // пазим най-влиятелните заглавия (по weight), за “why”
  const topInfluencers = [];

  for (const a of articles) {
    const title = a?.title || "";
    const desc = a?.description || "";
    const text = `${title}. ${desc}`.trim();
    if (!text) continue;

    const score = vaderCompound(text);
    const { weight, hits } = weightForTitle(title);

    // топ заглавия по weight (и после по abs(score))
    topInfluencers.push({
      title,
      url: a?.url,
      weight,
      score,
      hits,
      seendate: a?.seendate,
      domain: a?.domain,
    });

    if (weight > 1) {
      highImpactCount += 1;
      for (const h of hits) {
        hitCountsByGroup[h] = (hitCountsByGroup[h] || 0) + 1;
      }
    }

    wSum += weight;
    swSum += score * weight;
  }

  const avg = wSum > 0 ? swSum / wSum : 0;

  // избираме топ 3 най-влиятелни (weight desc, после |score| desc)
  topInfluencers.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return Math.abs(b.score) - Math.abs(a.score);
  });

  return {
    avg: clamp(avg, -1, 1),
    highImpactCount,
    hitCountsByGroup,
    totalUsed: wSum > 0 ? Math.round(wSum * 100) / 100 : 0,
    topInfluencers: topInfluencers.slice(0, 3),
  };
}


async function fetchJsonWithTimeout(url, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });

    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 200);
      throw new Error(`GDELT HTTP ${res.status}: ${snippet}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      const snippet = text.slice(0, 200);
      throw new Error(`GDELT returned non-JSON (likely query rejected / rate limited). Snippet: ${snippet}`);
    }
  } finally {
    clearTimeout(t);
  }
}

async function fetchCurrencyNews(code, timespan) {
  const query = makeCurrencyQuery(code);
  const url = buildGdeltUrl({ query, timespan, maxrecords: 40, sort: "datedesc" });
  const json = await fetchJsonWithTimeout(url);

  if (json?.error) throw new Error(`GDELT error: ${json.error}`);

  const articles = Array.isArray(json?.articles) ? json.articles : [];
  return articles;
}

app.get("/api/pairs", (req, res) => {
  res.json({ pairs: TOP_PAIRS });
});

app.get("/api/analyze", async (req, res) => {
  try {
    const pairRaw = String(req.query.pair || "").toUpperCase().trim();
    const timespan = String(req.query.timespan || "24h").trim();

    if (!pairRaw || pairRaw.length !== 6) {
      return res.status(400).json({ error: "Provide pair like EURUSD" });
    }

    const base = pairRaw.slice(0, 3);
    const quote = pairRaw.slice(3, 6);

    if (!CURRENCY_PROFILES[base] || !CURRENCY_PROFILES[quote]) {
      return res.status(400).json({
        error: `Unsupported currency in pair. Supported: ${Object.keys(CURRENCY_PROFILES).join(", ")}`,
      });
    }

    const [baseArticles, quoteArticles] = await Promise.all([
      fetchCurrencyNews(base, timespan),
      fetchCurrencyNews(quote, timespan),
    ]);

    const baseW = weightedSentiment(baseArticles);
    const quoteW = weightedSentiment(quoteArticles);



    const baseAvg = baseW.avg;
    const quoteAvg = quoteW.avg;
    const delta = clamp(baseAvg - quoteAvg, -2, 2);

    const decision = decide(delta);
    const why = shortWhy(base, quote, baseW, quoteW, delta, decision);

    const summary = buildSummary(pairRaw, base, quote, baseAvg, quoteAvg, delta, decision, baseW.highImpactCount, quoteW.highImpactCount);

    res.json({
      pair: pairRaw,
      timespan,
      decision,
      decisionLabel: prettyDecisionLabel(decision),
      sentiment: {
        base,
        quote,
        baseAvg,
        quoteAvg,
        spread: delta,
        highImpact: {
          baseCount: baseW.highImpactCount,
          quoteCount: quoteW.highImpactCount,
          baseGroups: baseW.hitCountsByGroup,
          quoteGroups: quoteW.hitCountsByGroup,
        },
      },
      summary,
      why,
      headlines: {
        base: pickTopHeadlines(baseArticles, 10),
        quote: pickTopHeadlines(quoteArticles, 10),
      },
      notes: [
        "Weighted sentiment: headlines with high-impact macro terms are weighted more.",
        "Spread = base weighted sentiment minus quote weighted sentiment.",
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
});
