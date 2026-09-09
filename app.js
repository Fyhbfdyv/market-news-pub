/* Market News · Vocab Trainer
 *
 * A dependency-free single-page app. It is DATA-DRIVEN: it never hardcodes
 * vocabulary. At load it fetches `summaries/index.json` (a manifest the
 * pipeline regenerates daily), then fetches the chosen `*_vocab.md` file and
 * parses it. New vocab therefore appears with zero code changes.
 *
 * Vocab line format (semicolon-separated, ASCII ';' between the 4 fields):
 *   term; English example; 中文解釋; 中文例句
 *
 * Structure: a tiny "router" swaps the active Mode. Each mode is a small
 * object with a render(items) method that draws into #stage. This keeps the
 * modes decoupled — adding a 5th mode does not touch the others.
 */

import StudyLog from "./study-log.js";
import { currentUser, onAuthChange } from "./sb-client.js";
import { favorites, favoriteControl, manageFavorites } from "./favorites.js";
import { parseVocab, termPattern, eligibleItems, answerChoices } from "./vocab-core.js";

const DATA_BASE = "./summaries/";

/** Capture ownership and deck before asynchronous audio work starts. */
function studyRecorder() {
  const owner = currentUser()?.id;
  const deckId = router.deckId;
  const render = router.render;
  return (fields) => {
    if (currentUser()?.id !== owner || router.render !== render) return;
    StudyLog.log({ deckId, ...fields });
    updateFooter();
  };
}

// ---------------------------------------------------------------------------
// Data layer: fetching + parsing
// ---------------------------------------------------------------------------

/** Fetch and return the deck manifest (newest first). */
async function loadManifest() {
  const res = await fetch(`${DATA_BASE}index.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Manifest not found (HTTP ${res.status})`);
  return res.json();
}

/** Fetch one deck file and return parsed vocab items. */
async function loadDeck(filename) {
  const res = await fetch(`${DATA_BASE}${filename}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Deck not found: ${filename}`);
  return parseVocab(await res.text());
}

// ---------------------------------------------------------------------------
// Speech layer (Web Speech API) — shared by Listening + Shadowing
// ---------------------------------------------------------------------------

// Screen Wake Lock — keep the phone's screen awake during audio playback.
// One job: own the WakeLockSentinel and re-acquire it after the OS drops it.
const WakeLock = {
  _sentinel: null,
  _wanted: false, // are we *currently* meant to be holding a lock?

  /** Ask the OS to keep the screen on. Safe to call when unsupported. */
  async acquire() {
    this._wanted = true;
    if (!("wakeLock" in navigator)) return; // e.g. iOS Safari < 16.4
    try {
      this._sentinel = await navigator.wakeLock.request("screen");
    } catch (err) {
      // Rejected (low battery, not a user gesture, etc.) — non-fatal:
      // playback continues, the screen just may dim as usual.
      console.warn("Wake Lock request failed:", err);
    }
  },

  /** Drop the lock and stop wanting it. */
  async release() {
    this._wanted = false;
    if (this._sentinel) {
      await this._sentinel.release();
      this._sentinel = null;
    }
  },
};

// iOS auto-releases the lock whenever the tab is backgrounded. When we come
// back to the foreground, re-acquire it — but only if playback still wants it.
document.addEventListener("visibilitychange", () => {
  if (WakeLock._wanted && document.visibilityState === "visible") {
    WakeLock.acquire();
  }
});

const Speech = {
  cancelled: false,
  runId: 0,

  /** Pick the best available voice for a BCP-47 language prefix. */
  voiceFor(langPrefix) {
    // Delegate to the shared VoicePrefs store so the voice chosen in the ⚙
    // settings panel applies here. Fall back to the original "first matching
    // lang" behaviour if voice-prefs.js failed to load (defensive).
    if (window.VoicePrefs) return window.VoicePrefs.voiceFor(langPrefix);
    const voices = speechSynthesis.getVoices();
    return voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) || null;
  },

  /** Speak `text` and resolve when finished (or on cancel/error). */
  speak(text, lang, rate = 1) {
    return new Promise((resolve) => {
      if (Speech.cancelled || !text) return resolve();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang;
      utter.rate = rate;
      const voice = Speech.voiceFor(lang.slice(0, 2));
      if (voice) utter.voice = voice;
      utter.onend = resolve;
      utter.onerror = resolve;
      speechSynthesis.speak(utter);
    });
  },

  /** Non-blocking pause that also aborts early if cancelled. */
  wait(ms) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (Speech.cancelled || Date.now() - start >= ms) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
  },

  stop() {
    Speech.runId++;
    Speech.cancelled = true;
    speechSynthesis.cancel();
    WakeLock.release(); // audio over → let the screen sleep again
  },

  start() {
    Speech.stop();
    Speech.cancelled = false;
    WakeLock.acquire(); // requested from the Play click → a valid user gesture
  },
};

// Some browsers load voices asynchronously; nudge them to populate.
if ("speechSynthesis" in window) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

// ---------------------------------------------------------------------------
// Small DOM helpers — keep the mode code declarative and readable
// ---------------------------------------------------------------------------

const stage = document.getElementById("status").parentElement;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clearStage() {
  Speech.stop(); // leaving a mode must silence any audio loop
  stage.replaceChildren();
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Mode: Flashcard
// ---------------------------------------------------------------------------

const FlashcardMode = {
  render(items) {
    const logEvent = studyRecorder();
    let index = 0;
    let flipped = false;

    const card = el("div", { className: "card" });
    const progress = el("div", { className: "progress" });
    const actions = el("div", { className: "actions" });

    const draw = () => {
      const item = items[index];
      card.replaceChildren();
      if (!item.zhMeaning && !item.zhExample) flipped = false;
      if (!flipped) {
        card.append(
          el("div", { className: "term", textContent: item.term }),
          el("div", { className: "divider" }),
          el("div", { className: "example", textContent: item.example }),
          el("div", { className: "hint", textContent: item.zhMeaning || item.zhExample ? "Tap to reveal meaning" : "English sentence" })
        );
      } else {
        card.append(
          el("div", { className: "zh-meaning", textContent: item.zhMeaning }),
          el("div", { className: "divider" }),
          el("div", { className: "zh-example", textContent: item.zhExample })
        );
      }
      card.append(saveControl(item));
      progress.replaceChildren(
        el("span", { textContent: `${index + 1} / ${items.length}` }),
        el("span", { className: "pill", textContent: flipped ? "meaning" : "term" })
      );
    };

    card.addEventListener("click", () => {
      if (!items[index].zhMeaning && !items[index].zhExample) return;
      flipped = !flipped;
      // Only the term → meaning direction is a study action worth logging;
      // flipping back is just navigation.
      if (flipped) {
        logEvent({ mode: "flashcard", kind: "reveal", item: items[index] });
      }
      draw();
    });

    const prev = el("button", { className: "btn btn-ghost", textContent: "← Prev" });
    const speak = el("button", { className: "btn", textContent: "🔊 Hear" });
    const next = el("button", { className: "btn btn-primary", textContent: "Next →" });

    prev.onclick = () => {
      index = (index - 1 + items.length) % items.length;
      flipped = false;
      draw();
    };
    next.onclick = () => {
      index = (index + 1) % items.length;
      flipped = false;
      draw();
    };
    speak.onclick = async () => {
      const item = items[index];
      Speech.start();
      // Say the vocab word first, then read its example sentence.
      const runId = Speech.runId;
      await Speech.speak(item.term, "en-US");
      if (runId !== Speech.runId) return;
      if (item.example) await Speech.speak(item.example, "en-US");
    };

    actions.append(prev, speak, next);
    stage.append(progress, card, actions);
    draw();
  },
};

// ---------------------------------------------------------------------------
// Mode: Quiz (multiple choice) + error tracking
// ---------------------------------------------------------------------------

const QuizMode = {
  render(items) {
    const logEvent = studyRecorder();
    if (items.length < 2) {
      stage.append(el("p", { className: "status", textContent: "Need at least 2 items to quiz." }));
      return;
    }

    const deck = shuffle(items);
    let index = 0;
    let correctCount = 0;
    let shownAt = 0; // start of the current question, for response time

    const progress = el("div", { className: "progress" });
    const card = el("div", { className: "card" });
    const options = el("div", { className: "options" });
    const footer = el("div", { className: "actions" });
    const next = el("button", { className: "btn btn-primary", textContent: "Next →", disabled: true });

    const drawQuestion = () => {
      const item = deck[index];
      shownAt = performance.now();

      // Build 4 choices: the correct meaning + 3 distractors from other items.
      const distractors = shuffle(answerChoices(items, item, "quiz")).slice(0, 3);
      const choices = shuffle([item.zhMeaning, ...distractors]);

      card.replaceChildren(
        el("div", { className: "hint", textContent: "What does this mean?" }),
        el("div", { className: "term", textContent: item.term }),
        el("div", { className: "example", textContent: item.example })
      );

      card.append(saveControl(item));
      options.replaceChildren();
      next.disabled = true;

      for (const choice of choices) {
        const btn = el("button", { className: "option", textContent: choice });
        btn.onclick = () => {
          // Lock all options once answered.
          [...options.children].forEach((c) => (c.disabled = true));
          const isCorrect = choice === item.zhMeaning;
          logEvent({
            mode: "quiz",
            kind: "answer",
            item,
            correct: isCorrect,
            chosen: isCorrect ? null : choice,
            ms: performance.now() - shownAt,
          });
          if (isCorrect) {
            btn.classList.add("correct");
            correctCount++;
          } else {
            btn.classList.add("wrong");
            // Also highlight the right answer.
            [...options.children]
              .find((c) => c.textContent === item.zhMeaning)
              ?.classList.add("correct");
          }
          next.disabled = false;
        };
        options.append(btn);
      }

      progress.replaceChildren(
        el("span", { textContent: `${index + 1} / ${deck.length}` }),
        el("span", { className: "pill", textContent: `✓ ${correctCount}` })
      );
    };

    const drawResult = () => {
      const pct = Math.round((correctCount / deck.length) * 100);
      const missed = deck.length - correctCount;
      clearStageLocal();
      stage.append(
        el("div", { className: "card" }, [
          el("div", { className: "term", textContent: `${pct}%` }),
          el("div", { className: "example", textContent: `${correctCount} / ${deck.length} correct` }),
          el("div", { className: "hint", textContent: `${missed} missed this round` }),
        ]),
        el("div", { className: "actions" }, [
          (() => {
            const again = el("button", { className: "btn btn-primary", textContent: "Try again" });
            again.onclick = () => router.setMode("quiz");
            return again;
          })(),
          (() => {
            const review = el("button", { className: "btn", textContent: "Review mistakes" });
            review.onclick = () => router.setDeck(REVIEW_DECK_ID);
            return review;
          })(),
        ])
      );
    };

    const clearStageLocal = () => stage.replaceChildren();

    next.onclick = () => {
      index++;
      if (index >= deck.length) drawResult();
      else drawQuestion();
    };

    footer.append(next);
    stage.append(progress, card, options, footer);
    drawQuestion();
  },
};

// ---------------------------------------------------------------------------
// Mode: Fill in the blanks (cloze) — read the sentence, tap the missing word
// ---------------------------------------------------------------------------

/**
 * Turn an example sentence into a "cloze" — the sentence with `term` hidden
 * behind a blank the learner must fill.
 *
 * Returns a small object with the rendered `node` and a `fill(word, ok)` method
 * that drops the answer into the blank afterwards (coloured by correctness).
 * We expose `fill` instead of re-rendering so the caller never has to know how
 * the blank is built — that's encapsulation.
 *
 * Upstream examples USUALLY contain the term, but often in an inflected form
 * ("clinched" for "clinch", "doubling down on" for "double down on"). We match
 * via `termPattern`, which tolerates that, and blank out the WHOLE matched span
 * so the gap lands in the right place. Ineligible examples are excluded before
 * rendering; an unmatched example is an error, never a made-up trailing blank.
 */
function buildCloze(example, term) {
  const blank = el("span", { className: "blank", textContent: "______" });
  const node = el("div", { className: "cloze" });

  const match = example.match(termPattern(term));
  if (match) {
    node.append(
      example.slice(0, match.index),
      blank,
      example.slice(match.index + match[0].length)
    );
  } else {
    throw new Error("The example does not contain the target word.");
  }

  const fill = (ok) => {
    blank.textContent = match[0];
    blank.classList.add(ok ? "blank-correct" : "blank-wrong");
  };
  return { node, fill };
}

const FillBlankMode = {
  render(items) {
    const logEvent = studyRecorder();
    if (items.length < 2) {
      stage.append(el("p", { className: "status", textContent: "Need at least 2 items to play." }));
      return;
    }

    const deck = shuffle(items);
    let index = 0;
    let correctCount = 0;
    let shownAt = 0;

    const progress = el("div", { className: "progress" });
    const card = el("div", { className: "card" });
    const bank = el("div", { className: "word-bank" });
    const footer = el("div", { className: "actions" });
    const next = el("button", { className: "btn btn-primary", textContent: "Next →", disabled: true });

    const drawQuestion = () => {
      const item = deck[index];
      shownAt = performance.now();

      // Word bank: the correct term + up to 3 distractor terms from other items.
      const distractors = shuffle(answerChoices(items, item, "fill")).slice(0, 3);
      const choices = shuffle([item.term, ...distractors]);

      const cloze = buildCloze(item.example, item.term);
      card.replaceChildren(
        el("div", { className: "hint", textContent: "Fill in the missing word" }),
        cloze.node,
        el("div", { className: "zh-meaning", textContent: item.zhMeaning })
      );

      card.append(saveControl(item));
      bank.replaceChildren();
      next.disabled = true;

      for (const choice of choices) {
        const btn = el("button", { className: "option", textContent: choice });
        btn.onclick = () => {
          // Lock the bank once answered, then reveal the answer in the blank.
          [...bank.children].forEach((c) => (c.disabled = true));
          const isCorrect = choice === item.term;
          cloze.fill(isCorrect);
          logEvent({
            mode: "fill",
            kind: "answer",
            item,
            correct: isCorrect,
            chosen: isCorrect ? null : choice,
            ms: performance.now() - shownAt,
          });
          if (isCorrect) {
            btn.classList.add("correct");
            correctCount++;
          } else {
            btn.classList.add("wrong");
            [...bank.children]
              .find((c) => c.textContent === item.term)
              ?.classList.add("correct");
          }
          next.disabled = false;
        };
        bank.append(btn);
      }

      progress.replaceChildren(
        el("span", { textContent: `${index + 1} / ${deck.length}` }),
        el("span", { className: "pill", textContent: `✓ ${correctCount}` })
      );
    };

    const drawResult = () => {
      const pct = Math.round((correctCount / deck.length) * 100);
      const missed = deck.length - correctCount;
      stage.replaceChildren(
        el("div", { className: "card" }, [
          el("div", { className: "term", textContent: `${pct}%` }),
          el("div", { className: "example", textContent: `${correctCount} / ${deck.length} correct` }),
          el("div", { className: "hint", textContent: `${missed} missed this round` }),
        ]),
        el("div", { className: "actions" }, [
          (() => {
            const again = el("button", { className: "btn btn-primary", textContent: "Try again" });
            again.onclick = () => router.setMode("fill");
            return again;
          })(),
          (() => {
            const review = el("button", { className: "btn", textContent: "Review mistakes" });
            review.onclick = () => router.setDeck(REVIEW_DECK_ID);
            return review;
          })(),
        ])
      );
    };

    next.onclick = () => {
      index++;
      if (index >= deck.length) drawResult();
      else drawQuestion();
    };

    footer.append(next);
    stage.append(progress, card, bank, footer);
    drawQuestion();
  },
};

// ---------------------------------------------------------------------------
// Mode: Listening cycle (auto-play, EN-only or EN+ZH)
// ---------------------------------------------------------------------------

const ListeningMode = {
  render(items) {
    const logEvent = studyRecorder();
    let withChinese = false;
    let rate = 0.9;
    let repeatMode = "off"; // "off" | "all" | "one"

    const nowPlaying = el("div", { className: "now-playing", textContent: "Ready." });
    const card = el("div", { className: "card" });

    const zhToggle = el("input", { type: "checkbox" });
    zhToggle.onchange = () => (withChinese = zhToggle.checked);

    const rateSel = el("select", {});
    for (const r of [0.7, 0.9, 1.0, 1.2]) {
      rateSel.append(el("option", { value: String(r), textContent: `${r}×`, selected: r === rate }));
    }
    rateSel.onchange = () => (rate = parseFloat(rateSel.value));

    const repeatSel = el("select", {});
    for (const [value, label] of [["off", "No repeat"], ["all", "🔁 All"], ["one", "🔂 One"]]) {
      repeatSel.append(el("option", { value, textContent: label, selected: value === repeatMode }));
    }
    // Read live on each loop iteration, so switching mid-playback takes effect.
    repeatSel.onchange = () => (repeatMode = repeatSel.value);

    const toggles = el("div", { className: "toggle-row" }, [
      el("label", {}, [zhToggle, " English + 中文"]),
      el("label", {}, ["Speed ", rateSel]),
      el("label", {}, ["Repeat ", repeatSel]),
    ]);

    const startBtn = el("button", { className: "btn btn-primary", textContent: "▶ Play" });
    const stopBtn = el("button", { className: "btn btn-ghost", textContent: "⏹ Stop", disabled: true });

    const showItem = (item, i) => {
      card.replaceChildren(
        el("div", { className: "term", textContent: item.term }),
        el("div", { className: "divider" }),
        el("div", { className: "example", textContent: item.example }),
        withChinese && item.zhMeaning ? el("div", { className: "zh-meaning", textContent: item.zhMeaning }) : null
      );
      card.append(saveControl(item));
      nowPlaying.textContent = `Playing ${i + 1} / ${items.length}`;
    };

    /** Speak a single item end-to-end. One job: play one card. */
    const playOne = async (item, i, runId) => {
      showItem(item, i);
      const startedAt = performance.now();
      await Speech.speak(item.term, "en-US", rate);
      if (runId !== Speech.runId) return;
      await Speech.speak(item.example, "en-US", rate);
      if (runId !== Speech.runId) return;
      if (withChinese) {
        await Speech.wait(250);
        if (runId !== Speech.runId) return;
        await Speech.speak(item.zhMeaning, "zh-TW", rate);
      }
      if (runId !== Speech.runId) return;
      // Only the active run can record completed audio.
      logEvent({
        mode: "listening",
        kind: "play",
        item,
        ms: performance.now() - startedAt,
      });
      await Speech.wait(600);
    };

    /** Decide the next index given the current repeat policy, or null to stop. */
    const nextIndex = (i) => {
      if (repeatMode === "one") return i; // stay put
      const next = i + 1;
      if (next < items.length) return next; // more items left
      return repeatMode === "all" ? 0 : null; // wrap around, or stop
    };

    const run = async () => {
      Speech.start();
      const runId = Speech.runId;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      let i = 0;
      while (!Speech.cancelled && runId === Speech.runId) {
        await playOne(items[i], i, runId);
        if (Speech.cancelled || runId !== Speech.runId) break;
        const next = nextIndex(i);
        if (next === null) break;
        i = next;
      }
      if (runId !== Speech.runId) return;
      nowPlaying.textContent = Speech.cancelled ? "Stopped." : "Done ✓";
      startBtn.disabled = false;
      stopBtn.disabled = true;
    };

    startBtn.onclick = run;
    stopBtn.onclick = () => {
      Speech.stop();
      nowPlaying.textContent = "Stopped.";
      startBtn.disabled = false;
      stopBtn.disabled = true;
    };

    stage.append(toggles, nowPlaying, card, el("div", { className: "actions" }, [startBtn, stopBtn]));
  },
};

// ---------------------------------------------------------------------------
// Mode: Shadowing (hear → pause to repeat aloud → advance)
// ---------------------------------------------------------------------------

const ShadowingMode = {
  render(items) {
    const logEvent = studyRecorder();
    let repeats = 2;
    let gap = 2500; // ms of silence for the learner to repeat

    const nowPlaying = el("div", { className: "now-playing", textContent: "Ready." });
    const card = el("div", { className: "card" });

    const repeatSel = el("select", {});
    for (const n of [1, 2, 3]) {
      repeatSel.append(el("option", { value: String(n), textContent: `${n}×`, selected: n === repeats }));
    }
    repeatSel.onchange = () => (repeats = parseInt(repeatSel.value, 10));

    const gapSel = el("select", {});
    for (const g of [1500, 2500, 4000]) {
      gapSel.append(el("option", { value: String(g), textContent: `${g / 1000}s`, selected: g === gap }));
    }
    gapSel.onchange = () => (gap = parseInt(gapSel.value, 10));

    const toggles = el("div", { className: "toggle-row" }, [
      el("label", {}, ["Repeats ", repeatSel]),
      el("label", {}, ["Pause ", gapSel]),
    ]);

    const startBtn = el("button", { className: "btn btn-primary", textContent: "▶ Start" });
    const stopBtn = el("button", { className: "btn btn-ghost", textContent: "⏹ Stop", disabled: true });

    const run = async () => {
      Speech.start();
      const runId = Speech.runId;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      for (let i = 0; i < items.length; i++) {
        if (Speech.cancelled || runId !== Speech.runId) break;
        const item = items[i];
        const phrase = item.example || item.term;
        card.replaceChildren(
          el("div", { className: "term", textContent: item.term }),
          el("div", { className: "divider" }),
          el("div", { className: "example", textContent: phrase })
        );
        card.append(saveControl(item));
        for (let r = 0; r < repeats; r++) {
          if (Speech.cancelled || runId !== Speech.runId) break;
          nowPlaying.textContent = `Listen (${i + 1}/${items.length})…`;
          const startedAt = performance.now();
          await Speech.speak(phrase, "en-US", 0.9);
          if (runId !== Speech.runId) break;
          nowPlaying.textContent = "🗣️ Your turn — repeat aloud!";
          await Speech.wait(gap);
          if (runId !== Speech.runId) break;
          // One event per repetition: shadowing 3× is three times the practice.
          logEvent({
            mode: "shadowing",
            kind: "play",
            item,
            ms: performance.now() - startedAt,
          });
        }
      }
      if (runId !== Speech.runId) return;
      nowPlaying.textContent = Speech.cancelled ? "Stopped." : "Done ✓";
      startBtn.disabled = false;
      stopBtn.disabled = true;
    };

    startBtn.onclick = run;
    stopBtn.onclick = () => {
      Speech.stop();
      nowPlaying.textContent = "Stopped.";
      startBtn.disabled = false;
      stopBtn.disabled = true;
    };

    stage.append(toggles, nowPlaying, card, el("div", { className: "actions" }, [startBtn, stopBtn]));
  },
};

// ---------------------------------------------------------------------------
// Router: holds current deck + mode, wires the header controls
// ---------------------------------------------------------------------------

const REVIEW_DECK_ID = "__review__";
const FAVORITES_DECK_ID = "__favorites__";

function saveControl(item) {
  const deck = router.manifest?.decks.find((entry) => entry.file === router.deckId);
  return favoriteControl(item, deck ? { sourceDeck: deck.file, sourceLabel: `${deck.date} · ${deck.label}` } : {});
}

const MODES = {
  flashcard: FlashcardMode,
  quiz: QuizMode,
  fill: FillBlankMode,
  listening: ListeningMode,
  shadowing: ShadowingMode,
};

const router = {
  manifest: null,
  items: [],
  deckId: null,
  mode: "flashcard",

  request: 0,
  render: 0,
  async setDeck(deckId, selection = null) {
    const request = ++this.request;
    this.render++;
    this.deckId = deckId;
    this.items = [];
    clearStage();
    setStatus("Loading deck…");
    document.getElementById("deck-select").value = deckId;
    try {
      let items;
      if (deckId === FAVORITES_DECK_ID) {
        items = selection ?? await favorites.load();
      } else if (deckId === REVIEW_DECK_ID) {
        await StudyLog.flush();
        items = await StudyLog.fetchReviewDeck();
      } else {
        const deck = this.manifest?.decks.find((entry) => entry.file === deckId);
        items = deck ? (await loadDeck(deck.file)).map((item) => ({
          ...item, sourceDeck: deck.file, sourceLabel: `${deck.date} · ${deck.label}`,
        })) : [];
      }
      if (request !== this.request) return;
      this.items = items;
      this.renderMode();
    } catch (err) {
      if (request !== this.request) return;
      setStatus(`Could not load deck: ${err.message}`);
      updateFooter();
    }
  },

  /** Switch drill. `paint` is false during boot, where setDeck renders next. */
  setMode(mode, paint = true) {
    this.mode = mode;
    for (const btn of document.querySelectorAll("#mode-nav button")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
    if (paint) this.renderMode();
  },

  renderMode() {
    this.render++;
    clearStage();
    if (!this.items.length) {
      stage.append(
        el("p", {
          className: "status",
          textContent: this.deckId !== REVIEW_DECK_ID
            ? "This deck is empty."
            : StudyLog.active
              ? "No mistakes to review — take a quiz first. 🎉"
              : "Sign in using the account button in the header to keep a review deck.",
        })
      );
      updateFooter();
      return;
    }
    let eligible = eligibleItems(this.items, this.mode);
    if (this.mode === "quiz" || this.mode === "fill") {
      eligible = eligible.filter((item) => answerChoices(eligible, item, this.mode).length > 0);
      const skipped = this.items.length - eligible.length;
      if (skipped) stage.append(el("p", { className: "hint", textContent: `${eligible.length} eligible · ${skipped} skipped (${this.mode === "quiz" ? "missing Chinese meaning or distinct answer choices" : "target not found in example or no distinct answer choices"}).` }));
      if (!eligible.length) {
        stage.append(el("p", { className: "status", textContent: "Not enough eligible sentences for this test." }));
        const switchMode = el("button", { className: "btn", textContent: this.mode === "quiz" ? "Try Fill blanks" : "Use Flashcards" });
        switchMode.onclick = () => this.setMode(this.mode === "quiz" ? "fill" : "flashcard");
        stage.append(switchMode);
        updateFooter();
        return;
      }
    }
    MODES[this.mode].render(eligible);
    updateFooter();
  },
};

function setStatus(text) {
  stage.replaceChildren(el("p", { className: "status", textContent: text }));
}

function updateFooter() {
  const info = document.getElementById("footer-info");
  if (!StudyLog.active) {
    info.textContent = `${router.items.length} item(s) · not signed in — progress is not saved`;
    return;
  }
  const pending = StudyLog.pending;
  info.textContent =
    `${router.items.length} item(s) · recording progress ●` +
    (pending ? ` · ${pending} to sync` : "");
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function populateDeckSelect(manifest) {
  const select = document.getElementById("deck-select");
  select.replaceChildren();
  for (const deck of manifest.decks) {
    select.append(
      el("option", { value: deck.file, textContent: `${deck.date} · ${deck.label}` })
    );
  }
  select.append(el("option", { value: FAVORITES_DECK_ID, textContent: "★ My favorites" }));
  select.append(el("option", { value: REVIEW_DECK_ID, textContent: "★ Review mistakes" }));
  select.onchange = () => router.setDeck(select.value);
}

/**
 * Step through the deck dropdown by one option. delta -1 = newer, +1 = older.
 *
 * We drive the <select> directly (not the manifest array) so the arrows stay in
 * sync with whatever the menu shows — including the trailing "Review mistakes"
 * entry. We clamp at both ends instead of wrapping, mirroring the news reader.
 */
function stepDeck(delta) {
  const select = document.getElementById("deck-select");
  const next = select.selectedIndex + delta;
  if (next < 0 || next >= select.options.length) return; // at the first/last deck
  select.selectedIndex = next;
  router.setDeck(select.value);
}

async function main() {
  let accountId = currentUser()?.id;
  onAuthChange((user) => {
    if (accountId !== user?.id) {
      accountId = user?.id;
      router.request++;
      router.render++;
      clearStage();
      if (router.deckId === FAVORITES_DECK_ID || router.deckId === REVIEW_DECK_ID) {
        void router.setDeck(router.deckId);
      } else if (router.items.length) router.renderMode();
    }
    updateFooter();
  });
  document.getElementById("manage-favorites").onclick = () => {
    Speech.stop();
    manageFavorites((items) => router.setDeck(FAVORITES_DECK_ID, items));
  };

  // Wire mode buttons.
  for (const btn of document.querySelectorAll("#mode-nav button")) {
    btn.onclick = () => router.setMode(btn.dataset.mode);
  }

  // Wire the deck stepper arrows (‹ newer / older ›).
  document.getElementById("prev-deck").onclick = () => stepDeck(-1);
  document.getElementById("next-deck").onclick = () => stepDeck(1);

  populateDeckSelect({ decks: [] });
  try {
    const manifest = await loadManifest();
    router.manifest = manifest;
    populateDeckSelect(manifest);

    // ?deck=&mode= lets the progress page link straight into a drill —
    // "Practise these →" on the mistake list opens the review deck as a quiz.
    const params = new URLSearchParams(location.search);
    const wanted = params.get("deck");
    const select = document.getElementById("deck-select");
    const known = [...select.options].some((o) => o.value === wanted);
    if (MODES[params.get("mode")]) router.setMode(params.get("mode"), false);
    await router.setDeck(known ? wanted : manifest.decks[0]?.file ?? FAVORITES_DECK_ID);
  } catch (err) {
    router.manifest = { decks: [] };
    await router.setDeck(FAVORITES_DECK_ID);
  }
}

main();
