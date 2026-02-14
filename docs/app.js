function money(n, currency = "CAD") {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}
function pct(n) { return `${Number(n).toFixed(2)}%`; }

async function loadData() {
  // cache-bust so Pages doesn't serve an old JSON
  const res = await fetch(`./data/latest.json?v=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load data: ${res.status}`);
  return res.json();
}

function renderRates(data) {
  const el = document.getElementById("rates");
  el.innerHTML = "";

  const items = [
    { title: "Prime (posted)", s: data.rates.prime },
    { title: "5Y Conventional (posted)", s: data.rates.mort5y },
    { title: "Overnight target", s: data.rates.overnight },
  ];

  for (const it of items) {
    const latest = it.s.latest?.value ?? null;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="k">${it.title}</div>
      <div class="v">${latest == null ? "—" : pct(latest)}</div>
      <div class="small">Series: ${it.s.seriesId}</div>
    `;
    el.appendChild(card);
  }
}

function applyFiltersAndRenderTable(data) {
  const minScore = Number(document.getElementById("minScore").value);
  const maxDom = Number(document.getElementById("maxDom").value);

  document.getElementById("minScoreLabel").textContent = String(minScore);
  document.getElementById("maxDomLabel").textContent = String(maxDom);

  const rowsEl = document.getElementById("rows");
  rowsEl.innerHTML = "";

  const deals = data.listings.filter(l => (l.dealScore ?? 0) >= minScore && l.dom <= maxDom);

  document.getElementById("count").textContent = String(deals.length);

  for (const l of deals) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${l.neighborhood}</td>
      <td>${l.beds}</td>
      <td>${l.sqft}</td>
      <td>${money(l.price, data.locale.currency)}</td>
      <td>${(l.pricePerSqft ?? 0).toFixed(1)}</td>
      <td>${(l.z ?? 0).toFixed(2)}</td>
      <td>${l.dom}</td>
      <td><b>${l.dealScore ?? 0}</b></td>
    `;
    rowsEl.appendChild(tr);
  }
}

(async function main() {
  try {
    const data = await loadData();
    document.getElementById("meta").innerHTML =
      `Data refreshed: <b>${new Date(data.generatedAt).toLocaleString()}</b>`;

    renderRates(data);
    applyFiltersAndRenderTable(data);

    document.getElementById("minScore").addEventListener("input", () => applyFiltersAndRenderTable(data));
    document.getElementById("maxDom").addEventListener("input", () => applyFiltersAndRenderTable(data));
  } catch (e) {
    document.getElementById("meta").textContent = `Error: ${e.message}`;
  }
})();
