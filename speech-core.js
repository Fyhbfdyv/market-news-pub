/* Market News · Speech core
 *
 * The ONE place that calls speechSynthesis.speak()/cancel(). Every page speaks
 * through a speaker made here, so browser quirks are handled once:
 *
 *   - cancel() only when something is actually speaking or queued. WebKit's
 *     platform cancel is asynchronous, and before Safari 27 it could also drop
 *     the utterance we speak right after it (WebKit bug 191745).
 *   - speak() stays synchronous inside the caller's click handler, because iOS
 *     ignores speech that does not start from a user gesture.
 *   - A strong reference to the live utterance, so it cannot be garbage
 *     collected mid-speech (then onend never fires and callers hang).
 *   - An utterance that ends without ever starting was dropped (a lost
 *     cancel/speak race, or a saved voice the OS no longer ships). Retry once,
 *     letting the browser pick a voice from `lang`.
 */

export const RETRY_DELAY_MS = 250;

/**
 * Create a speaker where each speak() replaces whatever is playing.
 *
 * `speak(text, { lang, rate })` resolves `true` once the text was spoken, or
 * `false` when it was stopped, replaced, or never started. It never rejects.
 * `stop()` silences speech and settles the pending speak() at once.
 */
export function createSpeaker({ synth, Utterance, voiceFor, schedule = setTimeout }) {
  let active = null; // { settle, utterance } for the in-flight speak() call

  function stop() {
    const call = active;
    active = null;
    if (synth.speaking || synth.pending) synth.cancel();
    call?.settle(false);
  }

  function speak(text, { lang, rate = 1 }) {
    stop();
    if (!text) return Promise.resolve(false);

    return new Promise((resolve) => {
      const call = { settle: resolve, utterance: null };
      active = call;

      const attempt = (voice, canRetry) => {
        const utterance = new Utterance(text);
        utterance.lang = lang;
        utterance.rate = rate;
        if (voice) utterance.voice = voice;
        let started = false;
        utterance.onstart = () => {
          started = true;
        };
        utterance.onend = utterance.onerror = () => {
          if (active !== call || call.utterance !== utterance) return; // stale
          if (started || !canRetry) {
            active = null;
            call.settle(started);
            return;
          }
          call.utterance = null; // ignore any second event from the dropped one
          schedule(() => {
            if (active === call) attempt(null, false);
          }, RETRY_DELAY_MS);
        };
        call.utterance = utterance;
        if (synth.paused) synth.resume(); // iOS can stay paused after backgrounding
        synth.speak(utterance);
      };

      attempt(voiceFor(lang), true);
    });
  }

  return { speak, stop };
}
