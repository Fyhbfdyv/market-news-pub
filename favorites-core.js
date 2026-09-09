/** Stable identity: the same term can have several different example sentences. */
export function sentenceKey(item) {
  return JSON.stringify([item.term.trim(), item.example.trim()]);
}

/** Parse a strict personal import and report every invalid line before writing. */
export function previewImport(raw, existing = []) {
  const known = new Set(existing.map(sentenceKey));
  const items = [];
  const errors = [];
  let duplicates = 0;
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const fields = line.split(";").map((field) => field.trim());
    if (fields.length < 2 || fields.length > 4 || !fields[0] || !fields[1]) {
      errors.push({ line: index + 1, message: "Use 2–4 fields; English term and example are required. Use ； inside a field." });
      return;
    }
    if (fields.some((field) => field.length > 4000)) {
      errors.push({ line: index + 1, message: "Each field must be at most 4,000 characters." });
      return;
    }
    const [term, example, zhMeaning = "", zhExample = ""] = fields;
    const item = { term, example, zhMeaning, zhExample };
    const key = sentenceKey(item);
    if (known.has(key)) duplicates++;
    else {
      known.add(key);
      items.push(item);
    }
  });
  if (items.length > 500) errors.push({ line: null, message: "Import at most 500 new sentences at a time." });
  return { items, errors, duplicates };
}

export function fromRow(row) {
  return { id: row.id, term: row.term, example: row.example,
    zhMeaning: row.zh_meaning, zhExample: row.zh_example,
    sourceDeck: row.source_deck, sourceLabel: row.source_label };
}

export function toRow(item) {
  return { term: item.term.trim(), example: item.example.trim(),
    zh_meaning: (item.zhMeaning ?? "").trim(), zh_example: (item.zhExample ?? "").trim(),
    source_deck: item.sourceDeck ?? null, source_label: item.sourceLabel ?? null };
}

/** Account-scoped repository. Explicit ownership also protects in-flight account switches. */
export function createFavoriteStore(client, currentUser) {
  let items = [];
  let revision = 0;
  let loadRevision = 0;
  const listeners = new Set();
  const emit = () => listeners.forEach((listener) => listener());
  function owner() {
    const id = currentUser()?.id;
    if (!id) throw new Error("Sign in using the account button to use favorites.");
    return id;
  }
  function assertOwner(id, version) {
    if (currentUser()?.id !== id || revision !== version) throw new Error("Account changed. Please try again.");
  }
  const store = {
    get items() { return items; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    reset() { revision++; items = []; emit(); },
    async load() {
      const id = owner();
      const version = revision;
      const request = ++loadRevision;
      const rows = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await client.from("favorites").select("*")
          .eq("user_id", id).order("created_at", { ascending: false }).order("id")
          .range(offset, offset + 499);
        assertOwner(id, version);
        if (request !== loadRevision) throw new Error("Favorites changed. Please try again.");
        if (error) throw error;
        rows.push(...data);
        if (data.length < 500) break;
      }
      items = rows.map(fromRow);
      emit();
      return items;
    },
    async save(entries, editId = null) {
      const id = owner();
      const version = revision;
      const rows = entries.map((item) => ({ ...toRow(item), user_id: id }));
      const request = editId
        ? client.from("favorites").update(rows[0]).eq("user_id", id).eq("id", editId)
        : client.from("favorites").upsert(rows, { onConflict: "user_id,sentence_key", ignoreDuplicates: true });
      const { error } = await request;
      assertOwner(id, version);
      if (error) throw error;
      await store.load();
    },
    async remove(itemId) {
      const id = owner();
      const version = revision;
      const { error } = await client.from("favorites").delete().eq("user_id", id).eq("id", itemId);
      assertOwner(id, version);
      if (error) throw error;
      await store.load();
    },
  };
  return store;
}
