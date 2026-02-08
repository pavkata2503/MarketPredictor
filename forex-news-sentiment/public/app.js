async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
  });
}

function renderHeadlines(el, items) {
  el.innerHTML = "";
  if (!items?.length) {
    el.innerHTML = `<div class="meta">No headlines returned.</div>`;
    return;
  }
  for (const it of items) {
    const date = it.seendate ? new Date(it.seendate).toLocaleString() : "";
    const meta = [it.domain, it.sourceCountry, it.language, date].filter(Boolean).join(" • ");
    const a = document.createElement("a");
    a.href = it.url || "#";
    a.target = "_blank";
    a.rel = "noreferrer";
    a.innerHTML = `${esc(it.title)}<span class="meta">${esc(meta)}</span>`;
    el.appendChild(a);
  }
}

function setPill(pill, decision) {
  pill.textContent = decision;
  // minimal styling without assuming colors convey correctness
  pill.style.borderColor = "#263247";
}

async function main() {
  const pairSel = document.getElementById("pair");
  const timespanSel = document.getElementById("timespan");
  const runBtn = document.getElementById("run");
  const status = document.getElementById("status");

  const result = document.getElementById("result");
  const decisionPill = document.getElementById("decisionPill");
  const metrics = document.getElementById("metrics");
  const summary = document.getElementById("summary");
  const baseHeadlines = document.getElementById("baseHeadlines");
  const quoteHeadlines = document.getElementById("quoteHeadlines");
  const baseTitle = document.getElementById("baseTitle");
  const quoteTitle = document.getElementById("quoteTitle");

  // Load pairs
  status.textContent = "Loading pairs…";
  const pairs = await getJson("/api/pairs");
  for (const p of pairs.pairs) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    pairSel.appendChild(opt);
  }
  status.textContent = "";

  runBtn.addEventListener("click", async () => {
    try {
      result.classList.add("hidden");
      status.textContent = "Fetching headlines + analyzing sentiment…";

      const pair = pairSel.value;
      const timespan = timespanSel.value;

      const data = await getJson(`/api/analyze?pair=${encodeURIComponent(pair)}&timespan=${encodeURIComponent(timespan)}`);

      setPill(decisionPill, data.decisionLabel);

      const s = data.sentiment;
      metrics.textContent =
        `Base ${s.base} avg: ${s.baseAvg.toFixed(2)} • Quote ${s.quote} avg: ${s.quoteAvg.toFixed(2)} • Spread: ${s.spread.toFixed(2)} • Timespan: ${data.timespan}`;

      summary.textContent = data.summary;

      // show why explanation under summary
const whyElId = "why";
let whyEl = document.getElementById(whyElId);
if (!whyEl) {
  whyEl = document.createElement("p");
  whyEl.id = whyElId;
  whyEl.className = "summary";
  summary.insertAdjacentElement("afterend", whyEl);
}
whyEl.textContent = data.why || "";


      baseTitle.textContent = `Base headlines (${s.base})`;
      quoteTitle.textContent = `Quote headlines (${s.quote})`;

      renderHeadlines(baseHeadlines, data.headlines.base);
      renderHeadlines(quoteHeadlines, data.headlines.quote);

      status.textContent = "";
      result.classList.remove("hidden");
    } catch (e) {
      status.textContent = `Error: ${e.message}`;
    }
  });
}

main().catch((e) => {
  const status = document.getElementById("status");
  status.textContent = `Init error: ${e.message}`;
});
