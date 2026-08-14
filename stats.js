/* Market News · Study Progress page
 *
 * The READ side of the study log. Every number here comes straight out of a
 * Postgres view (v_daily / v_monthly / v_yearly / v_term_stats) — this file
 * fetches and draws, it does not aggregate. The one exception is the streak
 * and heatmap shading, which need "today" in the learner's timezone and so
 * live in stats-core.js where they can be unit-tested.
 */

import { client, currentUser, onAuthChange } from "./sb-client.js";
import {
  accuracy,
  calendarCells,
  computeStreak,
  localDate,
  totals,
} from "./stats-core.js";

const stage = document.getElementById("stage");

// A local copy of app.js's DOM helper. app.js is a classic script and cannot
// export it; eight lines of duplication beats converting the whole trainer.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

let range = "day";
let data = null; // { daily, monthly, yearly, weak }

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchAll() {
  const [daily, monthly, yearly, weak] = await Promise.all([
    client.from("v_daily").select("*").order("local_date", { ascending: false }).limit(400),
    client.from("v_monthly").select("*").order("month", { ascending: false }).limit(36),
    client.from("v_yearly").select("*").order("year", { ascending: false }).limit(10),
    client
      .from("v_term_stats")
      .select("*")
      .gt("misses", 0)
      .order("misses", { ascending: false })
      .limit(20),
  ]);

  const failed = [daily, monthly, yearly, weak].find((r) => r.error);
  if (failed) throw failed.error;

  return {
    daily: daily.data,
    monthly: monthly.data,
    yearly: yearly.data,
    weak: weak.data,
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function tile(label, value, note = null) {
  return el("div", { className: "stat-tile" }, [
    el("div", { className: "stat-value", textContent: String(value) }),
    el("div", { className: "stat-label", textContent: label }),
    note ? el("div", { className: "stat-note", textContent: note }) : null,
  ]);
}

function summary(daily) {
  const today = localDate();
  const todayRow = daily.find((r) => r.local_date === today);
  const streak = computeStreak(daily.map((r) => r.local_date), today);
  const all = totals(daily);
  const rate = accuracy(all.correct, all.answers);

  return el("section", { className: "stat-grid" }, [
    tile("Today", todayRow ? Number(todayRow.answers) + Number(todayRow.plays) : 0, "answers + plays"),
    tile("Streak", `${streak.current}d`, `longest ${streak.longest}d`),
    tile("Accuracy", rate === null ? "—" : `${rate}%`, `${all.correct} / ${all.answers}`),
    tile("Study time", `${all.minutes}m`, `${all.activeDays} active days`),
  ]);
}

function heatmap(daily) {
  const cells = calendarCells(daily, localDate(), 182);
  const grid = el("div", { className: "heatmap" });
  for (const cell of cells) {
    grid.append(
      el("span", {
        className: `heat heat-${cell.level}`,
        title: `${cell.date} · ${cell.count} action(s)`,
      })
    );
  }
  return el("section", { className: "panel" }, [
    el("h2", { textContent: "Last 6 months" }),
    grid,
    el("p", { className: "hint", textContent: "Each square is a day — darker means more practice." }),
  ]);
}

/** Render one period table. `key` is the date column of the chosen range. */
function periodTable(rows, key, title) {
  if (!rows.length) {
    return el("section", { className: "panel" }, [
      el("h2", { textContent: title }),
      el("p", { className: "hint", textContent: "Nothing recorded yet." }),
    ]);
  }

  const max = Math.max(...rows.map((r) => Number(r.answers) + Number(r.plays)));
  const body = el("div", { className: "period-list" });

  for (const row of rows) {
    const activity = Number(row.answers) + Number(row.plays);
    const rate = accuracy(row.correct, row.answers);
    body.append(
      el("div", { className: "period-row" }, [
        el("span", { className: "period-label", textContent: String(row[key]) }),
        el("span", { className: "period-bar" }, [
          el("span", {
            className: "period-fill",
            style: `width:${max ? (activity / max) * 100 : 0}%`,
          }),
        ]),
        el("span", {
          className: "period-value",
          textContent: rate === null ? `${activity}` : `${activity} · ${rate}%`,
        }),
      ])
    );
  }

  return el("section", { className: "panel" }, [el("h2", { textContent: title }), body]);
}

function weakTerms(weak) {
  const panel = el("section", { className: "panel" }, [
    el("h2", { textContent: "Hardest words" }),
  ]);

  if (!weak.length) {
    panel.append(el("p", { className: "hint", textContent: "No wrong answers recorded — nice. 🎉" }));
    return panel;
  }

  for (const row of weak) {
    panel.append(
      el("div", { className: "weak-row" }, [
        el("span", { className: "weak-term", textContent: row.term }),
        el("span", {
          className: `pill ${row.last_correct ? "pill-good" : "pill-bad"}`,
          textContent: row.last_correct ? "recovered" : "still missing",
        }),
        el("span", { className: "weak-count", textContent: `✗ ${row.misses} · ✓ ${row.hits}` }),
      ])
    );
  }
  return panel;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  stage.replaceChildren();

  if (!currentUser()) {
    stage.append(
      el("p", { className: "status" }, [
        "Sign in with the 🔒 button above to see your study record.",
      ])
    );
    document.getElementById("footer-info").textContent = "Not signed in";
    return;
  }

  if (!data) {
    stage.append(el("p", { className: "status", textContent: "Loading your progress…" }));
    return;
  }

  stage.append(summary(data.daily));

  if (range === "day") {
    stage.append(heatmap(data.daily), periodTable(data.daily.slice(0, 30), "local_date", "Last 30 days"));
  } else if (range === "month") {
    stage.append(periodTable(data.monthly, "month", "By month"));
  } else {
    stage.append(periodTable(data.yearly, "year", "By year"));
  }

  stage.append(weakTerms(data.weak));

  const all = totals(data.daily);
  document.getElementById("footer-info").textContent =
    `${all.answers} answers · ${all.plays} plays · ${currentUser().email}`;
}

async function load() {
  if (!currentUser()) {
    data = null;
    render();
    return;
  }
  try {
    data = await fetchAll();
    render();
  } catch (err) {
    stage.replaceChildren(
      el("p", { className: "status", textContent: `Could not load progress: ${err.message}` })
    );
  }
}

for (const btn of document.querySelectorAll("#range-nav button")) {
  btn.onclick = () => {
    range = btn.dataset.range;
    for (const other of document.querySelectorAll("#range-nav button")) {
      other.classList.toggle("active", other === btn);
    }
    render();
  };
}

onAuthChange(load);
