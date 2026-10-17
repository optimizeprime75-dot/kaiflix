export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/titles" && request.method === "GET") {
      try {
        const { results } = await env.DB
          .prepare("SELECT * FROM titles ORDER BY created_at DESC")
          .all();

        return Response.json(results, { headers: corsHeaders });
      } catch (error) {
        return Response.json(
          { error: "Database query failed" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === "/api/titles" && request.method === "POST") {
      if (
        !env.ADMIN_PASSWORD ||
        request.headers.get("X-Admin-Password") !== env.ADMIN_PASSWORD
      ) {
        return Response.json(
          { error: "Unauthorized" },
          { status: 401, headers: corsHeaders }
        );
      }

      try {
        const data = await request.json();

        if (
          typeof data.title !== "string" ||
          !data.title.trim() ||
          !["Movie", "TV Series", "Anime"].includes(data.category)
        ) {
          return Response.json(
            { error: "Valid title and category are required" },
            { status: 400, headers: corsHeaders }
          );
        }

        const result = await env.DB
          .prepare(
            `INSERT INTO titles
             (title, category, year, poster_url, watch_url, download_url)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            data.title.trim(),
            data.category,
            data.year ? Number(data.year) : null,
            data.poster_url || null,
            data.watch_url || null,
            data.download_url || null
          )
          .run();

        return Response.json(
          { success: true, id: result.meta.last_row_id },
          { headers: corsHeaders }
        );
      } catch (error) {
        return Response.json(
          { error: "Could not save title" },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "Not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    return env.ASSETS.fetch(request);
  }
};
