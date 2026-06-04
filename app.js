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

"use strict";

const DATA_BASE = "./summaries/";
const MISTAKES_KEY = "vocab-trainer:mistakes";

// ---------------------------------------------------------------------------
// Data layer: fetching + parsing
// ---------------------------------------------------------------------------

/** Fetch and return the deck manifest (newest first). */
async function loadManifest() {
  const res = await fetch(`${DATA_BASE}index.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Manifest not found (HTTP ${res.status})`);
  return res.json();
}

/**
 * Parse raw vocab markdown into objects.
 *
 * Blank lines separate entries; we split each non-empty line on ASCII ';'.
 * Fullwidth '；' inside Chinese fields is preserved (we only split on ';').
 *
 * Upstream is occasionally inconsistent: most lines give the full
 * "term; en; zh_meaning; zh_example" (4 fields), but ~9% collapse the Chinese
 * into a single field (3 fields). We map defensively so EVERY item ends up
 * with a non-empty `zhMeaning` — the quiz uses it as the answer key, so an
 * empty one would break that mode.
 */
function parseVocab(raw) {
  const items = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(";").map((p) => p.trim());
    if (parts.length < 2) continue; // not a vocab line
    const term = parts[0];
    const example = parts[1] || "";
    const zhMeaning = parts[2] || example || term; // never empty
    const zhExample = parts[3] || "";
    items.push({ term, example, zhMeaning, zhExample });
  }
  return items;
}

/** Fetch one deck file and return parsed vocab items. */
async function loadDeck(filename) {
  const res = await fetch(`${DATA_BASE}${filename}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Deck not found: ${filename}`);
  return parseVocab(await res.text());
}

// ---------------------------------------------------------------------------
// Mistakes store (localStorage) — persists the quiz "wrong answers" deck
// ---------------------------------------------------------------------------

const Mistakes = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(MISTAKES_KEY)) || [];
    } catch {
      return [];
    }
  },
  add(item) {
    const all = Mistakes.load();
    if (!all.some((m) => m.term === item.term)) {
      all.push(item);
      localStorage.setItem(MISTAKES_KEY, JSON.stringify(all));
    }
  },
  remove(term) {
    const all = Mistakes.load().filter((m) => m.term !== term);
    localStorage.setItem(MISTAKES_KEY, JSON.stringify(all));
  },
  clear() {
    localStorage.removeItem(MISTAKES_KEY);
  },
};

// ---------------------------------------------------------------------------
// Speech layer (Web Speech API) — shared by Listening + Shadowing
// ---------------------------------------------------------------------------

const Speech = {
  cancelled: false,

  /** Pick the best available voice for a BCP-47 language prefix. */
  voiceFor(langPrefix) {
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
    Speech.cancelled = true;
    speechSynthesis.cancel();
  },

  start() {
    Speech.cancelled = false;
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
    let index = 0;
    let flipped = false;

    const card = el("div", { className: "card" });
    const progress = el("div", { className: "progress" });
    const actions = el("div", { className: "actions" });

    const draw = () => {
      const item = items[index];
      card.replaceChildren();
      if (!flipped) {
        card.append(
          el("div", { className: "term", textContent: item.term }),
          el("div", { className: "divider" }),
          el("div", { className: "example", textContent: item.example }),
          el("div", { className: "hint", textContent: "Tap to reveal meaning" })
        );
      } else {
        card.append(
          el("div", { className: "zh-meaning", textContent: item.zhMeaning }),
          el("div", { className: "divider" }),
          el("div", { className: "zh-example", textContent: item.zhExample })
        );
      }
      progress.replaceChildren(
        el("span", { textContent: `${index + 1} / ${items.length}` }),
        el("span", { className: "pill", textContent: flipped ? "meaning" : "term" })
      );
    };

    card.addEventListener("click", () => {
      flipped = !flipped;
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
      await Speech.speak(item.term, "en-US");
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
    if (items.length < 2) {
      stage.append(el("p", { className: "status", textContent: "Need at least 2 items to quiz." }));
      return;
    }

    const deck = shuffle(items);
    let index = 0;
    let correctCount = 0;

    const progress = el("div", { className: "progress" });
    const card = el("div", { className: "card" });
    const options = el("div", { className: "options" });
    const footer = el("div", { className: "actions" });
    const next = el("button", { className: "btn btn-primary", textContent: "Next →", disabled: true });

    const drawQuestion = () => {
      const item = deck[index];

      // Build 4 choices: the correct meaning + 3 distractors from other items.
      const distractors = shuffle(items.filter((i) => i.term !== item.term))
        .slice(0, 3)
        .map((i) => i.zhMeaning);
      const choices = shuffle([item.zhMeaning, ...distractors]);

      card.replaceChildren(
        el("div", { className: "hint", textContent: "What does this mean?" }),
        el("div", { className: "term", textContent: item.term }),
        el("div", { className: "example", textContent: item.example })
      );

      options.replaceChildren();
      next.disabled = true;

      for (const choice of choices) {
        const btn = el("button", { className: "option", textContent: choice });
        btn.onclick = () => {
          // Lock all options once answered.
          [...options.children].forEach((c) => (c.disabled = true));
          const isCorrect = choice === item.zhMeaning;
          if (isCorrect) {
            btn.classList.add("correct");
            correctCount++;
            Mistakes.remove(item.term); // got it right → drop from review deck
          } else {
            btn.classList.add("wrong");
            Mistakes.add(item); // remember this miss for later review
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
      const missed = Mistakes.load().length;
      clearStageLocal();
      stage.append(
        el("div", { className: "card" }, [
          el("div", { className: "term", textContent: `${pct}%` }),
          el("div", { className: "example", textContent: `${correctCount} / ${deck.length} correct` }),
          el("div", { className: "hint", textContent: `${missed} item(s) saved for review` }),
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
// Mode: Listening cycle (auto-play, EN-only or EN+ZH)
// ---------------------------------------------------------------------------

const ListeningMode = {
  render(items) {
    let withChinese = false;
    let rate = 0.9;

    const nowPlaying = el("div", { className: "now-playing", textContent: "Ready." });
    const card = el("div", { className: "card" });

    const zhToggle = el("input", { type: "checkbox" });
    zhToggle.onchange = () => (withChinese = zhToggle.checked);

    const rateSel = el("select", {});
    for (const r of [0.7, 0.9, 1.0, 1.2]) {
      rateSel.append(el("option", { value: String(r), textContent: `${r}×`, selected: r === rate }));
    }
    rateSel.onchange = () => (rate = parseFloat(rateSel.value));

    const toggles = el("div", { className: "toggle-row" }, [
      el("label", {}, [zhToggle, " English + 中文"]),
      el("label", {}, ["Speed ", rateSel]),
    ]);

    const startBtn = el("button", { className: "btn btn-primary", textContent: "▶ Play" });
    const stopBtn = el("button", { className: "btn btn-ghost", textContent: "⏹ Stop", disabled: true });

    const showItem = (item, i) => {
      card.replaceChildren(
        el("div", { className: "term", textContent: item.term }),
        el("div", { className: "divider" }),
        el("div", { className: "example", textContent: item.example }),
        withChinese ? el("div", { className: "zh-meaning", textContent: item.zhMeaning }) : null
      );
      nowPlaying.textContent = `Playing ${i + 1} / ${items.length}`;
    };

    const run = async () => {
      Speech.start();
      startBtn.disabled = true;
      stopBtn.disabled = false;
      for (let i = 0; i < items.length; i++) {
        if (Speech.cancelled) break;
        const item = items[i];
        showItem(item, i);
        await Speech.speak(item.term, "en-US", rate);
        await Speech.speak(item.example, "en-US", rate);
        if (withChinese) {
          await Speech.wait(250);
          await Speech.speak(item.zhMeaning, "zh-TW", rate);
        }
        await Speech.wait(600);
      }
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
      startBtn.disabled = true;
      stopBtn.disabled = false;
      for (let i = 0; i < items.length; i++) {
        if (Speech.cancelled) break;
        const item = items[i];
        const phrase = item.example || item.term;
        card.replaceChildren(
          el("div", { className: "term", textContent: item.term }),
          el("div", { className: "divider" }),
          el("div", { className: "example", textContent: phrase })
        );
        for (let r = 0; r < repeats; r++) {
          if (Speech.cancelled) break;
          nowPlaying.textContent = `Listen (${i + 1}/${items.length})…`;
          await Speech.speak(phrase, "en-US", 0.9);
          nowPlaying.textContent = "🗣️ Your turn — repeat aloud!";
          await Speech.wait(gap);
        }
      }
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

const MODES = {
  flashcard: FlashcardMode,
  quiz: QuizMode,
  listening: ListeningMode,
  shadowing: ShadowingMode,
};

const router = {
  manifest: null,
  items: [],
  deckId: null,
  mode: "flashcard",

  async setDeck(deckId) {
    this.deckId = deckId;
    setStatus("Loading deck…");
    try {
      if (deckId === REVIEW_DECK_ID) {
        this.items = Mistakes.load();
      } else {
        const deck = this.manifest.decks.find((d) => d.file === deckId);
        this.items = deck ? await loadDeck(deck.file) : [];
      }
    } catch (err) {
      setStatus(`Could not load deck: ${err.message}`);
      return;
    }
    document.getElementById("deck-select").value = deckId;
    this.renderMode();
  },

  setMode(mode) {
    this.mode = mode;
    for (const btn of document.querySelectorAll("#mode-nav button")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
    this.renderMode();
  },

  renderMode() {
    clearStage();
    if (!this.items.length) {
      stage.append(
        el("p", {
          className: "status",
          textContent:
            this.deckId === REVIEW_DECK_ID
              ? "No mistakes saved yet — take a quiz first. 🎉"
              : "This deck is empty.",
        })
      );
      updateFooter();
      return;
    }
    MODES[this.mode].render(this.items);
    updateFooter();
  },
};

function setStatus(text) {
  stage.replaceChildren(el("p", { className: "status", textContent: text }));
}

function updateFooter() {
  const info = document.getElementById("footer-info");
  const reviewCount = Mistakes.load().length;
  info.textContent = `${router.items.length} item(s) · ${reviewCount} saved for review`;
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
  // Wire mode buttons.
  for (const btn of document.querySelectorAll("#mode-nav button")) {
    btn.onclick = () => router.setMode(btn.dataset.mode);
  }

  // Wire the deck stepper arrows (‹ newer / older ›).
  document.getElementById("prev-deck").onclick = () => stepDeck(-1);
  document.getElementById("next-deck").onclick = () => stepDeck(1);

  try {
    const manifest = await loadManifest();
    router.manifest = manifest;
    if (!manifest.decks || manifest.decks.length === 0) {
      setStatus("No vocab decks found yet.");
      return;
    }
    populateDeckSelect(manifest);
    await router.setDeck(manifest.decks[0].file);
  } catch (err) {
    setStatus(`Startup failed: ${err.message}`);
  }
}

main();
