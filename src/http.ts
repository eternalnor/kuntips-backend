// http.ts
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://kuntips.no",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function corsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
