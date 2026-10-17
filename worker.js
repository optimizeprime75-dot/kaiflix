
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
    },
  });
}

function validOptionalUrl(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") return false;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    return parsed.href;
  } catch {
    return false;
  }
}

function validateTitle(body) {
  const title =
    typeof body.title === "string" ? body.title.trim() : "";

  const category =
    typeof body.category === "string" ? body.category.trim() : "";

  if (!title || title.length > 200) {
    return { error: "Title is required and must be at most 200 characters" };
  }

  if (!["Movie", "TV Series", "Anime"].includes(category)) {
    return { error: "Invalid category" };
  }

  let year = null;

  if (body.year !== undefined && body.year !== null && body.year !== "") {
    year = Number(body.year);
    if (!Number.isInteger(year) || year < 1888 || year > 2200) {
      return { error: "Invalid release year" };
    }
  }

  const posterUrl = validOptionalUrl(body.poster_url);
  const watchUrl = validOptionalUrl(body.watch_url);
  const downloadUrl = validOptionalUrl(body.download_url);

  if (posterUrl === false || watchUrl === false || downloadUrl === false) {
    return { error: "URLs must be valid HTTP or HTTPS links" };
  }

  return {
    value: {
      title,
      category,
      year,
      poster_url: posterUrl,
      watch_url: watchUrl,
      download_url: downloadUrl,
    },
  };
}

function isAdmin(request, env) {
  const savedPassword = env.ADMIN_PASSWORD;
  const enteredPassword = request.headers.get("X-Admin-Password");

  return Boolean(savedPassword && enteredPassword &&
    enteredPassword === savedPassword);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const isCollection = url.pathname === "/api/titles";
    const match = url.pathname.match(/^\/api\/titles\/(\d+)$/);
    const isItem = Boolean(match);

    if (isCollection || isItem) {
      if (request.method === "GET" && isCollection) {
        try {
          const result = await env.DB.prepare(
            `SELECT id, title, category, year, poster_url,
                    watch_url, download_url, created_at
             FROM titles
             ORDER BY created_at DESC, id DESC`
          ).all();

          return json(result.results);
        } catch (error) {
          console.error("GET titles failed:", error);
          return json({ error: "Could not load titles from database" }, 500);
        }
      }

      if (["POST", "PUT", "DELETE"].includes(request.method)) {
        if (!env.ADMIN_PASSWORD) {
          return json({ error: "Server configuration error" }, 500);
        }

        if (!isAdmin(request, env)) {
          return json({ error: "Incorrect admin password" }, 401);
        }
      }

      if (request.method === "POST" && isCollection) {
        let body;

        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const validated = validateTitle(body);
        if (validated.error) return json({ error: validated.error }, 400);

        const t = validated.value;

        try {
          const result = await env.DB.prepare(
            `INSERT INTO titles
              (title, category, year, poster_url, watch_url, download_url)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            t.title, t.category, t.year, t.poster_url,
            t.watch_url, t.download_url
          ).run();

          return json({
            success: true,
            id: result.meta.last_row_id,
            message: "Title added successfully",
          }, 201);
        } catch (error) {
          console.error("POST title failed:", error);
          return json({ error: "Could not add title to database" }, 500);
        }
      }

      if (request.method === "PUT" && isItem) {
        const id = Number(match[1]);

        if (!Number.isSafeInteger(id) || id < 1) {
          return json({ error: "Invalid title ID" }, 400);
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const validated = validateTitle(body);
        if (validated.error) return json({ error: validated.error }, 400);

        const t = validated.value;

        try {
          const result = await env.DB.prepare(
            `UPDATE titles
             SET title = ?, category = ?, year = ?, poster_url = ?,
                 watch_url = ?, download_url = ?
             WHERE id = ?`
          ).bind(
            t.title, t.category, t.year, t.poster_url,
            t.watch_url, t.download_url, id
          ).run();

          if (result.meta.changes === 0) {
            return json({ error: "Title not found or unchanged" }, 404);
          }

          return json({
            success: true,
            id,
            message: "Title updated successfully",
          });
        } catch (error) {
          console.error("PUT title failed:", error);
          return json({ error: "Could not update title" }, 500);
        }
      }

      if (request.method === "DELETE" && isItem) {
        const id = Number(match[1]);

        if (!Number.isSafeInteger(id) || id < 1) {
          return json({ error: "Invalid title ID" }, 400);
        }

        try {
          const result = await env.DB.prepare(
            "DELETE FROM titles WHERE id = ?"
          ).bind(id).run();

          if (result.meta.changes === 0) {
            return json({ error: "Title not found" }, 404);
          }

          return json({
            success: true,
            id,
            message: "Title deleted successfully",
          });
        } catch (error) {
          console.error("DELETE title failed:", error);
          return json({ error: "Database delete failed" }, 500);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("KaiFlix server is running.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
 
