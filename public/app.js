/* 金融肉鸽 · 黄金赌鸽所 —— 前端逻辑 */
'use strict';

const $ = id => document.getElementById(id);
const fmtCny = n => '¥' + Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const CARD_META = {
  red:    { name: '红卡·拉盘', icon: '🟥', desc: '基线2分钟拉升1~10%，随后2分钟缓步回落' },
  green:  { name: '绿卡·砸盘', icon: '🟩', desc: '基线2分钟下砸1~10%，随后2分钟缓步回归' },
  yellow: { name: '黄卡·卖价×1.1', icon: '🟨', desc: '10分钟内你的卖出价×1.1' },
  blue:   { name: '蓝卡·买价×0.9', icon: '🟦', desc: '10分钟内你的买入价×0.9' },
  hand:   { name: '手·行窃', icon: '🖐️', desc: '偷指定玩家：3%起步，每次+1%，上限20%' },
};

let token = localStorage.getItem('fp_token') || '';
let me = null;                 // 自己的私有数据
let users = [];                // 公开玩家列表
let hist = [];                 // 本地价格序列 [{t,p}]
let curRoom = '大厅';
let curThread = null;
let bjTable = null;
let rlSel = 'red';
let lastLogId = 0;

/* ---------------- 基础 ---------------- */
async function api(path, body, method) {
  const opt = { method: method || (body ? 'POST' : 'GET'), headers: { 'x-token': token } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({ ok: false, msg: '网络错误' }));
  return j;
}
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ---------------- 加入 / SSE ---------------- */
async function tryResume() {
  if (!token) return false;
  const r = await api('/api/state');
  if (r.ok) { me = r.you; return true; }
  token = ''; localStorage.removeItem('fp_token');
  return false;
}
async function join() {
  const name = $('joinName').value.trim();
  if (!name) { toast('先起个名字'); return; }
  const r = await api('/api/join', { name, token: token || undefined });
  if (!r.ok) { toast(r.msg || '加入失败'); return; }
  token = r.token; localStorage.setItem('fp_token', token);
  me = r.you;
  startGame();
}
function startGame() {
  $('joinOverlay').classList.add('hidden');
  $('topbar').classList.remove('hidden');
  $('app').classList.remove('hidden');
  connectSSE();
  loadThreads();
  loadChat(curRoom);
  // 支持 #token=xxx&tab=casino 直达
  const m = location.hash.match(/tab=(\w+)/);
  if (m) {
    const b = document.querySelector(`.tab[data-tab="${m[1]}"]`);
    if (b) b.click();
    const r = location.hash.match(/room=([^&]+)/);
    if (r) {
      const rb = document.querySelector(`.rtab[data-room="${decodeURIComponent(r[1])}"]`);
      if (rb) rb.click();
    }
  }
}
let es = null;
const dbg = [];
function connectSSE() {
  if (es) es.close();
  es = new EventSource('/api/stream?token=' + encodeURIComponent(token));
  es.onopen = () => dbg.push('open');
  es.onerror = e => dbg.push('error readyState=' + e.target.readyState);
  es.addEventListener('tick', e => { dbg.push('tick'); onTick(JSON.parse(e.data)); });
  es.addEventListener('chat', e => {
    const d = JSON.parse(e.data);
    if (d.room === curRoom) { appendChat(d.m); }
  });
  es.addEventListener('threads', () => { if (!$('tab-forum').classList.contains('active')) loadThreads(); });
  window.addEventListener('error', ev => dbg.push('JSERR: ' + ev.message + ' @' + (ev.lineno || '?')));
  setInterval(() => {
    let el = $('dbgBox');
    if (!el && location.hash.includes('debug=1')) {
      el = document.createElement('pre'); el.id = 'dbgBox';
      el.style.cssText = 'position:fixed;bottom:4px;left:4px;z-index:99;color:#0f0;font-size:11px;background:#000c;padding:4px';
      document.body.appendChild(el);
    }
    if (el) el.textContent = dbg.slice(-6).join('\n') + '\nhist=' + hist.length + ' token=' + (token || 'none');
  }, 500);
}

/* ---------------- Tick 渲染 ---------------- */
function onTick(d) {
  hist.push({ t: d.t, p: d.price.cnyg });
  if (hist.length > 1900) hist.shift();

  // 顶栏
  if (d.you) {
    me = d.you;
    $('tbName').textContent = me.name;
    $('tbLevel').textContent = 'Lv.' + me.level;
    $('tbCash').textContent = me.cash.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    $('tbEquity').textContent = Math.round(me.equity).toLocaleString();
    $('tbXpFill').style.width = Math.min(100, me.xp / me.xpNeed * 100) + '%';
    $('tbXpFill').title = `经验 ${me.xp}/${me.xpNeed}`;
  }

  // 价格
  $('priceBig').textContent = d.price.cnyg.toFixed(2);
  $('priceUsd').textContent = d.price.usd ? `COMEX $${d.price.usd.toFixed(2)}/oz · USDCNY ${d.price.usdcny.toFixed(4)}` : '行情加载中…';
  const badge = $('priceBadge');
  if (d.price.real) { badge.textContent = '● 实时行情'; badge.className = 'badge real'; }
  else { badge.textContent = '○ 模拟走势'; badge.className = 'badge sim'; }

  // 交易面板
  if (me) {
    const bp = d.price.cnyg * (me.armedBlue > 0 ? 0.9 : 1);
    const sp = d.price.cnyg * (me.armedYellow > 0 ? 1.1 : 1);
    $('tBuy').textContent = bp.toFixed(2) + (me.armedBlue > 0 ? ' 🟦' : '');
    $('tSell').textContent = sp.toFixed(2) + (me.armedYellow > 0 ? ' 🟨' : '');
    $('tPos').textContent = me.grams.toFixed(3);
    $('tAvg').textContent = me.avg ? me.avg.toFixed(2) : '--';
    const fl = me.grams > 0 ? (sp - me.avg) * me.grams : 0;
    const el = $('tFloat');
    el.textContent = me.grams > 0 ? (fl >= 0 ? '+' : '') + fl.toFixed(2) : '--';
    el.style.color = fl > 0 ? '#43d98c' : fl < 0 ? '#ff5d5d' : '';
    renderContracts(d.price.cnyg);
    renderCards();
    renderSteal(d.users);
  }

  // 激活的方向卡
  const ca = $('cardsActive');
  ca.innerHTML = d.cards.map(c => {
    const end = c.start + c.ramp + c.decay;
    const left = Math.max(0, Math.round((end - d.t) / 1000));
    const pct = (Math.abs(c.peak) * 100).toFixed(1);
    return `<span class="active-card-chip" style="color:${c.type === 'red' ? '#ff5d5d' : '#43d98c'};border-color:currentColor">
      ${c.type === 'red' ? '🟥 拉升' : '🟩 下砸'} ${pct}% · 剩 ${left}s</span>`;
  }).join('');

  // 排行榜 & AI
  users = d.users;
  $('lbList').innerHTML = d.users.map((u, i) =>
    `<li><span>${i + 1}. ${esc(u.name)} <small class="hint">Lv.${u.level}</small></span><span>${fmtCny(u.equity)}</span></li>`
  ).join('') || '<div class="empty">还没有玩家</div>';
  $('botList').innerHTML = d.bots.map(b =>
    `<div class="bot-item"><span>🤖 ${esc(b.name)} <small>(${b.strategy})</small></span><span>${fmtCny(b.equity)}${b.failCount ? ` <span class="bf">×${b.failCount}败</span>` : ''}</span></div>`
  ).join('');

  // 系统动态（增量）
  const logEl = $('logList');
  const fresh = d.log.filter(l => l.id > lastLogId);
  if (fresh.length) {
    lastLogId = d.log[d.log.length - 1].id;
    for (const l of fresh.slice(-15).reverse()) {
      const div = document.createElement('div');
      div.className = 'log-item ' + (l.kind || '');
      div.textContent = `[${new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}] ${l.text}`;
      logEl.prepend(div);
    }
    while (logEl.children.length > 60) logEl.lastChild.remove();
  }

  // 在线列表
  $('chatOnline').innerHTML = d.users.map(u =>
    `<li><span>${esc(u.name)}${u.name === (me && me.name) ? '（你）' : ''}</span><span class="lv">Lv.${u.level}</span></li>`
  ).join('');

  drawChart(d);
}

/* ---------------- 图表 ---------------- */
function drawChart(d) {
  const cv = $('chart');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const padL = 66, padR = 10, padT = 12, padB = 22;
  ctx.clearRect(0, 0, W, H);

  const win = hist.slice(-1800); // 30 分钟
  if (win.length < 2) return;
  let lo = Math.min(...win.map(x => x.p)), hi = Math.max(...win.map(x => x.p));
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;
  const X = t => padL + (W - padL - padR) * (t - win[0].t) / Math.max(1, win[win.length - 1].t - win[0].t);
  const Y = p => padT + (H - padT - padB) * (1 - (p - lo) / (hi - lo));

  // 网格
  ctx.strokeStyle = '#1c2333'; ctx.fillStyle = '#5a6377'; ctx.font = '11px Consolas';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (H - padT - padB) * i / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    const v = hi - (hi - lo) * i / 4;
    ctx.fillText(v.toFixed(1), 6, y + 4);
  }
  // 时间刻度
  for (let i = 0; i <= 3; i++) {
    const t = win[0].t + (win[win.length - 1].t - win[0].t) * i / 3;
    ctx.fillText(new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }), X(t) - 20, H - 6);
  }
  // 红绿卡区间
  for (const c of d.cards) {
    const s = Math.max(c.start, win[0].t), e = Math.min(c.start + c.ramp + c.decay, win[win.length - 1].t);
    if (e <= s) continue;
    ctx.fillStyle = c.type === 'red' ? 'rgba(255,93,93,.10)' : 'rgba(67,217,140,.10)';
    ctx.fillRect(X(s), padT, X(e) - X(s), H - padT - padB);
  }
  // 价格线
  const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, 'rgba(245,197,66,.28)'); grad.addColorStop(1, 'rgba(245,197,66,0)');
  ctx.beginPath();
  win.forEach((x, i) => i ? ctx.lineTo(X(x.t), Y(x.p)) : ctx.moveTo(X(x.t), Y(x.p)));
  ctx.strokeStyle = '#f5c542'; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(X(win[win.length - 1].t), H - padB); ctx.lineTo(X(win[0].t), H - padB);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  // 最新点
  const lx = X(win[win.length - 1].t), ly = Y(win[win.length - 1].p);
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, 7); ctx.fillStyle = '#f5c542'; ctx.fill();
}

/* ---------------- 交易 ---------------- */
async function doTrade(action, amount) {
  const r = await api('/api/trade', { action, amount });
  toast(r.ok ? '✅ ' + r.msg : '❌ ' + (r.msg || '失败'));
}
$('buyBtn').onclick = () => doTrade('buy', Number($('buyAmt').value));
$('sellBtn').onclick = () => doTrade('sell', Number($('sellAmt').value));
document.querySelectorAll('[data-buyf]').forEach(b => b.onclick = () => {
  if (!me) return;
  $('buyAmt').value = Math.max(1, Math.floor(me.cash * Number(b.dataset.buyf)));
});
document.querySelectorAll('[data-sellf]').forEach(b => b.onclick = () => {
  if (!me) return;
  $('sellAmt').value = (me.grams * Number(b.dataset.sellf)).toFixed(3);
});
$('sellAmt').addEventListener('input', () => { if (!$('sellAmt').value) $('sellAmt').placeholder = me ? me.grams.toFixed(3) : '1.0'; });

/* ---------------- 合约 ---------------- */
function renderContracts(p) {
  const box = $('ctList');
  const un = me.unlocks;
  $('ctUnlock').textContent = un.short ? (un.leverage ? `已解锁做空 + 杠杆最高 ${un.maxL}x` : 'Lv.5 已解锁做空 · Lv.10 解锁杠杆') : 'Lv.5 解锁做空 · Lv.10 解锁杠杆';
  const dirSel = $('ctDir'), lSel = $('ctL');
  dirSel.options[0].disabled = !un.short;
  [...lSel.options].forEach(o => o.disabled = !(Number(o.value) === 1 || (un.leverage && Number(o.value) <= un.maxL)));
  if (lSel.selectedOptions[0] && lSel.selectedOptions[0].disabled) lSel.value = '1';
  if (!me.contracts.length) { box.innerHTML = '<div class="empty">暂无合约仓位（做空 Lv.5 / 杠杆 Lv.10 解锁）</div>'; return; }
  box.innerHTML = me.contracts.map(c => {
    const cls = c.pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    return `<div class="ct-item">
      <span>${c.dir === 'long' ? '📈做多' : '📉做空'} ${c.L}x · 保证金 ¥${c.margin} @ ${c.entry.toFixed(2)}</span>
      <span class="${cls}">${c.pnl >= 0 ? '+' : ''}${c.pnl.toFixed(2)}</span>
      <button class="btn small" data-close="${c.id}">平仓</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-close]').forEach(b => b.onclick = async () => {
    const r = await api('/api/contract', { action: 'close', id: b.dataset.close });
    toast(r.ok ? '✅ ' + r.msg : '❌ ' + r.msg);
  });
}
$('ctOpenBtn').onclick = async () => {
  const r = await api('/api/contract', { action: 'open', dir: $('ctDir').value, L: Number($('ctL').value), margin: Number($('ctMargin').value) });
  toast(r.ok ? '✅ ' + r.msg : '❌ ' + r.msg);
};

/* ---------------- 技能卡 ---------------- */
function renderCards() {
  const row = $('cardRow');
  row.innerHTML = '';
  for (const [type, meta] of Object.entries(CARD_META)) {
    const n = me.cards[type] || 0;
    const slot = document.createElement('div');
    slot.className = 'card-slot';
    slot.title = meta.desc;
    slot.innerHTML = `<span>${meta.icon}</span><span>${meta.name}</span><span class="cnt">×${n}</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn small'; btn.textContent = '使用';
    btn.disabled = n <= 0 || (type === 'hand' && !$('stealTarget').value);
    if (type === 'hand') btn.disabled = n <= 0;
    btn.onclick = async () => {
      if (type === 'hand' && !$('stealTarget').value) { toast('先选一个行窃对象'); return; }
      const r = await api('/api/card', { type, target: $('stealTarget').value || undefined });
      toast(r.ok ? '✅ ' + r.msg : '❌ ' + r.msg);
    };
    slot.appendChild(btn);
    row.appendChild(slot);
  }
  $('stealChance').textContent = `成功率 ${Math.min(20, 3 + (me.stealUses || 0))}%`;
  $('cardHint').textContent = CARD_META.hand.desc + '。红/绿卡影响全场基线；黄/蓝卡只影响你自己 10 分钟。';
}
function renderSteal(usersList) {
  const sel = $('stealTarget');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— 选择行窃对象 —</option>' +
    usersList.filter(u => u.name !== me.name).map(u => `<option value="${u.token}">${esc(u.name)}（¥${Math.round(u.equity)}）</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}
$('stealBtn').onclick = async () => {
  if (!$('stealTarget').value) { toast('先选一个行窃对象'); return; }
  const r = await api('/api/card', { type: 'hand', target: $('stealTarget').value });
  toast(r.ok ? '🖐️ ' + r.msg : '❌ ' + r.msg);
};

/* ---------------- 聊天室 ---------------- */
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function loadChat(room) {
  const r = await api('/api/chat?room=' + encodeURIComponent(room));
  if (!r.ok) return;
  const box = $('chatList');
  box.innerHTML = '';
  r.list.forEach(appendChat);
  box.scrollTop = box.scrollHeight;
}
function appendChat(m) {
  const box = $('chatList');
  const self = me && m.from === me.name;
  const div = document.createElement('div');
  div.className = 'chat-msg' + (self ? ' self' : '');
  div.innerHTML = `<div class="who">${esc(m.from)} · ${new Date(m.t).toLocaleTimeString('zh-CN', { hour12: false })}</div><div class="bubble">${esc(m.text)}</div>`;
  box.appendChild(div);
  while (box.children.length > 150) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
document.querySelectorAll('.rtab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.rtab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  curRoom = b.dataset.room;
  loadChat(curRoom);
});
function sendChat() {
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  api('/api/chat', { room: curRoom, text });
}
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

/* ---------------- 21点 ---------------- */
const suitColor = s => (s === '♥' || s === '♦') ? 'red' : 'black';
function cardHtml(c) {
  if (c.s === '?') return '<div class="pcard back">🂠</div>';
  return `<div class="pcard ${suitColor(c.s)}">${c.r}<br>${c.s}</div>`;
}
function renderBj() {
  if (!bjTable) return;
  $('bjDealer').innerHTML = bjTable.dealer.map(cardHtml).join('');
  $('bjPlayer').innerHTML = bjTable.player.map(cardHtml).join('');
  $('bjMsg').textContent = bjTable.msg || '';
  const phase = bjTable.phase;
  $('bjBetBtn').disabled = !(phase === 'bet' || phase === 'done');
  $('bjHitBtn').disabled = phase !== 'player';
  $('bjStandBtn').disabled = phase !== 'player';
  $('bjDoubleBtn').disabled = phase !== 'player';
}
$('bjBetBtn').onclick = async () => {
  const r = await api('/api/bj', { action: 'bet', amount: Number($('bjBet').value) });
  if (!r.ok) { toast('❌ ' + r.msg); return; }
  bjTable = r.table; renderBj();
};
$('bjHitBtn').onclick = async () => {
  const r = await api('/api/bj', { action: 'hit' });
  if (r.ok) { bjTable = r.table; renderBj(); }
};
$('bjStandBtn').onclick = async () => {
  const r = await api('/api/bj', { action: 'stand' });
  if (r.ok) { bjTable = r.table; renderBj(); }
};
$('bjDoubleBtn').onclick = async () => {
  const r = await api('/api/bj', { action: 'double' });
  if (r.ok) { bjTable = r.table; renderBj(); }
};

/* ---------------- 轮盘 ---------------- */
document.querySelectorAll('.rl-bet').forEach(b => b.onclick = () => {
  rlSel = b.dataset.type;
  document.querySelectorAll('.rl-bet').forEach(x => x.classList.remove('sel'));
  b.classList.add('sel');
});
document.querySelector('[data-type="red"]').classList.add('sel');
$('rlSpin').onclick = async () => {
  const r = await api('/api/roulette', { type: rlSel, amount: Number($('rlAmt').value), num: Number($('rlNum').value) });
  if (!r.ok) { toast('❌ ' + r.msg); return; }
  const color = r.n === 0 ? 'green' : [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(r.n) ? 'red' : 'black';
  $('rlResult').innerHTML = `开出 <span class="rl-chip ${color}">${r.n}</span> ${r.win ? `—— 你赢了 ¥${r.got}！` : '—— 没中，下次一定'}`;
  const chip = document.createElement('div');
  chip.className = 'rl-chip ' + color; chip.textContent = r.n;
  $('rlHistory').prepend(chip);
  while ($('rlHistory').children.length > 18) $('rlHistory').lastChild.remove();
  if (r.win) toast('🎰 ' + r.msg);
};

/* ---------------- 贴吧 ---------------- */
async function loadThreads() {
  const r = await api('/api/threads');
  if (!r.ok) return;
  $('ftList').innerHTML = r.list.map(t => `
    <div class="ft-item" data-id="${t.id}">
      <div class="ft-title">${esc(t.title)} ${t.fake ? '<span class="ft-tag">疑似托</span>' : ''}</div>
      <div class="ft-meta"><span>${esc(t.author)}</span><span>${new Date(t.t).toLocaleString('zh-CN', { hour12: false })}</span><span>${t.replies} 回复</span></div>
    </div>`).join('') || '<div class="empty">还没有帖子，来当第一楼</div>';
  $('ftList').querySelectorAll('.ft-item').forEach(el => el.onclick = () => openThread(Number(el.dataset.id)));
}
async function openThread(id) {
  const r = await api('/api/thread?id=' + id);
  if (!r.ok) { toast('帖子不存在'); return; }
  curThread = r.thread;
  $('ftViewCard').classList.remove('hidden');
  $('ftView').innerHTML = `
    <h3 style="margin:10px 0">${esc(curThread.title)}</h3>
    ${curThread.posts.map(p => `
      <div class="ft-post"><div class="who">${esc(p.author)} · ${new Date(p.t).toLocaleString('zh-CN', { hour12: false })}</div>
      <div class="body">${esc(p.content)}</div></div>`).join('')}
    <div class="ft-reply">
      <textarea id="ftReplyBox" placeholder="理性回复（不可以）"></textarea>
      <button id="ftReplyBtn" class="btn">回复</button>
    </div>`;
  $('ftReplyBtn').onclick = async () => {
    const content = $('ftReplyBox').value.trim();
    if (!content) return;
    const rr = await api('/api/reply', { id: curThread.id, content });
    if (rr.ok) openThread(curThread.id);
  };
}
$('ftBack').onclick = () => { $('ftViewCard').classList.add('hidden'); curThread = null; };
$('ftPostBtn').onclick = async () => {
  const r = await api('/api/thread', { title: $('ftTitle').value, content: $('ftContent').value });
  if (!r.ok) { toast('❌ ' + r.msg); return; }
  $('ftTitle').value = ''; $('ftContent').value = '';
  toast('✅ 发布成功，等着看谁上当');
  await loadThreads();
  openThread(r.id);
};

/* ---------------- Tab 切换 ---------------- */
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('tab-' + b.dataset.tab).classList.add('active');
  if (b.dataset.tab === 'forum') loadThreads();
  if (b.dataset.tab === 'chat') loadChat(curRoom);
});

/* ---------------- 启动 ---------------- */
$('joinBtn').onclick = join;
$('joinName').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
function mark(s) { document.body.dataset.boot = ((document.body.dataset.boot || '') + ' ' + s).trim(); }
(async () => {
  try {
    mark('boot');
    const hashTok = (location.hash.match(/token=([a-f0-9]+)/) || [])[1];
    if (hashTok) { token = hashTok; localStorage.setItem('fp_token', token); }
    mark('tok:' + (token ? 'yes' : 'no'));
    const ok = await tryResume();
    mark('resume:' + ok);
    if (ok) { startGame(); mark('started'); }
    else { $('joinOverlay').classList.remove('hidden'); $('joinName').focus(); mark('overlay'); }
  } catch (e) {
    mark('ERR:' + (e && e.message));
    $('joinOverlay').classList.remove('hidden');
  }
})();
