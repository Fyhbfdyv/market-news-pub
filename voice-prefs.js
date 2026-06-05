/* Market News · Shared voice preferences
 *
 * SINGLE SOURCE OF TRUTH for "which voice does the app speak with".
 *
 * Both pages (Vocab Trainer + News reader) load this file. It owns one slice
 * of localStorage and exposes ONE lookup function, `VoicePrefs.voiceFor()`,
 * that every speak-call uses. Because all narration funnels through the same
 * store, changing the voice in the settings panel applies *everywhere* — no
 * per-page wiring, no duplication (the DRY principle).
 *
 * It is self-contained: on load it injects its own "⚙" button into the page
 * header and a settings modal into <body>. So a page opts in with a single
 * <script src="./voice-prefs.js" defer></script> tag and nothing else.
 *
 * Two Web Speech API facts drive the design:
 *   1. speechSynthesis.getVoices() loads ASYNCHRONOUSLY — the first call often
 *      returns [], and the browser fires a "voiceschanged" event when ready.
 *   2. A SpeechSynthesisVoice object cannot be serialised to localStorage. So
 *      we persist its stable `voiceURI` string and re-resolve the live object
 *      at speak-time.
 */

"use strict";

(function () {
  // Reuse the app's existing localStorage namespace ("vocab-trainer:*").
  const STORE_KEY = "vocab-trainer:voices";

  // The two language buckets we let the user configure. A voice has a fixed
  // `lang` (e.g. "en-US", "zh-TW"), so one voice can't cover both — we pick a
  // separate voice per language prefix and choose by the utterance's prefix.
  const BUCKETS = [
    { key: "en", label: "English voice", sample: "This is a test of the English voice." },
    { key: "zh", label: "Chinese voice", sample: "這是中文語音的測試。" },
  ];

  if (!("speechSynthesis" in window)) {
    // Graceful degradation: expose a no-op so callers don't need to guard.
    window.VoicePrefs = { voiceFor: () => null };
    return;
  }

  // ---- Store: { en: "<voiceURI>", zh: "<voiceURI>" } -----------------------

  /** Read the saved voice choices, tolerating a missing/corrupt entry. */
  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      return {};
    }
  }

  /** Persist one bucket's chosen voiceURI (empty string = "browser default"). */
  function saveChoice(bucketKey, voiceURI) {
    const store = loadStore();
    store[bucketKey] = voiceURI;
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  // ---- Voice lookup --------------------------------------------------------

  /** All installed voices whose BCP-47 lang starts with `prefix` ("en"/"zh"). */
  function voicesForPrefix(prefix) {
    return speechSynthesis
      .getVoices()
      .filter((v) => v.lang.toLowerCase().startsWith(prefix));
  }

  /**
   * Resolve the live SpeechSynthesisVoice to use for a language prefix.
   *
   * Order of preference: the user's saved choice → the browser's default
   * voice for that language → null (let the browser decide from utter.lang).
   *
   * @param {string} prefix - A 2-letter language prefix, e.g. "en" or "zh".
   * @returns {SpeechSynthesisVoice|null}
   */
  function voiceFor(prefix) {
    const matching = voicesForPrefix(prefix);
    const savedURI = loadStore()[prefix];
    if (savedURI) {
      const saved = matching.find((v) => v.voiceURI === savedURI);
      if (saved) return saved;
      // Saved voice is gone (uninstalled / different machine) — fall through.
    }
    return matching.find((v) => v.default) || matching[0] || null;
  }

  // Public API used by app.js (Speech.voiceFor) and news.js (toggleSpeech).
  window.VoicePrefs = { voiceFor };

  // ---- Settings UI (gear button + modal) -----------------------------------

  /** Build the modal DOM once and append it to <body>. Returns its parts. */
  function buildModal() {
    const overlay = document.createElement("div");
    overlay.className = "voice-modal-overlay";
    overlay.hidden = true;

    const panel = document.createElement("div");
    panel.className = "voice-modal";
    panel.innerHTML = '<h2 class="voice-modal-title">Voice Settings</h2>';

    // One labelled <select> per language bucket.
    const selects = {};
    for (const bucket of BUCKETS) {
      const row = document.createElement("label");
      row.className = "voice-row";
      row.append(document.createTextNode(bucket.label));

      const wrap = document.createElement("div");
      wrap.className = "voice-row-controls";

      const select = document.createElement("select");
      select.onchange = () => saveChoice(bucket.key, select.value);
      selects[bucket.key] = select;

      const test = document.createElement("button");
      test.type = "button";
      test.className = "btn-ghost";
      test.textContent = "Test";
      test.onclick = () => speakSample(bucket);

      wrap.append(select, test);
      row.append(wrap);
      panel.append(row);
    }

    const actions = document.createElement("div");
    actions.className = "voice-modal-actions";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-primary";
    close.textContent = "Close";
    close.onclick = () => (overlay.hidden = true);
    actions.append(close);
    panel.append(actions);

    overlay.append(panel);
    // Clicking the dimmed backdrop (but not the panel itself) closes it.
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.hidden = true;
    };
    document.body.append(overlay);
    return { overlay, selects };
  }

  /** Speak a bucket's sample sentence with the currently selected voice. */
  function speakSample(bucket) {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(bucket.sample);
    const voice = voiceFor(bucket.key);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    }
    speechSynthesis.speak(utter);
  }

  /** (Re)fill each dropdown with the installed voices for its language. */
  function populateSelects(selects) {
    const store = loadStore();
    for (const bucket of BUCKETS) {
      const select = selects[bucket.key];
      const saved = store[bucket.key] || "";
      select.replaceChildren();
      // First option = let the browser pick (the original behaviour).
      const auto = new Option("Browser default", "");
      select.append(auto);
      for (const voice of voicesForPrefix(bucket.key)) {
        select.append(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI));
      }
      // Restore the saved selection if that voice is still installed.
      select.value = saved;
      if (select.value !== saved) select.value = ""; // saved voice vanished
    }
  }

  /** Inject the ⚙ button into the page header's controls bar. */
  function mountGearButton(overlay) {
    const controls = document.querySelector(".app-header .controls");
    if (!controls) return; // page has no standard header — skip silently
    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "btn-ghost voice-gear";
    gear.textContent = "⚙";
    gear.title = "Voice settings";
    gear.setAttribute("aria-label", "Voice settings");
    gear.onclick = () => (overlay.hidden = false);
    controls.append(gear);
  }

  // ---- Boot ----------------------------------------------------------------

  function init() {
    const { overlay, selects } = buildModal();
    mountGearButton(overlay);

    populateSelects(selects);
    // Voices arrive asynchronously; refresh the menus when they (re)load.
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener("voiceschanged", () =>
      populateSelects(selects)
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
