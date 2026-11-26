// LUNMONT site worker: static assets + products/content APIs backed by D1.
// Writes (POST/DELETE) require header X-Admin-Key matching D1 settings.admin_key.
//
// 管理入口（2026-11-13）：首页不再有「管理模式」链接，改为 /admin 登录页。
// 关键：门禁在服务端 —— 所有写接口不论走哪个前端都先过 checkAdmin，
// 前端登录只决定「能不能拿到输入框」，绝不承担鉴权职责。

// build-tag: 2026-11-26 layout-blocks-facets
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
  "ALTER TABLE products ADD COLUMN updated_at TEXT",
  // 变体分组：同一产品不同花色/颜色共用一个 parent_sku（= 产品卡键）。
  // 空串表示「独立成卡」（老数据行为，绝不改变已有卡片数量）。
  "ALTER TABLE products ADD COLUMN parent_sku TEXT DEFAULT ''",
  // 色点两色 + 是否双色纹路（碎花/豹纹/条纹）。由 tools/_extract_sku_colors.py 从产品图实测得出，
  // 前端色点模式直接吃这三个值，不再靠色名猜色。
  "ALTER TABLE products ADD COLUMN color TEXT DEFAULT ''",
  "ALTER TABLE products ADD COLUMN color2 TEXT DEFAULT ''",
  "ALTER TABLE products ADD COLUMN pattern INTEGER DEFAULT 0",
  // 分类归纳（tools/_gen_site_taxonomy.py 产物）：一张卡 = 一个产品，
  // 四个维度都是卡级属性，所以同 parent_sku 的行写相同的值。
  "ALTER TABLE products ADD COLUMN material TEXT DEFAULT ''",
  "ALTER TABLE products ADD COLUMN size_type TEXT DEFAULT ''",
  // styles 是多值（几何+镶钻），逗号分隔存储；查询一律在应用层 split，不做 SQL LIKE
  "ALTER TABLE products ADD COLUMN styles TEXT DEFAULT ''",
  "ALTER TABLE products ADD COLUMN family TEXT DEFAULT ''",
  // 商城价格（USD，两位小数用 REAL 存）。0 = 未定价（前端显示「询价」，购物车拒加）。
  "ALTER TABLE products ADD COLUMN price REAL DEFAULT 0",
  // 批发档价格：/products/prices 与批发客价格覆盖都写读此列，
  // 但历史迁移从未建过它（products_v6 只加了 price）→ D1_ERROR: no such column。
  // 必须补进 DDL 并 bump 迁移键，否则老库永远缺列（2026-11-26 修复）。
  "ALTER TABLE products ADD COLUMN price_wholesale REAL DEFAULT 0"
];
const PRODUCTS_MIGRATION_KEY = 'products_v7';
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

// 图片 URL 键：只对 http(s) 图有效（dataURL 每次压缩都不一样，绝不能当键）。
// 用途是「历史行过渡」——老 149 行没有 sku，且名称+分类大量重名，
// 只有图片 URL 是逐行唯一的，用它当历史键才不会把多行压成一个键。
function imageKey(image) {
  const s = String(image || '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  return 'img:' + s.replace(/[?#].*$/, '').replace(/\s+/g, '').toLowerCase().slice(0, 200);
}

// 老行（无 ukey）的回填键：优先图片 URL，其次 名称+分类
function backfillKey(p) {
  return imageKey(p && p.image) || productKey(p);
}

// 「接管」候选键：带 sku 发布时新键查不到，就用这些老键找同一条历史行，
// 找到就地改写键，绝不新增。顺序=图片优先（唯一性最强），再名称+分类。
function adoptKeys(item) {
  const out = [];
  const img = imageKey(item.image);
  if (img) out.push(img);
  const nm = productKey({ name: item.name, category: item.category });
  if (out.indexOf(nm) < 0) out.push(nm);
  return out;
}

const CONTENT_SCHEMA = `CREATE TABLE IF NOT EXISTS site_content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
)`;

// 2026-11-22 SEO：产品英文内容独立表。绝不给 products 加列——cleanProduct/upsertMany
// 是全列写入，加了列却不在写入清单里会被每次发布清零（项目铁律）。独立表按 sku 关联，
// 后台产品编辑（name/category/image/price）照旧，SEO 文案单独维护、互不干扰。
const PRODUCT_SEO_SCHEMA = `CREATE TABLE IF NOT EXISTS product_seo (
  sku TEXT PRIMARY KEY,
  name_en TEXT DEFAULT '',
  slug TEXT DEFAULT '',
  description_en TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
)`;

const SETTINGS_SCHEMA = `CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`;

/* ================= 区块布局（2026-11-26） =================
   首页 7 个内置区块（data-block）的排序/显隐 + 自定义区块（模板化，纯文字+可选链接，
   不开 HTML 注入口子）。布局存 settings.layout_json；自定义区块的**文字内容**走
   /api/content 链路（cx_ 前缀 key），这里只存结构。访客 GET 公开可读，写需 admin。 */
const LAYOUT_V = 1;
const BUILTIN_BLOCKS = ['nav', 'hero', 'stats', 'products', 'admin', 'contact', 'footer'];
// locked：不可隐藏也不可删除（导航/产品/联系/页脚是功能骨架，admin 区是上架入口）
const LOCKED_BLOCKS = ['nav', 'products', 'contact', 'footer'];
const LAYOUT_TYPES = {
  cta: ['title', 'sub', 'btn', 'link'],
  feature: ['title', 'sub', 'text', 'btn', 'link'],
  faq: ['title', 'q1', 'a1', 'q2', 'a2', 'q3', 'a3'],
  trust: ['title', 'i1', 'i2', 'i3', 'i4'],
};
const CUSTOM_ID_RE = /^x[0-9a-z]{3,12}$/;

// 归一化校验：非法返回 null（调用方 400）。宽容缺省：order 缺项由前端按默认补齐。
function cleanLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const custom = raw.custom && typeof raw.custom === 'object' && !Array.isArray(raw.custom)
    ? raw.custom : {};
  const ckeys = Object.keys(custom);
  if (ckeys.length > 12) return null;
  const outCustom = {};
  for (const id of ckeys) {
    if (!CUSTOM_ID_RE.test(id)) return null;
    const blk = custom[id];
    if (!blk || typeof blk !== 'object' || Array.isArray(blk)) return null;
    const type = String(blk.type || '');
    const allowed = LAYOUT_TYPES[type];
    if (!allowed) return null;
    const fields = {};
    for (const f of Object.keys(blk)) {
      if (f === 'type') continue;
      if (allowed.indexOf(f) < 0) return null;   // 多余字段直接拒绝，防止塞任意数据
      const v = String(blk[f] == null ? '' : blk[f]).slice(0, f === 'link' ? 300 : 600);
      if (f === 'link' && v && !/^(https:\/\/[^\s"]+|\/[^\s"]*)$/.test(v)) return null;
      fields[f] = v;
    }
    outCustom[id] = { type, fields };
  }
  const orderIn = Array.isArray(raw.order) ? raw.order : [];
  const order = [];
  const seen = new Set();
  for (const x of orderIn) {
    const id = String(x || '');
    if (BUILTIN_BLOCKS.indexOf(id) < 0 && !outCustom[id]) return null;
    if (seen.has(id)) return null;
    seen.add(id); order.push(id);
  }
  // 内置区块缺失 = 隐藏该区块（锁定骨架除外，绝不隐藏）；统一补齐避免两侧口径分叉
  const hiddenIn = Array.isArray(raw.hidden) ? raw.hidden : [];
  const hidden = [];
  for (const x of hiddenIn) {
    const id = String(x || '');
    if (BUILTIN_BLOCKS.indexOf(id) < 0 && !outCustom[id]) return null;
    if (LOCKED_BLOCKS.indexOf(id) >= 0) continue;  // 锁定区块忽略隐藏请求，不整体拒绝
    if (seen.has(id) && hidden.indexOf(id) < 0) hidden.push(id);
  }
  for (const b of BUILTIN_BLOCKS) {
    if (!seen.has(b)) { order.push(b); if (LOCKED_BLOCKS.indexOf(b) < 0 && hidden.indexOf(b) < 0) hidden.push(b); }
  }
  return { v: LAYOUT_V, order, hidden, custom: outCustom };
}

async function readLayout(env) {
  const raw = await readSetting(env, 'layout_json');
  if (!raw) return null;
  try { return cleanLayout(JSON.parse(raw)); } catch { return null; }
}

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
// 'base' = 历史单语主表（site_content），保持兼容：老工具不传 lang 时行为完全不变。
// en/zh/ru = 独立 i18n 行，编辑某语言绝不覆盖其它语言或主表原文。
const LOCALE = 'base';
const LOCALES = ['en', 'zh', 'ru'];
const I18N_SCHEMA = `CREATE TABLE IF NOT EXISTS site_content_i18n (
  locale TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (locale, key)
)`;
let i18nReady = false;
async function ensureI18n(env) {
  if (i18nReady) return;
  await env.DB.prepare(I18N_SCHEMA).run();
  i18nReady = true;
}
function localeOf(request) {
  try {
    const u = new URL(request.url);
    const v = String(u.searchParams.get('lang') || u.searchParams.get('locale') || '').toLowerCase().trim();
    if (LOCALES.indexOf(v) >= 0) return v;
    if (v === 'base') return 'base';
  } catch (e) {}
  return LOCALE;
}
// 老数据多是「English / 中文」同行存放；没有该语言行时按此拆分兜底，
// 不写回主表、不改历史数据，只用于展示与编辑器的初始值。
function deriveLocaleValue(v, loc) {
  if (loc === 'base' || typeof v !== 'string') return v;
  const parts = v.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return v;
  const cjk = /[\u4e00-\u9fff]/;
  let en = parts[0], zh = parts[parts.length - 1];
  if (cjk.test(en) && !cjk.test(zh)) { const t = en; en = zh; zh = t; }
  if (loc === 'zh') return cjk.test(zh) ? zh : zh;
  if (loc === 'ru') return en;         // 暂无俄语源，回退英文，绝不编造译文
  return en;
}

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

// 询盘：访客提交的采购意向。公开只写、管理模式可读/删。
// 防滥用：蜜罐字段（人类看不见，机器人会填）+ 长度截断 + 频率上限（同 IP 每小时）。
const INQUIRIES_SCHEMA = `CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
)`;
let inquiriesReady = false;
async function ensureInquiries(env) {
  if (inquiriesReady) return;
  await env.DB.prepare(INQUIRIES_SCHEMA).run();
  inquiriesReady = true;
}

// ⚠️ 与前端 FONT_STACKS / ART_PRESETS 的 key 必须完全一致（改一处同步改另一处）。
// 只接受枚举 key；真正的 CSS 声明由前端常量表查表生成，服务端绝不接收任意 CSS 字符串，
// 任一非法属性/值 -> cleanStyles 返回 null -> 整个 POST 400，不会写入半套样式。
const FONT_KEYS = ['serif', 'songti', 'fangsong', 'kaiti', 'sans', 'heiti', 'yuanti', 'light',
  'georgia', 'times', 'helvetica', 'palatino', 'impact', 'script', 'mono', 'trebuchet'];
const ART_KEYS = ['shadow', 'glow', 'emboss', 'retro', 'stroke', 'hollow',
  'neon', 'outline', 'gold', 'rainbow'];
const STYLE_PROPS = {
  fontSize: v => Number.isInteger(Number(v)) && Number(v) >= 8 && Number(v) <= 120,
  fontWeight: v => ['300', '400', '500', '600', '700', '800'].indexOf(String(v)) >= 0,
  color: v => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v)) ||
              /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/.test(String(v)),
  align: v => ['left', 'center', 'right'].indexOf(String(v)) >= 0,
  lineHeight: v => Number(v) >= 0.8 && Number(v) <= 2.5,
  letterSpacing: v => Number(v) >= -0.05 && Number(v) <= 0.5,
  fontFamily: v => FONT_KEYS.indexOf(String(v)) >= 0,
  fontStyle: v => ['normal', 'italic'].indexOf(String(v)) >= 0,
  textTransform: v => ['none', 'uppercase', 'lowercase', 'capitalize'].indexOf(String(v)) >= 0,
  textDecoration: v => ['none', 'underline', 'overline', 'line-through'].indexOf(String(v)) >= 0,
  art: v => ART_KEYS.indexOf(String(v)) >= 0
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
  'empty_text': '暂无产品，请稍后再看或直接联系我们。',
  'admin_title': '上传产品图片',
  'admin_hint': '选择图片后自动压缩并生成产品卡片，可多选一次上传多张。产品名选填，分类决定卡片归类。',
  'contact_kicker': 'CONTACT',
  'contact_title': '欢迎来样订制与批发合作',
  'contact_sub': '义乌市玥岑进出口有限公司 · 浙江义乌',
  'contact_email': 'lunmontfa@gmail.com',
  'footer_left': '© 2026 LUNMONT · 义乌市玥岑进出口有限公司',
  'footer_right': 'HAIR ACCESSORIES WHOLESALE',
  'filter_all': '全部',
  'form_title': '在线询盘 · Send Inquiry',
  'form_name': '姓名 / Name',
  'form_contact': '邮箱或 WhatsApp / Email or WhatsApp',
  'form_msg': '询盘内容（想询价的款号、数量、目的港）',
  'form_submit': '发送询盘 Send',
  'wa_btn': 'WhatsApp 咨询',
  // 2026-11-25 后台可编辑性：WhatsApp 号码（纯数字带国家码）不再写死在前端，
  // 首页加载时用本键重写 wa.me 链接；改号码 = 改文案，不用发版。
  'wa_phone': '8618268820516',
  'foot_about': '关于我们 About',
  'foot_factory': '工厂 Factory',
  'foot_certificates': '资质 Certificates',
  'foot_privacy': '隐私政策 Privacy',
  'foot_returns': '退换货 Returns',
  'foot_terms': '服务条款 Terms',
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
// schema 版本沿革：taxonomy-v5（分类四列）→ products_v6（price）→ shop-checkout-v1（商城）。
// 版本号 = PRODUCTS_MIGRATION_KEY：每次要给 products 加列都必须升版本，
// 否则标记已存在 → 补列被跳过 → SELECT 新列报错 → 被 catch 成空数组（产品区整块消失且静默）。
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

  // 补列可能部分失败：先确认所有列都能读（含 updated_at 与变体三列），读不到就抛出去
  // —— 宁可不设标记也不能谎报迁移成功（否则标记=1 后永远补不上缺的列）。
  // 注意这里用 SELECT * 不写死列名，缺列时 SQLite 也不会因此报错。
  const all = await env.DB.prepare('SELECT * FROM products').all();
  const rows = all.results || [];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  if (rows.length) {
    for (const need of ['updated_at', 'parent_sku', 'color', 'color2', 'pattern',
                        'material', 'size_type', 'styles', 'family', 'price',
                        'price_wholesale']) {
      if (cols.indexOf(need) < 0) throw new Error('products migration incomplete: missing column ' + need);
    }
  }
  const backfill = [];
  for (const p of rows) {
    // 已有 sku 键的行不动；空键/老键按 backfillKey 归一（图片优先，避免重名塌缩）
    const k = (p.ukey && p.ukey.indexOf('sku:') === 0) ? p.ukey : backfillKey(p);
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
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function cleanColor(v) {
  const s = String(v || '').trim();
  return HEX_RE.test(s) ? s.toLowerCase() : '';
}
function cleanProduct(body) {
  const name = String((body && body.name) || '').trim().slice(0, 120);
  const category = String((body && body.category) || '').trim().slice(0, 60);
  const image = String((body && body.image) || '');
  const sku = String((body && body.sku) || '').trim().slice(0, 80);
  // 变体分组键：空 = 独立成卡。只允许 sku 形态，避免脏值把不相干的行并成一张卡。
  const parent = String((body && body.parent_sku) || '').trim().slice(0, 80);
  const parent_sku = (parent && parent !== sku) ? parent : '';
  const color = cleanColor(body && body.color);
  const color2 = cleanColor(body && body.color2) || color;
  const pattern = (body && (body.pattern === 1 || body.pattern === true)) ? 1 : 0;
  // 分类归纳：卡级属性，styles 多值用逗号拼接（前端 split，不做 SQL LIKE）
  const material = String((body && body.material) || '').trim().slice(0, 24);
  const size_type = String((body && (body.size_type || body.size)) || '').trim().slice(0, 12);
  const rawStyles = body && body.styles;
  const styles = (Array.isArray(rawStyles) ? rawStyles : String(rawStyles || '').split(','))
    .map(s => String(s || '').trim()).filter(Boolean).slice(0, 6).join(',');
  const family = String((body && body.family) || '').trim().slice(0, 16);
  // 商城价格：负数/非法=0（未定价）；上限封顶防手滑；保留两位小数
  let price = Number(body && body.price);
  price = (isFinite(price) && price > 0) ? Math.min(Math.round(price * 100) / 100, 1000000) : 0;
  if (!name) return { error: 'name required', status: 400 };
  if (!image.startsWith('data:image/') && !/^https?:\/\//.test(image))
    return { error: 'image must be data URL or http(s) URL', status: 400 };
  if (image.length > MAX_IMAGE) return { error: 'image too large', status: 413 };
  return { name, category, image, sku, ukey: productKey({ sku, name, category }),
           parent_sku, color, color2, pattern, material, size_type, styles, family, price };
}

// 批量幂等写入：一次读全表判重 + 一次 DB.batch 提交，2 个往返搞定任意条数。
// 逐条 INSERT/UPDATE 会变成几百次往返（D1 每次往返成本高），批量发布必须走这条路。
// 同样带「接管」：sku: 键没命中时用 nm: 键找历史行，命中就原地改写键，绝不新增。
async function upsertMany(env, items) {
  // ORDER BY id：同键多行（历史重复）时 Map 后写覆盖，命中的是最新那条
  const all = await env.DB.prepare(
    'SELECT id, name, category, image, sku, ukey, parent_sku, color, color2, pattern, ' +
    'material, size_type, styles, family, price FROM products ORDER BY id'
  ).all();
  const cur = new Map();
  for (const p of (all.results || [])) cur.set(p.ukey, p);
  let created = 0, updated = 0, unchanged = 0, adopted = 0;
  const stmts = [];
  const sameVariant = (ex, it) =>
    (ex.parent_sku || '') === it.parent_sku && (ex.color || '') === it.color &&
    (ex.color2 || '') === it.color2 && Number(ex.pattern || 0) === Number(it.pattern || 0) &&
    (ex.material || '') === (it.material || '') && (ex.size_type || '') === (it.size_type || '') &&
    (ex.styles || '') === (it.styles || '') && (ex.family || '') === (it.family || '') &&
    Number(ex.price || 0) === Number(it.price || 0);
  for (const it of items) {
    let ex = cur.get(it.ukey);
    let adoptFrom = null;
    if (!ex && it.ukey.indexOf('sku:') === 0) {
      for (const lk of adoptKeys(it)) {
        if (lk === it.ukey) continue;
        const old = cur.get(lk);
        if (old) { ex = old; adoptFrom = lk; break; }
      }
    }
    if (!ex) {
      created++;
      // 不用 ON CONFLICT：唯一索引在「存在历史重复」时建不上，依赖它会让整批插入失败
      stmts.push(env.DB.prepare(
        "INSERT INTO products (name, category, image, sku, ukey, parent_sku, color, color2, pattern, " +
        "material, size_type, styles, family, price, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
      ).bind(it.name, it.category, it.image, it.sku, it.ukey,
             it.parent_sku, it.color, it.color2, it.pattern,
             it.material, it.size_type, it.styles, it.family, it.price));
      cur.set(it.ukey, { id: -1, name: it.name, category: it.category, image: it.image,
                         sku: it.sku, ukey: it.ukey, parent_sku: it.parent_sku,
                         color: it.color, color2: it.color2, pattern: it.pattern,
                         material: it.material, size_type: it.size_type,
                         styles: it.styles, family: it.family, price: it.price });
      continue;
    }
    const changed = ex.name !== it.name || (ex.category || '') !== it.category ||
      ex.image !== it.image || (ex.sku || '') !== it.sku || ex.ukey !== it.ukey ||
      !sameVariant(ex, it);
    if (adoptFrom) {
      // 同批里两个不同 sku 抢同一历史行时，第二个不能再接管（键已被前一个占掉）
      if (cur.get(it.ukey)) { unchanged++; continue; }
      adopted++;
      cur.delete(adoptFrom);
    }
    if (changed) {
      updated++;
      stmts.push(env.DB.prepare(
        "UPDATE products SET name=?, category=?, image=?, sku=?, ukey=?, parent_sku=?, color=?, color2=?, " +
        "pattern=?, material=?, size_type=?, styles=?, family=?, price=?, updated_at=datetime('now') WHERE ukey=?"
      ).bind(it.name, it.category, it.image, it.sku, it.ukey,
             it.parent_sku, it.color, it.color2, it.pattern,
             it.material, it.size_type, it.styles, it.family, it.price, ex.ukey));
    } else unchanged++;
    cur.set(it.ukey, { id: ex.id, name: it.name, category: it.category, image: it.image,
                       sku: it.sku, ukey: it.ukey, parent_sku: it.parent_sku,
                       color: it.color, color2: it.color2, pattern: it.pattern,
                       material: it.material, size_type: it.size_type,
                       styles: it.styles, family: it.family, price: it.price });
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
  const COLS = 'id, name, category, image, sku, ukey, parent_sku, color, color2, pattern, ' +
               'material, size_type, styles, family, price';
  let ex = await env.DB.prepare('SELECT ' + COLS + ' FROM products WHERE ukey=?')
    .bind(item.ukey).first();
  let adopted = false;
  if (!ex && item.ukey.indexOf('sku:') === 0) {
    for (const lk of adoptKeys(item)) {
      if (lk === item.ukey) continue;
      const old = await env.DB.prepare('SELECT ' + COLS + ' FROM products WHERE ukey=?')
        .bind(lk).first();
      if (old) { ex = old; adopted = true; break; }
    }
  }
  if (ex) {
    const changed = ex.name !== item.name || (ex.category || '') !== item.category ||
      ex.image !== item.image || (ex.sku || '') !== item.sku || ex.ukey !== item.ukey ||
      (ex.parent_sku || '') !== item.parent_sku || (ex.color || '') !== item.color ||
      (ex.color2 || '') !== item.color2 || Number(ex.pattern || 0) !== Number(item.pattern || 0) ||
      (ex.material || '') !== (item.material || '') || (ex.size_type || '') !== (item.size_type || '') ||
      (ex.styles || '') !== (item.styles || '') || (ex.family || '') !== (item.family || '') ||
      Number(ex.price || 0) !== Number(item.price || 0);
    if (changed) {
      await env.DB.prepare(
        "UPDATE products SET name=?, category=?, image=?, sku=?, ukey=?, parent_sku=?, color=?, color2=?, " +
        "pattern=?, material=?, size_type=?, styles=?, family=?, price=?, updated_at=datetime('now') WHERE id=?"
      ).bind(item.name, item.category, item.image, item.sku, item.ukey,
             item.parent_sku, item.color, item.color2, item.pattern,
             item.material, item.size_type, item.styles, item.family, item.price, ex.id).run();
    }
    return { id: ex.id, action: changed ? 'updated' : 'unchanged', adopted };
  }
  try {
    const r = await env.DB.prepare(
      "INSERT INTO products (name, category, image, sku, ukey, parent_sku, color, color2, pattern, " +
      "material, size_type, styles, family, price, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).bind(item.name, item.category, item.image, item.sku, item.ukey,
           item.parent_sku, item.color, item.color2, item.pattern,
           item.material, item.size_type, item.styles, item.family, item.price).run();
    return { id: r.meta && r.meta.last_row_id, action: 'created' };
  } catch (e) {
    // ① 极端情况：变体列还没补上（迁移失败）→ 退回只写基础列，保证写入不瘫
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

function json(body, status = 200, cookies = []) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookies && cookies.length) headers['Set-Cookie'] = cookies;
  return new Response(JSON.stringify(body), { status, headers });
}

/* =====================================================================
   商城后端：客户注册/登录 + 购物车下单 + 付款（PayPal 在线 / 万里汇 B2B 汇款）
   =====================================================================
   口径：
   - 金额一律 USD，服务端用「分」(cents) 整数计算，绝不浮点累加。
   - 商品价格来自 products.price（工作站发布同步），0 = 未定价（只能询价，不能下单）。
   - 客户会话 = D1 表 cust_sessions + HttpOnly Cookie（lm_cust），密钥不进 cookie。
   - 密码 PBKDF2-SHA256(WebCrypto) + 每用户随机盐；服务端不存明文，日志不打印。
   - 下单时 items 用「产品行 id」从服务端重查价格并快照进 items_json —— 前端传的价格一律不信。
   - PayPal：商户密钥只存 D1 settings；下单/请款都在服务端完成并核对金额，
     前端 SDK 只负责弹收银台。未配置密钥时接口回 503，结账自动引导走「汇款」。
   - 汇款（万里汇 B2B 信用卡收款账号）：无公开自助 API，走「客户下单→提交回执→
     管理端核对到账→标记已收款」的人工确认闭环，收款账号在管理端配置。
   - 邮件通知：可选 Cloudflare Email 发信绑定（env.SEND_EMAIL）。没配置就跳过，
     绝不阻塞下单。
*/

// 客户价格档：retail=零售（公开注册默认），wholesale=批发（后台开号/改档）。
// ⚠️ 档位只影响"看到哪个价"，绝不作为鉴权凭据——鉴权永远是会话本身。
const TIERS = ['retail', 'wholesale'];

const CUSTOMERS_SCHEMA = `CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL DEFAULT '',
  pass_salt TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'retail',
  active INTEGER NOT NULL DEFAULT 1,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
)`;

// 老库补列：SQLite 的 ALTER TABLE 一次只能加一列，且**不许非常量默认值**
// （`DEFAULT (datetime('now'))` 会直接报错）。必须逐条执行，任一条失败不影响其余。
const CUSTOMERS_DDL = [
  "ALTER TABLE customers ADD COLUMN tier TEXT NOT NULL DEFAULT 'retail'",
  'ALTER TABLE customers ADD COLUMN active INTEGER NOT NULL DEFAULT 1',
  "ALTER TABLE customers ADD COLUMN admin_note TEXT NOT NULL DEFAULT ''"
];

const SESSIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS cust_sessions (
  token TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`;

const ORDERS_SCHEMA = `CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  num TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  pay_method TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '[]',
  ship_name TEXT NOT NULL DEFAULT '',
  ship_phone TEXT NOT NULL DEFAULT '',
  ship_country TEXT NOT NULL DEFAULT '',
  ship_address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  receipt TEXT NOT NULL DEFAULT '',
  pay_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`;

// 订单状态机：管理端可推进；客户端只能撤销未付款单。
const ORDER_STATUSES = ['pending_payment', 'awaiting_confirmation', 'paid',
                        'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
const CUST_COOKIE = 'lm_cust';
const SESSION_DAYS = 30;
let shopReady = false;
async function ensureShop(env) {
  if (shopReady) return;
  await env.DB.batch([
    env.DB.prepare(CUSTOMERS_SCHEMA),
    env.DB.prepare(SESSIONS_SCHEMA),
    env.DB.prepare(ORDERS_SCHEMA)
  ]);
  // 老库补列：逐条跑，已存在会抛错，吞掉即可（列已在 = 目标状态已达成）。
  // 不能塞进上面的 batch：batch 是原子的，一条 ALTER 失败会连带 CREATE 一起回滚。
  for (const sql of CUSTOMERS_DDL) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 列已存在 */ }
  }
  shopReady = true;
}

function hexOf(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function saltHex() { return hexOf(crypto.getRandomValues(new Uint8Array(16))); }
function randToken() { return hexOf(crypto.getRandomValues(new Uint8Array(32))); }

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBytes = Uint8Array.from(salt.match(/.{2}/g).map(h => parseInt(h, 16)));
  // ⚠️ Cloudflare Workers 的 WebCrypto 上限：PBKDF2 iterations ≤ 100000（超了直接
  // NotSupportedError 抛穿整个 Worker → CF 1101）。不要"更安全"地调大数字。
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return hexOf(bits);
}

// 恒定时间比较：不把「前缀相同」的时序信息漏给计时侧信道
function constEqual(a, b) {
  const s1 = String(a || ''), s2 = String(b || '');
  if (s1.length !== s2.length) return false;
  let diff = 0;
  for (let i = 0; i < s1.length; i++) diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
  return diff === 0;
}

function cleanEmail(v) {
  const s = String(v || '').trim().toLowerCase().slice(0, 160);
  return /^[^\s@,;]{1,80}@[^\s@,;.][^\s@,;]{0,80}\.[a-z]{2,10}$/i.test(s) ? s : '';
}

function parseCookies(request) {
  const raw = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeDays) {
  const secure = 'Secure; ';
  return CUST_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; ' + secure + 'SameSite=Lax; Max-Age=' + (maxAgeDays * 86400);
}

// 读会话 -> 客户行。过期即删。返回 null = 未登录。
async function currentCustomer(env, request) {
  const token = parseCookies(request)[CUST_COOKIE] || '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT s.token, s.expires_at, c.id, c.email, c.name, c.company, c.country, c.phone, ' +
      "COALESCE(c.tier,'retail') AS tier, COALESCE(c.active,1) AS active " +
      'FROM cust_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.token=?'
    ).bind(token).first();
    if (!row) return null;
    const exp = Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z');
    if (!isFinite(exp) || exp < Date.now()) {
      await env.DB.prepare('DELETE FROM cust_sessions WHERE token=?').bind(token).run();
      return null;
    }
    // 被后台停用的账户：会话当场作废，不留"停用后还能下单"的口子
    if (Number(row.active) === 0) {
      try { await env.DB.prepare('DELETE FROM cust_sessions WHERE token=?').bind(token).run(); } catch (e) {}
      return null;
    }
    return row;
  } catch (e) { return null; }
}

async function createSession(env, customerId) {
  const token = randToken();
  await env.DB.prepare(
    "INSERT INTO cust_sessions (token, customer_id, expires_at) VALUES (?, ?, datetime('now','+" + SESSION_DAYS + " day'))"
  ).bind(token, customerId).run();
  // 顺带清过期会话（写入路径低频，够用；不必定时任务）
  try { await env.DB.prepare("DELETE FROM cust_sessions WHERE expires_at < datetime('now')").run(); } catch (e) {}
  return token;
}

async function readSetting(env, key) {
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
    return (r && r.value) || '';
  } catch (e) { return ''; }
}

// 邮件：Cloudflare Email Sending 绑定（env.SEND_EMAIL，dashboard 配发信地址）。
// 未配置/失败都只记状态，绝不抛错打断订单流程。
async function sendMailSafe(env, to, subject, html) {
  if (!env.SEND_EMAIL || typeof EmailMessage === 'undefined' || !cleanEmail(to))
    return 'skipped';
  try {
    const from = await readSetting(env, 'shop_from_email');
    if (!from) return 'skipped';
    await env.SEND_EMAIL.send(new EmailMessage(from, to, subject,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, html || ''));
    return 'sent';
  } catch (e) { return 'failed'; }
}

function money(cents) { return (Number(cents || 0) / 100).toFixed(2); }

function orderRow(o) {
  let items = [];
  try { items = JSON.parse(o.items_json) || []; } catch (e) {}
  return {
    id: o.id, num: o.num, status: o.status, pay_method: o.pay_method || '',
    currency: o.currency || 'USD',
    subtotal: money(o.subtotal_cents), total: money(o.total_cents),
    items, ship_name: o.ship_name, ship_phone: o.ship_phone,
    ship_country: o.ship_country, ship_address: o.ship_address,
    note: o.note || '', receipt: o.receipt || '',
    created_at: o.created_at, updated_at: o.updated_at
  };
}

// PayPal REST（sandbox / live 由 settings.paypal_env 决定）
async function paypalBase(env) {
  const mode = await readSetting(env, 'paypal_env');
  return mode === 'live' ? 'https://api-m.paypal.com' : 'https://sandbox.api.paypal.com';
}
async function paypalAccessToken(env) {
  const cid = await readSetting(env, 'paypal_client_id');
  const sec = await readSetting(env, 'paypal_secret');
  if (!cid || !sec) return null;
  try {
    const resp = await fetch((await paypalBase(env)) + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(cid + ':' + sec),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    return j && j.access_token ? j.access_token : null;
  } catch (e) { return null; }
}

// 下单核心：客户端下单与购物车结账共用。返回 {error,status} 或订单行。
// tier 由调用方从登录会话传入（wholesale 才用批发价），绝不从前端 body 取。
async function createOrder(env, customerId, body, tier) {
  const rawItems = Array.isArray(body && body.items) ? body.items.slice(0, 50) : [];
  const want = [];
  for (const it of rawItems) {
    const id = Number(it && it.id), qty = Number(it && it.qty);
    if (!Number.isInteger(id) || id <= 0) return { error: 'bad item id', status: 400 };
    if (!Number.isInteger(qty) || qty <= 0 || qty > 999999) return { error: 'bad quantity', status: 400 };
    want.push({ id, qty });
  }
  if (!want.length) return { error: 'cart empty', status: 400 };
  const payMethod = String((body && body.pay_method) || '');
  if (['', 'paypal', 'wire'].indexOf(payMethod) < 0) return { error: 'bad pay_method', status: 400 };
  const shipName = String((body && body.ship_name) || '').trim().slice(0, 120);
  const shipPhone = String((body && body.ship_phone) || '').trim().slice(0, 60);
  const shipCountry = String((body && body.ship_country) || '').trim().slice(0, 60);
  const shipAddress = String((body && body.ship_address) || '').trim().slice(0, 500);
  const note = String((body && body.note) || '').trim().slice(0, 2000);
  if (!shipName || !shipAddress) return { error: 'shipping name/address required', status: 400 };

  // 服务端重查价格（前端传的价格一概不信）；未定价=不可售
  // ⚠️ 价格档只能从登录会话读，绝不接受前端传 tier —— 否则零售客自报批发档就能低价下单
  const ids = [...new Set(want.map(w => w.id))];
  const useWholesale = String(tier || 'retail') === 'wholesale';
  let sql = 'SELECT id, name, sku, image, price, price_wholesale FROM products WHERE id IN (' +
    ids.map(() => '?').join(',') + ')';
  let found;
  try {
    found = await env.DB.prepare(sql).bind(...ids).all();
  } catch (e) {
    // price_wholesale 列未补齐：退回零售价查询，保证下单不瘫
    found = await env.DB.prepare(
      'SELECT id, name, sku, image, price FROM products WHERE id IN (' +
      ids.map(() => '?').join(',') + ')'
    ).bind(...ids).all();
  }
  const byId = new Map((found.results || []).map(p => [p.id, p]));
  let subtotal = 0;
  const snapshot = [];
  for (const w of want) {
    const p = byId.get(w.id);
    if (!p) return { error: 'product not found: ' + w.id, status: 404 };
    const whole = Number(p.price_wholesale || 0);
    const unit = (useWholesale && whole > 0) ? whole : Number(p.price || 0);
    const cents = Math.round(unit * 100);
    if (cents <= 0) return { error: 'product not priced: ' + (p.sku || p.id), status: 400 };
    subtotal += cents * w.qty;
    snapshot.push({ id: p.id, sku: p.sku || '', name: p.name || '', image: p.image || '',
                    price_cents: cents, qty: w.qty });
  }
  if (subtotal > 500000000) return { error: 'order too large', status: 400 };

  // 订单号：LM + 日期 + 4 位随机（撞了重摇，最多试 5 次）
  let num = '';
  for (let i = 0; i < 5 && !num; i++) {
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cand = 'LM' + d + '-' + randToken().slice(0, 4).toUpperCase();
    const dup = await env.DB.prepare('SELECT id FROM orders WHERE num=?').bind(cand).first();
    if (!dup) num = cand;
  }
  if (!num) return { error: 'order number collision, retry', status: 500 };

  await env.DB.prepare(
    "INSERT INTO orders (num, customer_id, status, pay_method, subtotal_cents, total_cents, " +
    "items_json, ship_name, ship_phone, ship_country, ship_address, note) " +
    "VALUES (?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(num, customerId, payMethod, subtotal, subtotal,
         JSON.stringify(snapshot), shipName, shipPhone, shipCountry, shipAddress, note).run();
  const row = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
  return { order: row };
}

async function notifyOrder(env, order, customerEmail, isNew) {
  const rows = await env.DB.prepare('SELECT email, name, company FROM customers WHERE id=?')
    .bind(order.customer_id).first();
  const cEmail = rows && rows.email;
  const summary = orderRow(order);
  const lines = summary.items.map(it =>
    '<tr><td>' + escHtml(it.sku || String(it.id)) + '</td><td>' + escHtml(it.name) +
    '</td><td>' + it.qty + '</td><td>$' + money(it.price_cents) + '</td></tr>').join('');
  const html = '<div style="font-family:sans-serif;max-width:560px">' +
    '<h2>LUNMONT ' + (isNew ? '订单确认 Order Confirmed' : '订单更新 Order Update') + '</h2>' +
    '<p>订单号 / Order No.: <b>' + escHtml(summary.num) + '</b></p>' +
    '<p>状态 / Status: <b>' + escHtml(summary.status) + '</b></p>' +
    '<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:13px">' +
    '<tr><td>SKU</td><td>Product</td><td>Qty</td><td>Unit</td></tr>' + lines + '</table>' +
    '<p><b>Total: $' + summary.total + ' ' + escHtml(summary.currency) + '</b>（运费另议）</p>' +
    '<p>收货：' + escHtml(summary.ship_name) + ' ' + escHtml(summary.ship_phone) +
    '<br>' + escHtml(summary.ship_address) + ' ' + escHtml(summary.ship_country) + '</p>' +
    '</div>';
  const adminEmail = await readSetting(env, 'shop_notify_email');
  const r1 = cEmail ? await sendMailSafe(env, cEmail, 'LUNMONT order ' + summary.num, html) : 'none';
  const r2 = adminEmail ? await sendMailSafe(env, adminEmail, '[新订单] ' + summary.num + ' $' + summary.total, html) : 'none';
  return { customer: r1, admin: r2 };
}
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 登录暴力尝试限速（本 isolate 计数，尽力而为）
const loginFails = new Map(); // key: ip|email -> {n, until}
function loginThrottle(ip, email) {
  const k = String(ip || '') + '|' + String(email || '');
  const rec = loginFails.get(k);
  const now = Date.now();
  if (rec && rec.until > now && rec.n >= 12) return true;
  if (rec && rec.until <= now) loginFails.delete(k);
  return false;
}
function loginFailRecord(ip, email) {
  const k = String(ip || '') + '|' + String(email || '');
  const rec = loginFails.get(k);
  const now = Date.now();
  if (!rec || rec.until <= now) loginFails.set(k, { n: 1, until: now + 15 * 60 * 1000 });
  else { rec.n++; rec.until = now + 15 * 60 * 1000; }
  if (loginFails.size > 5000) loginFails.clear();
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

async function readContentMap(env, locale = LOCALE) {
  await ensureContent(env);
  const r = await env.DB.prepare('SELECT key, value FROM site_content').all();
  const base = {};
  for (const row of (r.results || [])) base[row.key] = row.value;
  if (locale === LOCALE) return base;
  await ensureI18n(env);
  const ir = await env.DB.prepare('SELECT key, value FROM site_content_i18n WHERE locale=?')
    .bind(locale).all();
  const c = {};
  for (const k of Object.keys(base)) c[k] = deriveLocaleValue(base[k], locale);
  for (const row of (ir.results || [])) c[row.key] = row.value;  // 已保存的译文优先
  return c;
}

function sameContent(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

async function saveVersion(env, content, note, locale = LOCALE) {
  await env.DB.prepare(VERSIONS_SCHEMA).run();
  const r = await env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM content_versions WHERE page=? AND locale=?'
  ).bind(PAGE, locale).first();
  const v = ((r && r.v) || 0) + 1;
  await env.DB.prepare(
    'INSERT INTO content_versions (page, locale, version, content_json, note, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(PAGE, locale, v, JSON.stringify(content), String(note || '').slice(0, 120), 'admin').run();
  if (v > 120) {
    await env.DB.prepare('DELETE FROM content_versions WHERE page=? AND locale=? AND version<=?')
      .bind(PAGE, locale, v - 120).run();
  }
  return v;
}

// 草稿/发布的内容校验比旧 /content 更严：key 必须在默认文案白名单内，防止写入任意键。
function cleanContentInput(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const allowed = Object.keys(DEFAULT_CONTENT);
  const keys = Object.keys(c);
  if (!keys.length || keys.length > 160) return null;
  const clean = {};
  for (const k of keys) {
    // cx_ 前缀 = 区块布局的自定义区块文案（2026-11-26），不在默认白名单也放行
    if (!/^[a-z0-9_]{1,40}$/.test(k) || (allowed.indexOf(k) < 0 && k.indexOf('cx_') !== 0)) return null;
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
  if (keys.length > 160) return null;
  const out = {};
  for (const k of keys) {
    if (allowed.indexOf(k) < 0 && k.indexOf('cx_') !== 0) return null;
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

async function readDraft(env, locale = LOCALE) {
  await env.DB.prepare(DRAFT_SCHEMA).run();
  const row = await env.DB.prepare(
    'SELECT content_json, note, updated_at FROM content_drafts WHERE page=? AND locale=?'
  ).bind(PAGE, locale).first();
  if (!row) return null;
  let content = {};
  try { content = JSON.parse(row.content_json) || {}; } catch { return null; }
  return { content, note: row.note || '', updated_at: row.updated_at || '' };
}

async function writeContentMap(env, c, locale = LOCALE) {
  const keys = Object.keys(c);
  if (!keys.length) return;
  if (locale !== LOCALE) await ensureI18n(env);
  const table = locale === LOCALE ? 'site_content' : 'site_content_i18n';
  const sql = `INSERT INTO ${table} (` + (locale === LOCALE ? 'key' : 'locale, key') +
    `, value, updated_at) VALUES ` +
    keys.map(() => (locale === LOCALE ? '(?, ?, datetime(\'now\'))' : '(?, ?, ?, datetime(\'now\'))')).join(', ') +
    ` ON CONFLICT(${locale === LOCALE ? 'key' : 'locale, key'}) DO UPDATE SET ` +
    `value=excluded.value, updated_at=excluded.updated_at`;
  const params = [];
  for (const k of keys) {
    if (locale !== LOCALE) params.push(locale);
    params.push(k, c[k].slice(0, MAX_CONTENT_VALUE));
  }
  await env.DB.prepare(sql).bind(...params).run();
}

/* =====================================================================
   2026-11-22 SEO 落地页（Worker SSR）
   - /p/<slug>          产品详情（Product + BreadcrumbList Schema）
   - /c/<slug>          分类页（CollectionPage + ItemList Schema）
   - /sitemap.xml       动态 sitemap（D1 产品 + 静态页）
   - /api/seo/products  SEO 文案读写（GET 公开 / POST 需 X-Admin-Key）
   数据与后台编辑完全隔离：products 表一个字段都不动，英文文案存 product_seo。
   ===================================================================== */
const SEO_ORIGIN = 'https://www.lunmont.com';

// 类目中文 → 英文 slug/title。新类目在此登记；未登记时回退通用映射，绝不 404。
const CATEGORY_I18N = {
  '醋酸发夹': { slug: 'acetate-hair-clips', en: 'Acetate Hair Clips' },
  '经典发夹': { slug: 'classic-hair-clips', en: 'Classic Hair Clips' },
  '珍珠系列': { slug: 'pearl-hair-accessories', en: 'Pearl Hair Accessories' },
  '金属抓夹': { slug: 'metal-claw-clips', en: 'Metal Claw Clips' },
  '流行配饰': { slug: 'fashion-hair-accessories', en: 'Fashion Hair Accessories' },
  '其他': { slug: 'other-hair-accessories', en: 'Other Hair Accessories' }
};
function catI18n(cat) {
  if (CATEGORY_I18N[cat]) return CATEGORY_I18N[cat];
  // 未登记类目：slug 用 unicode-safe 兜底，title 保留原文（不编造英文）
  const slug = 'cat-' + String(cat || 'all').replace(/[^\w\u4e00-\u9fa5]+/g, '-').slice(0, 40);
  return { slug, en: String(cat || 'Hair Accessories') };
}

async function ensureProductSeo(env) {
  await env.DB.prepare(PRODUCT_SEO_SCHEMA).run();
}

function seoTitle(p, seo) {
  const en = (seo && seo.name_en) || '';
  const base = en || String(p.name || '').slice(0, 60);
  return (base + ' | LUNMONT').slice(0, 65);
}
function seoDesc(p, seo) {
  const d = (seo && seo.description_en) || '';
  if (d) return String(d).slice(0, 160);
  const cat = catI18n(p.category).en;
  const sku = p.sku ? (' (SKU ' + p.sku + ')') : '';
  return ('Wholesale ' + cat + sku + ' from LUNMONT, a Yiwu hair accessories manufacturer. '
        + 'Low MOQ, custom designs, worldwide export. Request a quote.').slice(0, 160);
}
function productSlug(p, seo) {
  if (seo && seo.slug) return String(seo.slug).slice(0, 80);
  const sku = String(p.sku || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return sku || ('item-' + p.id);
}
function absImage(img) {
  const s = String(img || '');
  if (/^https?:\/\//i.test(s)) return s.replace(/^https?:\/\/[^/]+/, SEO_ORIGIN);
  return s;
}

function seoPageHead(title, desc, canonical, extraSchema, opts) {
  // 2026-11-23 SEO 补齐：og 完整套件（og:image/site_name/locale）+ twitter:image + robots 显式声明。
  // opts: { ogImage, ogType } —— PDP 用 product + 产品图，分类页用 first 产品图。
  const o = opts || {};
  const ogImg = o.ogImage
    ? '<meta property="og:image" content="' + escHtml(o.ogImage) + '">\n' +
      '<meta property="og:image:alt" content="' + escHtml(o.ogImageAlt || title) + '">\n' +
      '<meta name="twitter:image" content="' + escHtml(o.ogImage) + '">\n'
    : '';
  return '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<meta name="robots" content="index,follow">\n' +
    '<title>' + escHtml(title) + '</title>\n' +
    '<meta name="description" content="' + escHtml(desc) + '">\n' +
    '<link rel="canonical" href="' + escHtml(canonical) + '">\n' +
    '<link rel="alternate" hreflang="en" href="' + escHtml(canonical) + '">\n' +
    '<link rel="alternate" hreflang="x-default" href="' + escHtml(canonical) + '">\n' +
    '<meta property="og:type" content="' + escHtml(o.ogType || 'website') + '">\n' +
    '<meta property="og:site_name" content="LUNMONT">\n' +
    '<meta property="og:locale" content="en_US">\n' +
    '<meta property="og:title" content="' + escHtml(title) + '">\n' +
    '<meta property="og:description" content="' + escHtml(desc) + '">\n' +
    '<meta property="og:url" content="' + escHtml(canonical) + '">\n' +
    ogImg +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<script type="application/ld+json">' + JSON.stringify(extraSchema) + '</script>\n' +
    '<style>' +
    '*{box-sizing:border-box}body{margin:0;background:#fffdf9;color:#0f0e0c;font:16px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif}' +
    'nav{padding:18px 6vw;border-bottom:1px solid #e7e1d8;display:flex;gap:24px;align-items:center}' +
    'nav a{color:#0f0e0c;text-decoration:none;font-size:14px}.logo{font-weight:700;letter-spacing:.3em}' +
    'main{max-width:1080px;margin:0 auto;padding:40px 6vw 80px}' +
    '.crumb{font-size:13px;color:#7d7770;margin-bottom:20px}.crumb a{color:#9a7b4f;text-decoration:none}' +
    'h1{font-size:clamp(24px,4vw,38px);margin:0 0 12px;line-height:1.3}' +
    '.sub{color:#7d7770;margin-bottom:32px}' +
    '.hero-img{width:100%;max-height:520px;object-fit:contain;background:#f4efe7;margin-bottom:28px}' +
    'h2{font-size:20px;margin:32px 0 12px;border-bottom:1px solid #e7e1d8;padding-bottom:8px}' +
    'table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #e7e1d8;padding:10px 14px;text-align:left}th{background:#f6f1e8;width:32%}' +
    '.cta{display:inline-block;margin:28px 8px 0 0;padding:13px 30px;background:#0f0e0c;color:#fff;text-decoration:none;font-size:14px}' +
    '.cta.alt{background:transparent;color:#0f0e0c;border:1px solid #0f0e0c}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}' +
    '.card{border:1px solid #e7e1d8;padding:12px;text-decoration:none;color:inherit;display:block}' +
    '.card img{width:100%;aspect-ratio:1;object-fit:cover;background:#f4efe7}' +
    '.card h3{font-size:14px;margin:10px 0 0;line-height:1.4}' +
    '.faq{border-bottom:1px solid #e7e1d8;padding:14px 0}.faq h3{font-size:16px;margin:0 0 6px}.faq p{margin:0;color:#3d3a35}' +
    'footer{border-top:1px solid #e7e1d8;padding:28px 6vw;font-size:13px;color:#7d7770;text-align:center}' +
    '</style></head>\n<body>' +
    '<nav><a class="logo" href="/">LUNMONT</a><a href="/">Home</a><a href="/#products">Products</a><a href="/#contact">Contact</a></nav>\n<main>';
}
function seoPageFoot() {
  return '</main><footer>© 2026 LUNMONT · Yiwu Cenova Import and Export Co., Ltd. · ' +
    '<a href="/privacy">Privacy</a> · <a href="/return">Returns</a> · <a href="/terms">Terms</a></footer></body></html>';
}
function crumb(items) {
  return '<div class="crumb">' + items.map((x, i) =>
    x.href ? '<a href="' + escHtml(x.href) + '">' + escHtml(x.name) + '</a>' : escHtml(x.name)
  ).join(' / ') + '</div>';
}

async function renderProductPage(env, slug) {
  await ensureProductSeo(env);
  // slug 可能在 product_seo.slug，也可能就是 sku 归一化后的值
  const seoRows = await env.DB.prepare('SELECT * FROM product_seo').all();
  const seoMap = {};
  for (const s of (seoRows.results || [])) {
    if (s.slug) seoMap[String(s.slug).toLowerCase()] = s;
    if (s.sku) seoMap['sku:' + String(s.sku).toLowerCase()] = s;
  }
  let seo = seoMap[slug.toLowerCase()] || null;
  let p = null;
  // 先按 sku 找（最稳），再按 product_seo.slug 反查 sku
  const bySku = await env.DB.prepare(
    'SELECT id, name, category, image, sku, material, size_type, styles, family, price FROM products WHERE lower(sku)=? LIMIT 1'
  ).bind(slug.replace(/^sku:/, '').toLowerCase()).first();
  if (bySku) { p = bySku; if (!seo) seo = seoMap['sku:' + String(p.sku).toLowerCase()] || null; }
  if (!p && seo && seo.sku) {
    p = await env.DB.prepare(
      'SELECT id, name, category, image, sku, material, size_type, styles, family, price FROM products WHERE sku=? LIMIT 1'
    ).bind(seo.sku).first();
  }
  if (!p) return null;
  const title = seoTitle(p, seo);
  const desc = seoDesc(p, seo);
  const canonical = SEO_ORIGIN + '/p/' + encodeURIComponent(productSlug(p, seo)) + '/';
  const cat = catI18n(p.category);
  const nameEn = (seo && seo.name_en) || String(p.name || '');
  const img = absImage(p.image);
  const specs = [];
  if (p.sku) specs.push(['SKU', escHtml(p.sku)]);
  if (p.material) specs.push(['Material', escHtml(p.material)]);
  if (p.size_type) specs.push(['Size', escHtml(p.size_type)]);
  if (p.styles) specs.push(['Style', escHtml(String(p.styles).replace(/,/g, ', '))]);
  if (p.family) specs.push(['Collection', escHtml(p.family)]);
  if (p.category) specs.push(['Category', escHtml(cat.en)]);
  const specHtml = specs.length
    ? '<h2>Key Specifications</h2><table>' + specs.map(r => '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>').join('') + '</table>'
    : '';
  // 2026-11-23 SEO 补齐：应用场景 + FAQ（与 FAQPage Schema 一致，内容真实可核验）
  const catLower = cat.en.toLowerCase();
  const faqs = [
    ['What is the MOQ for ' + catLower + ' like ' + nameEn + '?',
     'We support small-batch trial orders. Please contact us with your target quantity and we will confirm the exact MOQ and price for SKU ' + (p.sku || nameEn) + '.'],
    ['Do you offer custom colors or designs for this product?',
     'Yes. Custom colors, finishes and packaging can be discussed. Send reference images or a specification with your inquiry and we will confirm feasibility and any additional cost before production.'],
    ['How do you ship orders from China?',
     'We export from Yiwu, Zhejiang, China and can quote based on your destination port or door address by sea, air or express. Shipping method, lead time and documents are confirmed per order.'],
    ['Can I get a sample before placing a bulk order?',
     'Yes. Sample confirmation of color, material and finish is part of our standard order flow before bulk production.']
  ];
  const faqHtml = '<h2>FAQ</h2>' + faqs.map(f =>
    '<div class="faq"><h3>' + escHtml(f[0]) + '</h3><p>' + escHtml(f[1]) + '</p></div>').join('');
  const schema = {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'Product', '@id': canonical + '#product', name: nameEn,
        image: img ? [img] : undefined,
        description: desc, sku: p.sku || undefined,
        brand: { '@type': 'Brand', name: 'LUNMONT' },
        manufacturer: { '@type': 'Organization', name: 'Yiwu Cenova Import and Export Co., Ltd.' },
        category: cat.en },
      { '@type': 'BreadcrumbList', '@id': canonical + '#breadcrumb', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SEO_ORIGIN + '/' },
        { '@type': 'ListItem', position: 2, name: cat.en, item: SEO_ORIGIN + '/c/' + cat.slug + '/' },
        { '@type': 'ListItem', position: 3, name: nameEn, item: canonical }
      ] },
      { '@type': 'FAQPage', '@id': canonical + '#faq', mainEntity: faqs.map(f => ({
        '@type': 'Question', name: f[0],
        acceptedAnswer: { '@type': 'Answer', text: f[1] } })) }
    ]
  };
  // 2026-11-23 SEO 补齐：相关产品（同分类其它 SKU，内链 + 页面厚度）
  let relatedHtml = '';
  try {
    const rel = await env.DB.prepare(
      'SELECT id, name, image, sku FROM products WHERE category=? AND id<>? AND image IS NOT NULL AND image<>\'\' ORDER BY id DESC LIMIT 4'
    ).bind(p.category, p.id).all();
    const relSeo = await env.DB.prepare('SELECT sku, slug, name_en FROM product_seo').all();
    const relMap = {};
    for (const s of (relSeo.results || [])) if (s.sku) relMap[s.sku] = s;
    const relItems = (rel.results || []).map(r => {
      const seoR = relMap[r.sku];
      const rn = (seoR && seoR.name_en) || String(r.name || '');
      const rh = '/p/' + encodeURIComponent(productSlug(r, seoR)) + '/';
      const ri = absImage(r.image);
      return '<a class="card" href="' + escHtml(rh) + '">' +
        (ri ? '<img src="' + escHtml(ri) + '" alt="' + escHtml(rn) + '" loading="lazy">' : '') +
        '<h3>' + escHtml(rn) + '</h3></a>';
    }).join('');
    if (relItems) relatedHtml = '<h2>Related Products</h2><div class="grid">' + relItems + '</div>';
  } catch (e) { /* 相关产品失败不影响主页面 */ }
  const body =
    crumb([{ name: 'Home', href: '/' }, { name: cat.en, href: '/c/' + cat.slug + '/' }, { name: nameEn }]) +
    '<h1>' + escHtml(nameEn) + '</h1>' +
    '<p class="sub">' + escHtml(cat.en) + (p.sku ? ' · SKU ' + escHtml(p.sku) : '') + ' · Wholesale &amp; Custom Orders</p>' +
    (img ? '<img class="hero-img" src="' + escHtml(img) + '" alt="' + escHtml(nameEn + ' - ' + cat.en) + '" width="1080" height="800">' : '') +
    '<h2>Product Overview</h2><p>' + escHtml(desc) + '</p>' + specHtml +
    '<h2>Application Scenarios</h2>' +
    '<p>This ' + escHtml(cat.en.toLowerCase()) + ' is selected by wholesalers and retailers for everyday hair styling and fashion accessory lines. ' +
    'Common retail uses include daily wear, office and casual styling, gift and occasion collections, and salon or boutique displays. ' +
    'For private-label buyers it works well as a staple SKU in mixed hair-accessory orders shipped from Yiwu.</p>' +
    '<h2>Wholesale &amp; Customization</h2>' +
    '<p>LUNMONT supplies hair accessories to wholesalers, retailers and distributors worldwide. ' +
    'Low minimum order quantities, custom colors and designs, and export service from Yiwu, China. ' +
    'Contact us for the latest wholesale price and lead time.</p>' +
    faqHtml + relatedHtml +
    '<a class="cta" href="/#contact">Request a Quote</a>' +
    '<a class="cta alt" href="/c/' + cat.slug + '/">More ' + escHtml(cat.en) + '</a>';
  return new Response(seoPageHead(title, desc, canonical, schema, { ogImage: img || undefined, ogType: 'product' }) + body + seoPageFoot(), {
    status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
}

async function renderCategoryPage(env, slug) {
  await ensureProductSeo(env);
  let catKey = null;
  for (const k of Object.keys(CATEGORY_I18N)) {
    if (CATEGORY_I18N[k].slug === slug) { catKey = k; break; }
  }
  // 2026-11-26 口径对齐：未登记类目（catI18n 兜底 slug）也可开落地页——
  // 从库内实际 category 反查，保证 /c/ 页与首页左树 ↗ 深链永远一致
  if (!catKey) {
    try {
      await ensureProducts(env);
      const cs = await env.DB.prepare('SELECT DISTINCT category FROM products').all();
      for (const row of (cs.results || [])) {
        const c = String(row.category || '').trim();
        if (c && catI18n(c).slug === slug) { catKey = c; break; }
      }
    } catch (e) { /* 库查询失败按原逻辑 return null */ }
  }
  if (!catKey) return null;
  const ci = CATEGORY_I18N[catKey];
  const rows = await env.DB.prepare(
    'SELECT id, name, category, image, sku, price FROM products WHERE category=? ORDER BY id DESC LIMIT 200'
  ).bind(catKey).all();
  const seoRows = await env.DB.prepare('SELECT sku, slug, name_en FROM product_seo').all();
  const seoBySku = {};
  for (const s of (seoRows.results || [])) if (s.sku) seoBySku[s.sku] = s;
  const canonical = SEO_ORIGIN + '/c/' + ci.slug + '/';
  const title = ci.en + ' Manufacturer & Wholesale | LUNMONT';
  const desc = ('Wholesale ' + ci.en + ' from LUNMONT, a Yiwu hair accessories supplier. ' +
    'Browse ' + (rows.results || []).length + ' designs with low MOQ and custom options. Request a quote.').slice(0, 160);
  // 2026-11-23 SEO 补齐：分类页 FAQ（与 FAQPage Schema 一致）
  const catFaqs = [
    ['Do you offer low MOQ wholesale for ' + ci.en.toLowerCase() + '?',
     'Yes. LUNMONT supports small-batch trial orders for ' + ci.en.toLowerCase() + '. Send us the SKUs and quantities you need and we will confirm MOQ and price.'],
    ['Can I get custom colors or private-label packaging?',
     'Custom colors, finishes and packaging are available for ' + ci.en.toLowerCase() + '. Share reference images or specifications and we will confirm feasibility before production.'],
    ['Where do you ship ' + ci.en.toLowerCase() + ' from?',
     'All orders ship from Yiwu, Zhejiang, China. We can quote by sea, air or express based on your destination.'],
    ['How do I request a quotation?',
     'Use the contact form or WhatsApp on our homepage, or email us with item numbers, target quantity and destination port. We reply within 24 hours.']
  ];
  const schema = {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'CollectionPage', '@id': canonical + '#page', name: ci.en, description: desc, url: canonical },
      { '@type': 'ItemList', numberOfItems: (rows.results || []).length,
        itemListElement: (rows.results || []).slice(0, 50).map((p, i) => ({
          '@type': 'ListItem', position: i + 1,
          url: SEO_ORIGIN + '/p/' + encodeURIComponent(productSlug(p, seoBySku[p.sku])) + '/'
        })) },
      { '@type': 'BreadcrumbList', '@id': canonical + '#breadcrumb', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SEO_ORIGIN + '/' },
        { '@type': 'ListItem', position: 2, name: ci.en, item: canonical }
      ] },
      { '@type': 'FAQPage', '@id': canonical + '#faq', mainEntity: catFaqs.map(f => ({
        '@type': 'Question', name: f[0],
        acceptedAnswer: { '@type': 'Answer', text: f[1] } })) }
    ]
  };
  const firstImg = (rows.results || []).map(p => absImage(p.image)).filter(Boolean)[0];
  const cards = (rows.results || []).map(p => {
    const s = seoBySku[p.sku];
    const nm = (s && s.name_en) || String(p.name || '');
    const href = '/p/' + encodeURIComponent(productSlug(p, s)) + '/';
    const im = absImage(p.image);
    return '<a class="card" href="' + escHtml(href) + '">' +
      (im ? '<img src="' + escHtml(im) + '" alt="' + escHtml(nm + ' - ' + ci.en) + '" loading="lazy">' : '') +
      '<h3>' + escHtml(nm) + '</h3></a>';
  }).join('');
  const body =
    crumb([{ name: 'Home', href: '/' }, { name: ci.en }]) +
    '<h1>' + escHtml(ci.en) + ' Wholesale</h1>' +
    '<p class="sub">Explore ' + (rows.results || []).length + ' ' + escHtml(ci.en.toLowerCase()) +
    ' designs. Low MOQ, custom colors and worldwide export from Yiwu, China.</p>' +
    '<div class="grid">' + cards + '</div>' +
    '<h2>Buying Guide</h2>' +
    '<p>LUNMONT is a Yiwu-based manufacturer and wholesale supplier of hair accessories. ' +
    'We support small-batch orders, custom designs and export shipping. Use the filters on our ' +
    'main site to narrow by style, size and color, or contact us with a SKU list for a quote.</p>' +
    '<h2>FAQ</h2>' + catFaqs.map(f =>
      '<div class="faq"><h3>' + escHtml(f[0]) + '</h3><p>' + escHtml(f[1]) + '</p></div>').join('') +
    // 首页筛选深链（与首页 ↗ 互链成闭环）：?cat= 会被首页 queryToFilters 回填
    '<a class="cta alt" href="/?cat=' + encodeURIComponent(catKey) + '">Browse &amp; filter ' +
    escHtml(ci.en) + ' on our site</a>' +
    '<a class="cta" href="/#contact">Request a Quote</a>';
  return new Response(seoPageHead(title, desc, canonical, schema, { ogImage: firstImg || undefined }) + body + seoPageFoot(), {
    status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=1800' }
  });
}

async function renderSitemap(env) {
  await ensureProductSeo(env);
  const staticUrls = [
    ['/', 'weekly', '1.0'], ['/privacy', 'yearly', '0.3'], ['/return', 'yearly', '0.3'],
    ['/terms', 'yearly', '0.3'], ['/about', 'monthly', '0.5'],
    ['/factory', 'monthly', '0.5'], ['/certificates', 'monthly', '0.4'],
    ['/blog', 'monthly', '0.5']  // 2026-11-23 采购指南（静态页 site/blog.html）
  ];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const [u, f, pr] of staticUrls) {
    xml += '  <url><loc>' + SEO_ORIGIN + u + '</loc><changefreq>' + f + '</changefreq><priority>' + pr + '</priority></url>\n';
  }
  const cats = [];
  const seenCat = new Set();
  for (const k of Object.keys(CATEGORY_I18N)) { cats.push('/c/' + CATEGORY_I18N[k].slug + '/'); seenCat.add(CATEGORY_I18N[k].slug); }
  const rows = await env.DB.prepare('SELECT id, sku, name, category FROM products ORDER BY id DESC LIMIT 1000').all();
  // 库内实际出现但未登记的类目也进 sitemap（与 renderCategoryPage 反查放开同口径）
  for (const p of (rows.results || [])) {
    const c = String(p.category || '').trim();
    if (!c) continue;
    const sl = catI18n(c).slug;
    if (!seenCat.has(sl)) { seenCat.add(sl); cats.push('/c/' + sl + '/'); }
  }
  const seoRows = await env.DB.prepare('SELECT sku, slug FROM product_seo').all();
  const seoBySku = {};
  for (const s of (seoRows.results || [])) if (s.sku) seoBySku[s.sku] = s;
  for (const p of (rows.results || [])) cats.push('/p/' + encodeURIComponent(productSlug(p, seoBySku[p.sku])) + '/');
  for (const u of cats) {
    xml += '  <url><loc>' + SEO_ORIGIN + u + '</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>\n';
  }
  xml += '</urlset>\n';
  return new Response(xml, {
    status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
}

async function handleSeoApi(env, request, route, method) {
  if (route === '/seo/products' && method === 'GET') {
    await ensureProductSeo(env);
    const r = await env.DB.prepare('SELECT sku, name_en, slug, description_en FROM product_seo ORDER BY sku').all();
    return json({ ok: true, items: r.results || [] });
  }
  if (route === '/seo/products' && method === 'POST') {
    if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    const items = body && body.items;
    if (!Array.isArray(items) || !items.length || items.length > 300)
      return json({ error: 'items array 1..300 required' }, 400);
    await ensureProductSeo(env);
    const stmts = [];
    for (const it of items) {
      const sku = String((it && it.sku) || '').trim().slice(0, 80);
      if (!sku) continue;
      const name_en = String(it.name_en || '').trim().slice(0, 120);
      const slug = String(it.slug || '').trim().toLowerCase().slice(0, 80);
      const description_en = String(it.description_en || '').trim().slice(0, 300);
      stmts.push(env.DB.prepare(
        "INSERT INTO product_seo (sku, name_en, slug, description_en, updated_at) VALUES (?, ?, ?, ?, datetime('now')) " +
        "ON CONFLICT(sku) DO UPDATE SET name_en=excluded.name_en, slug=excluded.slug, " +
        "description_en=excluded.description_en, updated_at=excluded.updated_at"
      ).bind(sku, name_en, slug, description_en));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, saved: stmts.length });
  }
  return null;
}

export default {
  async fetch(request, env) {
    const { method } = request;
    const url = new URL(request.url);
    const path = url.pathname;

    // 2026-11-22 SEO：规范域归一到 www.lunmont.com（Google 只索引一个域，消除三域重复内容）
    // 只在入口做 301，不碰静态资源 / API 逻辑，后台编辑功能完全不变。
    // workers.dev 调试域保留放行（内部用，不进 sitemap）。
    // 2026-11-25 修复：301 只重定向 GET/HEAD。POST 走 301 会跨源（lunmont.com→www），
    // 重定向响应无 CORS 头 → 浏览器 fetch 直接抛网络错误（admin 登录"网络异常"根因）。
    // POST/PUT 等 API 请求不会被搜索引擎索引，放行不重定向无 SEO 损失。
    const host = (url.hostname || '').toLowerCase();
    if ((method === 'GET' || method === 'HEAD') && (host === 'lunmont.com' || host === 'lunmont.asia')) {
      const canonical = new URL(request.url);
      canonical.hostname = 'www.lunmont.com';
      return new Response(null, {
        status: 301,
        headers: { 'Location': canonical.toString(), 'Cache-Control': 'public, max-age=3600' }
      });
    }

    // 2026-11-22 SEO 落地页：必须在静态资源放行之前拦截。
    // CF Workers Static Assets 的路由优先级：Worker 先跑，只有 Worker 放行才查 assets。
    // 路径用 /p/ /c/ 全新前缀，绝不与现有页面（/products /privacy）冲突。
    if (method === 'GET' || method === 'HEAD') {
      try {
        if (path === '/sitemap.xml' || path === '/sitemap') {
          const r = await renderSitemap(env);
          return method === 'HEAD' ? new Response(null, { status: 200, headers: r.headers }) : r;
        }
        const pm = path.match(/^\/p\/([^\/]+)\/?$/);
        if (pm) {
          const r = await renderProductPage(env, decodeURIComponent(pm[1]));
          if (r) return method === 'HEAD' ? new Response(null, { status: 200, headers: r.headers }) : r;
        }
        const cm = path.match(/^\/c\/([^\/]+)\/?$/);
        if (cm) {
          const r = await renderCategoryPage(env, decodeURIComponent(cm[1]));
          if (r) return method === 'HEAD' ? new Response(null, { status: 200, headers: r.headers }) : r;
        }
      } catch (e) {
        // SEO 页渲染失败绝不影响主站：放行给静态资源/原有逻辑
      }
    }

    // 静态资源放行 + 补 CORS：产品图要给「色点取色编辑器」用 canvas 读像素，
    // 没有 Access-Control-Allow-Origin 时 img 能显示但画布被污染，getImageData 全 0。
    if (!path.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      const isImg = /\.(jpe?g|png|webp|gif|avif|svg)$/i.test(path);
      if (!isImg) {
        // 2026-11-23 SEO 补齐：CF assets 未命中会返回空 body 的 404，
        // Google 抓取到空 404 无法回收链接权重。改为回退渲染 site/404.html（状态仍 404）。
        if (res.status === 404) {
          try {
            const notFoundReq = new Request(new URL('/404.html', request.url).toString(), { headers: request.headers });
            const nf = await env.ASSETS.fetch(notFoundReq);
            if (nf.status === 200) {
              const h = new Headers(nf.headers);
              h.set('Content-Type', 'text/html; charset=utf-8');
              return new Response(nf.body, { status: 404, statusText: 'Not Found', headers: h });
            }
          } catch (e) { /* 回退失败则原样返回空 404 */ }
        }
        return res;
      }
      const h = new Headers(res.headers);
      h.set('Access-Control-Allow-Origin', '*');
      h.set('Cross-Origin-Resource-Policy', 'cross-origin');
      // 图片内容不变，缓存策略沿用 assets 层；这里只补 CORS 头
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    const route = path.slice(4); // after /api

    // 2026-11-22 SEO 文案 API（独立 product_seo 表，不碰 products）
    if (route === '/seo/products' && (method === 'GET' || method === 'POST')) {
      const r = await handleSeoApi(env, request, route, method);
      if (r) return r;
    }

    // 2026-11-26 SEO 对齐：线上品类 → 英文 slug 映射（公开只读，带商品数）。
    // 首页类目树/筛选深链与 /c/ 落地页共用同一口径，工作站⑬也能直接展示落地页地址。
    if (route === '/seo/categories' && method === 'GET') {
      try {
        await ensureProducts(env);
        const r = await env.DB.prepare('SELECT category, COUNT(*) AS n FROM products GROUP BY category ORDER BY n DESC').all();
        const categories = (r.results || []).map(row => {
          const cat = String(row.category || '').trim();
          const i = catI18n(cat || '其他');
          return { category: cat, count: row.n, slug: i.slug, en: i.en, path: '/c/' + i.slug + '/' };
        });
        return json({ ok: true, categories });
      } catch (e) {
        return json({ ok: false, categories: [], error: String(e && e.message || e).slice(0, 120) }, 500);
      }
    }

    // —— 管理登录校验（公开：登录本身就是换取校验结果）——
    // ⚠️ 登录页本体是静态文件 site/admin.html：CF 的 assets 层在 Worker 之前处理
    // 无扩展名路径重写（/privacy.html -> /privacy），Worker 里返回 HTML 的裸路径会被
    // assets 先回 404，所以页面只能走静态文件，Worker 只保留这个 JSON 接口。
    if (route === '/admin/login' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      // 复用同一把内部密钥做比对（probe = 伪造一个只带 X-Admin-Key 的请求）
      const probe = new Request(request.url, { headers: { 'X-Admin-Key': String((body && body.key) || '') } });
      if (!(await checkAdmin(env, probe))) return json({ error: 'unauthorized' }, 401);
      // 顺带回是否还是出厂密钥：前端登录后提示「该换密钥了」，但绝不回密钥本身
      let weak = false;
      try {
        const r = await env.DB.prepare("SELECT value FROM settings WHERE key='admin_key'").first();
        weak = !!r && r.value === 'lunmont2026';
      } catch (e) { weak = false; }
      return json({ ok: true, weakDefaultKey: weak });
    }

    if (route === '/products' && method === 'GET') {
      // ⚠️ 必须先跑迁移：变体列（parent_sku/color/color2/pattern）只在 ensureProducts 里补，
      // 之前 GET 不调用它 → 新列永远不存在 → 下面的 SELECT 报错 → 静默降级成老字段。
      // 迁移失败也绝不阻塞出数据：catch 住继续走老查询。
      try { await ensureProducts(env); } catch (e) { /* 迁移失败：下面自动降级 */ }
      // 绝不 SELECT 迁移中才补的列（updated_at 曾因 SQLite 限制加不上，
      // 一条 SELECT 报错就被 catch 成空数组 —— 首页产品区会整体消失，且完全静默）
      let rows = [];
      let hasVariant = true;
      let hasTaxonomy = true;
      try {
        const r = await env.DB.prepare(
          'SELECT id, name, category, image, sku, parent_sku, color, color2, pattern, ' +
          'material, size_type, styles, family, price, price_wholesale ' +
          'FROM products ORDER BY id DESC LIMIT 500'
        ).all();
        rows = r.results || [];
      } catch (e) {
        // price/taxonomy 列未补齐时单独降级：退回只有变体列的查询（price=0 前端显示询价）
        hasTaxonomy = false;
        try {
          const r = await env.DB.prepare(
            'SELECT id, name, category, image, sku, parent_sku, color, color2, pattern ' +
            'FROM products ORDER BY id DESC LIMIT 500'
          ).all();
          rows = r.results || [];
        } catch (e) {
          hasVariant = false; // 变体列未补齐 -> 退回老查询，产品区照常出数据
          try {
            const r = await env.DB.prepare(
              'SELECT id, name, category, image, sku FROM products ORDER BY id DESC LIMIT 500'
            ).all();
            rows = r.results || [];
          } catch (e1) {
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
        }
      }
      const out = { products: rows, grouped: hasVariant, taxonomy: hasTaxonomy };
      // 批发档客户看到的价格换成 price_wholesale（为 0 时保持零售价）。
      // 会话探测失败一律当零售客，绝不因为鉴权异常把批发价漏给访客。
      let viewerTier = 'retail';
      if (url.searchParams.get('tier') === 'auto') {
        try {
          await ensureShop(env);
          const vc = await currentCustomer(env, request);
          if (vc && vc.tier === 'wholesale') viewerTier = 'wholesale';
        } catch (e) { viewerTier = 'retail'; }
      }
      out.tier = viewerTier;
      // 变体分组视图：同一 parent_sku 的行收成一张卡（父行自身带图，作为卡片主图）。
      // parent_sku 为空的行各自独立成卡 —— 老数据行为完全不变。
      // ?flat=1 返回扁平行（发布对账 / 管理后台用）。
      if (hasVariant && url.searchParams.get('flat') !== '1') {
        const byKey = new Map();
        for (const p of rows) {
          const key = p.parent_sku ? String(p.parent_sku) : 'row:' + p.id;
          let card = byKey.get(key);
          if (!card) {
            card = { key, parent_sku: p.parent_sku || '', id: p.id, name: p.name,
                     category: p.category, image: p.image, sku: p.sku, variants: [],
                     material: p.material || '', size: p.size_type || '',
                     styles: p.styles ? String(p.styles).split(',').filter(Boolean) : [],
                     family: p.family || '', price: Number(p.price || 0) };
            byKey.set(key, card);
          }
          // 卡级属性散落在各行时，哪行有值就用哪行（分类只写在其中一行也不会丢）
          if (!card.material && p.material) card.material = p.material;
          if (!card.size && p.size_type) card.size = p.size_type;
          if (!card.family && p.family) card.family = p.family;
          if ((!card.styles || !card.styles.length) && p.styles)
            card.styles = String(p.styles).split(',').filter(Boolean);
          card.variants.push({
            id: p.id, sku: p.sku, image: p.image, name: p.name,
            color: p.color || '', color2: p.color2 || p.color || '',
            pattern: Number(p.pattern || 0) === 1, price: Number(p.price || 0)
          });
          // 卡价 = 各花色里的最低有效价（未定价 0 不参与比较）；全 0 时保持 0=询价
          const pv = Number(p.price || 0);
          if (pv > 0 && (!card.price || pv < card.price)) card.price = pv;
          const pw = Number(p.price_wholesale || 0);
          if (pw > 0 && (!card.price_wholesale || pw < card.price_wholesale)) card.price_wholesale = pw;
        }
        // 批发档覆盖：接口明确换了价就删掉零售价，避免前端两套价并存导致显示错乱
        if (viewerTier === 'wholesale') {
          for (const card of byKey.values()) {
            if (card.price_wholesale > 0) { card.price = card.price_wholesale; card.tier = 'wholesale'; }
          }
        }
        // 花色名从名称末尾提取（「… 粉红色5.9cm」-> 粉红色5.9cm），前端直接显示
        for (const card of byKey.values()) {
          card.variants.forEach(v => { v.label = v.name || v.sku || ''; });
          card.variant_count = card.variants.length;
        }
        out.cards = [...byKey.values()];
      }
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
      // 前台展示开关(2026-11-26):hide_names=1 时首页产品卡只显示图片不显示名称
      out.display = { hideNames: (await readSetting(env, 'hide_names')) === '1' };
      return json(out);
    }

    if (route === '/display' && method === 'GET') {
      // 公开可读:前台渲染时查询;只回布尔展示开关,无敏感信息
      return json({ hideNames: (await readSetting(env, 'hide_names')) === '1' });
    }
    if (route === '/display' && method === 'POST') {
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
      let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const v = body && body.hideNames ? '1' : '0';
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('hide_names', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).bind(v).run();
      return json({ ok: true, hideNames: v === '1' });
    }

    if (route === '/content' && method === 'GET') {
      try {
        const loc = localeOf(request);
        const content = await readContentMap(env, loc);
        return json({ content, locale: loc, locales: LOCALES });
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
        const loc = localeOf(request);
        await env.DB.prepare(VERSIONS_SCHEMA).run();
        const r = await env.DB.prepare(
          'SELECT id, version, note, created_at, content_json FROM content_versions ' +
          'WHERE page=? AND locale=? ORDER BY version DESC LIMIT 40'
        ).bind(PAGE, loc).all();
        const versions = (r.results || []).map(row => {
          let content = {};
          try { content = JSON.parse(row.content_json) || {}; } catch { content = {}; }
          return {
            id: row.id, version: row.version, note: row.note,
            created_at: row.created_at, keys: Object.keys(content).length, content
          };
        });
        return json({ page: PAGE, locale: loc, versions });
      } catch (e) {
        return json({ error: 'list failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    if (route === '/content/draft' && method === 'GET') {
      // 草稿内容不对外公开，仅管理模式可查
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
      try {
        const draft = await readDraft(env, localeOf(request));
        return json({ hasDraft: !!draft, draft, locale: localeOf(request) });
      } catch (e) {
        return json({ error: 'draft read failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    // —— 公开写接口：询盘提交（必须放在 checkAdmin 门禁之前）——
    if (route === '/inquiries' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      if (body && String(body._hp || '')) return json({ ok: true }); // 蜜罐命中：假装成功
      const name = String((body && body.name) || '').trim().slice(0, 120);
      const contact = String((body && body.contact) || '').trim().slice(0, 160);
      const message = String((body && body.message) || '').trim().slice(0, 2000);
      const product = String((body && body.product) || '').trim().slice(0, 200);
      if (!name || !contact || !message)
        return json({ error: 'missing fields' }, 400);
      const ip = (request.headers.get('CF-Connecting-IP') || '').slice(0, 64);
      try {
        await ensureInquiries(env);
        // 同 IP 每小时 ≤ 5 条：足够正常买家，挡脚本轰炸
        const recent = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM inquiries WHERE ip=? AND created_at > datetime('now','-1 hour')"
        ).bind(ip).first();
        if (recent && Number(recent.n) >= 5) return json({ error: 'too many' }, 429);
        await env.DB.prepare(
          'INSERT INTO inquiries (name, contact, message, product, ip) VALUES (?, ?, ?, ?, ?)'
        ).bind(name, contact, message, product, ip).run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: 'submit failed', detail: String(e && e.message || e).slice(0, 120) }, 500);
      }
    }

    // —— 只读：管理模式查看询盘列表（在 checkAdmin 门禁之前单独判权）——
    if (route === '/inquiries' && method === 'GET') {
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
      try {
        await ensureInquiries(env);
        const r = await env.DB.prepare(
          'SELECT id, name, contact, message, product, created_at FROM inquiries ORDER BY id DESC LIMIT 200'
        ).all();
        return json({ inquiries: r.results || [] });
      } catch (e) {
        return json({ inquiries: [], detail: String(e && e.message || e).slice(0, 120) });
      }
    }

    /* ============================ 商城（客户侧，会话鉴权，不走 X-Admin-Key） ============================ */
    if (route.indexOf('/shop/') === 0 || route === '/shop') {
      try { await ensureShop(env); } catch (e) {
        return json({ error: 'shop tables unavailable', detail: String(e && e.message || e).slice(0, 120) }, 500);
      }
      const cust = await currentCustomer(env, request);

      // 注册：邮箱唯一；已注册直接 409（不泄露「该邮箱有没有号」之外的信息）
      if (route === '/shop/register' && method === 'POST') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const email = cleanEmail(body && body.email);
        const pass = String((body && body.password) || '');
        let name = String((body && body.name) || '').trim().slice(0, 120);
        if (!email) return json({ error: 'valid email required' }, 400);
        if (pass.length < 8 || pass.length > 200) return json({ error: 'password 8-200 chars' }, 400);
        if (!name) name = ((email && email.split('@')[0]) || '客户').slice(0, 120);
        const exist = await env.DB.prepare('SELECT id FROM customers WHERE email=?').bind(email).first();
        if (exist) return json({ error: 'email already registered' }, 409);
        try {
          const salt = saltHex();
          const hash = await hashPassword(pass, salt);
          const company = String((body && body.company) || '').trim().slice(0, 160);
          const country = String((body && body.country) || '').trim().slice(0, 60);
          const phone = String((body && body.phone) || '').trim().slice(0, 60);
          const ins = await env.DB.prepare(
            'INSERT INTO customers (email, pass_hash, pass_salt, name, company, country, phone) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(email, hash, salt, name, company, country, phone).run();
          const cid = ins.meta && ins.meta.last_row_id;
          const token = cid ? await createSession(env, cid) : '';
          return json({ ok: true, customer: { id: cid, email, name, company, country, phone,
                                              tier: 'retail' } },
                      201, token ? [sessionCookie(token, SESSION_DAYS)] : []);
        } catch (e) {
          return json({ error: 'register failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
        }
      }

      // 登录：限速 + 恒定时间比较；成功轮换会话
      if (route === '/shop/login' && method === 'POST') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const email = cleanEmail(body && body.email);
        const pass = String((body && body.password) || '').slice(0, 200);
        const ip = (request.headers.get('CF-Connecting-IP') || '').slice(0, 64);
        if (!email || !pass) return json({ error: 'email and password required' }, 400);
        if (loginThrottle(ip, email)) return json({ error: 'too many attempts, wait 15 min' }, 429);
        const row = await env.DB.prepare(
          'SELECT id, email, name, company, country, phone, pass_hash, pass_salt, ' +
          "COALESCE(tier,'retail') AS tier, COALESCE(active,1) AS active " +
          'FROM customers WHERE email=?'
        ).bind(email).first();
        if (!row) { loginFailRecord(ip, email); return json({ error: 'invalid credentials' }, 401); }
        const hash = await hashPassword(pass, row.pass_salt || '');
        if (!constEqual(hash, row.pass_hash)) { loginFailRecord(ip, email); return json({ error: 'invalid credentials' }, 401); }
        // 停用账户：密码对了也不发会话（提示语不区分「没这个号」，只说明停用）
        if (Number(row.active) === 0) return json({ error: 'account disabled, contact us' }, 403);
        loginFails.delete(ip + '|' + email);
        const token = await createSession(env, row.id);
        return json({ ok: true, customer: { id: row.id, email: row.email, name: row.name,
                       company: row.company, country: row.country, phone: row.phone,
                       tier: String(row.tier || 'retail') } },
                    200, [sessionCookie(token, SESSION_DAYS)]);
      }

      if (route === '/shop/logout' && method === 'POST') {
        const token = parseCookies(request)[CUST_COOKIE] || '';
        if (/^[0-9a-f]{64}$/.test(token)) {
          try { await env.DB.prepare('DELETE FROM cust_sessions WHERE token=?').bind(token).run(); } catch (e) {}
        }
        return json({ ok: true }, 200, [sessionCookie('', 0)]);
      }

      // 当前客户（前端启动时探测登录态）；未登录 200 + null，不 401（避免噪音）
      if (route === '/shop/me' && method === 'GET') {
        if (!cust) return json({ customer: null });
        // tier 必须回：前端要据此显示「批发价」标识，并按档位决定是否重拉商品换价。
        return json({ customer: { id: cust.id, email: cust.email, name: cust.name,
                       company: cust.company, country: cust.country, phone: cust.phone,
                       tier: String(cust.tier || 'retail') } });
      }

      // 收款方式配置（公开只读：结账页要展示万里汇汇款账号 + PayPal 是否可用）。
      // 只回展示字段，绝不回 paypal_secret/client_id。
      if (route === '/shop/payment-config' && method === 'GET') {
        const wire = { enabled: false };
        try {
          const raw = await readSetting(env, 'shop_wire_config');
          if (raw) {
            const w = JSON.parse(raw);
            wire.enabled = !!w.enabled;
            wire.account_name = String(w.account_name || '').slice(0, 160);
            wire.bank_name = String(w.bank_name || '').slice(0, 160);
            wire.account_no = String(w.account_no || '').slice(0, 80);
            wire.note = String(w.note || '').slice(0, 1000);
          }
        } catch (e) {}
        let paypal = false, ppCid = '';
        try {
          ppCid = await readSetting(env, 'paypal_client_id');
          paypal = !!(ppCid && await readSetting(env, 'paypal_secret'));
        } catch (e) {}
        // client-id 可公开（PayPal SDK 本来就写在页面 URL 上）；secret 绝不外传
        return json({ wire, paypalEnabled: paypal, paypalClientId: paypal ? ppCid : '',
                      currency: 'USD' });
      }

      // 下单（需登录）。pay_method 只记录意向，paypal 真实扣款走 capture。
      if (route === '/shop/orders' && method === 'POST') {
        if (!cust) return json({ error: 'login required' }, 401);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const res = await createOrder(env, cust.id, body, cust.tier);
        if (res.error) return json({ error: res.error }, res.status || 400);
        const order = res.order;
        const mail = await notifyOrder(env, order, cust.email, true);
        return json({ ok: true, order: orderRow(order), mail });
      }

      // 我的订单列表（只回自己的）
      if (route === '/shop/orders' && method === 'GET') {
        if (!cust) return json({ error: 'login required' }, 401);
        const r = await env.DB.prepare(
          'SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 100'
        ).bind(cust.id).all();
        return json({ orders: (r.results || []).map(orderRow) });
      }

      // 本人撤单：只有没付钱的单能撤
      if (route === '/shop/orders/cancel' && method === 'POST') {
        if (!cust) return json({ error: 'login required' }, 401);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const num = String((body && body.num) || '').slice(0, 40);
        const o = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        if (!o || o.customer_id !== cust.id) return json({ error: 'not found' }, 404);
        if (['pending_payment', 'awaiting_confirmation'].indexOf(o.status) < 0)
          return json({ error: 'cannot cancel a ' + o.status + ' order' }, 409);
        await env.DB.prepare("UPDATE orders SET status='cancelled', updated_at=datetime('now') WHERE num=?")
          .bind(num).run();
        return json({ ok: true });
      }

      // 汇款回执：客户提交流水号/截图说明 → 状态转「待确认到账」
      if (route === '/shop/orders/receipt' && method === 'POST') {
        if (!cust) return json({ error: 'login required' }, 401);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const num = String((body && body.num) || '').slice(0, 40);
        const receipt = String((body && body.receipt) || '').trim().slice(0, 500);
        if (!receipt) return json({ error: 'receipt required' }, 400);
        const o = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        if (!o || o.customer_id !== cust.id) return json({ error: 'not found' }, 404);
        if (o.status !== 'pending_payment') return json({ error: 'order is ' + o.status }, 409);
        await env.DB.prepare(
          "UPDATE orders SET status='awaiting_confirmation', receipt=?, updated_at=datetime('now') WHERE num=?"
        ).bind(receipt, num).run();
        const adminEmail = await readSetting(env, 'shop_notify_email');
        if (adminEmail) await sendMailSafe(env, adminEmail, '[汇款回执] ' + num, escHtml(receipt));
        return json({ ok: true });
      }

      /* PayPal：服务端创单+请款。client 只拿到 checkout URL / 订单号，密钥永不出服务端。 */
      if (route === '/shop/paypal/create' && method === 'POST') {
        if (!cust) return json({ error: 'login required' }, 401);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const num = String((body && body.num) || '').slice(0, 40);
        const o = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        if (!o || o.customer_id !== cust.id) return json({ error: 'not found' }, 404);
        if (o.status !== 'pending_payment') return json({ error: 'order is ' + o.status }, 409);
        const token = await paypalAccessToken(env);
        if (!token) return json({ error: 'paypal not configured' }, 503);
        const origin = new URL(request.url).origin;
        const resp = await fetch((await paypalBase(env)) + '/v2/checkout/orders', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{ reference_id: o.num,
              amount: { currency_code: 'USD', value: money(o.total_cents) } }],
            application_context: {
              brand_name: 'LUNMONT', user_action: 'PAY_NOW',
              return_url: origin + '/?pp=capture&num=' + encodeURIComponent(o.num),
              cancel_url: origin + '/?pp=cancel'
            }
          })
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok) return json({ error: 'paypal create failed', detail: JSON.stringify(j).slice(0, 300) }, 502);
        const appr = (j.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
        // 有托管收银台（paypal_orders 列）则记录 pp_order_id
        try { await env.DB.prepare('SELECT paypal_order_id FROM orders LIMIT 1').first();
          await env.DB.prepare("UPDATE orders SET paypal_order_id=?, updated_at=datetime('now') WHERE num=?")
            .bind(j.id, o.num).run();
        } catch (e) {
          // 老库没这列：补列（一次性，ALTER 常量默认值合法）
          try { await env.DB.prepare('ALTER TABLE orders ADD COLUMN paypal_order_id TEXT DEFAULT ""').run();
            await env.DB.prepare('UPDATE orders SET paypal_order_id=? WHERE num=?').bind(j.id, o.num).run();
          } catch (e2) {}
        }
        return json({ ok: true, paypalOrderId: j.id, approveUrl: appr ? appr.href : '' });
      }

      if (route === '/shop/paypal/capture' && method === 'POST') {
        if (!cust) return json({ error: 'login required' }, 401);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const num = String((body && body.num) || '').slice(0, 40);
        const o = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        if (!o || o.customer_id !== cust.id) return json({ error: 'not found' }, 404);
        if (o.status === 'paid') return json({ ok: true, order: orderRow(o) }); // 幂等
        if (o.status !== 'pending_payment') return json({ error: 'order is ' + o.status }, 409);
        const token = await paypalAccessToken(env);
        if (!token) return json({ error: 'paypal not configured' }, 503);
        let ppId = String((body && body.paypalOrderId) || '').slice(0, 64);
        if (!ppId) { try { ppId = String(o.paypal_order_id || ''); } catch (e) {} }
        if (!ppId) return json({ error: 'paypalOrderId required' }, 400);
        const resp = await fetch((await paypalBase(env)) + '/v2/checkout/orders/' +
          encodeURIComponent(ppId) + '/capture', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        });
        const j = await resp.json().catch(() => ({}));
        const cap = j && j.status_code === 'COMPLETED' || (j && j.status === 'COMPLETED');
        if (!resp.ok || !cap) {
          return json({ error: 'capture not completed', detail: JSON.stringify(j).slice(0, 300) }, 502);
        }
        // 金额核对：PayPal 回的 capture 金额必须等于订单金额（防改单）
        const amt = (((j.purchase_units || [])[0] || {}).payments || {})
          .captures || [];
        const got = Number((amt[0] || {}).amount && amt[0].amount.value);
        if (!(got > 0) || Math.abs(got * 100 - Number(o.total_cents)) > 1) {
          await env.DB.prepare("UPDATE orders SET status='awaiting_confirmation', pay_ref=?, updated_at=datetime('now') WHERE num=?")
            .bind(ppId, num).run();
          return json({ error: 'amount mismatch — held for manual check', detail: got + ' vs ' + money(o.total_cents) }, 409);
        }
        await env.DB.prepare(
          "UPDATE orders SET status='paid', pay_method='paypal', pay_ref=?, updated_at=datetime('now') WHERE num=?"
        ).bind(ppId, num).run();
        const fresh = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        await notifyOrder(env, fresh, cust.email, false);
        return json({ ok: true, order: orderRow(fresh) });
      }

      return json({ error: 'not found' }, 404);
    }

    /* ============================ 商城（管理侧，X-Admin-Key 门禁） ============================ */
    if (route.indexOf('/shop-admin/') === 0) {
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
      try { await ensureShop(env); } catch (e) {
        return json({ error: 'shop tables unavailable', detail: String(e && e.message || e).slice(0, 120) }, 500);
      }

      // 汇款收款账号配置（万里汇 B2B 账号信息，仅展示用）
      if (route === '/shop-admin/wire-config' && method === 'POST') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const w = {
          enabled: !!(body && body.enabled),
          account_name: String((body && body.account_name) || '').trim().slice(0, 160),
          bank_name: String((body && body.bank_name) || '').trim().slice(0, 160),
          account_no: String((body && body.account_no) || '').trim().slice(0, 80),
          note: String((body && body.note) || '').trim().slice(0, 1000)
        };
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('shop_wire_config', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).bind(JSON.stringify(w)).run();
        return json({ ok: true });
      }

      // PayPal / 通知邮箱配置
      if (route === '/shop-admin/settings' && method === 'POST') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const stmts = [];
        const set = (k, v) => stmts.push(env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).bind(k, String(v || '').trim().slice(0, 300)));
        if (body && Object.prototype.hasOwnProperty.call(body, 'paypal_client_id')) set('paypal_client_id', body.paypal_client_id);
        if (body && Object.prototype.hasOwnProperty.call(body, 'paypal_secret')) set('paypal_secret', body.paypal_secret);
        if (body && Object.prototype.hasOwnProperty.call(body, 'paypal_env')) {
          set('paypal_env', body.paypal_env === 'live' ? 'live' : 'sandbox');
        }
        if (body && Object.prototype.hasOwnProperty.call(body, 'shop_notify_email')) set('shop_notify_email', body.shop_notify_email);
        if (body && Object.prototype.hasOwnProperty.call(body, 'shop_from_email')) set('shop_from_email', body.shop_from_email);
        if (stmts.length) await env.DB.batch(stmts);
        // 只回布尔状态，绝不把密钥回传前端
        const has = async k => !!(await readSetting(env, k));
        return json({ ok: true, paypal_client_id: await has('paypal_client_id'),
                      paypal_secret: await has('paypal_secret'),
                      paypal_env: (await readSetting(env, 'paypal_env')) === 'live' ? 'live' : 'sandbox',
                      shop_notify_email: await has('shop_notify_email'),
                      shop_from_email: await has('shop_from_email') });
      }
      if (route === '/shop-admin/settings' && method === 'GET') {
        const has = async k => !!(await readSetting(env, k));
        return json({ paypal_client_id: await has('paypal_client_id'),
                      paypal_secret: await has('paypal_secret'),
                      paypal_env: (await readSetting(env, 'paypal_env')) === 'live' ? 'live' : 'sandbox',
                      shop_notify_email: await has('shop_notify_email'),
                      shop_from_email: await has('shop_from_email') });
      }

      // 订单列表（管理视角，带客户信息；status / q 过滤）
      if (route === '/shop-admin/orders' && method === 'GET') {
        const status = String((url.searchParams.get('status') || '')).slice(0, 30);
        const q = String((url.searchParams.get('q') || '')).trim().slice(0, 80);
        let sql = 'SELECT o.*, c.email AS cust_email, c.name AS cust_name, c.company AS cust_company ' +
                  'FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE 1=1';
        const binds = [];
        if (status && ORDER_STATUSES.indexOf(status) >= 0) { sql += ' AND o.status=?'; binds.push(status); }
        if (q) { sql += ' AND (o.num LIKE ? OR c.email LIKE ? OR c.name LIKE ?)'; binds.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
        sql += ' ORDER BY o.id DESC LIMIT 200';
        const r = await env.DB.prepare(sql).bind(...binds).all();
        const out = (r.results || []).map(o => Object.assign(orderRow(o), {
          customer: { id: o.customer_id, email: o.cust_email || '', name: o.cust_name || '', company: o.cust_company || '' }
        }));
        return json({ orders: out });
      }

      // 推进订单状态（paid 必须由管理端确认到账后手动标记）
      if (route === '/shop-admin/orders/status' && method === 'POST') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const num = String((body && body.num) || '').slice(0, 40);
        const status = String((body && body.status) || '');
        if (ORDER_STATUSES.indexOf(status) < 0) return json({ error: 'bad status' }, 400);
        const o = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        if (!o) return json({ error: 'not found' }, 404);
        if (o.status === status) return json({ ok: true, unchanged: true });
        if (o.status === 'cancelled' || o.status === 'refunded')
          return json({ error: 'terminal order cannot be moved to ' + status }, 409);
        await env.DB.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE num=?")
          .bind(status, num).run();
        const fresh = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        if (['paid', 'shipped', 'cancelled', 'refunded'].indexOf(status) >= 0) await notifyOrder(env, fresh, '', false);
        return json({ ok: true, order: orderRow(fresh) });
      }

      // 汇款单标记已收款（人工核对到账后一键 paid）
      if (route === '/shop-admin/orders/confirm-paid' && method === 'POST') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const num = String((body && body.num) || '').slice(0, 40);
        const payRef = String((body && body.pay_ref) || '').trim().slice(0, 200);
        const o = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        if (!o) return json({ error: 'not found' }, 404);
        if (['paid', 'shipped', 'delivered'].indexOf(o.status) >= 0) return json({ ok: true, unchanged: true });
        await env.DB.prepare(
          "UPDATE orders SET status='paid', pay_method=CASE WHEN pay_method='' THEN 'wire' ELSE pay_method END, " +
          "pay_ref=?, updated_at=datetime('now') WHERE num=?").bind(payRef, num).run();
        const fresh = await env.DB.prepare('SELECT * FROM orders WHERE num=?').bind(num).first();
        await notifyOrder(env, fresh, '', false);
        return json({ ok: true, order: orderRow(fresh) });
      }

      // 客户列表（注册时长、订单数、累计金额、当前档位、是否停用）
      if (route === '/shop-admin/customers' && method === 'GET') {
        const r = await env.DB.prepare(
          'SELECT c.id, c.email, c.name, c.company, c.country, c.phone, c.created_at, ' +
          "COALESCE(c.tier,'retail') AS tier, COALESCE(c.active,1) AS active, " +
          "COALESCE(c.admin_note,'') AS admin_note, " +
          'COUNT(o.id) AS order_count, COALESCE(SUM(CASE WHEN o.status IN ' +
          "('paid','processing','shipped','delivered') THEN o.total_cents ELSE 0 END),0) AS paid_cents " +
          'FROM customers c LEFT JOIN orders o ON o.customer_id = c.id ' +
          'GROUP BY c.id ORDER BY c.id DESC LIMIT 500'
        ).all();
        return json({ customers: (r.results || []).map(c => Object.assign({}, c, { paid: money(c.paid_cents) })) });
      }

      // 后台开号（批发老客户用）：管理员直接建账户并指定档位，不走公开注册。
      // 密码只收不明文回显；tier 只认白名单值。
      if (route === '/shop-admin/customers/create' && method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const email = cleanEmail(body && body.email);
        const pass = String((body && body.password) || '');
        let name = String((body && body.name) || '').trim().slice(0, 120);
        const tier = TIERS.indexOf(String((body && body.tier) || '')) >= 0
          ? String(body.tier) : 'retail';
        if (!email) return json({ error: 'valid email required' }, 400);
        if (pass.length < 8 || pass.length > 200) return json({ error: 'password 8-200 chars' }, 400);
        if (!name) name = ((email && email.split('@')[0]) || '客户').slice(0, 120);
        const exist = await env.DB.prepare('SELECT id FROM customers WHERE email=?').bind(email).first();
        if (exist) return json({ error: 'email already registered' }, 409);
        try {
          const salt = saltHex();
          const hash = await hashPassword(pass, salt);
          const company = String((body && body.company) || '').trim().slice(0, 160);
          const country = String((body && body.country) || '').trim().slice(0, 60);
          const phone = String((body && body.phone) || '').trim().slice(0, 60);
          const note = String((body && body.note) || '').trim().slice(0, 500);
          const ins = await env.DB.prepare(
            'INSERT INTO customers (email, pass_hash, pass_salt, name, company, country, phone, tier, admin_note) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(email, hash, salt, name, company, country, phone, tier, note).run();
          // 绝不回显密码/哈希
          return json({ ok: true, customer: { id: ins.meta && ins.meta.last_row_id,
                        email, name, company, country, phone, tier } }, 201);
        } catch (e) {
          return json({ error: 'create failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
        }
      }

      // 后台改客户：档位 / 启停 / 备注 / 重置密码。都不回显密码。
      if (route === '/shop-admin/customers/update' && method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const id = Number(body && body.id);
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
        const cur = await env.DB.prepare('SELECT id FROM customers WHERE id=?').bind(id).first();
        if (!cur) return json({ error: 'not found' }, 404);
        const sets = [], vals = [];
        if (body.tier !== undefined) {
          const t = String(body.tier);
          if (TIERS.indexOf(t) < 0) return json({ error: 'invalid tier' }, 400);
          sets.push('tier=?'); vals.push(t);
        }
        if (body.active !== undefined) {
          sets.push('active=?'); vals.push(Number(body.active) ? 1 : 0);
        }
        if (body.admin_note !== undefined) {
          sets.push('admin_note=?'); vals.push(String(body.admin_note || '').trim().slice(0, 500));
        }
        if (body.password !== undefined && String(body.password) !== '') {
          const p = String(body.password);
          if (p.length < 8 || p.length > 200) return json({ error: 'password 8-200 chars' }, 400);
          const salt = saltHex();
          sets.push('pass_hash=?', 'pass_salt=?');
          vals.push(await hashPassword(p, salt), salt);
        }
        if (!sets.length) return json({ error: 'nothing to update' }, 400);
        try {
          await env.DB.prepare('UPDATE customers SET ' + sets.join(', ') + ' WHERE id=?')
            .bind(...vals, id).run();
          // 停用必须立刻踢掉在线会话，否则对方手里的 Cookie 还能继续下单
          if (body.active !== undefined && !Number(body.active)) {
            try { await env.DB.prepare('DELETE FROM cust_sessions WHERE customer_id=?').bind(id).run(); }
            catch (e) { /* 会话表异常不影响停用本身 */ }
          }
          const fresh = await env.DB.prepare(
            "SELECT id, email, name, tier, COALESCE(active,1) AS active, COALESCE(admin_note,'') AS admin_note " +
            'FROM customers WHERE id=?').bind(id).first();
          return json({ ok: true, customer: fresh });
        } catch (e) {
          return json({ error: 'update failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
        }
      }

      return json({ error: 'not found' }, 404);
    }

    if (method === 'POST' || method === 'DELETE') {
      if (!(await checkAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
    }

    /* ---- 区块布局：GET 公开（访客首页就要应用），POST 已过上方 admin 门禁 ---- */
    if (route === '/layout' && method === 'GET') {
      try {
        const layout = await readLayout(env);
        return json({ layout: layout || null, builtin: BUILTIN_BLOCKS, locked: LOCKED_BLOCKS });
      } catch (e) {
        return json({ layout: null, builtin: BUILTIN_BLOCKS, locked: LOCKED_BLOCKS });
      }
    }
    if (route === '/layout' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const clean = cleanLayout(body && body.layout);
      if (!clean) return json({ error: 'invalid layout' }, 400);
      try {
        await env.DB.prepare(SETTINGS_SCHEMA).run();
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('layout_json', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        ).bind(JSON.stringify(clean)).run();
        return json({ ok: true, order: clean.order.length, custom: Object.keys(clean.custom).length });
      } catch (e) {
        return json({ error: 'layout save failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }
    if (route === '/layout' && method === 'DELETE') {
      try {
        await env.DB.prepare("DELETE FROM settings WHERE key='layout_json'").run();
        return json({ ok: true, reset: true });
      } catch (e) {
        return json({ error: 'layout reset failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
    }

    /* ---- 四维分类维护（工作站⑬）：整值改名 / 迁移，单列 UPDATE 绝不全列覆盖 ----
       dims: category | styles | size | family。sku: 行 ukey 不随 category 变，天然安全；
       nm: 行改 category 会重算 ukey，撞键（409 UNIQUE）该行如实报错跳过，绝不硬写。 */
    if (route === '/products/facets' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const dim = String(body && body.dim || '');
      const DIM_COL = { category: 'category', styles: 'styles', size: 'size_type', family: 'family' };
      if (!DIM_COL[dim]) return json({ error: 'dim must be category|styles|size|family' }, 400);
      const from = String(body.from || '').trim().slice(0, 60);
      const to = String(body.to || '').trim().slice(0, 60);
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null;
      if (!from && !ids) return json({ error: 'from or ids required' }, 400);
      const col = DIM_COL[dim];
      try {
        await ensureProducts(env);
        const all = await env.DB.prepare('SELECT id, name, sku, ukey, ' + col + ' AS v FROM products').all();
        let targets;
        if (ids && ids.length) {
          const want = new Set(ids);
          targets = (all.results || []).filter((r) => want.has(r.id));
        } else {
          targets = (all.results || []).filter((r) => {
            if (dim === 'styles') return String(r.v || '').split(',').map(s => s.trim()).indexOf(from) >= 0;
            return String(r.v || '').trim() === from;
          });
        }
        if (!targets.length) return json({ error: 'no matching products' }, 404);
        if (body.dryRun) {
          return json({ ok: true, dryRun: true, dim, from, to, count: targets.length,
                        sample: targets.slice(0, 8).map(r => r.sku || r.name) });
        }
        if (dim !== 'category' && !to) return json({ error: 'to required for this dim' }, 400);
        let updated = 0; const errors = [];
        for (const r of targets) {
          let nv;
          if (dim === 'styles') {
            const arr = String(r.v || '').split(',').map(s => s.trim()).filter(Boolean);
            const set = new Set(to ? arr.map(s => s === from ? to : s).concat([to]) : arr.filter(s => s !== from));
            set.delete(''); nv = Array.from(set).join(',').slice(0, 180);
          } else {
            nv = to;
            if (dim === 'category' && !nv) { errors.push({ id: r.id, reason: '品类不能为空' }); continue; }
          }
          try {
            if (dim === 'category') {
              // nm: 键行 category 参与 ukey，重算后可能撞键 → UNIQUE 报错跳过该行
              const newKey = productKey({ name: r.name, category: nv, sku: r.sku });
              if (r.ukey && r.ukey.indexOf('sku:') === 0) {
                await env.DB.prepare("UPDATE products SET category=?, updated_at=datetime('now') WHERE id=?")
                  .bind(nv, r.id).run();
              } else {
                await env.DB.prepare("UPDATE products SET category=?, ukey=?, updated_at=datetime('now') WHERE id=?")
                  .bind(nv, newKey, r.id).run();
              }
            } else {
              await env.DB.prepare('UPDATE products SET ' + col + "=?, updated_at=datetime('now') WHERE id=?")
                .bind(nv, r.id).run();
            }
            updated++;
          } catch (e) {
            const m = String(e && e.message || e);
            errors.push({ id: r.id, sku: r.sku, reason: m.indexOf('UNIQUE') >= 0 ? '去重键冲突' : m.slice(0, 60) });
          }
        }
        return json({ ok: !errors.length, dim, from, to, updated,
                      errors: errors.slice(0, 20),
                      message: '已更新 ' + updated + ' 行' + (errors.length ? '，失败 ' + errors.length + ' 行' : '') });
      } catch (e) {
        return json({ error: 'facets failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
      }
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
        const loc = localeOf(request);
        await env.DB.prepare(DRAFT_SCHEMA).run();
        await env.DB.prepare(
          `INSERT INTO content_drafts (page, locale, content_json, note, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(page, locale) DO UPDATE SET
             content_json=excluded.content_json, note=excluded.note,
             updated_at=excluded.updated_at`
        ).bind(PAGE, loc, JSON.stringify(clean),
               String((body && body.note) || '').slice(0, 120) || '存为草稿').run();
        // 注意：这里绝不调用 writeContentMap / saveVersion，草稿不影响访客看到的内容
        return json({ ok: true, hasDraft: true, locale: loc, keys: Object.keys(clean).length });
      } catch (e) {
        return json({ error: 'draft save failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
    }

    if (route === '/content/draft' && method === 'DELETE') {
      try {
        const loc = localeOf(request);
        await env.DB.prepare(DRAFT_SCHEMA).run();
        await env.DB.prepare('DELETE FROM content_drafts WHERE page=? AND locale=?')
          .bind(PAGE, loc).run();
        return json({ ok: true, locale: loc });
      } catch (e) {
        return json({ error: 'draft discard failed', detail: String(e && e.message || e).slice(0, 200) }, 500);
      }
    }

    if (route === '/content/publish' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      try {
        const loc = localeOf(request);
        const draft = await readDraft(env, loc);
        if (!draft) return json({ error: 'no draft' }, 404);
        const clean = cleanContentInput(draft.content);
        if (!clean) return json({ error: 'bad draft content' }, 500);
        const before = await readContentMap(env, loc);
        await writeContentMap(env, clean, loc);
        const after = Object.assign({}, before, clean);
        const changed = !sameContent(before, after);
        const version = changed
          ? await saveVersion(env, after,
              String((body && body.note) || draft.note || '').slice(0, 120) || '发布草稿', loc)
          : null;
        await env.DB.prepare('DELETE FROM content_drafts WHERE page=? AND locale=?')
          .bind(PAGE, loc).run();
        return json({ ok: true, locale: loc, published: Object.keys(clean).length,
                      version, unchanged: !changed });
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
        const loc = localeOf(request);
        await env.DB.prepare(VERSIONS_SCHEMA).run();
        const row = await env.DB.prepare(
          'SELECT content_json FROM content_versions WHERE page=? AND locale=? AND version=?'
        ).bind(PAGE, loc, v).first();
        if (!row) return json({ error: 'version not found' }, 404);
        let old = {};
        try { old = JSON.parse(row.content_json) || {}; } catch { return json({ error: 'bad snapshot' }, 500); }
        const keys = Object.keys(old);
        if (!keys.length || keys.length > 160) return json({ error: 'bad snapshot keys' }, 500);
        for (const k of keys) {
          if (!/^[a-z0-9_]{1,40}$/.test(k) || typeof old[k] !== 'string')
            return json({ error: 'bad snapshot value: ' + k }, 500);
        }
        const clean = {};
        for (const k of keys) clean[k] = old[k].slice(0, MAX_CONTENT_VALUE);
        const before = await readContentMap(env, loc);
        await writeContentMap(env, clean, loc);
        const changed = !sameContent(before, clean);
        const newV = changed
          ? await saveVersion(env, clean, '回滚到 v' + v, loc)
          : null;
        return json({ ok: true, locale: loc, restoredFrom: v, version: newV, unchanged: !changed });
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
          { role: 'user', content: JSON.stringify({ page: PAGE, locale: localeOf(request), globalHint, fields: marks }) }
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
      if (!keys.length || keys.length > 160) return json({ error: 'bad key count' }, 400);
      for (const k of keys) {
        if (!/^[a-z0-9_]{1,40}$/.test(k)) return json({ error: 'invalid key: ' + k }, 400);
        if (typeof c[k] !== 'string') return json({ error: 'invalid value: ' + k }, 400);
      }
      try {
        const loc = localeOf(request);
        const clean = {};
        for (const k of keys) clean[k] = c[k].slice(0, MAX_CONTENT_VALUE);
        const before = await readContentMap(env, loc);
        await writeContentMap(env, clean, loc);
        // 保存前是整个 live 快照，保存后是 before 叠加本次字段；内容没变就不涨版本
        const after = Object.assign({}, before, clean);
        const changed = !sameContent(before, after);
        const version = changed
          ? await saveVersion(env, after, String((body && body.note) || '').slice(0, 120) || '保存文案', loc)
          : null;
        return json({ ok: true, locale: loc, saved: keys.length, version, unchanged: !changed });
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
      // 顺手把回填也跑完，省得还要靠一次真实发布来触发
      try { await ensureProducts(env); out.migrated = true; }
      catch (e) { out.migrateError = String(e && e.message || e).slice(0, 160); }
      try {
        const s = await env.DB.prepare(
          "SELECT COUNT(*) AS rows, COUNT(DISTINCT ukey) AS keys FROM products"
        ).first();
        out.stats = s;
        out.dupes = (await dupeReport(env)).length;
      } catch (e) {}
      return json(out);
    }

    if (route === '/inquiries' && method === 'DELETE') {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
      try {
        await ensureInquiries(env);
        await env.DB.prepare('DELETE FROM inquiries WHERE id = ?').bind(id).run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: 'delete failed' }, 500);
      }
    }

    // —— 产品字段修改：改名称/分类。sku 键的行 ukey 不变；名称键的行重算 ukey，
    // 撞唯一索引时报 duplicate，前端提示改名会并入另一款。
    if (route === '/products/update' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const id = Number(body && body.id);
      const name = String((body && body.name) || '').trim().slice(0, 200);
      const category = String((body && body.category) || '').trim().slice(0, 60);
      if (!Number.isInteger(id) || id <= 0 || !name) return json({ error: 'invalid fields' }, 400);
      try {
        await ensureProducts(env);
        const cur = await env.DB.prepare('SELECT id, name, sku, ukey FROM products WHERE id=?')
          .bind(id).first();
        if (!cur) return json({ error: 'not found' }, 404);
        const newKey = productKey({ name, category, sku: cur.sku });
        if (cur.ukey && cur.ukey.indexOf('sku:') === 0) {
          await env.DB.prepare("UPDATE products SET name=?, category=?, updated_at=datetime('now') WHERE id=?")
            .bind(name, category, id).run();
        } else {
          await env.DB.prepare("UPDATE products SET name=?, category=?, ukey=?, updated_at=datetime('now') WHERE id=?")
            .bind(name, category, newKey, id).run();
        }
        return json({ ok: true, action: 'updated' });
      } catch (e) {
        const msg = String(e && e.message || e);
        if (msg.indexOf('UNIQUE') >= 0) return json({ error: 'duplicate' }, 409);
        return json({ error: 'update failed', detail: msg.slice(0, 120) }, 500);
      }
    }

    // —— 首图：访客可读（公开），管理模式可换（存 settings，不挤占文案字段长度）
    if (route === '/hero' && method === 'GET') {
      try {
        const r = await env.DB.prepare("SELECT value FROM settings WHERE key='hero_img'").first();
        return json({ image: (r && r.value) || '' });
      } catch (e) { return json({ image: '' }); }
    }
    if (route === '/hero' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const image = String((body && body.image) || '');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > MAX_IMAGE)
        return json({ error: 'invalid image' }, 400);
      try {
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('hero_img', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).bind(image).run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: 'save failed', detail: String(e && e.message || e).slice(0, 120) }, 500);
      }
    }

    // —— K5 拍立得：访客可读，管理模式可改（存 settings.snaps，JSON 数组 ≤4 张）
    if (route === '/snaps' && method === 'GET') {
      try {
        const r = await env.DB.prepare("SELECT value FROM settings WHERE key='snaps'").first();
        let snaps = [];
        if (r && r.value) { try { snaps = JSON.parse(r.value); } catch (e) { snaps = []; } }
        return json({ snaps: Array.isArray(snaps) ? snaps.slice(0, 4) : [] });
      } catch (e) { return json({ snaps: [] }); }
    }
    if (route === '/snaps' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const list = Array.isArray(body && body.snaps) ? body.snaps.slice(0, 4) : null;
      if (!list) return json({ error: 'invalid snaps' }, 400);
      for (const s of list) {
        const img = String((s && s.img) || '');
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > MAX_IMAGE)
          return json({ error: 'invalid image' }, 400);
        s.cap = String((s && s.cap) || '').slice(0, 60);
      }
      try {
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('snaps', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).bind(JSON.stringify(list)).run();
        return json({ ok: true, count: list.length });
      } catch (e) {
        return json({ error: 'save failed', detail: String(e && e.message || e).slice(0, 120) }, 500);
      }
    }

    // 按 id 批量改价（零售价 / 批发价）。**只动价格，绝不碰 name/category/image/ukey**：
    // 走 /products/batch 会把 ukey 重算、还可能把整行字段用 0 覆盖掉，改价绝不能借道那条路。
    // items: [{ id, price?, price_wholesale? }]，两个字段至少给一个，缺省=不改。
    if (route === '/products/prices' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const items = Array.isArray(body && body.items) ? body.items : null;
      if (!items) return json({ error: 'items array required' }, 400);
      if (!items.length) return json({ error: 'items empty' }, 400);
      if (items.length > 500) return json({ error: 'too many items (max 500)' }, 413);
      // 价格归一化口径与 cleanProduct 完全一致：非法/负数=0，两位小数，封顶防手滑
      const norm = (v) => {
        const n = Number(v);
        return (isFinite(n) && n > 0) ? Math.min(Math.round(n * 100) / 100, 1000000) : 0;
      };
      const clean = [];
      const errors = [];
      items.forEach((raw, i) => {
        const id = Number(raw && raw.id);
        if (!Number.isInteger(id) || id <= 0) { errors.push({ index: i, error: 'invalid id' }); return; }
        const hasP = raw.price !== undefined;
        const hasW = raw.price_wholesale !== undefined;
        if (!hasP && !hasW) { errors.push({ index: i, error: 'no price field' }); return; }
        clean.push({ id, hasP, hasW, price: norm(raw.price), whole: norm(raw.price_wholesale) });
      });
      if (!clean.length) return json({ error: 'no valid items', errors }, 400);
      try {
        await ensureProducts(env);
        const ids = clean.map(c => c.id);
        const found = await env.DB.prepare(
          'SELECT id FROM products WHERE id IN (' + ids.map(() => '?').join(',') + ')'
        ).bind(...ids).all();
        const alive = new Set((found.results || []).map(p => p.id));
        const stmts = [];
        for (const c of clean) {
          if (!alive.has(c.id)) { errors.push({ id: c.id, error: 'not found' }); continue; }
          if (c.hasP && c.hasW) {
            stmts.push(env.DB.prepare(
              "UPDATE products SET price=?, price_wholesale=?, updated_at=datetime('now') WHERE id=?"
            ).bind(c.price, c.whole, c.id));
          } else if (c.hasP) {
            stmts.push(env.DB.prepare(
              "UPDATE products SET price=?, updated_at=datetime('now') WHERE id=?"
            ).bind(c.price, c.id));
          } else {
            stmts.push(env.DB.prepare(
              "UPDATE products SET price_wholesale=?, updated_at=datetime('now') WHERE id=?"
            ).bind(c.whole, c.id));
          }
        }
        if (stmts.length) await env.DB.batch(stmts);
        return json({ ok: true, total: items.length, updated: stmts.length, errors });
      } catch (e) {
        return json({ error: 'price update failed', detail: String(e && e.message || e).slice(0, 160) }, 500);
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
