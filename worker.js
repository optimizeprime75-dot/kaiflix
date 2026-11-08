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

// Same as json(), but tells browsers and caches never to store the response.
// Used for private admin data such as visitor reports.
function privateJson(data, status = 200) {
  const response = json(data, status);
  response.headers.set("Cache-Control", "no-store");
  return response;
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

  // Description and backdrop image are optional (used on the Movie Details page).
  // A key that is missing means "leave the saved value unchanged" when editing;
  // null or an empty text clears it.
  let description;

  if (body.description !== undefined) {
    if (body.description === null || body.description === "") {
      description = null;
    } else if (typeof body.description === "string") {
      description = body.description.trim() || null;

      if (description && description.length > 2000) {
        return { error: "Description must be at most 2000 characters" };
      }
    } else {
      return { error: "Invalid description" };
    }
  }

  let backdrop_url;

  if (body.backdrop_url !== undefined) {
    backdrop_url = validUrl(body.backdrop_url);

    if (backdrop_url === false) {
      return { error: "Backdrop URL must be a valid HTTP or HTTPS link" };
    }
  }

  // Genres and custom categories are optional lists of ids.
  const genres = parseIdList(body.genre_ids, "Genres");
  if (genres.error) return { error: genres.error };

  const categories = parseIdList(body.custom_category_ids, "Custom categories");
  if (categories.error) return { error: categories.error };

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
      description,
      backdrop_url,
      genre_ids: genres.ids,
      custom_category_ids: categories.ids,
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

/* ============================================================
   VISITOR REPORT SYSTEM
   - Visitors may only SUBMIT reports (POST /api/reports).
   - Reading, updating and deleting reports needs the Admin Password.
   ============================================================ */

const REPORT_CONTENT_TYPES = ["Movie", "TV Series", "Anime"];

const REPORT_PROBLEM_TYPES = [
  "Video is not playing",
  "Watch link is not working",
  "Download link is not working",
  "Episode is not working",
  "Missing episode",
  "Wrong content information",
  "Other problem",
];

const REPORT_STATUSES = ["Pending", "Reviewing", "Fixed", "Rejected"];

// Spam limits.
const REPORT_MAX_PER_IP_PER_HOUR = 5;
const REPORT_MAX_TOTAL_PER_HOUR = 100;

function validateReport(body) {
  // Hidden "website" field: real visitors never fill it, bots often do.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { spam: true };
  }

  const content_type =
    typeof body.content_type === "string" ? body.content_type.trim() : "";

  if (!REPORT_CONTENT_TYPES.includes(content_type)) {
    return { error: "Please choose a valid content type" };
  }

  const content_name =
    typeof body.content_name === "string" ? body.content_name.trim() : "";

  if (!content_name || content_name.length > 200) {
    return {
      error: "Content name is required and must be at most 200 characters",
    };
  }

  const problem_type =
    typeof body.problem_type === "string" ? body.problem_type.trim() : "";

  if (!REPORT_PROBLEM_TYPES.includes(problem_type)) {
    return { error: "Please choose a valid problem type" };
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";

  if (description.length < 10 || description.length > 2000) {
    return {
      error: "Description must be between 10 and 2000 characters",
    };
  }

  return {
    value: { content_type, content_name, problem_type, description },
  };
}

// Stores only a one-way hash of the visitor IP, never the IP itself.
async function hashVisitor(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const data = new TextEncoder().encode("kaiflix-report:" + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/* ============================================================
   GENRES AND CUSTOM CATEGORIES (both completely optional)
   The table and column names below are fixed in this file and are
   never taken from the request, so they are safe to put in SQL text.
   ============================================================ */

const GENRE_TAX = {
  table: "genres",
  link: "title_genres",
  column: "genre_id",
  label: "Genre",
  maxLength: 40,
};

const CATEGORY_TAX = {
  table: "custom_categories",
  link: "title_custom_categories",
  column: "category_id",
  label: "Custom category",
  maxLength: 60,
};

const MAX_CHOICES_PER_TITLE = 20;
const MAX_TITLES_PER_REQUEST = 90;

function cleanTaxonomyName(value, tax) {
  if (typeof value !== "string") {
    return { error: `${tax.label} name is required` };
  }

  const name = value.replace(/\s+/g, " ").trim();

  if (!name) return { error: `${tax.label} name is required` };

  if (name.length > tax.maxLength) {
    return {
      error: `${tax.label} name must be at most ${tax.maxLength} characters`,
    };
  }

  if (/[\u0000-\u001f\u007f<>]/.test(name)) {
    return { error: `${tax.label} name contains invalid characters` };
  }

  return { name };
}

// undefined = the key was not sent (leave things unchanged), [] = clear all.
function parseIdList(value, label, max = MAX_CHOICES_PER_TITLE) {
  if (value === undefined) return { ids: undefined };
  if (value === null) return { ids: [] };

  if (!Array.isArray(value)) return { error: `${label} must be a list` };

  const ids = [];

  for (const item of value) {
    const id = validPositiveInteger(item);
    if (!id) return { error: `${label} contains an invalid id` };
    if (!ids.includes(id)) ids.push(id);
  }

  if (ids.length > max) {
    return { error: `${label}: choose at most ${max} items` };
  }

  return { ids };
}

async function allIdsExist(db, table, ids) {
  if (!ids.length) return true;

  const marks = ids.map(() => "?").join(", ");
  const row = await db.prepare(
    `SELECT COUNT(*) AS total FROM ${table} WHERE id IN (${marks})`
  ).bind(...ids).first();

  return Boolean(row) && row.total === ids.length;
}

async function checkTaxonomyChoices(db, choices) {
  if (
    choices.genre_ids &&
    !(await allIdsExist(db, GENRE_TAX.table, choices.genre_ids))
  ) {
    return "One or more selected genres do not exist";
  }

  if (
    choices.custom_category_ids &&
    !(await allIdsExist(db, CATEGORY_TAX.table, choices.custom_category_ids))
  ) {
    return "One or more selected custom categories do not exist";
  }

  return null;
}

async function replaceTitleLinks(db, tax, titleId, ids) {
  const statements = [
    db.prepare(`DELETE FROM ${tax.link} WHERE title_id = ?`).bind(titleId),
  ];

  for (const id of ids) {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO ${tax.link} (title_id, ${tax.column})
         VALUES (?, ?)`
      ).bind(titleId, id)
    );
  }

  await db.batch(statements);
}

// A new title with nothing chosen needs no extra work at all.
async function saveTaxonomyChoices(db, titleId, choices, isNewTitle) {
  const pairs = [
    [GENRE_TAX, choices.genre_ids],
    [CATEGORY_TAX, choices.custom_category_ids],
  ];

  for (const [tax, ids] of pairs) {
    if (ids === undefined) continue;
    if (isNewTitle && ids.length === 0) continue;
    await replaceTitleLinks(db, tax, titleId, ids);
  }
}

// If the new tables do not exist yet, a title page still loads (with empty lists).
async function readTitleTaxonomy(db, titleId) {
  const read = async (tax) => {
    try {
      const result = await db.prepare(
        `SELECT x.id, x.name
         FROM ${tax.link} l
         JOIN ${tax.table} x ON x.id = l.${tax.column}
         WHERE l.title_id = ?
         ORDER BY x.name COLLATE NOCASE`
      ).bind(titleId).all();

      return result.results;
    } catch {
      return [];
    }
  };

  return {
    genres: await read(GENRE_TAX),
    custom_categories: await read(CATEGORY_TAX),
  };
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

      // Reports routes. The ONLY public report action is submitting one.
      const isReportsRoute =
        path === "/api/reports" || /^\/api\/reports\/\d+$/.test(path);
      const isPublicReportSubmit =
        path === "/api/reports" && request.method === "POST";

      if (!isPublicReportSubmit && (isWrite || isReportsRoute)) {
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

        const badChoice = await checkTaxonomyChoices(env.DB, t);
        if (badChoice) return json({ error: badChoice }, 400);

        const result = await env.DB.prepare(
          `INSERT INTO titles
           (title, category, year, poster_url, watch_url,
            download_url, quality, imdb_rating, description, backdrop_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          t.title,
          t.category,
          t.year,
          t.poster_url,
          t.watch_url,
          t.download_url,
          t.quality,
          t.imdb_rating,
          t.description ?? null,
          t.backdrop_url ?? null
        ).run();

        await saveTaxonomyChoices(env.DB, result.meta.last_row_id, t, true);

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

          if (!item) return json({ error: "Title not found" }, 404);

          return json({ ...item, ...(await readTitleTaxonomy(env.DB, id)) });
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

          const badChoice = await checkTaxonomyChoices(env.DB, t);
          if (badChoice) return json({ error: badChoice }, 400);

          await env.DB.prepare(
            `UPDATE titles
             SET title = ?, category = ?, year = ?, poster_url = ?,
                 watch_url = ?, download_url = ?, quality = ?,
                 imdb_rating = ?,
                 description = CASE WHEN ? = 1 THEN ? ELSE description END,
                 backdrop_url = CASE WHEN ? = 1 THEN ? ELSE backdrop_url END
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
            t.description !== undefined ? 1 : 0,
            t.description ?? null,
            t.backdrop_url !== undefined ? 1 : 0,
            t.backdrop_url ?? null,
            id
          ).run();

          await saveTaxonomyChoices(env.DB, id, t, false);

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

          for (const tax of [GENRE_TAX, CATEGORY_TAX]) {
            try {
              await env.DB.prepare(
                `DELETE FROM ${tax.link} WHERE title_id = ?`
              ).bind(id).run();
            } catch {
              // table not created yet: nothing to clean up
            }
          }

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

      /* ---------- GENRES AND CUSTOM CATEGORIES ---------- */
      // Reading the lists is public (names only). Every change needs the
      // admin password, which is checked at the top for all POST/PUT/DELETE.

      const taxonomyFor = (name) =>
        name === "genres" ? GENRE_TAX : CATEGORY_TAX;

      // List all, or create one.
      match = path.match(/^\/api\/(genres|custom-categories)$/);

      if (match) {
        const tax = taxonomyFor(match[1]);

        if (request.method === "GET") {
          const result = await env.DB.prepare(
            `SELECT x.id, x.name, COUNT(l.title_id) AS title_count
             FROM ${tax.table} x
             LEFT JOIN ${tax.link} l ON l.${tax.column} = x.id
             GROUP BY x.id, x.name
             ORDER BY x.name COLLATE NOCASE`
          ).all();

          return json(result.results);
        }

        if (request.method === "POST") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const cleaned = cleanTaxonomyName(parsed.body.name, tax);
          if (cleaned.error) return json({ error: cleaned.error }, 400);

          const duplicate = await env.DB.prepare(
            `SELECT id FROM ${tax.table} WHERE name = ? COLLATE NOCASE`
          ).bind(cleaned.name).first();

          if (duplicate) {
            return json({ error: `${tax.label} "${cleaned.name}" already exists` }, 409);
          }

          try {
            const result = await env.DB.prepare(
              `INSERT INTO ${tax.table} (name) VALUES (?)`
            ).bind(cleaned.name).run();

            return json({
              success: true,
              id: result.meta.last_row_id,
              name: cleaned.name,
            }, 201);
          } catch (error) {
            if (error && error.message && error.message.includes("UNIQUE")) {
              return json({ error: `${tax.label} "${cleaned.name}" already exists` }, 409);
            }
            throw error;
          }
        }
      }

      // Rename or delete one. Deleting only removes the links, never the titles.
      match = path.match(/^\/api\/(genres|custom-categories)\/(\d+)$/);

      if (match) {
        const tax = taxonomyFor(match[1]);
        const id = validPositiveInteger(match[2]);
        if (!id) return json({ error: `Invalid ${tax.label.toLowerCase()} ID` }, 400);

        if (request.method === "PUT") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const cleaned = cleanTaxonomyName(parsed.body.name, tax);
          if (cleaned.error) return json({ error: cleaned.error }, 400);

          if (!(await exists(env.DB, tax.table, id))) {
            return json({ error: `${tax.label} not found` }, 404);
          }

          const duplicate = await env.DB.prepare(
            `SELECT id FROM ${tax.table} WHERE name = ? COLLATE NOCASE AND id != ?`
          ).bind(cleaned.name, id).first();

          if (duplicate) {
            return json({ error: `${tax.label} "${cleaned.name}" already exists` }, 409);
          }

          try {
            await env.DB.prepare(
              `UPDATE ${tax.table} SET name = ? WHERE id = ?`
            ).bind(cleaned.name, id).run();
          } catch (error) {
            if (error && error.message && error.message.includes("UNIQUE")) {
              return json({ error: `${tax.label} "${cleaned.name}" already exists` }, 409);
            }
            throw error;
          }

          return json({ success: true, id, name: cleaned.name });
        }

        if (request.method === "DELETE") {
          if (!(await exists(env.DB, tax.table, id))) {
            return json({ error: `${tax.label} not found` }, 404);
          }

          await env.DB.batch([
            env.DB.prepare(
              `DELETE FROM ${tax.link} WHERE ${tax.column} = ?`
            ).bind(id),
            env.DB.prepare(
              `DELETE FROM ${tax.table} WHERE id = ?`
            ).bind(id),
          ]);

          return json({
            success: true,
            id,
            message: `${tax.label} deleted. Titles were not changed.`,
          });
        }
      }

      // Titles that belong to a genre or custom category: list or add several.
      match = path.match(/^\/api\/(genres|custom-categories)\/(\d+)\/titles$/);

      if (match) {
        const tax = taxonomyFor(match[1]);
        const id = validPositiveInteger(match[2]);
        if (!id) return json({ error: `Invalid ${tax.label.toLowerCase()} ID` }, 400);

        if (request.method === "GET") {
          if (!(await exists(env.DB, tax.table, id))) {
            return json({ error: `${tax.label} not found` }, 404);
          }

          const result = await env.DB.prepare(
            `SELECT t.id, t.title, t.category, t.year
             FROM ${tax.link} l
             JOIN titles t ON t.id = l.title_id
             WHERE l.${tax.column} = ?
             ORDER BY t.title COLLATE NOCASE`
          ).bind(id).all();

          return json(result.results);
        }

        if (request.method === "POST") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const list = parseIdList(
            parsed.body.title_ids,
            "Titles",
            MAX_TITLES_PER_REQUEST
          );

          if (list.error) return json({ error: list.error }, 400);

          if (!list.ids || list.ids.length === 0) {
            return json({ error: "Choose at least one title" }, 400);
          }

          if (!(await exists(env.DB, tax.table, id))) {
            return json({ error: `${tax.label} not found` }, 404);
          }

          if (!(await allIdsExist(env.DB, "titles", list.ids))) {
            return json({ error: "One or more selected titles do not exist" }, 400);
          }

          await env.DB.batch(
            list.ids.map((titleId) =>
              env.DB.prepare(
                `INSERT OR IGNORE INTO ${tax.link} (title_id, ${tax.column})
                 VALUES (?, ?)`
              ).bind(titleId, id)
            )
          );

          return json({ success: true, id, added: list.ids.length }, 201);
        }
      }

      // Take one title out of a genre or custom category (the title itself stays).
      match = path.match(
        /^\/api\/(genres|custom-categories)\/(\d+)\/titles\/(\d+)$/
      );

      if (match && request.method === "DELETE") {
        const tax = taxonomyFor(match[1]);
        const id = validPositiveInteger(match[2]);
        const titleId = validPositiveInteger(match[3]);

        if (!id || !titleId) return json({ error: "Invalid ID" }, 400);

        if (!(await exists(env.DB, tax.table, id))) {
          return json({ error: `${tax.label} not found` }, 404);
        }

        await env.DB.prepare(
          `DELETE FROM ${tax.link} WHERE ${tax.column} = ? AND title_id = ?`
        ).bind(id, titleId).run();

        return json({ success: true, id, title_id: titleId });
      }

      /* ---------- VISITOR REPORTS ---------- */

      // PUBLIC: a visitor submits a report. This is the only open report route.
      if (path === "/api/reports" && request.method === "POST") {
        const declaredSize = Number(request.headers.get("Content-Length") || 0);

        if (declaredSize > 10000) {
          return json({ error: "Request is too large" }, 413);
        }

        const parsed = await readBody(request);
        if (parsed.error) return json({ error: parsed.error }, 400);

        const checked = validateReport(parsed.body);

        // Bots that fill the hidden field get a normal-looking reply,
        // but nothing is saved.
        if (checked.spam) {
          return json({
            success: true,
            message: "Report submitted successfully",
          }, 201);
        }

        if (checked.error) return json({ error: checked.error }, 400);

        const r = checked.value;
        const visitor = await hashVisitor(request);

        const perVisitor = await env.DB.prepare(
          `SELECT COUNT(*) AS total FROM reports
           WHERE ip_hash = ? AND created_at >= datetime('now', '-1 hour')`
        ).bind(visitor).first();

        if (perVisitor && perVisitor.total >= REPORT_MAX_PER_IP_PER_HOUR) {
          return json({
            error: "Too many reports. Please try again later.",
          }, 429);
        }

        const overall = await env.DB.prepare(
          `SELECT COUNT(*) AS total FROM reports
           WHERE created_at >= datetime('now', '-1 hour')`
        ).first();

        if (overall && overall.total >= REPORT_MAX_TOTAL_PER_HOUR) {
          return json({
            error: "Too many reports right now. Please try again later.",
          }, 429);
        }

        const repeated = await env.DB.prepare(
          `SELECT id FROM reports
           WHERE ip_hash = ?
             AND lower(content_name) = lower(?)
             AND problem_type = ?
             AND created_at >= datetime('now', '-1 day')
           LIMIT 1`
        ).bind(visitor, r.content_name, r.problem_type).first();

        if (repeated) {
          return json({
            error: "You already reported this problem. Thank you!",
          }, 429);
        }

        await env.DB.prepare(
          `INSERT INTO reports
           (content_type, content_name, problem_type, description, status, ip_hash)
           VALUES (?, ?, ?, ?, 'Pending', ?)`
        ).bind(
          r.content_type,
          r.content_name,
          r.problem_type,
          r.description,
          visitor
        ).run();

        return json({
          success: true,
          message: "Report submitted successfully",
        }, 201);
      }

      // ADMIN ONLY (password already checked above): list reports.
      if (path === "/api/reports" && request.method === "GET") {
        const where = [];
        const values = [];

        const statusFilter = url.searchParams.get("status");
        const typeFilter = url.searchParams.get("content_type");

        if (statusFilter && REPORT_STATUSES.includes(statusFilter)) {
          where.push("status = ?");
          values.push(statusFilter);
        }

        if (typeFilter && REPORT_CONTENT_TYPES.includes(typeFilter)) {
          where.push("content_type = ?");
          values.push(typeFilter);
        }

        const result = await env.DB.prepare(
          `SELECT id, content_type, content_name, problem_type,
                  description, status, created_at
           FROM reports
           ${where.length ? "WHERE " + where.join(" AND ") : ""}
           ORDER BY created_at DESC, id DESC
           LIMIT 500`
        ).bind(...values).all();

        return privateJson(result.results);
      }

      // ADMIN ONLY: change status or delete one report.
      match = path.match(/^\/api\/reports\/(\d+)$/);

      if (match) {
        const id = validPositiveInteger(match[1]);
        if (!id) return json({ error: "Invalid report ID" }, 400);

        if (request.method === "PUT") {
          const parsed = await readBody(request);
          if (parsed.error) return json({ error: parsed.error }, 400);

          const status =
            typeof parsed.body.status === "string"
              ? parsed.body.status.trim()
              : "";

          if (!REPORT_STATUSES.includes(status)) {
            return json({
              error: "Status must be Pending, Reviewing, Fixed or Rejected",
            }, 400);
          }

          if (!(await exists(env.DB, "reports", id))) {
            return json({ error: "Report not found" }, 404);
          }

          await env.DB.prepare(
            "UPDATE reports SET status = ? WHERE id = ?"
          ).bind(status, id).run();

          return privateJson({
            success: true,
            id,
            status,
            message: "Report status updated successfully",
          });
        }

        if (request.method === "DELETE") {
          if (!(await exists(env.DB, "reports", id))) {
            return json({ error: "Report not found" }, 404);
          }

          await env.DB.prepare(
            "DELETE FROM reports WHERE id = ?"
          ).bind(id).run();

          return privateJson({
            success: true,
            id,
            message: "Report deleted successfully",
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
