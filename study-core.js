/** Limit UTF-8 payload bytes now that study events include sentence snapshots. */
export function eventChunks(rows, budget = 55000) {
  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = [];
  let bytes = 2;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length + 1;
    if (chunk.length && bytes + size > budget) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
