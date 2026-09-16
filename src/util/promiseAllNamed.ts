// src/util/promiseAllNamed.ts
//
// Promise.all keyed by name instead of position.
//
// The failure this prevents: with `const [a, b, c] = await Promise.all([...])`,
// inserting a query in the middle shifts every variable after it by one. Nothing
// throws, every query is still valid SQL, and the type checker is satisfied
// because the rows are structurally similar — you just silently render the wrong
// number in each cell. It is the kind of bug that survives review precisely
// because the diff looks like "added one query".
//
// Keyed by name, an inserted entry cannot disturb the others.

export async function promiseAllNamed<T extends Record<string, Promise<any>>>(
  tasks: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(tasks) as (keyof T)[];
  const settled = await Promise.all(keys.map((k) => tasks[k]));
  const out = {} as { [K in keyof T]: Awaited<T[K]> };
  keys.forEach((k, i) => {
    out[k] = settled[i];
  });
  return out;
}
