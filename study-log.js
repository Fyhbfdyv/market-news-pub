/* Market News · study log (write path)
 *
 * Records what you actually did — every answer, every audio play — as append-
 * only events in Supabase. All statistics are derived from these rows in SQL,
 * so this module never computes or stores a total.
 *
 * Two rules shape the design:
 *
 *  1. NEVER BLOCK THE UI. A listening loop on repeat fires hundreds of events;
 *     one HTTP round-trip per event would stutter the audio. Events land in an
 *     in-memory buffer and go out in batches.
 *
 *  2. NEVER LOSE A SESSION. Practising on a phone means dead spots and tabs
 *     killed by the OS. A failed batch falls back to a localStorage outbox and
 *     is retried later; each event carries a client-minted `client_id` that a
 *     unique index turns into a no-op if it ever arrives twice.
 *
 * Signed out, logging is a no-op — there is no user to attribute the study to,
 * and guessing later would corrupt the history.
 */

import { client, currentUser, onAuthChange } from "./sb-client.js";
import { localDate } from "./stats-core.js";

const OUTBOX_KEY = "vocab-trainer:outbox";
const BATCH_SIZE = 25; // flush once this many events are waiting
const FLUSH_MS = 15000; // …or this long after the first one
const OUTBOX_CAP = 2000; // hard ceiling so a long outage cannot fill up storage

let buffer = [];
let timer = null;

// ---------------------------------------------------------------------------
// Outbox — the offline safety net
// ---------------------------------------------------------------------------

function readOutbox() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || [];
  } catch {
    return [];
  }
}

function writeOutbox(rows) {
  // Keep the NEWEST events when over the cap: recent practice is the part
  // still worth reconstructing.
  const kept = rows.slice(-OUTBOX_CAP);
  if (kept.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(kept));
  else localStorage.removeItem(OUTBOX_KEY);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Push every pending event to Supabase.
 *
 * A duplicate-key error means the batch already landed on an earlier attempt,
 * so it counts as success — that is the whole point of `client_id`.
 */
async function flush() {
  clearTimeout(timer);
  timer = null;

  if (!currentUser()) return;

  const rows = [...readOutbox(), ...buffer];
  if (!rows.length) return;
  buffer = [];
  writeOutbox([]);

  const { error } = await client.from("study_events").insert(rows);
  if (error && error.code !== "23505") {
    console.warn("Study log: batch deferred —", error.message);
    writeOutbox([...readOutbox(), ...rows]);
  }
}

function scheduleFlush() {
  if (buffer.length >= BATCH_SIZE) return void flush();
  timer ??= setTimeout(flush, FLUSH_MS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const StudyLog = {
  /** True when events are being recorded (i.e. somebody is signed in). */
  get active() {
    return Boolean(currentUser());
  },

  /**
   * Queue one study event.
   *
   * Args: deckId, mode, kind ('answer' | 'play' | 'reveal'), term, and the
   * optional `correct` / `chosen` / `ms` detail fields.
   */
  log({ deckId, mode, kind, term, correct = null, chosen = null, ms = null }) {
    if (!currentUser()) return;
    buffer.push({
      client_id: crypto.randomUUID(),
      local_date: localDate(),
      deck_id: deckId ?? "unknown",
      mode,
      kind,
      term,
      correct,
      chosen,
      ms: ms == null ? null : Math.max(0, Math.round(ms)),
    });
    scheduleFlush();
  },

  /**
   * Remember the display fields of a whole deck in one request.
   *
   * The review deck rebuilds its cards from this table, so a term must be
   * known here before it can come back for review. Called once per session
   * rather than per question — 20 rows in one round-trip, not 20 round-trips.
   */
  async noteDeck(items, deckId) {
    if (!currentUser() || !items.length) return;
    const rows = items.map((item) => ({
      term: item.term,
      deck_id: deckId ?? "unknown",
      example: item.example ?? "",
      zh_meaning: item.zhMeaning ?? "",
      zh_example: item.zhExample ?? "",
      updated_at: new Date().toISOString(),
    }));
    const { error } = await client
      .from("terms")
      .upsert(rows, { onConflict: "user_id,term" });
    if (error) console.warn("Study log: could not save deck terms —", error.message);
  },

  /**
   * Terms whose most recent answer was wrong, hardest first.
   *
   * Returns items in the shape the trainer modes expect, so the review deck is
   * interchangeable with a real deck.
   */
  async fetchReviewDeck(limit = 50) {
    if (!currentUser()) return [];
    const { data, error } = await client
      .from("v_review_deck")
      .select("term, example, zh_meaning, zh_example")
      .limit(limit);
    if (error) {
      console.warn("Study log: could not load review deck —", error.message);
      return [];
    }
    return data.map((row) => ({
      term: row.term,
      example: row.example,
      zhMeaning: row.zh_meaning,
      zhExample: row.zh_example,
    }));
  },

  flush,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Signing in is the moment a stranded outbox can finally be delivered. The
// event lets pages that loaded before the session resolved (app.js runs first,
// this module awaits the network) repaint without polling.
onAuthChange((user) => {
  if (user) flush();
  document.dispatchEvent(new CustomEvent("studylog:auth", { detail: { user } }));
});

// Leaving the page is the last chance to save the current run. `visibilitychange`
// is the reliable one on mobile — `beforeunload` never fires when iOS kills a
// backgrounded tab.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});

// app.js is a classic script and cannot import a module, so the API is also
// hung off `window` — the same bridge voice-prefs.js uses.
window.StudyLog = StudyLog;

export default StudyLog;
