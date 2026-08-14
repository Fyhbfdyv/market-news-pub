/* Market News · study-statistics maths
 *
 * PURE FUNCTIONS ONLY — no DOM, no network, no Date.now() hidden inside.
 * Anything that needs "today" takes it as an argument. That keeps this file
 * unit-testable under `node --test` (see tests/web/) while the rendering and
 * fetching stay in stats.js.
 *
 * Dates are ISO day strings ("2026-08-14") throughout. Day arithmetic goes
 * through UTC on purpose: local-time arithmetic silently breaks on daylight
 * saving days, where a "+24h" jump lands on the same calendar date.
 */

/** Format a Date as a local-timezone ISO day string. */
export function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Shift an ISO day string by `n` days (negative goes back). */
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Current and longest run of consecutive study days.
 *
 * A streak that ran through YESTERDAY still counts as current — today is not
 * over yet, and zeroing someone's 30-day streak at midnight is the fastest way
 * to make them quit.
 */
export function computeStreak(activeDates, today) {
  const days = new Set(activeDates);
  if (days.size === 0) return { current: 0, longest: 0 };

  let cursor = days.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (days.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  for (const day of [...days].sort()) {
    run = days.has(addDays(day, -1)) ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  return { current, longest };
}

/** Day of the week for an ISO day string. 0 = Sunday. */
export function weekdayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Build the last `days` calendar cells ending on `today`, newest last.
 *
 * `level` is a 0–4 shade bucket scaled to the busiest day in the window, so
 * the heatmap stays readable whether a typical day is 5 answers or 500.
 */
export function calendarCells(rows, today, days = 182) {
  const counts = new Map(rows.map((r) => [r.local_date, activityOf(r)]));
  const max = Math.max(0, ...counts.values());

  const cells = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const count = counts.get(date) ?? 0;
    cells.push({ date, count, level: shadeLevel(count, max) });
  }
  return cells;
}

/**
 * The heatmap as whole Sunday–Saturday weeks, so the grid reads like a wall
 * calendar: every row is one weekday, every column one week.
 *
 * The window is extended forward to the Saturday of the current week and back
 * to a Sunday. Days after `today` come back as `future` cells, which the page
 * renders as empty space — without them the last column would be misaligned.
 */
export function calendarWeeks(rows, today, weeks = 26) {
  const end = addDays(today, 6 - weekdayOf(today));
  const start = addDays(end, -(weeks * 7 - 1));
  const cells = calendarCells(rows, end, weeks * 7).map((cell) => ({
    ...cell,
    future: cell.date > today,
    count: cell.date > today ? 0 : cell.count,
    level: cell.date > today ? 0 : cell.level,
  }));
  return { cells, start, end };
}

/**
 * Month labels for a `calendarWeeks` grid: one per column that opens a new
 * month, positioned by column index (1-based, as CSS grid counts).
 */
export function monthLabels(cells, names = MONTHS) {
  const labels = [];
  let previous = null;
  for (let col = 0; col < cells.length / 7; col++) {
    const month = cells[col * 7].date.slice(0, 7);
    if (month !== previous) labels.push({ column: col + 1, label: names[Number(month.slice(5)) - 1] });
    previous = month;
  }
  // A month that only owns the final column has no room for its label.
  return labels.filter((l) => l.column <= cells.length / 7 - 1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One day's total activity: answers plus audio plays. */
export function activityOf(row) {
  return Number(row.answers ?? 0) + Number(row.plays ?? 0);
}

function shadeLevel(count, max) {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((count / max) * 4));
}

/** Correct-answer percentage, rounded. Returns null when nothing was answered. */
export function accuracy(correct, answers) {
  if (!answers) return null;
  return Math.round((Number(correct) / Number(answers)) * 100);
}

/** Whole days from `from` to `to`, both ISO day strings. Negative if `to` is earlier. */
export function daysBetween(from, to) {
  const at = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86400000);
}

/**
 * A short human label for a past day: "today", "yesterday", "5d ago", or the
 * plain date once "n days ago" stops being easier to read than the date.
 */
export function relativeDay(iso, today) {
  if (!iso) return "—";
  const day = iso.slice(0, 10);
  const ago = daysBetween(day, today);
  if (ago <= 0) return "today";
  if (ago === 1) return "yesterday";
  if (ago < 30) return `${ago}d ago`;
  return day;
}

/**
 * Split mistake rows into the two that matter: still getting it wrong, and
 * since recovered. `last_correct` is the correctness of the newest answer.
 */
export function splitMistakes(rows) {
  return {
    open: rows.filter((r) => !r.last_correct),
    recovered: rows.filter((r) => r.last_correct),
  };
}

/** Sum a set of daily rows into one totals object. */
export function totals(rows) {
  const sum = (key) => rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
  return {
    answers: sum("answers"),
    correct: sum("correct"),
    wrong: sum("wrong"),
    plays: sum("plays"),
    minutes: Math.round(sum("minutes")),
    activeDays: rows.length,
  };
}
