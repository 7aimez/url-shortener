export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Normalize the path: strip leading and trailing slashes to get the slug.
    const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");

    // Read the admin secret from the header once and compare against env.
    const isAuthorized = () => {
      const provided = request.headers.get("X-Admin-Secret");
      return Boolean(provided) && provided === env.ADMIN_SECRET;
    };

    // Root requests go back to the main portfolio site.
    if (!path) {
      return Response.redirect("https://yourdomain.com", 302);
    }

    if (path === "admin" && request.method === "GET") {
      return new Response(renderAdminPage(), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (path === "admin/links" && request.method === "GET") {
      if (!isAuthorized()) {
        return new Response("Unauthorized", { status: 401 });
      }

      // NOTE: KV list() returns up to 1000 keys per call and a cursor
      // for pagination. Fine for a personal shortener; loop with the
      // cursor if you ever expect more than 1000 links.
      const listResult = await env.URL_STORE.list();
      const links = await Promise.all(
        listResult.keys.map(async ({ name }) => ({
          slug: name,
          url: await env.URL_STORE.get(name)
        }))
      );

      return Response.json({ success: true, links });
    }

    if (path === "admin/delete" && request.method === "DELETE") {
      if (!isAuthorized()) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }

      const { slug } = payload ?? {};

      if (typeof slug !== "string" || slug.trim() === "") {
        return new Response("slug is required as a non-empty string", {
          status: 400
        });
      }

      const normalizedSlug = slug.trim();
      await env.URL_STORE.delete(normalizedSlug);

      return Response.json({
        success: true,
        slug: normalizedSlug
      });
    }

    // Handle authenticated short-link creation from the admin endpoint.
    if (path === "admin/create" && request.method === "POST") {
      // Reject requests that do not provide the expected admin secret.
      if (!isAuthorized()) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }

      const { slug, url: targetUrl } = payload ?? {};

      // Require non-empty string values for both slug and destination URL.
      if (
        typeof slug !== "string" ||
        slug.trim() === "" ||
        typeof targetUrl !== "string" ||
        targetUrl.trim() === ""
      ) {
        return new Response(
          "Both slug and url are required as non-empty strings",
          { status: 400 }
        );
      }

      const normalizedSlug = slug.trim();
      const normalizedUrl = targetUrl.trim();

      // Prevent users from creating slugs that collide with admin routes.
      const RESERVED = new Set([
        "admin",
        "admin/links",
        "admin/create",
        "admin/delete"
      ]);
      if (RESERVED.has(normalizedSlug)) {
        return new Response("slug is reserved", { status: 400 });
      }

      // Validate that the destination is a real absolute http(s) URL.
      // Without this, Response.redirect() would throw on bad input and
      // return a 500, and non-http schemes like javascript: would be unsafe.
      let parsedUrl;
      try {
        parsedUrl = new URL(normalizedUrl);
      } catch {
        return new Response("url must be a valid absolute URL", {
          status: 400
        });
      }

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return new Response("url must use http or https", { status: 400 });
      }

      // Persist the slug => destination URL mapping in Cloudflare KV.
      await env.URL_STORE.put(normalizedSlug, normalizedUrl);

      return Response.json({
        success: true,
        slug: normalizedSlug,
        url: normalizedUrl
      });
    }

    // For all other paths, attempt to resolve the slug from KV storage.
    const targetUrl = await env.URL_STORE.get(path);

    if (targetUrl) {
      // Redirect visitors to the full target URL when the slug exists.
      return Response.redirect(targetUrl, 302);
    }

    // Return a clear not-found response when no short link matches the slug.
    return new Response("Short link not found", { status: 404 });
  }
};

function renderAdminPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>URL Shortener Admin</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
      form, .panel { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
      label { display: block; margin-bottom: 0.5rem; }
      input { width: 100%; box-sizing: border-box; padding: 0.5rem; margin-top: 0.25rem; }
      button { margin-top: 0.75rem; padding: 0.5rem 0.75rem; }
      ul { padding-left: 1.25rem; }
      li { margin: 0.5rem 0; }
      .row { display: flex; gap: 0.5rem; align-items: center; }
      .row a { flex: 1; overflow-wrap: anywhere; }
      #status { min-height: 1.25rem; }
    </style>
  </head>
  <body>
    <h1>URL Shortener Admin</h1>

    <form id="create-form">
      <label>Admin secret
        <input id="admin-secret" name="admin-secret" type="password" autocomplete="current-password" required />
      </label>
      <label>Slug
        <input id="slug" name="slug" placeholder="github" required />
      </label>
      <label>Destination URL
        <input id="target-url" name="target-url" type="url" placeholder="https://github.com/" required />
      </label>
      <button type="submit">Create / Update Link</button>
      <button id="refresh-links" type="button">Refresh Links</button>
    </form>

    <div class="panel">
      <h2>Stored Links</h2>
      <ul id="links"></ul>
    </div>

    <p id="status"></p>

    <script>
      const secretInput = document.getElementById("admin-secret");
      const statusEl = document.getElementById("status");
      const linksEl = document.getElementById("links");
      const createForm = document.getElementById("create-form");
      const refreshButton = document.getElementById("refresh-links");
      const storageKey = "url-shortener-admin-secret";
      secretInput.value = localStorage.getItem(storageKey) || "";

      function setStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.style.color = isError ? "crimson" : "inherit";
      }

      function getSecret() {
        const secret = secretInput.value.trim();
        localStorage.setItem(storageKey, secret);
        return secret;
      }

      async function api(path, options = {}) {
        const response = await fetch(path, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Secret": getSecret(),
            ...(options.headers || {})
          }
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        return response.json();
      }

      async function refreshLinks() {
        setStatus("Loading links...");

        try {
          const data = await api("/admin/links");
          linksEl.innerHTML = "";

          if (!data.links.length) {
            linksEl.innerHTML = "<li>No links stored yet.</li>";
          }

          for (const link of data.links) {
            const item = document.createElement("li");
            const row = document.createElement("div");
            row.className = "row";

            const anchor = document.createElement("a");
            anchor.href = "/" + encodeURIComponent(link.slug);
            anchor.target = "_blank";
            anchor.rel = "noreferrer";
            anchor.textContent = link.slug + " \u2192 " + link.url;

            const del = document.createElement("button");
            del.type = "button";
            del.textContent = "Delete";
            del.onclick = async () => {
              try {
                await api("/admin/delete", {
                  method: "DELETE",
                  body: JSON.stringify({ slug: link.slug })
                });
                setStatus('Deleted "' + link.slug + '"');
                await refreshLinks();
              } catch (error) {
                setStatus(error.message, true);
              }
            };

            row.append(anchor, del);
            item.append(row);
            linksEl.append(item);
          }

          setStatus("Links loaded.");
        } catch (error) {
          setStatus(error.message, true);
        }
      }

      createForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const slug = document.getElementById("slug").value;
        const targetUrl = document.getElementById("target-url").value;
        const secret = getSecret();
        setStatus("Saving link...");

        try {
          const data = await api("/admin/create", {
            method: "POST",
            body: JSON.stringify({ slug, url: targetUrl })
          });
          setStatus('Saved "' + data.slug + '"');
          createForm.reset();
          secretInput.value = secret;
          await refreshLinks();
        } catch (error) {
          setStatus(error.message, true);
        }
      });

      refreshButton.addEventListener("click", refreshLinks);
    </script>
  </body>
</html>`;
}
