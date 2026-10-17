
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: corsHeaders
      });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // Only API routes are handled here.
    if (url.pathname === "/api/titles") {
      if (request.method === "GET") {
        try {
          const { results } = await env.DB
            .prepare(
              "SELECT * FROM titles ORDER BY created_at DESC, id DESC"
            )
            .all();

          return json(results);
        } catch (error) {
          console.error("GET /api/titles failed:", error);
          return json({ error: "Database read failed" }, 500);
        }
      }

      if (request.method === "POST") {
        const savedPassword = env.ADMIN_PASSWORD;
        const enteredPassword =
          request.headers.get("X-Admin-Password");

        if (!savedPassword) {
          console.error("ADMIN_PASSWORD is missing from Worker environment");
          return json({
            error: "Server configuration error: ADMIN_PASSWORD is missing"
          }, 500);
        }

        if (
          !enteredPassword ||
          enteredPassword !== savedPassword
        ) {
          return json({
            error: "Incorrect admin password"
          }, 401);
        }

        let data;

        try {
          data = await request.json();
        } catch {
          return json({ error: "Invalid JSON request" }, 400);
        }

        if (
          typeof data.title !== "string" ||
          !data.title.trim() ||
          !["Movie", "TV Series", "Anime"].includes(data.category)
        ) {
          return json({
            error: "A valid title and category are required"
          }, 400);
        }

        let year = null;

        if (data.year !== null && data.year !== undefined &&
            data.year !== "") {
          year = Number(data.year);

          if (!Number.isInteger(year) || year < 1888 || year > 2100) {
            return json({ error: "Invalid release year" }, 400);
          }
        }

        const optionalUrl = (value) => {
          if (value === null || value === undefined || value === "") {
            return null;
          }

          if (typeof value !== "string") {
            throw new Error("Invalid URL field");
          }

          const parsed = new URL(value);

          if (!["http:", "https:"].includes(parsed.protocol)) {
            throw new Error("Only HTTP and HTTPS URLs are allowed");
          }

          return parsed.href;
        };

        let posterUrl;
        let watchUrl;
        let downloadUrl;

        try {
          posterUrl = optionalUrl(data.poster_url);
          watchUrl = optionalUrl(data.watch_url);
          downloadUrl = optionalUrl(data.download_url);
        } catch {
          return json({
            error: "Poster, watch and download links must be valid HTTP(S) URLs"
          }, 400);
        }

        try {
          const result = await env.DB
            .prepare(`
              INSERT INTO titles
                (title, category, year, poster_url, watch_url, download_url)
              VALUES (?, ?, ?, ?, ?, ?)
            `)
            .bind(
              data.title.trim(),
              data.category,
              year,
              posterUrl,
              watchUrl,
              downloadUrl
            )
            .run();

          return json({
            success: true,
            id: result.meta.last_row_id,
            message: "Title saved successfully"
          }, 201);
        } catch (error) {
          console.error("POST /api/titles database error:", error);
          return json({ error: "Database save failed" }, 500);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "API endpoint not found" }, 404);
    }

    // Serve website files.
    try {
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Asset serving failed:", error);
      return new Response("Website temporarily unavailable", {
        status: 500
      });
    }
  }
};

