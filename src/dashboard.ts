/** Minimal self-contained HTML dashboard that polls GET /stats. */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ClaudeCode_router</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem;
         background: #0f1115; color: #e6e6e6; }
  h1 { font-size: 1.2rem; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
  .card { background: #1a1d24; border: 1px solid #2a2f3a; border-radius: 8px;
          padding: 1rem 1.25rem; min-width: 9rem; }
  .card .label { color: #8a90a0; font-size: .75rem; text-transform: uppercase; }
  .card .value { font-size: 1.5rem; margin-top: .25rem; }
  .save { color: #4ade80; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: right; padding: .5rem .75rem; border-bottom: 1px solid #2a2f3a; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #8a90a0; font-weight: normal; font-size: .8rem; }
  .muted { color: #8a90a0; font-size: .8rem; }
</style>
</head>
<body>
<h1>ClaudeCode_router &mdash; cost dashboard</h1>
<div class="cards">
  <div class="card"><div class="label">Requests</div><div class="value" id="reqs">-</div></div>
  <div class="card"><div class="label">Spent</div><div class="value" id="cost">-</div></div>
  <div class="card"><div class="label">Baseline (Sonnet)</div><div class="value" id="base">-</div></div>
  <div class="card"><div class="label">Saved</div><div class="value save" id="save">-</div></div>
  <div class="card"><div class="label">Uptime</div><div class="value" id="up">-</div></div>
</div>
<table>
  <thead><tr><th>Provider</th><th>Requests</th><th>Input tok</th><th>Output tok</th><th>Cost</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<p class="muted">Auto-refreshes every 3s. Costs use the rates in config.json.</p>
<script>
  const usd = (n) => "$" + (n ?? 0).toFixed(4);
  async function refresh() {
    try {
      const s = await (await fetch("/stats")).json();
      document.getElementById("reqs").textContent = s.totalRequests;
      document.getElementById("cost").textContent = usd(s.totals.costUsd);
      document.getElementById("base").textContent = usd(s.totals.baselineCostUsd);
      document.getElementById("save").textContent =
        usd(s.totals.savingsUsd) + " (" + s.totals.savingsPct + "%)";
      document.getElementById("up").textContent = s.uptimeSec + "s";
      document.getElementById("rows").innerHTML = s.providers.map((p) =>
        "<tr><td>" + p.name + "</td><td>" + p.requests + "</td><td>" +
        p.inputTokens + "</td><td>" + p.outputTokens + "</td><td>" +
        usd(p.costUsd) + "</td></tr>").join("");
    } catch (e) { /* keep last view */ }
  }
  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>`;
}
