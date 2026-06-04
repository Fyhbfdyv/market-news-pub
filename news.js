/* Market News · Daily Summaries reader
 *
 * Data-driven, like the vocab app: it fetches `summaries/index.json` (the
 * manifest the pipeline regenerates) and renders the chosen `*_sum.md` file as
 * HTML with the vendored `marked` library. New summaries appear with no code
 * change.
 *
 * The summaries follow a consistent shape — each themed story is a `# Title`
 * with `## Cause` / `## Positive Impact` / `## Negative Impact` sections. We
 * lean on that structure twice: to build a table of contents (from the `# `
 * headings) and to colour-code the impact sections.
 */

"use strict";

const DATA_BASE = "./summaries/";

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

async function loadManifest() {
  const res = await fetch(`${DATA_BASE}index.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Manifest not found (HTTP ${res.status})`);
  return res.json();
}

async function loadReport(filename) {
  const res = await fetch(`${DATA_BASE}${filename}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Report not found: ${filename}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Rendering: markdown -> HTML, then structure-aware enhancements
// ---------------------------------------------------------------------------

/** Turn "🤖 The AI Supercycle" into a stable id like "the-ai-supercycle". */
function slugify(text, index) {
  const base = text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, "-") // keep word chars + CJK
    .replace(/^-+|-+$/g, "");
  return `theme-${index}-${base}`.slice(0, 60);
}

/** Map a section heading to a CSS class so impacts can be colour-coded. */
function sectionClass(headingText) {
  const t = headingText.toLowerCase();
  if (t.includes("positive")) return "sec-positive";
  if (t.includes("negative")) return "sec-negative";
  if (t.includes("cause")) return "sec-cause";
  return null;
}

/**
 * Render markdown into `container`, then:
 *  - give each H1 (theme) an id and collect {id, text} for the TOC,
 *  - tag each H2 with its section class for colour-coding.
 * Returns the TOC entries.
 *
 * The markdown comes from our own pipeline (trusted), so we render it as-is;
 * if it ever included user input we'd sanitize (e.g. DOMPurify) first.
 */
function renderReport(markdown, container) {
  container.innerHTML = marked.parse(markdown);

  const toc = [];
  container.querySelectorAll("h1").forEach((h1, i) => {
    const id = slugify(h1.textContent, i);
    h1.id = id;
    toc.push({ id, text: h1.textContent });
  });

  container.querySelectorAll("h2").forEach((h2) => {
    const cls = sectionClass(h2.textContent);
    if (cls) h2.classList.add(cls);
  });

  return toc;
}

function renderToc(entries, tocEl) {
  tocEl.replaceChildren();
  if (entries.length <= 1) return; // a single-theme report needs no jump list
  const heading = document.createElement("p");
  heading.className = "toc-heading";
  heading.textContent = `Themes (${entries.length})`;
  tocEl.append(heading);

  for (const { id, text } of entries) {
    const link = document.createElement("a");
    link.href = `#${id}`;
    link.textContent = text;
    link.onclick = (e) => {
      e.preventDefault();
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    tocEl.append(link);
  }
}

// ---------------------------------------------------------------------------
// Controller: source filter + date navigation
// ---------------------------------------------------------------------------

const reportEl = document.getElementById("report");
const tocEl = document.getElementById("toc");
const selectEl = document.getElementById("report-select");

const state = {
  reports: [], // all reports from the manifest (newest first)
  source: "all", // "all" | "b" | "c"
  current: null, // filename currently shown
};

/** Reports matching the active source filter, newest first. */
function visibleReports() {
  return state.source === "all"
    ? state.reports
    : state.reports.filter((r) => r.source === state.source);
}

function populateSelect() {
  const reports = visibleReports();
  selectEl.replaceChildren();
  for (const r of reports) {
    const opt = document.createElement("option");
    opt.value = r.file;
    opt.textContent = `${r.date} · ${r.label}`;
    selectEl.append(opt);
  }
  // Keep the current selection if still visible; else jump to the newest.
  const stillVisible = reports.some((r) => r.file === state.current);
  const target = stillVisible ? state.current : reports[0]?.file;
  if (target) {
    selectEl.value = target;
    show(target);
  } else {
    state.current = null;
    reportEl.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "status",
        textContent: "No summaries for this source yet.",
      })
    );
    tocEl.replaceChildren();
  }
}

async function show(filename) {
  state.current = filename;
  reportEl.replaceChildren(
    Object.assign(document.createElement("p"), {
      className: "status",
      textContent: "Loading…",
    })
  );
  try {
    const markdown = await loadReport(filename);
    const toc = renderReport(markdown, reportEl);
    renderToc(toc, tocEl);
    reportEl.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
    updateFooter();
  } catch (err) {
    reportEl.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "status",
        textContent: `Could not load report: ${err.message}`,
      })
    );
  }
}

/** Step through the visible list. delta -1 = newer, +1 = older. */
function step(delta) {
  const reports = visibleReports();
  const idx = reports.findIndex((r) => r.file === state.current);
  const next = reports[idx + delta];
  if (next) {
    selectEl.value = next.file;
    show(next.file);
  }
}

function updateFooter() {
  const info = document.getElementById("footer-info");
  info.textContent = `${visibleReports().length} report(s) · source: ${state.source}`;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  for (const btn of document.querySelectorAll("#source-nav button")) {
    btn.onclick = () => {
      state.source = btn.dataset.source;
      for (const b of document.querySelectorAll("#source-nav button")) {
        b.classList.toggle("active", b === btn);
      }
      populateSelect();
    };
  }
  selectEl.onchange = () => show(selectEl.value);
  document.getElementById("prev-day").onclick = () => step(-1);
  document.getElementById("next-day").onclick = () => step(1);

  try {
    const manifest = await loadManifest();
    state.reports = manifest.reports || [];
    if (state.reports.length === 0) {
      reportEl.replaceChildren(
        Object.assign(document.createElement("p"), {
          className: "status",
          textContent: "No summaries found yet.",
        })
      );
      return;
    }
    populateSelect();
  } catch (err) {
    reportEl.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "status",
        textContent: `Startup failed: ${err.message}`,
      })
    );
  }
}

main();
