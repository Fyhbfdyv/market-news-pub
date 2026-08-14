/* Market News · Study Progress page
 *
 * The READ side of the study log. Every number here comes straight out of a
 * Postgres view (v_daily / v_monthly / v_yearly / v_mistakes / v_mode_stats) —
 * this file fetches and draws, it does not aggregate. The exceptions are the
 * streak, the calendar grid and the date labels, which need "today" in the
 * learner's timezone and so live in stats-core.js where they can be
 * unit-tested.
 *
 * Before reading anything it flushes the study log's outbox, so a session that
 * ended without a connection is on the server by the time we query.
 */

import StudyLog from "./study-log.js";
import { client, currentUser, onAuthChange } from "./sb-client.js";
import {
  accuracy,
  calendarWeeks,
  computeStreak,
  localDate,
  monthLabels,
  relativeDay,
  splitMistakes,
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

const MODE_LABELS = {
  flashcard: "Flashcard",
  quiz: "Quiz",
  fill: "Fill blanks",
  listening: "Listening",
  shadowing: "Shadowing",
};

let range = "day";
let mistakeTab = "open";
let data = null; // { daily, monthly, yearly, mistakes, modes }

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchAll() {
  const [daily, monthly, yearly, mistakes, modes] = await Promise.all([
    client.from("v_daily").select("*").order("local_date", { ascending: false }).limit(400),
    client.from("v_monthly").select("*").order("month", { ascending: false }).limit(36),
    client.from("v_yearly").select("*").order("year", { ascending: false }).limit(10),
    client.from("v_mistakes").select("*").limit(300),
    client.from("v_mode_stats").select("*"),
  ]);

  const failed = [daily, monthly, yearly, mistakes, modes].find((r) => r.error);
  if (failed) throw failed.error;

  return {
    daily: daily.data,
    monthly: monthly.data,
    yearly: yearly.data,
    mistakes: mistakes.data,
    modes: modes.data,
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function panel(title, children, action = null) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-head" }, [
      el("h2", { textContent: title }),
      action,
    ]),
    ...[].concat(children),
  ]);
}

function tile(label, value, note, accent = "") {
  return el("div", { className: `stat-tile ${accent}` }, [
    el("div", { className: "stat-label", textContent: label }),
    el("div", { className: "stat-value", textContent: String(value) }),
    el("div", { className: "stat-note", textContent: note }),
  ]);
}

function summary(daily, mistakes) {
  const today = localDate();
  const todayRow = daily.find((r) => r.local_date === today);
  const streak = computeStreak(daily.map((r) => r.local_date), today);
  const all = totals(daily);
  const rate = accuracy(all.correct, all.answers);
  const open = splitMistakes(mistakes).open.length;

  const todayCount = todayRow ? Number(todayRow.answers) + Number(todayRow.plays) : 0;

  return el("section", { className: "stat-grid" }, [
    tile("Today", todayCount, todayCount ? "answers + plays" : "nothing yet — go practise"),
    tile("Streak", `${streak.current}`, `days · best ${streak.longest}`, streak.current ? "accent-good" : ""),
    tile("Accuracy", rate === null ? "—" : `${rate}%`, `${all.correct} of ${all.answers} answers`),
    tile("To fix", open, open ? "words still wrong" : "nothing outstanding", open ? "accent-bad" : "accent-good"),
  ]);
}

function heatmap(daily) {
  const today = localDate();
  const { cells } = calendarWeeks(daily, today, 26);

  const grid = el("div", { className: "heatmap" });
  for (const cell of cells) {
    grid.append(
      cell.future
        ? el("span", { className: "heat heat-future" })
        : el("span", {
            className: `heat heat-${cell.level}${cell.date === today ? " heat-today" : ""}`,
            title: `${cell.date} · ${cell.count} action${cell.count === 1 ? "" : "s"}`,
          })
    );
  }

  const months = el("div", { className: "heatmap-months" });
  for (const { column, label } of monthLabels(cells)) {
    months.append(el("span", { textContent: label, style: `grid-column:${column}` }));
  }

  // Mon/Wed/Fri only — labelling all seven rows crowds an 11px grid.
  const days = el("div", { className: "heatmap-days" }, [
    el("span", { textContent: "Mon", style: "grid-row:2" }),
    el("span", { textContent: "Wed", style: "grid-row:4" }),
    el("span", { textContent: "Fri", style: "grid-row:6" }),
  ]);

  const legend = el("div", { className: "heatmap-legend" }, [
    el("span", { className: "hint", textContent: "Less" }),
    ...[0, 1, 2, 3, 4].map((n) => el("span", { className: `heat heat-${n}` })),
    el("span", { className: "hint", textContent: "More" }),
  ]);

  return panel("Last 6 months", [
    el("div", { className: "heatmap-wrap" }, [
      months,
      el("div", { className: "heatmap-body" }, [days, grid]),
    ]),
    legend,
  ]);
}

function rangeSwitch() {
  const nav = el("nav", { className: "seg" });
  for (const [key, label] of [["day", "Daily"], ["month", "Monthly"], ["year", "Yearly"]]) {
    const btn = el("button", {
      className: key === range ? "active" : "",
      textContent: label,
    });
    btn.onclick = () => {
      range = key;
      render();
    };
    nav.append(btn);
  }
  return nav;
}

/** One period table. `key` is the date column of the chosen range. */
function trend(rows, key, title) {
  if (!rows.length) {
    return panel(title, el("p", { className: "hint", textContent: "Nothing recorded yet." }), rangeSwitch());
  }

  const max = Math.max(...rows.map((r) => Number(r.answers) + Number(r.plays)));
  const body = el("div", { className: "period-list" });

  for (const row of rows) {
    const activity = Number(row.answers) + Number(row.plays);
    const rate = accuracy(row.correct, row.answers);
    const label = key === "local_date" ? String(row[key]).slice(5) : String(row[key]).slice(0, key === "year" ? 4 : 7);

    body.append(
      el("div", { className: "period-row" }, [
        el("span", { className: "period-label", textContent: label }),
        el("span", { className: "period-bar" }, [
          el("span", {
            className: "period-fill",
            style: `width:${max ? Math.max(2, (activity / max) * 100) : 0}%`,
          }),
        ]),
        el("span", { className: "period-value", textContent: String(activity) }),
        el("span", {
          className: `period-rate ${rate !== null && rate >= 80 ? "good" : rate !== null && rate < 60 ? "bad" : ""}`,
          textContent: rate === null ? "—" : `${rate}%`,
        }),
      ])
    );
  }

  return panel(title, body, rangeSwitch());
}

/**
 * The mistake list — the point of keeping a record at all.
 *
 * Each row answers "which word, what does it mean, what did I put instead, and
 * how long has it been wrong". Two tabs keep the outstanding words separate
 * from the ones already recovered.
 */
function mistakes(rows) {
  const today = localDate();
  const { open, recovered } = splitMistakes(rows);
  const shown = mistakeTab === "open" ? open : recovered;

  const tabs = el("nav", { className: "seg" });
  for (const [key, label, n] of [["open", "Still wrong", open.length], ["recovered", "Recovered", recovered.length]]) {
    const btn = el("button", { className: key === mistakeTab ? "active" : "" }, [
      label,
      el("span", { className: "seg-count", textContent: String(n) }),
    ]);
    btn.onclick = () => {
      mistakeTab = key;
      render();
    };
    tabs.append(btn);
  }

  const list = el("div", { className: "mistake-list" });

  if (!shown.length) {
    list.append(
      el("p", {
        className: "hint",
        textContent:
          mistakeTab === "open"
            ? rows.length
              ? "Every word you missed has been answered correctly since. 🎉"
              : "No wrong answers recorded yet."
            : "Nothing recovered yet — words move here once you get them right again.",
      })
    );
  }

  for (const row of shown) {
    const wrongPick = row.last_chosen
      ? el("span", { className: "mistake-picked" }, [
          "you put ",
          el("s", { textContent: row.last_chosen }),
          row.last_mode === "fill" ? ` · answer “${row.term}”` : row.zh_meaning ? ` · answer “${row.zh_meaning}”` : "",
        ])
      : null;

    list.append(
      el("div", { className: "mistake-row" }, [
        el("div", { className: "mistake-main" }, [
          el("div", { className: "mistake-head" }, [
            el("span", { className: "mistake-term", textContent: row.term }),
            el("span", { className: "mistake-zh", textContent: row.zh_meaning || "—" }),
          ]),
          row.example ? el("div", { className: "mistake-example", textContent: row.example }) : null,
          wrongPick,
        ]),
        el("div", { className: "mistake-meta" }, [
          el("span", { className: "mistake-score" }, [
            el("b", { className: "bad", textContent: `✗${row.misses}` }),
            el("b", { className: "good", textContent: `✓${row.hits}` }),
          ]),
          el("span", { className: "hint", textContent: relativeDay(row.last_wrong_at, today) }),
        ]),
      ])
    );
  }

  const practise = open.length
    ? el("a", { className: "btn-link", href: "./index.html?deck=__review__&mode=quiz", textContent: "Practise these →" })
    : null;

  return panel("Mistakes", [tabs, list, practise]);
}

/**
 * Where the practice actually went. The right-hand column is accuracy for the
 * two modes that ask questions, and a plain action count for the three that
 * do not — a listening loop has no notion of being right.
 */
function modeBreakdown(modes) {
  const actionsOf = (m) => Number(m.answers) + Number(m.plays) + Number(m.reveals);
  const rows = modes.filter((m) => actionsOf(m) > 0).sort((a, b) => actionsOf(b) - actionsOf(a));
  if (!rows.length) return null;

  const list = el("div", { className: "mode-list" });
  for (const row of rows) {
    const rate = accuracy(row.correct, row.answers);
    const minutes = Math.round(Number(row.minutes));
    list.append(
      el("div", { className: "mode-row" }, [
        el("span", { className: "mode-name", textContent: MODE_LABELS[row.mode] ?? row.mode }),
        el("span", {
          className: "hint",
          textContent: `${row.terms} words${minutes ? ` · ${minutes}m` : ""}`,
        }),
        el("span", {
          className: "mode-rate",
          title: rate === null ? `${actionsOf(row)} actions` : `${row.correct} of ${row.answers} correct`,
          textContent: rate === null ? `${actionsOf(row)}×` : `${rate}%`,
        }),
      ])
    );
  }
  return panel("By mode", list);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  stage.replaceChildren();

  if (!currentUser()) {
    stage.append(
      el("div", { className: "panel empty" }, [
        el("div", { className: "empty-icon", textContent: "🔒" }),
        el("p", { textContent: "Sign in with the 🔒 button above to see your study record." }),
        el("p", { className: "hint", textContent: "Practice is only recorded while you are signed in." }),
      ])
    );
    document.getElementById("footer-info").textContent = "Not signed in";
    return;
  }

  if (!data) {
    stage.append(el("p", { className: "status", textContent: "Loading your progress…" }));
    return;
  }

  stage.append(summary(data.daily, data.mistakes));
  stage.append(mistakes(data.mistakes));

  if (range === "day") {
    stage.append(heatmap(data.daily), trend(data.daily.slice(0, 30), "local_date", "Recent days"));
  } else if (range === "month") {
    stage.append(trend(data.monthly, "month", "By month"));
  } else {
    stage.append(trend(data.yearly, "year", "By year"));
  }

  const modes = modeBreakdown(data.modes);
  if (modes) stage.append(modes);

  const all = totals(data.daily);
  document.getElementById("footer-info").textContent =
    `${all.answers} answers · ${all.plays} plays · ${all.minutes}m · ${currentUser().email}`;
}

async function load() {
  if (!currentUser()) {
    data = null;
    render();
    return;
  }
  try {
    // Deliver anything the trainer could not send before reading the views,
    // otherwise the last few answers of a session are missing from the page
    // that exists to show them. A write that cannot go out must not stop the
    // read: the events stay parked and the numbers below are still worth
    // showing.
    await StudyLog.flush().catch(() => {});
    data = await fetchAll();
    render();
  } catch (err) {
    stage.replaceChildren(
      el("p", { className: "status", textContent: `Could not load progress: ${err.message}` })
    );
  }
}

onAuthChange(load);
