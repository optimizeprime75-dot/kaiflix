
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

function validUrl(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") return false;

  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? u.href : false;
  } catch {
    return false;
  }
}

function isAdmin(request, env) {
  const saved = env.ADMIN_PASSWORD;
  const entered = request.headers.get("X-Admin-Password");
  return Boolean(saved && entered && saved === entered);
}

async function readBody(request) {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: "Invalid JSON body" };
    }

    return { body };
  } catch {
    return { error: "Invalid JSON body" };
  }
}

function validateTitle(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
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

  const poster_url = validUrl(body.poster_url);
  const watch_url = validUrl(body.watch_url);
  const download_url = validUrl(body.download_url);

  if (poster_url === false || watch_url === false || download_url === false) {
    return { error: "URLs must be valid HTTP or HTTPS links" };
  }

  const quality = body.quality || "WEB-DL";

  if (!["WEB-DL", "HALL PRINT"].includes(quality)) {
    return { error: "Quality must be WEB-DL or HALL PRINT" };
  }

  // IMDb rating is optional. Valid range: 0 to 10.
  let imdb_rating = null;

  if (
    body.imdb_rating !== undefined &&
    body.imdb_rating !== null &&
    body.imdb_rating !== ""
  ) {
    imdb_rating = Number(body.imdb_rating);

    if (
      !Number.isFinite(imdb_rating) ||
      imdb_rating < 0 ||
      imdb_rating > 10
    ) {
      return { error: "IMDb rating must be between 0 and 10" };
    }

    // Keep the rating to one decimal place.
    imdb_rating = Math.round(imdb_rating * 10) / 10;
  }

  return {
    value: {
      title,
      category,
      year,
      poster_url,
      watch_url,
      download_url,
      quality,
      imdb_rating,
    },
  };
}

function validPositiveInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function validateSeason(body) {
  const season_number = validPositiveInteger(body.season_number);

  if (!season_number || season_number > 1000) {
    return { error: "Season number must be between 1 and 1000" };
  }

  return { value: { season_number } };
}

function validateEpisode(body) {
  const episode_number = validPositiveInteger(body.episode_number);

  if (!episode_number || episode_number > 10000) {
    return { error: "Episode number must be between 1 and 10000" };
  }

  const title =
    body.title == null || body.title === ""
      ? null
      : typeof body.title === "string"
        ? body.title.trim().slice(0, 200)
        : false;

  const watch_url = validUrl(body.watch_url);
  const download_url = validUrl(body.download_url);

  if (
    title === false ||
    watch_url === false ||
    download_url === false
  ) {
    return { error: "Invalid episode title or URL" };
  }

  return {
    value: { episode_number, title, watch_url, download_url },
  };
}

async function exists(db, table, id) {
  const result = await db.prepare(
    `SELECT id FROM ${table} WHERE id = ?`
  ).bind(id).first();

  return Boolean(result);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (!path.startsWith("/api/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);

      return new Response("KaiFlix server is running.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    try {
      const isWrite = ["POST", "PUT", "DELETE"].includes(request.method);

      if (isWrite) {
        if (!env.ADMIN_PASSWORD) {
          return json({ error: "Server configuration error" }, 500);
        }

        if (!isAdmin(request, env)) {
          return json({ error: "Incorrect admin password" }, 401);
        }
      }

      // GET all catalog titles, including IMDb ratings.
      if (path === "/api/titles" && request.method === "GET") {
        const result = await env.DB.prepare(
          `SELECT id, title, category, year, poster_url,
                  watch_url, download_url, quality, imdb_rating, created_at
           FROM titles
           ORDER BY created_at DESC, id DESC`
        ).all();

        return json(result.results);
      }

      // ADD a catalog title.
      if (path === "/api/titles" && request.method === "POST") {
        const parsed = await readBody(request);
        if (parsed.error) return json({ error: parsed.error }, 400);

        const checked = validateTitle(parsed.body);
        if (checked.error) return json({ error: checked.error }, 400);

        const t = checked.value;

        const result = await env.DB.prepare(
          `INSERT INTO titles
           (title, category, year, poster_url, watch_url,
            download_url, quality, imdb_rating)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          t.title,
          t.category,
          t.year,
          t.poster_url,
          t.watch_url,
          t.download_url,
          t.quality,
          t.imdb_rating
        ).run();

        return json({
          success: true,
          id: result.meta.last_row_id,
          message: "Title added successfully",
        }, 201);
      }

      // GET, EDIT or DELETE one catalog title.
      let match = path.match(/^\/api\/titles\/(\d+)$/);

      if (match) {
        const id = validPositiveInteger(match[1]);
        if (!id) return json({ error: "Invalid title ID" }, 400);

        if (request.method === "GET") {
          const item = await env.DB.prepare(
            "SELECT * FROM titles WHERE id = ?"
          ).bind(id).first();

          return item
            ? json(item)
            : json({ error: "Title not found" }, 404);
        }

        if (request.method === "PUT") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const checked = validateTitle(parsed.body);
          if (checked.error) return json({ error: checked.error }, 400);

          if (!(await exists(env.DB, "titles", id))) {
            return json({ error: "Title not found" }, 404);
          }

          const t = checked.value;

          await env.DB.prepare(
            `UPDATE titles
             SET title = ?, category = ?, year = ?, poster_url = ?,
                 watch_url = ?, download_url = ?, quality = ?,
                 imdb_rating = ?
             WHERE id = ?`
          ).bind(
            t.title,
            t.category,
            t.year,
            t.poster_url,
            t.watch_url,
            t.download_url,
            t.quality,
            t.imdb_rating,
            id
          ).run();

          return json({
            success: true,
            id,
            message: "Title updated successfully",
          });
        }

        if (request.method === "DELETE") {
          if (!(await exists(env.DB, "titles", id))) {
            return json({ error: "Title not found" }, 404);
          }

          await env.DB.prepare(
            `DELETE FROM episodes
             WHERE season_id IN (
               SELECT id FROM seasons WHERE title_id = ?
             )`
          ).bind(id).run();

          await env.DB.prepare(
            "DELETE FROM seasons WHERE title_id = ?"
          ).bind(id).run();

          await env.DB.prepare(
            "DELETE FROM titles WHERE id = ?"
          ).bind(id).run();

          return json({
            success: true,
            id,
            message: "Title deleted successfully",
          });
        }
      }

      // LIST or ADD seasons belonging to a title.
      match = path.match(/^\/api\/titles\/(\d+)\/seasons$/);

      if (match) {
        const titleId = validPositiveInteger(match[1]);
        if (!titleId) return json({ error: "Invalid title ID" }, 400);

        if (request.method === "GET") {
          const result = await env.DB.prepare(
            `SELECT id, title_id, season_number, created_at
             FROM seasons
             WHERE title_id = ?
             ORDER BY season_number ASC`
          ).bind(titleId).all();

          return json(result.results);
        }

        if (request.method === "POST") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const checked = validateSeason(parsed.body);
          if (checked.error) return json({ error: checked.error }, 400);

          const parent = await env.DB.prepare(
            "SELECT id, category FROM titles WHERE id = ?"
          ).bind(titleId).first();

          if (!parent) return json({ error: "Title not found" }, 404);

          if (!["TV Series", "Anime"].includes(parent.category)) {
            return json({
              error: "Seasons can only be added to TV Series or Anime",
            }, 400);
          }

          const result = await env.DB.prepare(
            `INSERT INTO seasons (title_id, season_number)
             VALUES (?, ?)`
          ).bind(titleId, checked.value.season_number).run();

          return json({
            success: true,
            id: result.meta.last_row_id,
            title_id: titleId,
            season_number: checked.value.season_number,
          }, 201);
        }
      }

      // GET, EDIT or DELETE a season.
      match = path.match(/^\/api\/seasons\/(\d+)$/);

      if (match) {
        const id = validPositiveInteger(match[1]);
        if (!id) return json({ error: "Invalid season ID" }, 400);

        if (request.method === "GET") {
          const item = await env.DB.prepare(
            "SELECT * FROM seasons WHERE id = ?"
          ).bind(id).first();

          return item
            ? json(item)
            : json({ error: "Season not found" }, 404);
        }

        if (request.method === "PUT") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const checked = validateSeason(parsed.body);
          if (checked.error) return json({ error: checked.error }, 400);

          if (!(await exists(env.DB, "seasons", id))) {
            return json({ error: "Season not found" }, 404);
          }

          await env.DB.prepare(
            "UPDATE seasons SET season_number = ? WHERE id = ?"
          ).bind(checked.value.season_number, id).run();

          return json({
            success: true,
            id,
            message: "Season updated successfully",
          });
        }

        if (request.method === "DELETE") {
          if (!(await exists(env.DB, "seasons", id))) {
            return json({ error: "Season not found" }, 404);
          }

          await env.DB.prepare(
            "DELETE FROM episodes WHERE season_id = ?"
          ).bind(id).run();

          await env.DB.prepare(
            "DELETE FROM seasons WHERE id = ?"
          ).bind(id).run();

          return json({
            success: true,
            id,
            message: "Season deleted successfully",
          });
        }
      }

      // LIST or ADD episodes belonging to a season.
      match = path.match(/^\/api\/seasons\/(\d+)\/episodes$/);

      if (match) {
        const seasonId = validPositiveInteger(match[1]);
        if (!seasonId) return json({ error: "Invalid season ID" }, 400);

        if (request.method === "GET") {
          const result = await env.DB.prepare(
            `SELECT id, season_id, episode_number, title,
                    watch_url, download_url, created_at
             FROM episodes
             WHERE season_id = ?
             ORDER BY episode_number ASC`
          ).bind(seasonId).all();

          return json(result.results);
        }

        if (request.method === "POST") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const checked = validateEpisode(parsed.body);
          if (checked.error) return json({ error: checked.error }, 400);

          if (!(await exists(env.DB, "seasons", seasonId))) {
            return json({ error: "Season not found" }, 404);
          }

          const e = checked.value;

          const result = await env.DB.prepare(
            `INSERT INTO episodes
             (season_id, episode_number, title, watch_url, download_url)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(
            seasonId,
            e.episode_number,
            e.title,
            e.watch_url,
            e.download_url
          ).run();

          return json({
            success: true,
            id: result.meta.last_row_id,
            season_id: seasonId,
            episode_number: e.episode_number,
          }, 201);
        }
      }

      // GET, EDIT or DELETE an episode.
      match = path.match(/^\/api\/episodes\/(\d+)$/);

      if (match) {
        const id = validPositiveInteger(match[1]);
        if (!id) return json({ error: "Invalid episode ID" }, 400);

        if (request.method === "GET") {
          const item = await env.DB.prepare(
            "SELECT * FROM episodes WHERE id = ?"
          ).bind(id).first();

          return item
            ? json(item)
            : json({ error: "Episode not found" }, 404);
        }

        if (request.method === "PUT") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const checked = validateEpisode(parsed.body);
          if (checked.error) return json({ error: checked.error }, 400);

          if (!(await exists(env.DB, "episodes", id))) {
            return json({ error: "Episode not found" }, 404);
          }

          const e = checked.value;

          await env.DB.prepare(
            `UPDATE episodes
             SET episode_number = ?, title = ?, watch_url = ?,
                 download_url = ?
             WHERE id = ?`
          ).bind(
            e.episode_number,
            e.title,
            e.watch_url,
            e.download_url,
            id
          ).run();

          return json({
            success: true,
            id,
            message: "Episode updated successfully",
          });
        }

        if (request.method === "DELETE") {
          if (!(await exists(env.DB, "episodes", id))) {
            return json({ error: "Episode not found" }, 404);
          }

          await env.DB.prepare(
            "DELETE FROM episodes WHERE id = ?"
          ).bind(id).run();

          return json({
            success: true,
            id,
            message: "Episode deleted successfully",
          });
        }
      }

      return json({ error: "Route not found or method not allowed" }, 404);
    } catch (error) {
      console.error("KaiFlix API error:", error);

      if (
        error &&
        error.message &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        return json({
          error: "This season or episode number already exists in this parent",
        }, 409);
      }

      return json({
        error: "Server error while processing the request",
      }, 500);
    }
  },
};
