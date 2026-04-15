# Moderator Drift Analysis & Coaching Engine v2.0

Rebuilt full-stack analysis engine for content moderation QA — detects moderator drift, classifies error types (overkill/undercall/wrong-tag), generates coaching recommendations, and tracks progress toward 95% accuracy target.

---

## What's New in v2.0

- **Error Classification Engine**: Every case auto-classified as OVERKILL / UNDERCALL / WRONG TAG
- **Overkill Detection**: `[]` market answer + mod tagged policy = moderator overkilled (added dimension that shouldn't be there)
- **Coaching Cards**: Per-moderator coaching recommendations with specific action items
- **Drift Prevention**: Alerts when moderators drift from calibration baseline
- **95% Target Tracking**: Gap-to-target visualization for each moderator

---

## Prerequisites

[Node.js](https://nodejs.org/) v18+ (LTS recommended)

---

## Quick Start

### Option A: One-Click (Windows)
Double-click **`start.bat`**

### Option B: Manual
```bash
npm install
npm run dev
```
Dashboard opens at **http://localhost:3000**

---

## Dashboard Tabs

| Tab | Purpose |
|-----|---------|
| **Overview** | KPI cards, accuracy gap, site-level SPC chart, moderator risk ranking |
| **SPC Charts** | Per-moderator control charts with ±2σ limits and Western Electric rules |
| **Error Classification** | Overkill/Undercall/Wrong-Tag breakdown, policy confusion matrix, drift signals |
| **Coaching** | Priority queue, per-mod coaching cards, recommended actions, weekly trends |
| **RCA Analysis** | Root cause breakdown, RCA×moderator heatmap, policy-level patterns |
| **Systemic Issues** | Multi-moderator errors = policy gaps (not individual drift) |
| **Alerts** | Adjustable threshold, auto-generated coaching actions |
| **Event Log** | Full searchable table, color-coded by error type |

---

## Error Classification Logic

| Error Type | Condition | Color |
|-----------|-----------|-------|
| **Overkill** | Market approved `[]` but mod tagged a policy | 🟠 Amber |
| **Undercall** | Market flagged a policy but mod approved `[]` | 🔴 Red |
| **Wrong Tag** | Both flagged but different policies | 🟣 Purple |

### Key Rule
`[]` = case approved (no policy tagged). If market answer is `[]` and moderator tagged a policy → **moderator overkilled** (added a dimension on analysis). This is a drift signal requiring calibration coaching.

---

## Expected Excel Structure

| Column | Example |
|--------|---------|
| Batch | 2026-02-07 |
| Market | SSA |
| Moderator | omar.ndour |
| Task ID | 7603775194091504145 |
| Alignment | Misaligned / [] / [Policy] |
| Market Top Voted Answer | [Youth Regulated Goods...] or [] |
| Mod Policy Title | ["Tobacco and Nicotine"] or [] |
| TCS Link | https://tcs-sg.tiktok-row.net/... |
| RCA | mod did not age down |

> Column names are flexible — fuzzy matching auto-detects headers.

