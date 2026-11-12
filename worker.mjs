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

// 内容版本：page/locale 从第一版就留列，避免以后加双语要做全量数据迁移。
// 每次保存生成一版完整快照；回滚 = 把某历史版写回 site_content 并再记一版。
const VERSIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS content_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL DEFAULT 'home',
  locale TEXT NOT NULL DEFAULT 'zh',
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT DEFAULT (datetime('now'))
)`;
const PAGE = 'home';
const LOCALE = 'zh';

// 草稿：一份「未发布」的完整内容快照，按 page+locale 只存一行。
// 存草稿绝不写 site_content、绝不发版；只有 /content/publish 才把草稿写回线上并留版本。
const DRAFT_SCHEMA = `CREATE TABLE IF NOT EXISTS content_drafts (
  page TEXT NOT NULL DEFAULT 'home',
  locale TEXT NOT NULL DEFAULT 'zh',
  content_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (page, locale)
)`;

// 文字样式覆盖层：每个文案字段可选一组白名单属性。
// 关键安全口径：绝不接受任意 CSS 字符串，只按属性白名单 + 值格式逐项校验，
// 前端也不拼 style 属性，而是生成一条 <style> 规则（不进 DOM 文本，不污染 innerText）。
const STYLES_SCHEMA = `CREATE TABLE IF NOT EXISTS content_styles (
  key TEXT PRIMARY KEY,
  css_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
)`;

const STYLE_PROPS = {
  fontSize: v => Number.isInteger(Number(v)) && Number(v) >= 8 && Number(v) <= 120,
  fontWeight: v => ['300', '400', '500', '600', '700', '800'].indexOf(String(v)) >= 0,
  color: v => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v)) ||
              /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/.test(String(v)),
  align: v => ['left', 'center', 'right'].indexOf(String(v)) >= 0,
  lineHeight: v => Number(v) >= 0.8 && Number(v) <= 2.5,
  letterSpacing: v => Number(v) >= -0.05 && Number(v) <= 0.5,
  fontFamily: v => ['serif', 'sans'].indexOf(String(v)) >= 0
};

// AI 文案编辑：密钥只存 D1 settings，绝不进公开仓库；AI 只返回数据，永不返回代码。
// 品牌词库 / 历史语气样本 / 禁用词本机没有，就不硬编（文档禁止代理自己编文案素材）。
const AI_SYS_PROMPT = `你是网站文案编辑。输入包含页面 slug、语言 locale、若干字段（key / 中文名 / 当前文本 / 单条提示词 / maxLen 字数上限），以及一条全局提示词。
要求：
1. 给出 2 到 3 个互不相同、都可直接采用的改写方案。
2. 严格返回单个 JSON 对象，不要 HTML、Markdown、代码块围栏或解释文字。
3. 顶层结构只能是：{"candidates":[{"why":"一句话说明该方案","risk":"低或中或高","edits":{"<key>":"改写后的纯文本"}}]}
4. 每个 edits 的键只能来自给出的 key，值必须是纯文本字符串；没有提示词的字段保持原文并原样返回。
5. 每个字段值不得超过该字段的 maxLen（中文按字、英文按字符）；保持原文语言，不要编造公司名、电话、邮箱等事实信息。
6. 不要新增顶层键，不要返回数组以外形式的 candidates。`;

// 长度上限按字段类型封顶 + 原文长度自适应，不硬编码任何具体文案或 key 名。
function aiLimit(key, text) {
  const n = [...String(text || '')].length;
  let cap = 80;
  if (/(title|kicker|brand|num|cta|label)$/.test(key)) cap = 40;
  else if (/(sub|hint|desc|text)$/.test(key)) cap = 160;
  return Math.min(cap, Math.max(24, Math.ceil(n * 1.5) + 8));
}

// 只接受纯文本；含 HTML / 代码围栏 / 常见 Markdown 的值直接判非法（连带整个候选丢弃）。
function cleanAIText(v, limit) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r/g, '').trim();
  if (/[<>]|```|\*\*|\]\(/.test(s)) return null;
  const chars = [...s];
  const truncated = chars.length > limit;
  return { text: truncated ? chars.slice(0, limit).join('') : s, truncated };
}

function normalizeCandidates(parsed, marks, rejects) {
  let p = parsed;
  // 容错：模型偶发回老的扁平格式 {key:text}，包成单候选，不让整次生成白跑
  if (p && !p.candidates && typeof p === 'object' && !Array.isArray(p) &&
      marks.some(m => typeof p[m.key] === 'string')) {
    p = { candidates: [{ why: '按提示词改写', risk: '低', edits: p }] };
  }
  const list = Array.isArray(p && p.candidates) ? p.candidates.slice(0, 3) : [];
  if (!list.length) { rejects.push('缺 candidates 数组'); return []; }
  const allowed = new Set(marks.map(m => m.key));
  const out = [];
  list.forEach((c, i) => {
    const tag = '候选' + (i + 1);
    if (!c || typeof c !== 'object' || Array.isArray(c)) { rejects.push(tag + ' 不是对象'); return; }
    const em = c.edits;
    if (!em || typeof em !== 'object' || Array.isArray(em)) { rejects.push(tag + ' 缺 edits 对象'); return; }
    const extra = Object.keys(em).filter(k => !allowed.has(k));
    if (extra.length) { rejects.push(tag + ' 含非白名单字段 ' + extra[0]); return; }
    const edits = [];
    let bad = false, truncated = false;
    for (const m of marks) {
      const lim = aiLimit(m.key, m.text);
      const v = Object.prototype.hasOwnProperty.call(em, m.key) ? em[m.key] : m.text;
      const r = cleanAIText(v, lim);
      if (!r) { rejects.push(tag + ' 字段 ' + m.key + ' 含标记/代码或非字符串'); bad = true; break; }
      truncated = truncated || r.truncated;
      edits.push({ key: m.key, before: m.text, after: r.text, maxLen: lim });
    }
    if (bad) return;
    const sig = edits.map(e => e.after).join('\u0001');
    if (out.some(o => o._sig === sig)) { rejects.push(tag + ' 与已有方案重复'); return; }
    out.push({
      id: 'c' + (i + 1),
      why: String(c.why || '方案 ' + (i + 1)).replace(/[<>]/g, '').slice(0, 120),
      risk: /^(低|中|高)$/.test(String(c.risk || '')) ? String(c.risk) : '低',
      truncated, edits, _sig: sig
    });
  });
  return out.map(o => {
    const copy = Object.assign({}, o);
    delete copy._sig;
    return copy;
  });
}

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
// 建表只需一次：D1 每次 CREATE TABLE IF NOT EXISTS 都有往返开销，
// 不缓存会让 GET /api/styles 从 ~1s 变成 6s+。
let stylesReady = false;
async function ensureStyles(env) {
  if (stylesReady) return;
  await env.DB.prepare(STYLES_SCHEMA).run();
  stylesReady = true;
}

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

async function readContentMap(env) {
  await ensureContent(env);
  const r = await env.DB.prepare('SELECT key, value FROM site_content').all();
  const c = {};
  for (const row of (r.results || [])) c[row.key] = row.value;
  return c;
}

function sameContent(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

async function saveVersion(env, content, note) {
  await env.DB.prepare(VERSIONS_SCHEMA).run();
  const r = await env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM content_versions WHERE page=? AND locale=?'
  ).bind(PAGE, LOCALE).first();
  const v = ((r && r.v) || 0) + 1;
  await env.DB.prepare(
    'INSERT INTO content_versions (page, locale, version, content_json, note, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(PAGE, LOCALE, v, JSON.stringify(content), String(note || '').slice(0, 120), 'admin').run();
  if (v > 120) {
    await env.DB.prepare('DELETE FROM content_versions WHERE page=? AND locale=? AND version<=?')
      .bind(PAGE, LOCALE, v - 120).run();
  }
  return v;
}

// 草稿/发布的内容校验比旧 /content 更严：key 必须在默认文案白名单内，防止写入任意键。
function cleanContentInput(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const allowed = Object.keys(DEFAULT_CONTENT);
  const keys = Object.keys(c);
  if (!keys.length || keys.length > 60) return null;
  const clean = {};
  for (const k of keys) {
    if (!/^[a-z0-9_]{1,40}$/.test(k) || allowed.indexOf(k) < 0) return null;
    if (typeof c[k] !== 'string') return null;
    clean[k] = c[k].slice(0, MAX_CONTENT_VALUE);
  }
  return clean;
}

// 样式校验：key 必须是默认文案白名单字段；属性与值逐项过白名单，任一非法即整体拒绝。
function cleanStyles(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const allowed = Object.keys(DEFAULT_CONTENT);
  const keys = Object.keys(input);
  if (keys.length > 60) return null;
  const out = {};
  for (const k of keys) {
    if (allowed.indexOf(k) < 0) return null;
    const s = input[k];
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const o = {};
    for (const p of Object.keys(s)) {
      if (!Object.prototype.hasOwnProperty.call(STYLE_PROPS, p)) return null;
      if (!STYLE_PROPS[p](s[p])) return null;
      o[p] = String(s[p]).slice(0, 40);
    }
    if (Object.keys(o).length) out[k] = o;
  }
  return out;
}

async function readDraft(env) {
  await env.DB.prepare(DRAFT_SCHEMA).run();
  const row = await env.DB.prepare(
    'SELECT content_json, note, updated_at FROM content_drafts WHERE page=? AND locale=?'
  ).bind(PAGE, LOCALE).first();
  if (!row) return null;
  let content = {};
  try { content = JSON.parse(row.content_json) || {}; } catch { return null; }
  return { content, note: row.note || '', updated_at: row.updated_at || '' };
}

async function writeContentMap(env, c) {
  const keys = Object.keys(c);
  const sql = `INSERT INTO site_content (key, value, updated_at) VALUES ` +
    keys.map(() => "(?, ?, datetime('now'))").join(', ') +
    ` ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`;
  const params = [];
  for (const k of keys) params.push(k, c[k].slice(0, MAX_CONTENT_VALUE));
  await env.DB.prepare(sql).bind(...params).run();
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

    if (route === '/styles' && method === 'GET') {
      // 样式必须对访客公开可读：访客加载首页就要应用，否则刷新后看不到自定义样式
      try {
        await ensureStyles(env);
        const r = await env.DB.prepare('SELECT key, css_json FROM content_styles').all();
        const styles = {};
        for (const row of (r.results || [])) {
          try {
            const o = JSON.parse(row.css_json);
            if (o && typeof o === 'object' && !Array.isArray(o)) styles[row.key] = o;
          } catch (e) { /* 坏行忽略，绝不影响整页 */ }
        }
        return json({ styles });
      } catch (e) {
        return json({ styles: {} });
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

    if (route === '/content/versions' && method === 'GET') {
      // 历史文案不对外公开，仅管理模式可查
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
      try {
        await env.DB.prepare(VERSIONS_SCHEMA).run();
        const r = await env.DB.prepare(
          'SELECT id, version, note, created_at, content_json FROM content_versions ' +
          'WHERE page=? AND locale=? ORDER BY version DESC LIMIT 40'
        ).bind(PAGE, LOCALE).all();
        const versions = (r.results || []).map(row => {
          let content = {};
          try { content = JSON.parse(row.content_json) || {}; } catch { content = {}; }
          return {
            id: row.id, version: row.version, note: row.note,
            created_at: row.created_at, keys: Object.keys(content).length, content
          };
        });
        return json({ page: PAGE, locale: LOCALE, versions });
      } catch (e) {
        return json({ error: 'list failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    if (route === '/content/draft' && method === 'GET') {
      // 草稿内容不对外公开，仅管理模式可查
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
      try {
        const draft = await readDraft(env);
        return json({ hasDraft: !!draft, draft });
      } catch (e) {
        return json({ error: 'draft read failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    if (method === 'POST' || method === 'DELETE') {
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
    }

    if (route === '/styles' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const clean = cleanStyles(body && body.styles);
      if (!clean) return json({ error: 'invalid styles' }, 400);
      try {
        await ensureStyles(env);
        const keys = Object.keys(clean);
        // 一条 batch 提交（DELETE + 全部 INSERT），避免逐条往返把 2 个字段拖到 13s
        const stmts = [env.DB.prepare('DELETE FROM content_styles')];
        for (const k of keys) {
          stmts.push(env.DB.prepare(
            "INSERT INTO content_styles (key, css_json, updated_at) VALUES (?, ?, datetime('now'))"
          ).bind(k, JSON.stringify(clean[k])));
        }
        await env.DB.batch(stmts);
        return json({ ok: true, keys: keys.length });
      } catch (e) {
        return json({ error: 'styles save failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
    }

    if (route === '/styles' && method === 'DELETE') {
      try {
        await ensureStyles(env);
        await env.DB.prepare('DELETE FROM content_styles').run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: 'styles reset failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
    }

    if (route === '/content/draft' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const clean = cleanContentInput(body && body.content);
      if (!clean) return json({ error: 'valid content object required' }, 400);
      try {
        await env.DB.prepare(DRAFT_SCHEMA).run();
        await env.DB.prepare(
          `INSERT INTO content_drafts (page, locale, content_json, note, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(page, locale) DO UPDATE SET
             content_json=excluded.content_json, note=excluded.note,
             updated_at=excluded.updated_at`
        ).bind(PAGE, LOCALE, JSON.stringify(clean),
               String((body && body.note) || '').slice(0, 120) || '存为草稿').run();
        // 注意：这里绝不调用 writeContentMap / saveVersion，草稿不影响访客看到的内容
        return json({ ok: true, hasDraft: true, keys: Object.keys(clean).length });
      } catch (e) {
        return json({ error: 'draft save failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
    }

    if (route === '/content/draft' && method === 'DELETE') {
      try {
        await env.DB.prepare(DRAFT_SCHEMA).run();
        await env.DB.prepare('DELETE FROM content_drafts WHERE page=? AND locale=?')
          .bind(PAGE, LOCALE).run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: 'draft discard failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
    }

    if (route === '/content/publish' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      try {
        const draft = await readDraft(env);
        if (!draft) return json({ error: 'no draft' }, 404);
        const clean = cleanContentInput(draft.content);
        if (!clean) return json({ error: 'bad draft content' }, 500);
        const before = await readContentMap(env);
        await writeContentMap(env, clean);
        const after = Object.assign({}, before, clean);
        const changed = !sameContent(before, after);
        const version = changed
          ? await saveVersion(env, after,
              String((body && body.note) || draft.note || '').slice(0, 120) || '发布草稿')
          : null;
        await env.DB.prepare('DELETE FROM content_drafts WHERE page=? AND locale=?')
          .bind(PAGE, LOCALE).run();
        return json({ ok: true, published: Object.keys(clean).length, version, unchanged: !changed });
      } catch (e) {
        return json({ error: 'publish failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
    }

    if (route === '/content/rollback' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const v = Number(body && body.version);
      if (!Number.isInteger(v) || v <= 0) return json({ error: 'version required' }, 400);
      try {
        await env.DB.prepare(VERSIONS_SCHEMA).run();
        const row = await env.DB.prepare(
          'SELECT content_json FROM content_versions WHERE page=? AND locale=? AND version=?'
        ).bind(PAGE, LOCALE, v).first();
        if (!row) return json({ error: 'version not found' }, 404);
        let old = {};
        try { old = JSON.parse(row.content_json) || {}; } catch { return json({ error: 'bad snapshot' }, 500); }
        const keys = Object.keys(old);
        if (!keys.length || keys.length > 60) return json({ error: 'bad snapshot keys' }, 500);
        for (const k of keys) {
          if (!/^[a-z0-9_]{1,40}$/.test(k) || typeof old[k] !== 'string')
            return json({ error: 'bad snapshot value: ' + k }, 500);
        }
        const clean = {};
        for (const k of keys) clean[k] = old[k].slice(0, MAX_CONTENT_VALUE);
        const before = await readContentMap(env);
        await writeContentMap(env, clean);
        const changed = !sameContent(before, clean);
        const newV = changed
          ? await saveVersion(env, clean, '回滚到 v' + v)
          : null;
        return json({ ok: true, restoredFrom: v, version: newV, unchanged: !changed });
      } catch (e) {
        return json({ error: 'rollback failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
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
        const text = String((m && m.text) || '').slice(0, 1200);
        marks.push({
          key,
          label: String((m && m.label) || key).slice(0, 60),
          text,
          maxLen: aiLimit(key, text),
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
          { role: 'user', content: JSON.stringify({ page: PAGE, locale: LOCALE, globalHint, fields: marks }) }
        ],
        temperature: 0.7,
        max_tokens: 2400
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
      const rejects = [];
      const candidates = normalizeCandidates(parsed, marks, rejects);
      if (!candidates.length)
        return json({ error: 'AI 结果未通过校验', rejected: rejects.slice(0, 6),
                      raw: String(content).slice(0, 300) }, 502);
      // edits 保留为首候选，兼容旧调用；前端一律用 candidates，点「采用」才进预览
      return json({ ok: true, candidates, edits: candidates[0].edits, rejected: rejects.slice(0, 6) });
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
        const clean = {};
        for (const k of keys) clean[k] = c[k].slice(0, MAX_CONTENT_VALUE);
        const before = await readContentMap(env);
        await writeContentMap(env, clean);
        // 保存前是整个 live 快照，保存后是 before 叠加本次字段；内容没变就不涨版本
        const after = Object.assign({}, before, clean);
        const changed = !sameContent(before, after);
        const version = changed
          ? await saveVersion(env, after, String((body && body.note) || '').slice(0, 120) || '保存文案')
          : null;
        return json({ ok: true, saved: keys.length, version, unchanged: !changed });
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
