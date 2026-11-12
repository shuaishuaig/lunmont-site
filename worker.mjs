// LUNMONT site worker: static assets + products/content APIs backed by D1.
// Writes (POST/DELETE) require header X-Admin-Key matching D1 settings.admin_key.

const MAX_IMAGE = 700000; // dataURL char cap, keeps request body < 1MiB
const MAX_CONTENT_VALUE = 4000;

// products：去重键 ukey 是业务主键（sku 优先，其次 名称+分类），配合唯一索引保证
// 「同一产品反复发布只会更新、不会多出一条」。image 只是内容，绝不能拿来当判重依据
// ——dataURL 每次压缩字节都不同，按 image 判重必然重复。
const SCHEMA = `CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  image TEXT NOT NULL,
  sku TEXT DEFAULT '',
  ukey TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`;
// ⚠️ SQLite 限制：ALTER TABLE ADD COLUMN 不允许非常量默认值（datetime('now') 会直接报错），
// 所以补列一律不带默认值；新建表才用 DEFAULT (datetime('now'))。
const PRODUCTS_DDL = [
  "ALTER TABLE products ADD COLUMN sku TEXT DEFAULT ''",
  "ALTER TABLE products ADD COLUMN ukey TEXT DEFAULT ''",
  "ALTER TABLE products ADD COLUMN updated_at TEXT"
];
const PRODUCTS_MIGRATION_KEY = 'products_v3';
let productsReady = false;

// 稳定业务键：有 sku 用 sku（产品改了名/换了图也认得出来），否则用 名称+分类。
// 归一化必须与迁移回填共用同一个函数，否则回填出来的键和运行时算的对不上=白填。
function productKey(p) {
  const sku = String((p && p.sku) || '').trim().toLowerCase();
  if (sku) return 'sku:' + sku.slice(0, 80);
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const name = norm(p && p.name).slice(0, 120);
  const cat = norm(p && p.category).slice(0, 60);
  return 'nm:' + name + '|' + cat;
}

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

// products 迁移（只做一次，用 settings 标记位判定，避免每次冷启动都跑）。
// 步骤：建表 → 补列 → 按 productKey 回填 ukey → 尽力建唯一索引。
// ⚠️ 迁移里**绝不删数据**：历史重复只统计进 settings 供 /products/dedupe 预览，
// 真正删除必须人来显式调用（默认 dryRun）。删行放在自动迁移里=一次判重口径失误就清库。
async function ensureProducts(env) {
  if (productsReady) return;
  await env.DB.prepare(SETTINGS_SCHEMA).run();
  const flag = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
    .bind(PRODUCTS_MIGRATION_KEY).first();
  if (flag && flag.value === '1') { productsReady = true; return; }

  await env.DB.prepare(SCHEMA).run();
  for (const ddl of PRODUCTS_DDL) {
    try { await env.DB.prepare(ddl).run(); } catch (e) { /* 列已存在：忽略 */ }
  }

  // 补列可能部分失败：先确认四列（含 updated_at）都能读，读不到就抛出去
  // —— 宁可不设标记也不能谎报迁移成功（否则标记=1 后永远补不上缺的列）
  const all = await env.DB.prepare('SELECT id, name, category, sku, image, ukey, updated_at FROM products').all();
  const rows = all.results || [];
  const backfill = [];
  for (const p of rows) {
    const k = productKey(p);
    if (p.ukey !== k) backfill.push(env.DB.prepare('UPDATE products SET ukey=? WHERE id=?').bind(k, p.id));
  }
  if (backfill.length) await env.DB.batch(backfill);

  // 只统计、不删除；有重复时索引建不上，应用层 upsert 仍然能保证不新增
  let dupes = 0;
  try {
    const dup = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM (SELECT ukey FROM products WHERE ukey<>'' GROUP BY ukey HAVING COUNT(*)>1)"
    ).first();
    dupes = (dup && dup.n) || 0;
  } catch (e) { /* 统计失败不影响主流程 */ }
  try {
    await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_ukey ON products(ukey)').run();
  } catch (e) { /* 存在历史重复：索引建不上，交给 /products/dedupe 人工确认 */ }

  const stmts = [
    env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .bind(PRODUCTS_MIGRATION_KEY),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('products_dupe_groups', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(String(dupes))
  ];
  await env.DB.batch(stmts);
  productsReady = true;
}

// 历史重复体检 + 清理（仅在人工显式调用时删行，默认只预览）
async function dupeReport(env) {
  const r = await env.DB.prepare(
    "SELECT ukey, COUNT(*) AS n, MIN(id) AS first_id, MAX(id) AS last_id FROM products WHERE ukey<>'' GROUP BY ukey HAVING COUNT(*)>1"
  ).all();
  return r.results || [];
}

// 单条产品入参清洗：字段截断 + 图片格式/体积校验，返回 ukey 供 upsert 判重
function cleanProduct(body) {
  const name = String((body && body.name) || '').trim().slice(0, 120);
  const category = String((body && body.category) || '').trim().slice(0, 60);
  const image = String((body && body.image) || '');
  const sku = String((body && body.sku) || '').trim().slice(0, 80);
  if (!name) return { error: 'name required', status: 400 };
  if (!image.startsWith('data:image/') && !/^https?:\/\//.test(image))
    return { error: 'image must be data URL or http(s) URL', status: 400 };
  if (image.length > MAX_IMAGE) return { error: 'image too large', status: 413 };
  return { name, category, image, sku, ukey: productKey({ sku, name, category }) };
}

// 批量幂等写入：一次读全表判重 + 一次 DB.batch 提交，2 个往返搞定任意条数。
// 逐条 INSERT/UPDATE 会变成几百次往返（D1 每次往返成本高），批量发布必须走这条路。
// 同样带「接管」：sku: 键没命中时用 nm: 键找历史行，命中就原地改写键，绝不新增。
async function upsertMany(env, items) {
  const all = await env.DB.prepare('SELECT id, name, category, image, sku, ukey FROM products').all();
  const cur = new Map();
  for (const p of (all.results || [])) cur.set(p.ukey, p);
  let created = 0, updated = 0, unchanged = 0, adopted = 0;
  const stmts = [];
  for (const it of items) {
    let ex = cur.get(it.ukey);
    let adoptFrom = null;
    if (!ex && it.ukey.indexOf('sku:') === 0) {
      const legacy = productKey({ name: it.name, category: it.category });
      const old = legacy !== it.ukey ? cur.get(legacy) : null;
      if (old) { ex = old; adoptFrom = legacy; }
    }
    if (!ex) {
      created++;
      // 不用 ON CONFLICT：唯一索引在「存在历史重复」时建不上，依赖它会让整批插入失败
      stmts.push(env.DB.prepare(
        "INSERT INTO products (name, category, image, sku, ukey, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).bind(it.name, it.category, it.image, it.sku, it.ukey));
      cur.set(it.ukey, { id: -1, name: it.name, category: it.category, image: it.image,
                         sku: it.sku, ukey: it.ukey });
      continue;
    }
    const changed = ex.name !== it.name || (ex.category || '') !== it.category ||
      ex.image !== it.image || (ex.sku || '') !== it.sku || ex.ukey !== it.ukey;
    if (adoptFrom) {
      // 同批里两个不同 sku 抢同一历史行时，第二个不能再接管（键已被前一个占掉）
      if (cur.get(it.ukey)) { unchanged++; continue; }
      adopted++;
      cur.delete(adoptFrom);
    }
    if (changed) {
      updated++;
      stmts.push(env.DB.prepare(
        "UPDATE products SET name=?, category=?, image=?, sku=?, ukey=?, updated_at=datetime('now') WHERE ukey=?"
      ).bind(it.name, it.category, it.image, it.sku, it.ukey, ex.ukey));
    } else unchanged++;
    cur.set(it.ukey, { id: ex.id, name: it.name, category: it.category, image: it.image,
                       sku: it.sku, ukey: it.ukey });
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { created, updated, unchanged, adopted };
}

// 幂等写入：同一 ukey 只会有一行。created/updated/unchanged 三态回给调用方，
// unchanged 直接不写库（重复发布同一份内容 = 零写入、零耗时、零脏数据）。
//
// ⚠️ 「接管」逻辑（去重能不能落地的关键）：历史行是按 nm:（名称+分类）建的键，
// 而升级后带 sku 发布算出的是 sku: 键 —— 只按新键查会查不到 → 重复发布反而多出 149 条。
// 所以新键没命中时，再用 nm: 键找一次，命中就把该行「接管」成 sku: 键（原地更新，不新增）。
async function upsertProduct(env, item) {
  let ex = await env.DB.prepare('SELECT id, name, category, image, sku, ukey FROM products WHERE ukey=?')
    .bind(item.ukey).first();
  let adopted = false;
  if (!ex && item.ukey.indexOf('sku:') === 0) {
    const legacy = productKey({ name: item.name, category: item.category });
    if (legacy !== item.ukey) {
      const old = await env.DB.prepare('SELECT id, name, category, image, sku, ukey FROM products WHERE ukey=?')
        .bind(legacy).first();
      if (old) { ex = old; adopted = true; }
    }
  }
  if (ex) {
    const changed = ex.name !== item.name || (ex.category || '') !== item.category ||
      ex.image !== item.image || (ex.sku || '') !== item.sku || ex.ukey !== item.ukey;
    if (changed) {
      await env.DB.prepare(
        "UPDATE products SET name=?, category=?, image=?, sku=?, ukey=?, updated_at=datetime('now') WHERE id=?"
      ).bind(item.name, item.category, item.image, item.sku, item.ukey, ex.id).run();
    }
    return { id: ex.id, action: changed ? 'updated' : 'unchanged', adopted };
  }
  try {
    const r = await env.DB.prepare(
      "INSERT INTO products (name, category, image, sku, ukey, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).bind(item.name, item.category, item.image, item.sku, item.ukey).run();
    return { id: r.meta && r.meta.last_row_id, action: 'created' };
  } catch (e) {
    // ① 极端情况：updated_at 列还没补上（迁移失败）→ 去掉该列重试，保证写入不瘫
    if (/no such column/i.test(String(e && e.message || e))) {
      const r2 = await env.DB.prepare(
        'INSERT INTO products (name, category, image, sku, ukey) VALUES (?, ?, ?, ?, ?)'
      ).bind(item.name, item.category, item.image, item.sku, item.ukey).run();
      return { id: r2.meta && r2.meta.last_row_id, action: 'created' };
    }
    // ② 并发下被唯一索引挡住的第二条：退化成更新，既不报错也不会多出一条
    const again = await env.DB.prepare('SELECT id FROM products WHERE ukey=?').bind(item.ukey).first();
    if (!again) throw e;
    await env.DB.prepare(
      "UPDATE products SET name=?, category=?, image=?, sku=?, updated_at=datetime('now') WHERE id=?"
    ).bind(item.name, item.category, item.image, item.sku, again.id).run();
    return { id: again.id, action: 'updated' };
  }
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

// 数值属性统一归一化成数字（含小位数），枚举/颜色统一成字符串。
// 关键：前端提交数字、回读也必须是数字，否则面板回显与脏检查会出现 "72" !== 72 的假差异。
const STYLE_NUMERIC = { fontSize: 0, fontWeight: 0, lineHeight: 2, letterSpacing: 3 };
function normStyleValue(p, v) {
  if (Object.prototype.hasOwnProperty.call(STYLE_NUMERIC, p)) {
    const d = STYLE_NUMERIC[p];
    const n = Number(v);
    if (!isFinite(n)) return null;
    return d === 0 ? Math.round(n) : Number(n.toFixed(d));
  }
  return String(v).slice(0, 40);
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
      const nv = normStyleValue(p, s[p]);
      if (nv === null) return null;
      o[p] = nv;
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
      // 绝不 SELECT 迁移中才补的列（updated_at 曾因 SQLite 限制加不上，
      // 一条 SELECT 报错就被 catch 成空数组 —— 首页产品区会整体消失，且完全静默）
      let rows = [];
      try {
        const r = await env.DB.prepare(
          'SELECT id, name, category, image, sku FROM products ORDER BY id DESC LIMIT 500'
        ).all();
        rows = r.results || [];
      } catch (e) {
        // 兜底：老 schema 只有四列时也要能出数据
        try {
          const r2 = await env.DB.prepare(
            'SELECT id, name, category, image FROM products ORDER BY id DESC LIMIT 500'
          ).all();
          rows = r2.results || [];
        } catch (e2) {
          return json({ products: [], detail: String(e2 && e2.message || e2).slice(0, 160) }, 200);
        }
      }
      const out = { products: rows };
      // ?stats=1 需要 admin：给「发布对账」用，返回总行数/唯一键数/重复组数
      if (url.searchParams.get('stats') === '1') {
        if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
        try {
          const s = await env.DB.prepare(
            "SELECT COUNT(*) AS rows, COUNT(DISTINCT ukey) AS keys FROM products"
          ).first();
          const dups = await dupeReport(env);
          out.stats = {
            rows: (s && s.rows) || rows.length,
            keys: (s && s.keys) || 0,
            dupes: dups.length
          };
        } catch (e) {
          out.stats = { rows: rows.length, keys: 0, dupes: 0,
                        detail: String(e && e.message || e).slice(0, 160) };
        }
      }
      return json(out);
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
            if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
            // 回读同样过一遍归一化：老行/脏行（字符串数字、未知属性）统一成标准形态
            const out = {};
            for (const p of Object.keys(o)) {
              if (!Object.prototype.hasOwnProperty.call(STYLE_PROPS, p)) continue;
              if (!STYLE_PROPS[p](o[p])) continue;
              const nv = normStyleValue(p, o[p]);
              if (nv !== null) out[p] = nv;
            }
            if (Object.keys(out).length) styles[row.key] = out;
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
      const item = cleanProduct(body);
      if (item.error) return json({ error: item.error }, item.status || 400);
      try {
        await ensureProducts(env);
        const r = await upsertProduct(env, item);
        return json({ ok: true, id: r.id, action: r.action, adopted: !!r.adopted, ukey: item.ukey });
      } catch (e) {
        return json({ error: 'save failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    // 批量发布：一次最多 200 条，整体幂等。重复发布（含改名/换图）只会更新原行，
    // 同一批里出现两次同 ukey 也只留最后一条。返回三态计数便于对账。
    if (route === '/products/batch' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const items = Array.isArray(body && body.items) ? body.items : null;
      if (!items) return json({ error: 'items array required' }, 400);
      if (!items.length) return json({ error: 'items empty' }, 400);
      if (items.length > 200) return json({ error: 'too many items (max 200)' }, 413);
      const clean = [];
      const errors = [];
      items.forEach((raw, i) => {
        const it = cleanProduct(raw);
        if (it.error) errors.push({ index: i, error: it.error });
        else clean.push(it);
      });
      if (!clean.length) return json({ error: 'no valid items', errors }, 400);
      try {
        await ensureProducts(env);
        // 批内去重：同 ukey 后者覆盖前者，避免同一批里自己撞自己
        const map = new Map();
        for (const it of clean) map.set(it.ukey, it);
        const r = await upsertMany(env, [...map.values()]);
        return json({
          ok: true, total: items.length, valid: map.size,
          created: r.created, updated: r.updated, unchanged: r.unchanged, adopted: r.adopted,
          errors
        });
      } catch (e) {
        return json({ error: 'batch failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    // 历史重复体检/清理：默认 dryRun 只报告不删；要真删必须显式传 dryRun:false。
    // keep 默认 newest（保留最后一次发布的内容），'oldest' 则保留最早那条。
    if (route === '/products/dedupe' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* 允许空 body */ }
      const dryRun = !body || body.dryRun !== false;
      const keepOldest = String((body && body.keep) || 'newest') === 'oldest';
      try {
        await ensureProducts(env);
        const groups = await dupeReport(env);
        const wouldRemove = groups.reduce((s, g) => s + Math.max(0, (Number(g.n) || 0) - 1), 0);
        if (dryRun) {
          return json({ ok: true, dryRun: true, groups: groups.length, wouldRemove,
                        sample: groups.slice(0, 10) });
        }
        if (groups.length) {
          await env.DB.batch(groups.map(g => env.DB.prepare('DELETE FROM products WHERE ukey=? AND id<>?')
            .bind(g.ukey, keepOldest ? g.first_id : g.last_id)));
        }
        let indexed = true;
        try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_ukey ON products(ukey)').run(); }
        catch (e) { indexed = false; }
        const after = await dupeReport(env);
        return json({ ok: true, dryRun: false, removed: wouldRemove,
                      groupsAfter: after.length, indexed });
      } catch (e) {
        return json({ error: 'dedupe failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    // 迁移修复口（admin）：逐条执行补列并回报真实错误 + 当前列清单。
    // 为什么单独开一个：迁移里的 try/catch 会把 D1 的具体报错吞掉，只看到「列不存在」
    // 这种二次症状，根本判不出是 ADD COLUMN 不被支持还是默认值非法。
    if (route === '/products/migrate' && method === 'POST') {
      const out = { ddl: [], columns: [], flagCleared: false };
      try {
        await env.DB.prepare(SCHEMA).run();
      } catch (e) { out.schemaError = String(e && e.message || e).slice(0, 160); }
      for (const ddl of PRODUCTS_DDL) {
        try {
          await env.DB.prepare(ddl).run();
          out.ddl.push({ ddl, ok: true });
        } catch (e) {
          out.ddl.push({ ddl, ok: false, error: String(e && e.message || e).slice(0, 160) });
        }
      }
      try {
        const c = await env.DB.prepare('PRAGMA table_info(products)').all();
        out.columns = (c.results || []).map(x => x.name);
      } catch (e) { out.columnsError = String(e && e.message || e).slice(0, 160); }
      try {
        await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'products_v%'").run();
        out.flagCleared = true;
      } catch (e) {}
      productsReady = false;   // 下次请求重新走迁移（补列+回填 ukey）
      return json(out);
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
