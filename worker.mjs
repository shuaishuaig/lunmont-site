// LUNMONT site worker: static assets + products API backed by D1.
// Writes (POST/DELETE) require header X-Admin-Key == env ADMIN_KEY.

const MAX_IMAGE = 700000; // dataURL char cap, keeps request body < 1MiB

const SCHEMA = `CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  image TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    const { method } = request;
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    const route = path.slice(4); // after /api

    if (route === '/products' && method === 'GET') {
      try {
        const r = await env.DB.prepare(
          'SELECT id, name, category, image FROM products ORDER BY id DESC LIMIT 500'
        ).all();
        return json({ products: r.results || [] });
      } catch (e) {
        return json({ products: [] });
      }
    }

    // everything below mutates data: require admin key
    if (method === 'POST' || method === 'DELETE') {
      const key = request.headers.get('X-Admin-Key') || '';
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
    }

    if (route === '/products' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const name = String(body.name || '').trim().slice(0, 120);
      const category = String(body.category || '').trim().slice(0, 60);
      const image = String(body.image || '');
      if (!name) return json({ error: 'name required' }, 400);
      if (!image.startsWith('data:image/') && !/^https?:\/\//.test(image))
        return json({ error: 'image must be data URL or http(s) URL' }, 400);
      if (image.length > MAX_IMAGE) return json({ error: 'image too large' }, 413);
      try {
        await env.DB.prepare(SCHEMA).run();
        const r = await env.DB.prepare(
          'INSERT INTO products (name, category, image) VALUES (?, ?, ?)'
        ).bind(name, category, image).run();
        return json({ ok: true, id: r.meta && r.meta.last_row_id });
      } catch (e) {
        return json({ error: 'save failed' }, 500);
      }
    }

    if (route === '/products' && method === 'DELETE') {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
      try {
        await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: 'delete failed' }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  }
};
