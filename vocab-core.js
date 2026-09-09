/**
 * Parse raw vocab markdown into objects.
 *
 * Blank lines separate entries; we split each non-empty line on ASCII ';'.
 * Fullwidth '；' inside Chinese fields is preserved (we only split on ';').
 *
 * Chinese fields remain empty when absent. Daily generated files also accept
 * the producer’s three-field Chinese form. Personal imports use strict validation.
 */
export function parseVocab(raw) {
  const items = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parts = trimmed.split(";").map((p) => p.trim());
    if (parts.length < 2) continue; // not a vocab line

    // If the line has exactly 3 parts but the 3rd part contains a full-width semicolon
    // (；), it means the LLM used it to separate the Traditional Chinese translation and
    // example sentence instead of a half-width semicolon. Split it to recover all 4 fields.
    if (parts.length === 3 && parts[2].includes("；")) {
      const idx = parts[2].indexOf("；");
      const zhMeaning = parts[2].slice(0, idx).trim();
      const zhExample = parts[2].slice(idx + 1).trim();
      parts = [parts[0], parts[1], zhMeaning, zhExample];
    }

    // Some upstream rows arrive as a numbered list ("1. felt inclined to");
    // strip that enumeration so the term is clean for display AND so the quiz
    // can locate it inside the example sentence.
    const term = parts[0].replace(/^\d+\.\s*/, "");
    const example = parts[1] || "";
    const zhMeaning = parts[2] || "";
    const zhExample = parts[3] || "";
    if (term && example) items.push({ term, example, zhMeaning, zhExample });
  }
  return items;
}

/** Escape a string so it can be embedded literally in a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a case-insensitive RegExp that matches `term` in a sentence even when
 * its words are inflected ("double down on" should match "doubling down on").
 *
 * Each word accepts common suffixes, silent-e/y changes and doubled consonants.
 * Boundaries avoid matching unrelated words ("cut" must not match "cute").
 * Short function words are exact. Irregular forms outside these rules are skipped.
 *
 * Between the term's words we allow up to 2 INSERTED words, so separable phrases
 * still match ("give back gains" → "giving back those gains"). The cap keeps the
 * blank from ballooning across the sentence if the words happen to recur.
 */
export function termPattern(term) {
  const word = (w) => {
    if (w.length <= 2) return escapeRegExp(w);
    if (/e$/i.test(w)) return `${escapeRegExp(w.slice(0, -1))}(?:e|es|ed|ing)`;
    if (/y$/i.test(w)) return `${escapeRegExp(w.slice(0, -1))}(?:y|ies|ied|ying)`;
    const doubled = /[b-df-hj-np-tv-z]$/i.test(w) ? `|${escapeRegExp(w.slice(-1))}(?:ed|ing)` : "";
    return `${escapeRegExp(w)}(?:s|es|ed|ing${doubled})?`;
  };
  const gap = "\\s+(?:\\w+\\s+){0,2}"; // separator: a space, then ≤2 inserted words
  const words = term.trim().split(/\s+/).map(word);
  return new RegExp(`(?<!\\w)${words.join(gap)}(?!\\w)`, "i");
}

/** Eligible items and distinct answers prevent empty or duplicate quiz choices. */
export function eligibleItems(items, mode) {
  if (mode === "quiz") return items.filter((item) => item.zhMeaning.trim());
  if (mode === "fill") return items.filter((item) => item.term.trim() && termPattern(item.term).test(item.example));
  return items;
}

export function answerChoices(items, item, mode) {
  const field = mode === "quiz" ? "zhMeaning" : "term";
  return [...new Set(items.filter((other) => other.term !== item.term && other[field] !== item[field]).map((other) => other[field]))];
}
