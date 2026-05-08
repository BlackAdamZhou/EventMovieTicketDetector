# HerHealth Insights Dashboard

A static front-end dashboard for exploring a structured women’s heart health dataset. The application loads JSON records, processes missing values, applies filters, renders summary metrics and charts, and displays the filtered records in both table and mobile card layouts.

This project is built with plain HTML, CSS, and JavaScript. It does not require a build step, framework, package manager, or backend server.

---

## Live Demo

<https://dodgerblue-sardine-840522.hostingersite.com/#overview>

---

## Tech Stack

| File / Library | Purpose |
|---|---|
| `index.html` | Main page structure and dashboard sections |
| `assets/styles.css` | Layout, visual design, responsive styling, and UI states |
| `assets/script.js` | Data loading, filtering, chart rendering, record rendering, and CSV export |
| `data/dummy-data.json` | Main JSON dataset loaded by the dashboard |
| `img/LOGO-HH.png` | Dashboard logo image |
| Chart.js CDN | External charting library used for dashboard visualisations |

Chart.js is loaded from:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
```

An internet connection is required for Chart.js unless the library is downloaded and served locally.

---

## Project Structure

```text
public_html/
├── index.html
├── assets/
│   ├── styles.css
│   └── script.js
├── data/
│   └── dummy-data.json
└── img/
    └── LOGO-HH.png
```

---

## Main Features

### 1. Static Web Dashboard

The dashboard is implemented as a single static page. It contains the following sections:

- `#overview` — project overview and introduction
- `#dashboard` — metrics, filters, and visual charts
- `#records` — searchable and filterable record list
- `#insights` — static insight cards based on the sample data
- `#methodology` — workflow explanation for how JSON records are transformed into charts

---

### 2. JSON Data Loading

The application loads the dataset from:

```text
data/dummy-data.json
```

The loading logic is located in `assets/script.js`:

```js
async function loadData() {
  const response = await fetch("data/dummy-data.json", { cache: "no-store" });
  return await response.json();
}
```

If the JSON file cannot be loaded, the dashboard automatically uses the built-in `fallbackData` array inside `script.js`.

This prevents the page from becoming empty if:

- the JSON file path is incorrect
- the site is opened directly from `file://`
- the server blocks local JSON loading
- the dataset is temporarily unavailable

---

### 3. Data Normalisation

Each record is processed by `normaliseRecord()` before it is displayed.

This function creates safe display values for missing or nullable fields, including:

- missing title
- missing author
- missing summary
- missing engagement values
- missing tag arrays
- missing hashtag arrays

It also converts `publish_time` into:

- a JavaScript `Date` object
- a readable date label
- a `YYYY-MM` month key for timeline aggregation

Key derived fields include:

| Derived Field | Purpose |
|---|---|
| `safeTitle` | Uses the original title or a default title for untitled posts |
| `safeAuthor` | Uses the original author or `Unknown / community` |
| `safeSummary` | Uses the summary or a shortened version of the content |
| `publishDate` | JavaScript date object used for filtering |
| `publishDateLabel` | Human-readable display date |
| `monthKey` | Monthly grouping key for timeline charts |
| `likes` | Numeric likes value, defaulting to `0` |
| `comments` | Numeric comments value, defaulting to `0` |
| `shares` | Numeric shares value, defaulting to `0` |

---

## Dataset Format

The main dataset is an array of JSON objects.

Example:

```json
[
  {
    "id": "abc_20260318_001",
    "source": "ABC News",
    "source_category": "news",
    "source_type": "media",
    "source_classification": "factual",
    "url": "https://www.abc.net.au/news/health/2026-03-18/women-heart-disease-diagnosis-gaps",
    "title": "Why women's heart attacks go undiagnosed: new research reveals gender gap",
    "content": "New research from Australian health institutions shows women are significantly less likely to receive timely diagnoses for heart disease.",
    "summary": "Australian research reveals gender disparities in heart disease diagnosis.",
    "author": "Sarah Mitchell",
    "author_type": "individual",
    "publish_time": "2026-03-18T08:30:00Z",
    "scrape_time": "2026-03-18T15:45:22Z",
    "tags": ["heart disease", "women's health", "diagnosis"],
    "hashtags": [],
    "engagement": {
      "likes": null,
      "comments": null,
      "shares": null
    },
    "media_type": "text",
    "content_type": "article",
    "language": "en"
  }
]
```

### Required / Expected Fields

| Field | Type | Description |
|---|---:|---|
| `id` | string | Unique record identifier |
| `source` | string | Source name, such as `ABC News` or `Instagram` |
| `source_category` | string | Platform category, such as `news`, `website`, `forum`, or `social` |
| `source_type` | string | Source type, such as `media`, `organisation`, or `community` |
| `source_classification` | string | Content classification, such as `factual` or `opinion/anecdotal` |
| `url` | string | Original content URL |
| `title` | string or null | Content title |
| `content` | string | Main content text |
| `summary` | string | Short record summary |
| `author` | string or null | Author or account name |
| `author_type` | string | Author category |
| `publish_time` | string | ISO timestamp for publication time |
| `scrape_time` | string | ISO timestamp for data collection time |
| `tags` | array | Topic tags used for filtering and tag charts |
| `hashtags` | array | Social hashtags, if available |
| `engagement.likes` | number or null | Like count |
| `engagement.comments` | number or null | Comment count |
| `engagement.shares` | number or null | Share count |
| `media_type` | string | Media format, such as `text` or `image` |
| `content_type` | string | Content type, such as `article` or `post` |
| `language` | string | Language code |

---

## Dashboard Components

### Summary Metrics

The metric cards are updated by `updateMetrics()`.

Displayed metrics:

- total filtered records
- number of source categories
- total engagement count
- top tag in the current filtered dataset

Relevant HTML IDs:

```text
#totalRecords
#categoryCount
#totalEngagement
#topTag
```

---

### Filters

The dashboard supports six filter controls:

| Filter | HTML ID | Behaviour |
|---|---|---|
| Search | `searchInput` | Searches title, summary, content, source, category, type, classification, tags, and hashtags |
| Source category | `categoryFilter` | Filters by category and updates source/tag options |
| Source | `sourceFilter` | Filters by selected source |
| Topic / tag | `tagFilter` | Filters records containing the selected tag |
| From date | `fromDate` | Filters records published on or after the selected date |
| To date | `toDate` | Filters records published on or before the selected date |

Filtering is handled by:

```js
function applyFilters() { ... }
```

Resetting filters is handled by:

```js
function resetFilters() { ... }
```

---

### Charts

The dashboard renders five Chart.js charts.

| Chart | Canvas ID | Chart Type | Data Source |
|---|---|---|---|
| Source Category Breakdown | `sourceCategoryChart` | Doughnut | Count by `source_category` |
| Tag Frequency Distribution | `tagFrequencyChart` | Horizontal bar | Top 10 tags by frequency |
| Monthly Engagement Timeline | `engagementTimelineChart` | Line | Likes, comments, and shares grouped by month |
| Source Type Comparison | `sourceTypeChart` | Bar | Count by `source_type` |
| Classification Mix | `classificationChart` | Pie | Count by `source_classification` |

All charts are created or updated through:

```js
function createOrUpdateChart(canvasId, type, data, extraOptions = {}) { ... }
```

Before a chart is redrawn, the previous chart instance is destroyed. This prevents duplicate Chart.js instances when filters change.

---

### Record Rendering

Filtered records are rendered in two formats:

1. Desktop table
2. Mobile card layout

Relevant containers:

```text
#recordsTableBody
#recordsCards
#recordCountText
```

The rendering function is:

```js
function renderRecords(data) { ... }
```

The rendered record displays:

- title
- summary
- source link
- author
- source category
- published date
- tags
- total engagement

---

### CSV Export

The dashboard can export the currently filtered records as a CSV file.

The export button uses:

```text
#exportCsvBtn
```

The export function is:

```js
function exportFilteredCsv() { ... }
```

The generated file name is:

```text
herhealth-filtered-records.csv
```

Exported columns:

```text
id, source, source_category, source_type, source_classification, title, summary, author, publish_time, tags, hashtags, likes, comments, shares, url
```

---

## Styling and Layout

The visual design is defined in:

```text
assets/styles.css
```

Main CSS features:

- CSS variables for colours, spacing, shadows, and radius values
- fixed/sticky sidebar navigation on desktop
- sticky top bar
- card-based dashboard layout
- responsive chart grid
- responsive table-to-card layout for smaller screens
- toast notification styling
- mobile menu toggle support

Responsive breakpoints are defined with:

```css
@media (max-width: 1200px) { ... }
@media (max-width: 860px) { ... }
@media (max-width: 560px) { ... }
```

---

## How to Run Locally

### Recommended Method: Use a Local Server

Because the dashboard fetches `data/dummy-data.json`, it is better to run it through a local web server instead of opening `index.html` directly.

From the project root folder:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

On Windows, if `python3` is not recognised, try:

```bash
python -m http.server 8000
```

---

### Alternative Method: Open `index.html` Directly

You can open `index.html` directly in a browser, but some browsers may block `fetch("data/dummy-data.json")` under the `file://` protocol.

If that happens, the dashboard will use the built-in fallback dataset from `script.js`.

---

## How to Deploy

This project can be deployed on any static hosting service.

Supported options include:

- Hostinger
- GitHub Pages
- Netlify
- Vercel static hosting
- Apache
- Nginx

To deploy:

1. Upload `index.html` to the web root.
2. Upload the `assets/`, `data/`, and `img/` folders without changing their names.
3. Ensure `assets/styles.css`, `assets/script.js`, `data/dummy-data.json`, and `img/LOGO-HH.png` are reachable from the same relative paths.
4. Open the hosted URL in a browser.

---

## How to Update the Dataset

To update the dashboard data:

1. Open `data/dummy-data.json`.
2. Replace or append records using the same JSON schema.
3. Keep the file as a valid JSON array.
4. Ensure `tags` and `hashtags` are arrays.
5. Ensure `engagement` contains `likes`, `comments`, and `shares`.
6. Save the file and refresh the dashboard.

Example minimum valid record:

```json
{
  "id": "example_001",
  "source": "Example Source",
  "source_category": "news",
  "source_type": "media",
  "source_classification": "factual",
  "url": "https://example.com/article",
  "title": "Example title",
  "content": "Example content text.",
  "summary": "Example summary.",
  "author": "Example Author",
  "author_type": "individual",
  "publish_time": "2026-03-18T08:30:00Z",
  "scrape_time": "2026-03-18T15:45:22Z",
  "tags": ["heart disease", "women's health"],
  "hashtags": [],
  "engagement": {
    "likes": 0,
    "comments": 0,
    "shares": 0
  },
  "media_type": "text",
  "content_type": "article",
  "language": "en"
}
```

---

## Important Implementation Notes

### 1. Filter Dependency

When a source category is selected, the source and tag dropdowns are rebuilt using only records from that selected category.

This logic is handled by:

```js
function updateDependentFilters() { ... }
```

---

### 2. Engagement Handling

Null engagement values are converted to `0` during normalisation.

Example:

```js
likes: Number(engagement.likes || 0)
```

This allows charts and totals to calculate safely even when some platforms do not provide engagement data.

---

### 3. Safe HTML Rendering

Record values are escaped before being inserted into the DOM.

Relevant functions:

```js
function escapeHtml(value) { ... }
function escapeAttr(value) { ... }
```

This reduces the risk of broken HTML or unsafe injected content when rendering user-facing data.

---

### 4. Chart Re-rendering

Charts are destroyed and recreated when filters change.

```js
if (charts[canvasId]) {
  charts[canvasId].destroy();
}
```

This prevents rendering conflicts and memory issues caused by repeated Chart.js initialisation.

---

## Troubleshooting

### Charts do not appear

Possible causes:

- Chart.js CDN is blocked or unavailable.
- Internet connection is unavailable.
- The `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>` line is missing.

Fix:

- Check browser console errors.
- Confirm Chart.js loads successfully.
- Download Chart.js locally if offline support is required.

---

### JSON data does not load

Possible causes:

- `data/dummy-data.json` is missing.
- The file path has changed.
- The JSON file contains invalid syntax.
- The page is opened through `file://`.

Fix:

- Run the dashboard through a local server.
- Validate the JSON file.
- Check the browser console.

---

### Filters show no results

Possible causes:

- Too many filters are selected at once.
- Date range excludes all records.
- Search keyword does not match current records.

Fix:

- Click `Reset filters`.
- Use broader search keywords.
- Select `All categories`, `All sources`, and `All tags`.

---

### CSV export does not work

Possible causes:

- No records match the current filters.
- Browser blocks automatic downloads.

Fix:

- Reset filters and try again.
- Allow downloads in the browser.

---

## Browser Compatibility

Recommended browsers:

- Google Chrome
- Microsoft Edge
- Firefox
- Safari

The dashboard uses modern browser APIs including:

- `fetch()`
- `Blob`
- `URL.createObjectURL()`
- `classList`
- `querySelectorAll()`
- Chart.js canvas rendering

---

## Current Limitations

- The project is a static front-end application.
- There is no backend API.
- There is no database connection.
- There is no authentication or user account system.
- The dataset must be manually updated in `data/dummy-data.json`.
- Chart.js is loaded from a CDN, so charts require internet access unless Chart.js is hosted locally.

---

## Development Checklist

Before submitting or deploying, check that:

- [ ] `index.html` opens correctly.
- [ ] `assets/styles.css` loads correctly.
- [ ] `assets/script.js` loads correctly.
- [ ] `data/dummy-data.json` is valid JSON.
- [ ] Chart.js loads from the CDN.
- [ ] All five charts render correctly.
- [ ] Search works correctly.
- [ ] Category, source, tag, and date filters work correctly.
- [ ] Reset filters button works correctly.
- [ ] CSV export works correctly.
- [ ] Mobile layout displays record cards instead of the desktop table.
- [ ] Logo image loads correctly from `img/LOGO-HH.png`.

---

## File Maintenance Guide

| Task | File to Edit |
|---|---|
| Change page text or dashboard sections | `index.html` |
| Change colours, spacing, layout, or responsiveness | `assets/styles.css` |
| Change filters, charts, CSV export, or data processing | `assets/script.js` |
| Update dashboard records | `data/dummy-data.json` |
| Replace the logo | `img/LOGO-HH.png` |

---

## Submission Notes

This dashboard is designed as a static front-end prototype for an analytics capstone project. The current version focuses on data visualisation, filtering, record exploration, and CSV export using a structured JSON dataset. Backend services, authentication, database integration, and real-time data pipelines are not included in this version.

---

## License

No license file is included in the current source package. Add a license before public reuse or redistribution.
