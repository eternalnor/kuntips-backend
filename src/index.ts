export interface Env {
  // D1 binding name from wrangler.toml
  kuntips_db: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Handle CORS preflight (OPTIONS)
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    // ---------------------
    // 1) Simple health endpoint: GET /api/health
    // ---------------------
    if (request.method === "GET" && pathname === "/api/health") {
      return corsResponse({
        status: "ok",
        service: "KunTips backend",
        time: new Date().toISOString(),
      });
    }

    // ---------------------
    // 2) DB health: GET /api/db-health
    // ---------------------
    if (request.method === "GET" && pathname === "/api/db-health") {
      try {
        const result = await env.kuntips_db
          .prepare("SELECT COUNT(*) AS creator_count FROM creators")
          .first<{ creator_count: number }>();

        return corsResponse({
          status: "ok",
          creator_count: result?.creator_count ?? 0,
        });
      } catch (err) {
        return corsResponse(
          {
            status: "error",
            message: (err as Error).message,
          },
          500,
        );
      }
    }

    // ---------------------
    // 3) Creator profile: GET /api/creators/:username
    //    Example: /api/creators/mia
    // ---------------------
    if (request.method === "GET" && pathname.startsWith("/api/creators/")) {
      const segments = pathname.split("/"); // ["", "api", "creators", ":username"]
      const username = segments[3];        // index 3

      if (!username) {
        return corsResponse(
          { error: "Missing username in URL (expected /api/creators/:username)" },
          400,
        );
      }

      try {
        const creator = await env.kuntips_db
          .prepare(
            `
            SELECT
              id,
              username,
              display_name,
              bio,
              avatar_url,
              is_active,
              created_at,
              updated_at
            FROM creators
            WHERE username = ? AND is_active = 1
            `,
          )
          .bind(username)
          .first<{
            id: number;
            username: string;
            display_name: string;
            bio: string;
            avatar_url: string;
            is_active: number;
            created_at: string;
            updated_at: string;
          }>();

        if (!creator) {
          return corsResponse(
            { error: "Creator not found or inactive", username },
            404,
          );
        }

        return corsResponse({
          id: creator.id,
          username: creator.username,
          display_name: creator.display_name,
          bio: creator.bio,
          avatar_url: creator.avatar_url || null,
          is_active: !!creator.is_active,
          created_at: creator.created_at,
          updated_at: creator.updated_at,
        });
      } catch (err) {
        return corsResponse(
          {
            status: "error",
            message: (err as Error).message,
          },
          500,
        );
      }
    }

    // ---------------------
    // 4) Fallback for everything else
    // ---------------------
    return corsResponse(
      {
        error: "Not found",
        path: pathname,
      },
      404,
    );
  },
};

function corsResponse(body: unknown, status = 200): Response {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (body === null) {
    // For OPTIONS / empty responses
    return new Response(null, { status, headers });
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });
}
