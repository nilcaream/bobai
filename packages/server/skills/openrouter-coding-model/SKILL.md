---
name: openrouter-coding-model
description: >-
  Find the best bang-for-the-buck coding model on OpenRouter right now, including
  currently-discounted models, and warn when a previously-recommended discount has
  ended or Bob AI's cached pricing has gone stale. Uses the public OpenRouter models
  API plus a scrape of the discount page, and persists a rolling snapshot via the
  memory tool for timing-aware drift detection. Triggers on "best coding model",
  "best model for today", "which model should I use", "good coding model",
  "openrouter discount", "discounted models", "is my model still discounted",
  "check model pricing", "recheck pricing", "best bang for buck",
  "cheap coding model", "coding model for today".
---

# OpenRouter Coding Model Picker

Pick the best coding model to use **right now**, weighing price against coding
quality, with special attention to **transient discounts** that can end at any
time. Persist a rolling snapshot in memory so a later run can detect when a
discount ended or pricing drifted.

## Output contract

Produce exactly this shape — a single primary answer plus the timing caveats:

```
**Use:** <model> — coding <N>, $<in>/M in / $<out>/M out.
**Opportunity (transient):** <model> — <N>% off, coding <N>, $<in>/M in / $<out>/M out.
**Since your last check:** <drift or "no change">
```

- **Use** = the steady best-value pick (does not depend on a discount).
- **Opportunity** = a strong coder that is only cheap *because* of a discount —
  worth trying while it lasts, but not safe to assume long-term.
- If there is no discounted opportunity, omit that line and say "no discounts today".

## Step 1 — Read the previous snapshot

```
memory search "openrouter-coding-model-pick"
```

If an entry exists, read its content. You will diff against it in Step 5.
This is the entire mechanism for the timing guard: the snapshot records what
was recommended *and at what discount*, so the next run can detect a change.

## Step 2 — Fetch live data

```bash
curl -sS "https://openrouter.ai/api/v1/models" -o .tmp-openrouter-models.json
curl -sS "https://openrouter.ai/models?discount=true" -o .tmp-openrouter-discount.html
```

Facts about the sources:

- `/api/v1/models` is public, no auth, ~5 min Cloudflare cache (`max-age=300`).
  It carries `pricing` (per-token USD, already reflecting any discount) and
  `benchmarks.artificial_analysis.coding_index` (0–100) per model.
- **Discounts are NOT in the API.** They live only in the page's server-rendered
  flight stream as `pricing.discount` (e.g. `0.75` = 75% off). That is why the
  page is scraped. If the scrape finds no `discount` fields, degrade gracefully
  (report the value pick and say "discount status unconfirmed today").
- `:batch` variants are async queue jobs (not interactive) and `:free` variants
  are rate-limited — both are excluded from the pick.

## Step 3 — Compute picks

Write and run this script (uses the two temp files from Step 2):

```bash
cat > .tmp-or-pick.mjs <<'EOF'
import fs from "node:fs";

const models = JSON.parse(fs.readFileSync(".tmp-openrouter-models.json", "utf8")).data;
const html = fs.readFileSync(".tmp-openrouter-discount.html", "utf8");

// Discount overlay: {slug -> discount rate} from the page's flight stream.
const discounts = new Map();
let idx = 0;
while ((idx = html.indexOf("model_variant_slug", idx + 1)) !== -1) {
  const win = html.slice(idx, idx + 5000);
  const slug = win.match(/model_variant_slug\\":\\"([^\\"]+)/)?.[1];
  const disc = win.match(/discount\\":([0-9.]+)/)?.[1];
  if (slug && disc && disc !== "0") discounts.set(slug, Number(disc));
}

const M = 1_000_000;
const interactive = (id) => !id.endsWith(":free") && !id.endsWith(":batch");

const rows = [];
for (const m of models) {
  const coding = m.benchmarks?.artificial_analysis?.coding_index;
  if (typeof coding !== "number") continue;
  const inM = Number(m.pricing.prompt) * M;
  const outM = Number(m.pricing.completion) * M;
  const blended = 0.7 * inM + 0.3 * outM; // assume ~70/30 input/output for a coding agent
  rows.push({
    id: m.id,
    coding,
    inM,
    outM,
    value: blended > 0 ? coding / blended : Infinity,
    discount: discounts.get(m.id) ?? 0,
  });
}

const fmt = (p) => "$" + p.toFixed(3);
const candidates = rows
  .filter((r) => interactive(r.id) && r.coding >= 60)
  .sort((a, b) => b.value - a.value);
const discounted = rows
  .filter((r) => interactive(r.id) && r.discount > 0)
  .sort((a, b) => b.coding - a.coding);

console.log("TOP_VALUE");
for (const r of candidates.slice(0, 5)) {
  console.log(`${r.id} coding=${r.coding} ${fmt(r.inM)}/${fmt(r.outM)} per M value=${r.value.toFixed(0)}${r.discount ? " discount=" + r.discount : ""}`);
}
console.log("DISCOUNTED");
if (discounted.length === 0) console.log("(none)");
for (const r of discounted) {
  console.log(`${r.id} coding=${r.coding} ${fmt(r.inM)}/${fmt(r.outM)} per M discount=${r.discount}`);
}
EOF
node .tmp-or-pick.mjs
```

Rules embedded above (tunable, but document any change to the user):

- Candidate pool: interactive models with `coding_index >= 60`.
- `value = coding_index / (0.7·input + 0.3·output)` per M tokens.
- Winner = highest value. Discounted models are surfaced separately.

## Step 4 — Decide the answer

- **Use** = the `TOP_VALUE` winner.
- **Opportunity** = the highest-`coding` entry in `DISCOUNTED`, but only if its
  coding index is competitive with (within ~10 points of) the winner's. If the
  discounted model is clearly weaker, say "no worthwhile discount today" instead
  of hyping it.

## Step 5 — Diff against the previous snapshot

Compare today's result with the stored memory. Flag loudly when:

- The previously recommended **Opportunity** model's discount dropped to 0
  (promo ended) — warn the user they may now be paying full price.
- The **Use** winner changed since the last check.
- Prices moved materially (> ~10%).

Also cross-check `~/.config/bobai/models.json` (its `generatedAt` and the
per-model `inputPrice`/`outputPrice`). If it is older than a few days or the
prices disagree with live OpenRouter, say the catalog is stale and suggest
`bobai refresh` so Bob AI's own cost estimates stay honest.

## Step 6 — Save the snapshot

Upsert a memory (the tool overwrites by title, so this stays a single rolling
entry):

- `title`: `openrouter-coding-model-pick`
- `type`: `project`
- `description`: one-line summary, e.g. "Use <winner>; opportunity <model> at N% off (checked <date>)"
- `content`: a JSON snapshot:

```json
{
  "checkedAt": "<ISO-8601 UTC>",
  "winner": { "modelId": "...", "codingIndex": 0, "inputPricePerM": 0, "outputPricePerM": 0, "discount": 0 },
  "opportunity": { "modelId": "...", "codingIndex": 0, "inputPricePerM": 0, "outputPricePerM": 0, "discount": 0.75 }
}
```

## Failure handling

| Situation | Action |
|-----------|--------|
| Discount scrape finds no `discount` fields | Report value pick; say "discount status unconfirmed today" |
| `/api/v1/models` fetch fails | Check provider status first; report the failure honestly |
| No models pass the `coding_index >= 60` gate | Lower the gate to 50 and say so |
| Memory tool unavailable | Skip persistence; note the snapshot could not be saved |

## Cleanup

Remove the temp files when done: `.tmp-openrouter-models.json`,
`.tmp-openrouter-discount.html`, `.tmp-or-pick.mjs`.
