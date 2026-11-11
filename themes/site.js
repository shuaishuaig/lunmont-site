/* Site core logic: bilingual, catalog render, lightbox, inquiry mailto.
   Theme-neutral — visual identity lives in themes/*.css only. */
const CONFIG = { email:'lunmontfa@gmail.com', whatsapp:'', phone:'+86 18268820516', wechat:'' };
const LABEL = {
  email:{zh:'邮箱',en:'Email'}, whatsapp:{zh:'WhatsApp',en:'WhatsApp'},
  phone:{zh:'电话',en:'Phone'}, wechat:{zh:'微信',en:'WeChat'}
};
let lang = 'zh';
let catalog = window.PRODUCTS || [];
const catalogCount = catalog.flatMap(c=>c.groups||[]).reduce((n,g)=>n+(g.items||[]).length,0) || 0;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function renderBadge(){
  const b = document.getElementById('srcbadge');
  b.className='srcbadge';
  b.textContent = (lang==='zh'?'产品目录 · ':'Product catalog · ')+catalogCount+' SKU';
}
function applyLang(){
  document.querySelectorAll('[data-zh]').forEach(el=>{
    const v = el.getAttribute('data-'+lang); if(v!==null) el.innerHTML = v;
  });
  document.querySelectorAll('[data-ph-zh]').forEach(el=>{
    const v = el.getAttribute('data-ph-'+lang); if(v!==null) el.placeholder = v;
  });
  document.documentElement.lang = lang==='zh'?'zh-CN':'en';
  document.getElementById('lang').textContent = lang==='zh'?'EN':'中文';
  renderContact(); renderBadge();
}
function renderContact(){
  const items=[], todo=document.getElementById('ctodo');
  Object.keys(CONFIG).forEach(k=>{
    const v=CONFIG[k].trim(); if(!v) return;
    const label=LABEL[k][lang];
    const href = k==='email' ? 'mailto:'+v
      : k==='whatsapp' ? 'https://wa.me/'+v.replace(/[^\d]/g,'')
      : k==='phone' ? 'tel:'+v.replace(/[^\d+]/g,'') : null;
    const txt = label+' · '+v;
    items.push(href ? '<a href="'+href+'" target="_blank" rel="noopener">'+txt+'</a>' : '<span>'+txt+'</span>');
  });
  document.getElementById('crow').innerHTML = items.join('');
  todo.textContent = items.length ? '' : (lang==='zh'
    ? '联系方式待补充：在 themes/site.js 顶部 CONFIG 中填入邮箱 / WhatsApp 即可自动显示。'
    : 'Contact details pending: fill CONFIG in themes/site.js.');
  todo.style.display = items.length ? 'none' : 'block';
}
function renderProducts(){
  const cats = catalog, tabs=document.getElementById('ptabs'), body=document.getElementById('pbody');
  if(!cats.length) return;
  tabs.innerHTML = cats.map((c,i)=>'<button class="ptab'+(i?'':' on')+'" data-cat="'+c.id+'" data-zh="'+esc(c.zh)+'" data-en="'+esc(c.en)+'">'+esc(c.zh)+'</button>').join('');
  body.innerHTML = cats.map((c,i)=>'<div class="pcat'+(i?'':' on')+'" data-cat="'+c.id+'">'+c.groups.map(g=>
      '<h3><span data-zh="'+esc(g.zh)+'" data-en="'+esc(g.en)+'">'+esc(g.zh)+'</span> <small>'+g.items.length+' SKU</small></h3>'+
      '<div class="pgrid">'+g.items.map(it=>{
        const src=g.path+it.sku+'.jpg';
        return '<figure class="pcard" title="'+esc(it.name)+'" data-src="'+esc(src)+'" data-cap="'+esc(it.sku+' · '+it.name)+'">'+
               '<img loading="lazy" src="'+esc(src)+'" alt="'+esc(it.sku)+'">'+
               '<figcaption title="'+esc(it.sku)+'">'+esc(it.sku)+'</figcaption></figure>';
      }).join('')+'</div>').join('')+'</div>').join('');
  tabs.querySelectorAll('.ptab').forEach(btn=>btn.onclick=()=>{
    tabs.querySelectorAll('.ptab').forEach(b=>b.classList.toggle('on', b===btn));
    body.querySelectorAll('.pcat').forEach(c=>c.classList.toggle('on', c.dataset.cat===btn.dataset.cat));
  });
  body.querySelectorAll('.pcard').forEach(card=>card.onclick=()=>openLB(card.dataset.src, card.dataset.cap));
}
function fillSkuOptions(){
  const sel = document.getElementById('inqsku');
  const items = catalog.flatMap(c=>c.groups.flatMap(g=>g.items));
  sel.innerHTML = '<option value="">'+(lang==='zh'?'不指定 / 未确定':'Not specified')+'</option>'+
    items.map(i=>'<option value="'+esc(i.sku)+'">'+esc(i.sku)+'</option>').join('');
}
function openLB(src, cap){
  document.getElementById('lbimg').src=src;
  document.getElementById('lbcap').textContent=cap;
  document.getElementById('lb').classList.add('on');
}
document.getElementById('lang').onclick = ()=>{ lang = lang==='zh'?'en':'zh'; applyLang(); fillSkuOptions(); };
document.getElementById('licimg').onclick = ()=>openLB('assets/business-license.jpg', lang==='zh'?'营业执照（副本）':'Business License (duplicate)');
document.getElementById('lb').onclick = ()=>document.getElementById('lb').classList.remove('on');
document.addEventListener('keydown', e=>{ if(e.key==='Escape') document.getElementById('lb').classList.remove('on'); });
document.getElementById('inq').onsubmit = e=>{
  e.preventDefault();
  const msg=document.getElementById('inqmsg');
  const name=document.getElementById('inqname').value.trim();
  const contact=document.getElementById('inqcontact').value.trim();
  const sku=document.getElementById('inqsku').value.trim();
  const text=document.getElementById('inqtext').value.trim();
  msg.className=''; msg.textContent='';
  if(!name || !contact || !text){
    msg.className='err'; msg.textContent = lang==='zh'?'请填写称呼、联系方式和询价内容。':'Please fill in all required fields.'; return;
  }
  const subject = 'Website inquiry' + (sku ? ' - ' + sku : '');
  const body = ['Name / Company: '+name, 'Contact: '+contact,
                'SKU: '+(sku||'-'), '', 'Message:', text, '',
                'Sent from https://lunmont.asia'].join('\n');
  window.location.href = 'mailto:'+CONFIG.email+'?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body);
  msg.className='ok';
  msg.textContent = lang==='zh'
    ? '已打开您的邮件客户端，点击发送即可送达；也可直接发邮件至 '+CONFIG.email+'。'
    : 'Your email app is opening. Send the message, or email '+CONFIG.email+' directly.';
};
document.getElementById('year').textContent = new Date().getFullYear();
renderProducts(); fillSkuOptions(); applyLang();
