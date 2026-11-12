// LUNMONT site worker: static assets + products/content APIs backed by D1.
// Writes (POST/DELETE) require header X-Admin-Key matching D1 settings.admin_key.

const MAX_IMAGE = 700000; // dataURL char cap, keeps request body < 1MiB
const MAX_CONTENT_VALUE = 4000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  image TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`;

const CONTENT_SCHEMA = `CREATE TABLE IF NOT EXISTS site_content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
)`;

// Keep in sync with the [data-content-key] skeleton in index.html.
// First request after deploy seeds these idempotently; no console/DDL step needed.
const DEFAULT_CONTENT = {
  'nav_brand': 'LUNMONT',
  'nav_products': '产品展示',
  'nav_contact': '联系我们',
  'hero_kicker': 'HAIR ACCESSORIES · WHOLESALE',
  'hero_title': '以细节见质感的\n发夹与饰品批发',
  'hero_sub': 'LUNMONT（义乌市玥岑进出口有限公司）· 支持小批量起订与出口订单',
  'hero_cta': '获取产品目录',
  'stat1_label': '展示产品',
  'stat2_num': '小批量',
  'stat2_label': '灵活起订',
  'stat3_num': '出口',
  'stat3_label': '进出口直营',
  'products_kicker': 'COLLECTIONS',
  'products_title': '产品系列',
  'empty_text': '暂无产品。进入「管理模式」上传你的产品图片即可自动生成卡片。',
  'admin_title': '上传产品图片',
  'admin_hint': '选择图片后自动压缩并生成产品卡片，可多选一次上传多张。产品名选填，分类决定卡片归类。',
  'contact_kicker': 'CONTACT',
  'contact_title': '欢迎来样订制与批发合作',
  'contact_sub': '义乌市玥岑进出口有限公司 · 浙江义乌',
  'contact_email': 'info@lunmont.asia',
  'footer_left': '© 2026 LUNMONT · 义乌市玥岑进出口有限公司',
  'footer_right': 'HAIR ACCESSORIES WHOLESALE',
  'seo_title': 'LUNMONT — 发夹与饰品批发 | 义乌市玥岑进出口有限公司',
  'seo_desc': 'LUNMONT（义乌市玥岑进出口有限公司）— 发夹与饰品批发，支持小批量起订与出口订单。Yiwu Cenova Import and Export Co., Ltd.'
};

let contentReady = false;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function checkAdmin(env, request) {
  const key = request.headers.get('X-Admin-Key') || '';
  if (!key) return false;
  try {
    const r = await env.DB.prepare("SELECT value FROM settings WHERE key='admin_key'").first();
    return !!r && r.value === key;
  } catch (e) {
    return false;
  }
}

async function ensureContent(env) {
  if (contentReady) return;
  await env.DB.prepare(CONTENT_SCHEMA).run();
  const keys = Object.keys(DEFAULT_CONTENT);
  const sql = 'INSERT OR IGNORE INTO site_content (key, value) VALUES ' +
    keys.map(() => '(?, ?)').join(', ');
  const params = [];
  for (const k of keys) params.push(k, DEFAULT_CONTENT[k]);
  await env.DB.prepare(sql).bind(...params).run();
  contentReady = true;
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

    if (route === '/content' && method === 'GET') {
      try {
        await ensureContent(env);
        const r = await env.DB.prepare('SELECT key, value FROM site_content').all();
        const content = {};
        for (const row of (r.results || [])) content[row.key] = row.value;
        return json({ content });
      } catch (e) {
        return json({ content: {}, detail: String(e && e.message || e).slice(0, 120) });
      }
    }

    if (method === 'POST' || method === 'DELETE') {
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
    }

    if (route === '/content' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const c = body && body.content;
      if (!c || typeof c !== 'object' || Array.isArray(c))
        return json({ error: 'content object required' }, 400);
      const keys = Object.keys(c);
      if (!keys.length || keys.length > 60) return json({ error: 'bad key count' }, 400);
      for (const k of keys) {
        if (!/^[a-z0-9_]{1,40}$/.test(k)) return json({ error: 'invalid key: ' + k }, 400);
        if (typeof c[k] !== 'string') return json({ error: 'invalid value: ' + k }, 400);
      }
      try {
        await ensureContent(env);
        const sql = `INSERT INTO site_content (key, value, updated_at) VALUES ` +
          keys.map(() => "(?, ?, datetime('now'))").join(', ') +
          ` ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`;
        const params = [];
        for (const k of keys) params.push(k, c[k].slice(0, MAX_CONTENT_VALUE));
        await env.DB.prepare(sql).bind(...params).run();
        return json({ ok: true, saved: keys.length });
      } catch (e) {
        return json({ error: 'save failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
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
