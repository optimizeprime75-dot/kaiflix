export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/titles") {
      try {
        const { results } = await env.DB
          .prepare(
            "SELECT * FROM titles ORDER BY created_at DESC"
          )
          .all();

        return Response.json(results);
      } catch (error) {
        return Response.json(
          { error: "Database query failed" },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
