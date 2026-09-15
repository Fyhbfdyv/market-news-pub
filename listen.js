/* Market News · Listen page
 *
 * Renders one summary (?news=<file>) or one vocab deck (?vocab=<file>&repeat=N)
 * as English prose for Safari's "Listen to Page". The file must be listed in
 * the manifest, so the query string can never point the page at other paths.
 */

import { parseVocab } from "./vocab-core.js";
import { newsParagraphs, parseRepeat, spokenDate, vocabParagraphs } from "./listen-core.js";

const DATA_BASE = "./summaries/";
const article = document.getElementById("script");

async function fetchOk(path, as) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path} (HTTP ${res.status})`);
  return res[as]();
}

/** Resolve the query to a manifest entry plus how to build its paragraphs. */
function selectScript(manifest, params) {
  if (params.has("news")) {
    const entry = manifest.reports?.find((r) => r.file === params.get("news"));
    return entry && {
      entry,
      back: "./news.html",
      title: `Daily Summary · ${entry.label} · ${spokenDate(entry.date)}`,
      build: (text) => newsParagraphs(text),
    };
  }
  const entry = manifest.decks?.find((d) => d.file === params.get("vocab"));
  const repeat = parseRepeat(params.get("repeat"));
  return entry && {
    entry,
    back: "./index.html",
    title: `Vocabulary · ${entry.label} · ${spokenDate(entry.date)}`,
    build: (text) => vocabParagraphs(parseVocab(text), repeat),
  };
}

function render(title, paragraphs) {
  document.title = title;
  const nodes = paragraphs.map(({ lead, text }) => {
    const p = document.createElement("p");
    if (lead) p.append(Object.assign(document.createElement("strong"), { textContent: lead }));
    if (lead && text) p.append(" ");
    p.append(text);
    return p;
  });
  article.replaceChildren(Object.assign(document.createElement("h1"), { textContent: title }), ...nodes);
}

function fail(message) {
  article.replaceChildren(Object.assign(document.createElement("p"), { className: "status", textContent: message }));
}

async function main() {
  try {
    const manifest = await fetchOk(`${DATA_BASE}index.json`, "json");
    const script = selectScript(manifest, new URLSearchParams(location.search));
    if (!script) return fail("This summary or deck is not available.");
    document.getElementById("back-link").href = script.back;
    const paragraphs = script.build(await fetchOk(`${DATA_BASE}${script.entry.file}`, "text"));
    if (paragraphs.length === 0) return fail("Nothing to read in this file.");
    render(script.title, paragraphs);
  } catch (err) {
    fail(`Could not load: ${err.message}`);
  }
}

main();
