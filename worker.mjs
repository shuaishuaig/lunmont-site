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

const SETTINGS_SCHEMA = `CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`;

// AI 文案编辑：密钥只存 D1 settings，绝不进公开仓库；提示词约束模型只回纯文本 JSON。
const AI_SYS_PROMPT = `你是网站文案编辑。用户给出若干网页文案字段（key / 中文名 / 当前文本 / 单条提示词），以及一条全局提示词。
要求：
1. 只改文字，不输出 HTML、Markdown、解释或额外内容。
2. 严格返回 JSON 对象：键必须是给出的 key，值是修改后的纯文本字符串。
3. 没有对应提示词的字段保持原文，也要在 JSON 中原样返回。
4. 保持原文语言与大致长度；不要新增键、不要删键、不要输出数组。
5. 若提示词要求调整语气/风格，只改措辞，不编造公司名、电话、邮箱等事实信息。`;

async function readAIConfig(env) {
  const r = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('ai_key','ai_base','ai_model')"
  ).all();
  const cfg = {};
  for (const row of (r.results || [])) cfg[row.key] = row.value;
  return cfg;
}

function parseAIJson(txt) {
  const t = (txt || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

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

    if (route === '/ai-status' && method === 'GET') {
      try {
        const cfg = await readAIConfig(env);
        // 只回「是否已配置」，绝不回密钥本身
        return json({ configured: !!cfg.ai_key, base: cfg.ai_base || '', model: cfg.ai_model || '' });
      } catch (e) {
        return json({ configured: false });
      }
    }

    if (method === 'POST' || method === 'DELETE') {
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
    }

    if (route === '/ai-config' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const aiKey = String((body && body.aiKey) || '').trim();
      const base = String((body && body.aiBase) || 'https://api.deepseek.com')
        .trim().replace(/\/+$/, '');
      const model = String((body && body.aiModel) || 'deepseek-chat').trim();
      if (!aiKey) return json({ error: 'aiKey required' }, 400);
      if (!/^https:\/\/[^\s]{1,180}$/.test(base)) return json({ error: 'bad aiBase' }, 400);
      if (!/^[\w.\-:]{1,80}$/.test(model)) return json({ error: 'bad aiModel' }, 400);
      try {
        await env.DB.prepare(SETTINGS_SCHEMA).run();
        const sql = `INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
        await env.DB.prepare(sql)
          .bind('ai_key', aiKey, 'ai_base', base, 'ai_model', model).run();
        return json({ ok: true, base, model });
      } catch (e) {
        return json({ error: 'config failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    if (route === '/ai-edit' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const raw = Array.isArray(body && body.marks) ? body.marks.slice(0, 30) : [];
      const globalHint = String((body && body.hint) || '').slice(0, 500);
      const marks = [];
      for (const m of raw) {
        const key = String((m && m.key) || '');
        if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
        marks.push({
          key,
          label: String((m && m.label) || key).slice(0, 60),
          text: String((m && m.text) || '').slice(0, 1200),
          hint: String((m && m.hint) || '').slice(0, 500)
        });
      }
      if (!marks.length) return json({ error: 'no valid marks' }, 400);
      if (!globalHint && marks.every(m => !m.hint))
        return json({ error: 'hint required' }, 400);
      let cfg;
      try { cfg = await readAIConfig(env); } catch (e) { cfg = {}; }
      if (!cfg.ai_key)
        return json({ error: 'AI 未配置，请先运行 tools/_site_ai_setup.py', code: 'AI_NOT_CONFIGURED' }, 503);
      const payload = {
        model: cfg.ai_model || 'deepseek-chat',
        messages: [
          { role: 'system', content: AI_SYS_PROMPT },
          { role: 'user', content: JSON.stringify({ globalHint, fields: marks }) }
        ],
        temperature: 0.5,
        max_tokens: 1600
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      let resp, rawTxt = '';
      try {
        resp = await fetch((cfg.ai_base || 'https://api.deepseek.com') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.ai_key },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
        rawTxt = await resp.text();
      } catch (e) {
        clearTimeout(timer);
        return json({ error: 'AI 请求失败', detail: String(e && e.message || e).slice(0, 160) }, 502);
      }
      clearTimeout(timer);
      if (!resp.ok)
        return json({ error: 'AI 接口 HTTP ' + resp.status, detail: rawTxt.slice(0, 200) }, 502);
      let out;
      try { out = JSON.parse(rawTxt); } catch { return json({ error: 'AI 返回非 JSON' }, 502); }
      const content = out && out.choices && out.choices[0] && out.choices[0].message
        ? out.choices[0].message.content : '';
      const parsed = parseAIJson(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return json({ error: 'AI 结果无法解析', raw: String(content).slice(0, 300) }, 502);
      const edits = marks.map(m => ({
        key: m.key,
        before: m.text,
        after: (typeof parsed[m.key] === 'string' ? parsed[m.key] : m.text).slice(0, MAX_CONTENT_VALUE)
      }));
      return json({ ok: true, edits });
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
