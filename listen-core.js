/* Market News · Listen page core
 *
 * Pure helpers that turn a summary or vocab deck into plain English prose for
 * Safari's "Listen to Page". Safari reads the Reader view with the Siri voice,
 * so the page must be one <article> of <p> paragraphs: subheadings become bold
 * lead-ins, and anything that sounds like noise (emoji, ticker symbols, link
 * URLs, markdown markers, Chinese fields) never reaches the page.
 */

export const REPEAT_CHOICES = [1, 3, 5, 10];
export const DEFAULT_REPEAT = 5;

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]/gu;
const TICKER = /\s*\([A-Z]{1,5}(?:\.[A-Z])?\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** A repeat count from a query value; anything unexpected means the default. */
export function parseRepeat(value) {
  const n = Number(value);
  return REPEAT_CHOICES.includes(n) ? n : DEFAULT_REPEAT;
}

/** Relative URL of the listen page for `{ news }` or `{ vocab, repeat }`. */
export function listenHref({ news, vocab, repeat }) {
  const params = news ? { news } : { vocab, repeat: String(parseRepeat(repeat)) };
  return `./listen.html?${new URLSearchParams(params)}`;
}

/** "2026-09-14" → "September 14, 2026", which Siri reads naturally. */
export function spokenDate(isoDay) {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Strip markdown and symbols that sound like noise when read aloud. */
export function speechText(text) {
  return text
    .replace(LINK, "$1")
    .replace(/(\*\*|__|\*|`)/g, "")
    .replace(TICKER, "")
    .replace(EMOJI, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

/** End a spoken phrase with a full stop unless it already has punctuation. */
function sentence(text) {
  return /[.!?:]$/.test(text) ? text : `${text}.`;
}

/**
 * Turn a daily summary into `{ lead, text }` paragraphs.
 *
 * `# 1. Title` becomes "Theme 1: Title." and each `## Section` label is folded
 * into the next paragraph as "Section:" so Reader never drops a short line.
 */
export function newsParagraphs(markdown) {
  const paragraphs = [];
  let themes = 0;
  let label = null;
  const flushLabel = () => {
    if (label) paragraphs.push({ lead: label, text: "" });
    label = null;
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(-{3,}|\*{3,})$/.test(line)) continue;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading?.[1] === "#") {
      flushLabel();
      themes++;
      const title = speechText(heading[2].replace(/^\d+\.\s*/, ""));
      paragraphs.push({ lead: sentence(`Theme ${themes}: ${title}`), text: "" });
    } else if (heading) {
      flushLabel();
      label = `${speechText(heading[2]).replace(/:$/, "")}:`;
    } else {
      const text = speechText(line.replace(/^(?:[-*+]|\d+\.|>)\s+/, ""));
      if (!text) continue;
      paragraphs.push({ lead: label, text });
      label = null;
    }
  }
  flushLabel();
  return paragraphs;
}

/**
 * Turn vocab items into English-only paragraphs, the whole deck `repeat` times.
 * The first paragraph of each pass starts with "Round N." as a spoken marker.
 */
export function vocabParagraphs(items, repeat) {
  const paragraphs = [];
  for (let round = 1; round <= repeat; round++) {
    items.forEach((item, i) => {
      const term = speechText(item.term);
      const spokenTerm = sentence(term.charAt(0).toUpperCase() + term.slice(1));
      paragraphs.push({
        lead: i === 0 ? `Round ${round}.` : null,
        text: `${spokenTerm} ${speechText(item.example)}`,
      });
    });
  }
  return paragraphs;
}
