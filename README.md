# Lifecycle Ledger — PLC Dashboard

An installable dashboard for tracking **Product Life Cycle (PLC)** across a menu or product
portfolio. It classifies every SKU into a life-cycle stage, measures performance against a
sales target, and recommends an action plan for each stage.

Built as a **PWA** — install it on a phone or desktop and it runs in its own window with no
browser chrome, and works fully offline.

---

## Features

**Overview**
- KPI cards: total SKUs, total M3 sales with month-over-month delta, target achievement
- Portfolio mix bar showing the spread across all six life-cycle stages

**Table**
- Sort on any column, search by SKU or product name
- Filter by category (multi-select dropdown), by stage, and by M3 sales range
- Per-row sparkline of the M1 → M3 trend, coloured by stage
- Stage pill, target variance, and a contribution bar per row

**Editing**
- Add / edit / delete SKUs through a modal with a **live preview** — stage, variance and
  action plan recompute on every keystroke
- Create new categories inline; duplicate SKU codes are rejected
- Adjustable thresholds (growth %, decline %, introduction cut-off date) applied live

**Data**
- Upload a `.csv` or `.json` file to replace the whole dataset
- Every row is validated; invalid rows are skipped and reported rather than silently dropped
- Data is stored in `localStorage`, so edits survive a reload

---

## The PLC model

Stage is decided on **two dimensions** — monthly momentum *and* distance from target — so a
product that is growing fast but still far below target is not treated the same as one that is
genuinely ahead.

```
momentum  = (M3 − M2) / M2
gap       = (M1 + M2 + M3) − target
variance  = gap / target
```

| Stage | Condition | Action plan |
|---|---|---|
| **Introduction** | Launched after the cut-off date | Push awareness; track repeat-purchase rate before scaling spend |
| **Growth** | momentum > growth threshold **and** gap ≥ 0 | Expand distribution and lean into promotions — scale it |
| **Recovery** | momentum > growth threshold **but** gap < 0 | Do **not** re-run promos (margin risk); fix pricing or trim cost base |
| **Maturity** | momentum between the two thresholds | Cost control and retention over acquisition spend |
| **Saturation** | momentum < decline threshold **but** gap ≥ 0 | Slowed but target still covered — watch the trend, no budget cuts yet |
| **Decline** | momentum < decline threshold **and** gap < 0 | Cut marketing spend; bundle out or evaluate delisting |

Defaults: growth threshold **20%**, decline threshold **−10%**, introduction cut-off
**2026-01-01**. All three are adjustable from the *Thresholds* button.

`% Contribution` is each SKU's share of **total portfolio M3 sales**. It is calculated against
the whole portfolio, not the filtered subset, so filtered rows will not sum to 100%.

---

## Installing

**Android (Chrome / Edge)** — open the site, then tap **Install app** in the header, or use
the browser menu → *Install app* / *Add to Home screen*.

**iPhone / iPad (Safari)** — open the site, tap the **Share** button, then
*Add to Home Screen*. iOS does not support the in-page install button.

**Desktop (Chrome / Edge)** — click **Install app** in the header, or the install icon in the
address bar.

Once installed it launches in a standalone window and works with no connection.

---

## Uploading your own data

Use the **Upload data** button. Column headers are matched case-insensitively and ignore
spaces and underscores.

**Required:** `SKU`, `Name`, `Category`, `Launch`, `M1`, `M2`, `M3`
**Optional:** `Target` (leave blank or `0` for "no target set")

Accepted aliases include `SKU Code` / `Code`, `Product` / `Product Name`,
`Launch Date` / `Launched`, `Sales M1`, `Target Sales`, and similar.

### CSV

```csv
SKU,Product Name,Category,Launch Date,M1,M2,M3,Target
SKU-001,Mala Soup Original,Mala Soup,2024-01-15,10000,210000,245000,400000
SKU-002,Suancai Fish Stew,Suancai Fish,2024-03-01,120000,165000,215000,900000
SKU-003,Grass Jelly Milk Tea,Beverage,2022-08-15,85000,72000,58000,
```

### JSON

Either a bare array, or an object with an `items` array:

```json
[
  {
    "sku": "SKU-001",
    "name": "Mala Soup Original",
    "category": "Mala Soup",
    "launch": "2024-01-15",
    "m1": 10000,
    "m2": 210000,
    "m3": 245000,
    "target": 400000
  }
]
```

Uploading **replaces the entire dataset**. If the file is missing a required column, nothing
is imported and the existing data is left untouched.

---

## Running locally

No build step and no dependencies — but it must be served over HTTP, because service workers
do not run from `file://`.

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

---

## Project layout

```
index.html               the whole app — markup, styles and logic in one file
manifest.webmanifest     PWA metadata (name, icons, standalone display)
sw.js                    service worker — offline caching and update handling
icons/                   app icons, including a maskable variant for Android
```

Vanilla JavaScript with no framework or external requests, so it loads instantly and has
nothing to break offline.

---

## Licence

MIT
