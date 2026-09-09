import { client, currentUser, onAuthChange } from "./sb-client.js";
import { createFavoriteStore, previewImport, sentenceKey } from "./favorites-core.js";

export const favorites = createFavoriteStore(client, currentUser);
let accountId;
onAuthChange((user) => {
  if (accountId === user?.id) return;
  accountId = user?.id;
  favorites.reset();
  document.querySelectorAll(".favorites-dialog").forEach((dialog) => dialog.close());
  if (user) void favorites.load().catch(() => {}); // visible actions report load failures
});

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  Object.assign(element, props);
  for (const child of children) if (child != null) element.append(child);
  return element;
}
function button(label, onclick) {
  return node("button", { type: "button", className: "btn", textContent: label, onclick });
}
function paintButtons() {
  const keys = new Set(favorites.items.map(sentenceKey));
  document.querySelectorAll("button[data-favorite-key]").forEach((btn) => {
    const saved = keys.has(btn.dataset.favoriteKey);
    btn.textContent = saved ? "★ Saved" : "☆ Save sentence";
    btn.setAttribute("aria-pressed", String(saved));
  });
}
favorites.subscribe(paintButtons);

/** A save control shared by every practice mode. Errors stay beside the action. */
export function favoriteControl(item, source = {}) {
  const message = node("span", { className: "favorite-error" });
  message.setAttribute("role", "alert");
  const btn = button(favorites.items.some((entry) => sentenceKey(entry) === sentenceKey(item)) ? "★ Saved" : "☆ Save sentence", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    message.textContent = "";
    try {
      await favorites.load();
      const saved = favorites.items.find((entry) => sentenceKey(entry) === sentenceKey(item));
      if (saved) await favorites.remove(saved.id);
      else await favorites.save([{ ...item, ...source }]);
    } catch (err) {
      message.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  btn.dataset.favoriteKey = sentenceKey(item);
  btn.setAttribute("aria-pressed", String(favorites.items.some((entry) => sentenceKey(entry) === sentenceKey(item))));
  return node("div", { className: "favorite-control" }, [btn, message]);
}

/** Manage personal sentences, then send the chosen set to the existing trainer. */
export function manageFavorites(onPractice) {
  const dialog = node("dialog", { className: "favorites-dialog" });
  dialog.setAttribute("aria-labelledby", "favorites-title");
  const message = node("p", { className: "favorite-error" });
  message.setAttribute("role", "alert");
  const content = node("div");
  const close = button("Close", () => dialog.close());
  dialog.append(node("div", { className: "favorites-heading" }, [
    node("h2", { id: "favorites-title", textContent: "My favorites" }), close,
  ]), message, content);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  let busy = false;
  async function action(task) {
    if (busy) return;
    busy = true;
    message.textContent = "";
    content.inert = true;
    try { await task(); }
    catch (err) { if (dialog.open) message.textContent = err.message; }
    finally { busy = false; content.inert = false; }
  }
  let query = "";
  const selected = new Set();
  function listing() {
    if (!dialog.open) return;
    const search = node("input", { type: "search", placeholder: "Search words or sentences", value: query });
    search.setAttribute("aria-label", "Search favorites");
    const list = node("div", { className: "favorites-list" });
    const practice = button("Practice selected", () => {
      const chosen = favorites.items.filter((item) => selected.has(item.id));
      if (!chosen.length) return;
      dialog.close();
      onPractice(chosen);
    });
    const all = button("Practice all", () => { dialog.close(); onPractice([...favorites.items]); });
    all.disabled = !favorites.items.length;
    function draw() {
      list.replaceChildren();
      const shown = favorites.items.filter((item) =>
        [item.term, item.example, item.zhMeaning, item.zhExample].join(" ").toLowerCase().includes(query.toLowerCase()));
      practice.textContent = `Practice selected (${selected.size})`;
      practice.disabled = !selected.size;
      for (const item of shown) {
        const check = node("input", { type: "checkbox", checked: selected.has(item.id) });
        check.setAttribute("aria-label", `Select ${item.term}: ${item.example}`);
        check.onchange = () => { check.checked ? selected.add(item.id) : selected.delete(item.id); draw(); };
        const source = item.sourceDeck
          ? node("a", { href: `./index.html?deck=${encodeURIComponent(item.sourceDeck)}`, textContent: item.sourceLabel || item.sourceDeck })
          : node("span", { textContent: "Added by you" });
        list.append(node("article", { className: "favorite-row" }, [
          check,
          node("div", { className: "favorite-copy" }, [
            node("strong", { textContent: item.term }), node("p", { textContent: item.example }),
            item.zhMeaning ? node("p", { textContent: item.zhMeaning }) : null,
            item.zhExample ? node("p", { textContent: item.zhExample }) : null,
            node("small", {}, [source]),
            node("div", { className: "actions" }, [
              button("Edit", () => editor(item)),
              button("Delete", () => {
                if (!confirm(`Remove “${item.term}” from favorites? Study history will be kept.`)) return;
                void action(async () => { await favorites.remove(item.id); selected.delete(item.id); listing(); });
              }),
            ]),
          ]),
        ]));
      }
      if (!shown.length) list.append(node("p", { textContent: favorites.items.length ? "No matching sentences." : "No favorites yet. Save a daily sentence or add your own." }));
    }
    search.oninput = () => { query = search.value; draw(); };
    content.replaceChildren(node("div", { className: "actions" }, [
      button("Add sentence", () => editor()), button("Import text / file", importer),
      practice, all,
      button("Select matching", () => {
        favorites.items.filter((item) => [item.term, item.example, item.zhMeaning, item.zhExample].join(" ").toLowerCase().includes(query.toLowerCase())).forEach((item) => selected.add(item.id));
        draw();
      }),
      button("Clear selection", () => { selected.clear(); draw(); }),
    ]), search, list);
    draw();
  }
  function editor(item = null) {
    message.textContent = "";
    const form = node("form", { className: "favorite-form" });
    const fields = {};
    for (const [key, label] of [["term", "English word / phrase"], ["example", "English example"], ["zhMeaning", "中文意思（選填）"], ["zhExample", "中文例句（選填）"]]) {
      const input = node("textarea", { value: item?.[key] ?? "", required: key === "term" || key === "example", maxLength: 4000, rows: key === "term" ? 1 : 2 });
      fields[key] = input;
      form.append(node("label", {}, [label, input]));
    }
    form.append(node("div", { className: "actions" }, [
      node("button", { type: "submit", className: "btn btn-primary", textContent: "Save" }), button("Back", listing),
    ]));
    form.onsubmit = (event) => {
      event.preventDefault();
      const entry = { ...item, ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value.trim()])) };
      if (!entry.term || !entry.example) { message.textContent = "English word and example are required."; return; }
      if (favorites.items.some((other) => other.id !== item?.id && sentenceKey(other) === sentenceKey(entry))) {
        message.textContent = "This word and sentence are already saved.";
        return;
      }
      void action(async () => { await favorites.save([entry], item?.id); listing(); });
    };
    content.replaceChildren(form);
  }
  function importer() {
    message.textContent = "";
    const input = node("textarea", { rows: 7, placeholder: "word; English example; 中文意思; 中文例句" });
    input.setAttribute("aria-label", "Sentences to import");
    const file = node("input", { type: "file", accept: ".txt,.md,text/plain,text/markdown" });
    file.setAttribute("aria-label", "Upload text or Markdown file");
    const preview = node("div", { className: "import-preview" });
    let result = null;
    const save = button("Import", () => void action(async () => {
      if (!result || result.errors.length || !result.items.length) return;
      await favorites.save(result.items);
      listing();
    }));
    save.disabled = true;
    const invalidate = () => { result = null; preview.replaceChildren(); save.disabled = true; };
    input.oninput = invalidate;
    file.onchange = () => void action(async () => {
      invalidate();
      const picked = file.files[0];
      if (!picked) return;
      if (picked.size > 2_000_000) throw new Error("Use a file smaller than 2 MB.");
      input.value = await picked.text();
    });
    content.replaceChildren(
      node("p", { textContent: "One sentence per line: word; English example; Chinese meaning (optional); Chinese example (optional). Use ； inside fields. Up to 500 new sentences per import." }),
      file, input,
      node("div", { className: "actions" }, [button("Preview", () => {
        result = previewImport(input.value, favorites.items);
        preview.replaceChildren(node("p", { textContent: `${result.items.length} new · ${result.duplicates} duplicates · ${result.errors.length} errors` }));
        for (const error of result.errors) preview.append(node("p", { className: "favorite-error", textContent: `${error.line ? `Line ${error.line}: ` : ""}${error.message}` }));
        for (const item of result.items) preview.append(node("p", { textContent: [item.term, item.example, item.zhMeaning, item.zhExample].filter(Boolean).join(" · ") }));
        save.disabled = result.errors.length > 0 || !result.items.length;
      }), save, button("Back", listing)]), preview,
    );
  }
  content.append(node("p", { textContent: "Loading favorites…" }));
  void action(async () => { await favorites.load(); listing(); });
}
