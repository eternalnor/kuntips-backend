// src/rateLimit.ts
// Simple fixed-window rate limiter backed by Cloudflare KV.
// A new counter key is minted each window period; KV TTL handles cleanup.

export async function checkRateLimit(
  kv: KVNamespace,
  prefix: string,
  ip: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rl:${prefix}:${ip}:${windowId}`;

  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= limit) return false; // blocked

  // Increment — keep the key alive for two full windows so there's no edge-case
  // where a key expires mid-window and resets the counter early.
  await kv.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
  return true; // allowed
}
