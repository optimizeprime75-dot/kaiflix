function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
        },
      });
    }

    // API: List titles, add titles, and delete titles
    if (
      url.pathname === "/api/titles" ||
      /^\/api\/titles\/\d+$/.test(url.pathname)
    ) {
      // GET: Return all titles
      if (
        request.method === "GET" &&
        url.pathname === "/api/titles"
      ) {
        try {
          const result = await env.DB
            .prepare(
              `SELECT id, title, category, year, poster_url,
                      watch_url, download_url, created_at
               FROM titles
               ORDER BY created_at DESC, id DESC`
            )
            .all();

          return json(result.results);
        } catch (error) {
          console.error("GET titles failed:", error);
          return json(
            { error: "Could not load titles from database" },
            500
          );
        }
      }

      // POST: Add a new title
      if (
        request.method === "POST" &&
        url.pathname === "/api/titles"
      ) {
        const savedPassword = env.ADMIN_PASSWORD;
        const enteredPassword =
          request.headers.get("X-Admin-Password");

        if (!savedPassword) {
          return json(
            { error: "Server configuration error" },
            500
          );
        }

        if (
          !enteredPassword ||
          enteredPassword !== savedPassword
        ) {
          return json(
            { error: "Incorrect admin password" },
            401
          );
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const title =
          typeof body.title === "string"
            ? body.title.trim()
            : "";

        const category =
          typeof body.category === "string"
            ? body.category.trim()
            : "";

        const allowedCategories = [
          "Movie",
          "TV Series",
          "Anime",
        ];

        if (!title) {
          return json(
            { error: "Title is required" },
            400
          );
        }

        if (!allowedCategories.includes(category)) {
          return json(
            {
              error:
                "Category must be Movie, TV Series, or Anime",
            },
            400
          );
        }

        let year = null;

        if (
          body.year !== undefined &&
          body.year !== null &&
          body.year !== ""
        ) {
          year = Number(body.year);

          if (
            !Number.isInteger(year) ||
            year < 1888 ||
            year > 2200
          ) {
            return json(
              { error: "Invalid release year" },
              400
            );
          }
        }

        function validOptionalUrl(value) {
          if (value === undefined || value === null || value === "") {
            return null;
          }

          if (typeof value !== "string") {
            return false;
          }

          try {
            const parsed = new URL(value);

            if (
              parsed.protocol !== "https:" &&
              parsed.protocol !== "http:"
            ) {
              return false;
            }

            return parsed.href;
          } catch {
            return false;
          }
        }

        const posterUrl = validOptionalUrl(body.poster_url);
        const watchUrl = validOptionalUrl(body.watch_url);
        const downloadUrl = validOptionalUrl(body.download_url);

        if (
          posterUrl === false ||
          watchUrl === false ||
          downloadUrl === false
        ) {
          return json(
            {
              error:
                "Poster, watch, and download links must be valid HTTP or HTTPS URLs",
            },
            400
          );
        }

        try {
          const result = await env.DB
            .prepare(
              `INSERT INTO titles
                (title, category, year, poster_url,
                 watch_url, download_url)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(
              title,
              category,
              year,
              posterUrl,
              watchUrl,
              downloadUrl
            )
            .run();

          return json(
            {
              success: true,
              id: result.meta.last_row_id,
              message: "Title added successfully",
            },
            201
          );
        } catch (error) {
          console.error("POST title failed:", error);
          return json(
            { error: "Could not add title to database" },
            500
          );
        }
      }

      // DELETE: Delete a title by its database ID
      if (request.method === "DELETE") {
        const savedPassword = env.ADMIN_PASSWORD;
        const enteredPassword =
          request.headers.get("X-Admin-Password");

        if (!savedPassword) {
          return json(
            { error: "Server configuration error" },
            500
          );
        }

        if (
          !enteredPassword ||
          enteredPassword !== savedPassword
        ) {
          return json(
            { error: "Incorrect admin password" },
            401
          );
        }

        const match = url.pathname.match(
          /^\/api\/titles\/(\d+)$/
        );

        if (!match) {
          return json(
            { error: "A valid title ID is required" },
            400
          );
        }

        const id = Number(match[1]);

        if (!Number.isSafeInteger(id) || id < 1) {
          return json(
            { error: "Invalid title ID" },
            400
          );
        }

        try {
          const result = await env.DB
            .prepare("DELETE FROM titles WHERE id = ?")
            .bind(id)
            .run();

          if (result.meta.changes === 0) {
            return json(
              { error: "Title not found" },
              404
            );
          }

          return json({
            success: true,
            id,
            message: "Title deleted successfully",
          });
        } catch (error) {
          console.error("DELETE title failed:", error);
          return json(
            { error: "Database delete failed" },
            500
          );
        }
      }

      return json(
        { error: "Method not allowed" },
        405
      );
    }

    // Serve website files
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("KaiFlix server is running.", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  },
};
