/* Market News · study log (write path)
 *
 * Records what you actually did — every answer, every audio play — as append-
 * only events in Supabase. All statistics are derived from these rows in SQL,
 * so this module never computes or stores a total.
 *
 * Three rules shape the design:
 *
 *  1. NEVER BLOCK THE UI. A listening loop on repeat fires hundreds of events;
 *     one HTTP round-trip per event would stutter the audio. Events land in an
 *     in-memory buffer and go out in batches.
 *
 *  2. NEVER DROP AN EVENT BEFORE THE SERVER HAS IT. Pending events are parked
 *     in a localStorage outbox — a synchronous write that survives navigation,
 *     a crash, or the OS killing a backgrounded tab — and are deleted ONLY
 *     after a request comes back OK. Anything else loses the run that happens
 *     between the last flush and tapping a link, which is the run the learner
 *     is about to go and look at.
 *
 *  3. REDELIVERY MUST BE HARMLESS. Every event carries a client-minted
 *     `client_id`; the batch is posted with `resolution=ignore-duplicates`, so
 *     a retry that overlaps an earlier batch inserts the new rows and skips the
 *     seen ones instead of failing as a whole.
 *
 * Writes go straight to PostgREST rather than through supabase-js, because the
 * unload path needs `fetch(..., { keepalive: true })` to outlive the page and
 * the SDK does not expose that. One code path, both cases.
 *
 * Signed out, logging is a no-op — there is no user to attribute the study to,
 * and guessing later would corrupt the history.
 */

import {
  DB_SCHEMA,
  SUPABASE_KEY,
  SUPABASE_URL,
  accessToken,
  client,
  currentUser,
  onAuthChange,
} from "./sb-client.js";
import { localDate } from "./stats-core.js";

const ENDPOINT = `${SUPABASE_URL}/rest/v1/study_events?on_conflict=user_id,client_id`;
const OUTBOX_KEY = "vocab-trainer:outbox";
const BATCH_SIZE = 25; // flush once this many events are waiting
const FLUSH_MS = 15000; // …or this long after the first one
const CHUNK = 50; // rows per request — keeps an unload POST inside the 64 KB keepalive cap
const OUTBOX_CAP = 2000; // hard ceiling so a long outage cannot fill up storage
const POST_TIMEOUT_MS = 15000; // a stalled request must not wedge the queue behind it

let buffer = [];
let timer = null;
let inFlight = null;

// ---------------------------------------------------------------------------
// Outbox — the durability layer
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
  try {
    if (kept.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(kept));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch (err) {
    console.warn("Study log: could not park events —", err.message);
  }
}

/**
 * Move the in-memory buffer into the outbox.
 *
 * Synchronous and called before every send, so from this point on the events
 * survive anything that can happen to the page.
 */
function park() {
  if (!buffer.length) return;
  writeOutbox([...readOutbox(), ...buffer]);
  buffer = [];
}

/** Drop the rows a request confirmed, keeping anything logged in the meantime. */
function forget(rows) {
  const done = new Set(rows.map((r) => r.client_id));
  writeOutbox(readOutbox().filter((r) => !done.has(r.client_id)));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * POST one chunk. Resolves true only when the server has the rows.
 *
 * The timeout matters more than it looks: flushes run one after another, so a
 * request left hanging on a half-open mobile connection would block every
 * later flush — including the one the progress page waits on.
 */
async function post(rows, keepalive) {
  const token = accessToken();
  if (!token) return false;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      keepalive,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Profile": DB_SCHEMA,
        Prefer: "return=minimal,resolution=ignore-duplicates",
      },
      body: JSON.stringify(rows),
    });
    if (res.ok) return true;
    console.warn(`Study log: batch deferred — HTTP ${res.status} ${res.statusText}`);
  } catch (err) {
    console.warn("Study log: batch deferred —", err.message);
  }
  return false;
}

/**
 * Push everything parked to Supabase, oldest first.
 *
 * Stops at the first failed chunk and leaves the rest parked: a retry with a
 * live connection is always better than dropping the tail.
 */
async function sendAll() {
  const user = currentUser();
  if (!user) return;

  park();
  // Events parked by a previous account stay untouched rather than being
  // re-attributed — row level security would reject them anyway.
  const mine = readOutbox().filter((r) => r.user_id === user.id);

  for (let i = 0; i < mine.length; i += CHUNK) {
    const chunk = mine.slice(i, i + CHUNK);
    if (!(await post(chunk, false))) return;
    forget(chunk);
  }
}

/**
 * Send pending events and resolve once they are on the server.
 *
 * Runs are serialised end to end rather than skipped when one is already in
 * flight, so `await flush()` always means "everything queued up to this call
 * has been delivered". The progress page depends on that: it flushes before it
 * reads the views, and a flush that returned early would query a database that
 * is still missing the last few answers.
 */
function flush() {
  clearTimeout(timer);
  timer = null;
  if (!currentUser()) return Promise.resolve();

  const run = (inFlight ?? Promise.resolve()).then(sendAll, sendAll);
  inFlight = run;
  return run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
}

/**
 * Last-chance send as the page goes away.
 *
 * `keepalive` lets the request outlive the document, so answering a question
 * and immediately tapping through to the progress page shows that answer. If
 * the browser kills it anyway the rows are still parked, and the next page
 * load delivers them.
 */
function flushOnHide() {
  const user = currentUser();
  if (!user) return;
  park();
  const chunk = readOutbox()
    .filter((r) => r.user_id === user.id)
    .slice(0, CHUNK);
  if (!chunk.length) return;
  void post(chunk, true).then((ok) => ok && forget(chunk));
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

  /** How many events are waiting to reach the server. Drives the footer. */
  get pending() {
    const id = currentUser()?.id;
    if (!id) return 0;
    return buffer.length + readOutbox().filter((r) => r.user_id === id).length;
  },

  /**
   * Queue one study event.
   *
   * Args: deckId, mode, kind ('answer' | 'play' | 'reveal'), term, and the
   * optional `correct` / `chosen` / `ms` detail fields.
   */
  log({ deckId, mode, kind, term, correct = null, chosen = null, ms = null }) {
    const user = currentUser();
    if (!user) return;
    buffer.push({
      // Stamped now, not at send time: an event belongs to whoever was signed
      // in when it happened, even if the outbox outlives the session.
      user_id: user.id,
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
   * The review deck and the mistake list rebuild their cards from this table,
   * so a term must be known here before it can come back. Called once per deck
   * load rather than per question — 20 rows in one round-trip.
   */
  async noteDeck(items, deckId) {
    if (!currentUser() || !items?.length) return;
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
  if (user) void flush();
  document.dispatchEvent(new CustomEvent("studylog:auth", { detail: { user } }));
});

// Leaving the page is the last chance to save the current run. Both events are
// wired because neither fires everywhere: `pagehide` is the reliable one for
// same-tab navigation, `visibilitychange` for a tab backgrounded on mobile and
// then killed by the OS.
window.addEventListener("pagehide", flushOnHide);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushOnHide();
});

// app.js is a classic script and cannot import a module, so the API is also
// hung off `window` — the same bridge voice-prefs.js uses.
window.StudyLog = StudyLog;

export default StudyLog;
