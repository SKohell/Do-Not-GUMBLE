/* ============================================================
 * 金融肉鸽 · 黄金赌鸽所 —— 本地 Demo 服务端
 * 纯 Node 内置模块，无任何第三方依赖
 *   node server.js   →  http://127.0.0.1:8787
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

/* ---------------- 工具 ---------------- */
const T = () => Date.now();
const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rnd(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
const rid = () => crypto.randomBytes(8).toString('hex');
const OZ = 31.1034768; // 金衡盎司 → 克
const now2 = () => Math.floor(T() / 1000);
const todaySH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const hhmmssSH = () => new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

const CARD_META = {
  red:    { name: '红卡·利好拉盘', icon: '🟥', desc: '基线 2 分钟内拉升 1~10%，随后 2 分钟缓步回落' },
  green:  { name: '绿卡·利空砸盘', icon: '🟩', desc: '基线 2 分钟内下砸 1~10%，随后 2 分钟缓步回归' },
  yellow: { name: '黄卡·高价卖出', icon: '🟨', desc: '10 分钟内你的卖出价 ×1.1' },
  blue:   { name: '蓝卡·低价买入', icon: '🟦', desc: '10 分钟内你的买入价 ×0.9' },
  hand:   { name: '手·妙手空空', icon: '🖐️', desc: '对指定玩家行窃：3% 起步，每用一次 +1%，上限 20%' },
};
const CARD_TYPES = Object.keys(CARD_META);

/* ---------------- 状态 ---------------- */
let state = null;

function newBot(name, strategy) {
  return {
    id: rid(), name, strategy,
    cash: 10000, grams: 0, avg: 0,
    failCount: 0, lastDay: todaySH(),
    hist: [], born: T(),
  };
}
function defaultState() {
  const s = {
    t: T(), seq: 1,
    price: { usd: 0, usdcny: 0, cnyg: 0, real: false, ts: 0, anchor: 975, jWalk: 0 },
    hist: [],            // [{t,p}] 展示价
    cards: [],           // 激活的红/绿卡 {id,type,peak,start,ramp,decay}
    users: {},           // token → user
    bots: [
      newBot('AI·铁头趋势鸽', 'trend'),
      newBot('AI·高抛低吸鸽', 'meanrev'),
      newBot('AI·梭哈赌怪鸽', 'gambler'),
    ],
    chats: { '大厅': [], '闲聊灌水': [], '交易喊单': [] },
    threads: [],
    bj: {},
    log: [],
  };
  seedThreads(s);
  return s;
}
function seedThreads(s) {
  const seeds = [
    ['内部消息！今晚有大事，黄金要起飞了', '匿名大户', '信我，这波必涨，不满仓算我输。'],
    ['劝退帖：昨天全仓接盘，现在已经不敢看账户了', '韭菜的自我修养', '兄弟们谨慎，庄家就等着你们追高。'],
    ['长期看黄金到底值不值得囤？理性讨论', '小散一枚', '排除通胀因素感觉就是情绪游戏？'],
  ];
  for (const [title, author, content] of seeds) {
    s.threads.push({
      id: s.seq++, title, author, t: T() - ri(1000, 90000) * 1000, fake: true,
      posts: [{ author, t: T() - ri(1000, 90000) * 1000, content }],
    });
  }
}
function addLog(text, kind = 'info') {
  state.log.push({ id: state.seq++, t: T(), text, kind });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const slim = JSON.parse(JSON.stringify(state));
    slim.hist = slim.hist.slice(-1800);
    for (const r in slim.chats) slim.chats[r] = slim.chats[r].slice(-150);
    slim.log = slim.log.slice(-120);
    fs.writeFileSync(STATE_FILE, JSON.stringify(slim));
  } catch (e) { console.error('[save]', e.message); }
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      s.t = T();
      if (!s.users) s.users = {};
      if (!s.bots || !s.bots.length) s.bots = defaultState().bots;
      for (const b of s.bots) { b.lastDay = todaySH(); b.hist = []; }
      state = Object.assign(defaultState(), s);
      console.log('[load] 已恢复存档');
      return;
    }
  } catch (e) { console.error('[load]', e.message); }
  state = defaultState();
  addLog('服务器首次启动，游戏开服啦！', 'sys');
}

/* ---------------- 价格 ---------------- */
let fetching = false;
async function fetchSina() {
  if (fetching) return;
  fetching = true;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch('https://hq.sinajs.cn/list=hf_GC,fx_susdcny', {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' },
      signal: ctl.signal,
    });
    clearTimeout(to);
    const txt = new TextDecoder('gbk').decode(Buffer.from(await r.arrayBuffer()));
    const gc = txt.match(/hq_str_hf_GC="([^"]*)"/);
    const fx = txt.match(/hq_str_fx_susdcny="([^"]*)"/);
    if (!gc || !fx) throw new Error('bad body');
    const gp = gc[1].split(','), fp = fx[1].split(',');
    const usd = parseFloat(gp[0]);
    const usdcny = parseFloat(fp[1]);
    const quoteDate = (gp[12] || '').trim();
    if (usd > 0 && usdcny > 0) {
      const cnyg = usd / OZ * usdcny;
      const fresh = quoteDate === todaySH(); // 日期不匹配 = 休市旧数据
      state.price = {
        usd, usdcny, cnyg, real: fresh, ts: T(),
        anchor: cnyg, jWalk: state.price.jWalk || 0,
      };
    }
  } catch (e) {
    // 拉不到就保持旧 anchor，走本地模拟
  } finally { fetching = false; }
}

function cardOffsetSum() {
  let off = 0;
  const t = T();
  state.cards = state.cards.filter(c => t < c.start + c.ramp + c.decay + 1000);
  for (const c of state.cards) {
    const e = t - c.start;
    let v;
    if (e <= c.ramp) v = c.peak * (e / c.ramp);
    else if (e <= c.ramp + c.decay) v = c.peak * (1 - (e - c.ramp) / c.decay);
    else v = 0;
    off += v;
  }
  return clamp(off, -0.15, 0.15);
}
function basePrice() {
  const p = state.price;
  return p.cnyg > 0 ? p.cnyg : p.anchor;
}
function effPrice() {
  return basePrice() * (1 + cardOffsetSum() + state.price.jWalk);
}
function sellPriceOf(u) { return effPrice() * (u.armedYellowUntil > T() ? 1.1 : 1); }
function buyPriceOf(u) { return effPrice() * (u.armedBlueUntil > T() ? 0.9 : 1); }

/* ---------------- 等级 / 解锁 ---------------- */
const needXp = l => 100 + (l - 1) * 50;
function unlocks(level) {
  return {
    spot: true,
    short: level >= 5,
    leverage: level >= 10,
    maxL: level >= 20 ? 5 : level >= 15 ? 3 : level >= 10 ? 2 : 1,
  };
}
function unlockDesc(level) {
  const u = unlocks(level);
  const list = ['Lv1 现货买卖'];
  if (u.short) list.push('Lv5 合约做空');
  if (u.leverage) list.push(`Lv10+ 杠杆（当前最高 ${u.maxL} 倍）`);
  return list;
}
function gainXp(u, n) {
  if (n <= 0) return;
  u.xp += n;
  let need = needXp(u.level);
  while (u.xp >= need) {
    u.xp -= need;
    u.level++;
    const reward = 500 * u.level;
    u.cash += reward;
    addLog(`🎉 ${u.name} 升到 Lv.${u.level}，获得升级奖励 ¥${reward}`, 'level');
    need = needXp(u.level);
  }
}

/* ---------------- 权益 ---------------- */
function contractPnl(c) {
  const p = effPrice();
  const geq = (c.margin * c.L) / c.entry;
  let pnl = c.dir === 'long' ? (p - c.entry) * geq : (c.entry - p) * geq;
  return Math.max(pnl, -c.margin);
}
function equity(u) {
  return u.cash + u.grams * effPrice() + u.contracts.reduce((s, c) => s + c.margin + contractPnl(c), 0);
}
function botEquity(b) { return b.cash + b.grams * effPrice(); }

/* ---------------- 技能卡 ---------------- */
function grantCard(u, type) {
  const t = type || CARD_TYPES[ri(0, 4)];
  u.cards[t] = (u.cards[t] || 0) + 1;
  return t;
}
function useCard(u, type, targetToken) {
  if ((u.cards[type] || 0) <= 0) return { ok: false, msg: '你没有这种卡' };
  if (type === 'red' || type === 'green') {
    if (state.cards.filter(c => c.owner === u.token).length >= 2) return { ok: false, msg: '你同时最多挂 2 张方向卡' };
    const peak = (type === 'red' ? 1 : -1) * rnd(1, 10) / 100;
    state.cards.push({ id: rid(), type, owner: u.token, peak, start: T(), ramp: 120000, decay: 120000 });
    const pct = Math.abs(peak * 100).toFixed(1);
    addLog(`${u.name} 打出${CARD_META[type].icon}${CARD_META[type].name}！基线将 ${type === 'red' ? '拉升' : '下砸'} ${pct}%`, 'card');
  } else if (type === 'yellow') {
    u.armedYellowUntil = T() + 600000;
    addLog(`${u.name} 使用黄卡，10 分钟内卖出价 ×1.1`, 'card');
  } else if (type === 'blue') {
    u.armedBlueUntil = T() + 600000;
    addLog(`${u.name} 使用蓝卡，10 分钟内买入价 ×0.9`, 'card');
  } else if (type === 'hand') {
    const target = state.users[targetToken];
    if (!target || target === u) return { ok: false, msg: '选择一个其他玩家' };
    const chance = clamp(0.03 + 0.01 * (u.stealUses || 0), 0, 0.20);
    u.stealUses = Math.min((u.stealUses || 0) + 1, 17);
    u.cards.hand--;
    if (Math.random() < chance) {
      const amount = target.cash >= 100 ? Math.round(target.cash * rnd(0.05, 0.1)) : 0;
      if (amount > 0) {
        target.cash -= amount; u.cash += amount;
        addLog(`🖐️ ${u.name} 对 ${target.name} 行窃成功，偷走 ¥${amount}！（下次成功率 ${(clamp(0.03 + 0.01 * (u.stealUses), 0, 0.2) * 100).toFixed(0)}%）`, 'steal');
        return { ok: true, msg: `得手！偷到 ¥${amount}` };
      }
      addLog(`🖐️ ${u.name} 摸了 ${target.name} 的口袋……一分钱都没有`, 'steal');
      return { ok: true, msg: '对方穷得叮当响，一分没偷到' };
    }
    addLog(`🖐️ ${u.name} 对 ${target.name} 行窃失败！（成功率 ${(chance * 100).toFixed(0)}%）`, 'steal');
    return { ok: true, msg: `没偷到（本次成功率 ${(chance * 100).toFixed(0)}%）` };
  }
  u.cards[type]--;
  return { ok: true, msg: '使用成功' };
}

/* ---------------- 交易 ---------------- */
function trade(u, action, amount) {
  if (!unlocks(u.level).spot) return { ok: false, msg: '等级不足' };
  const n = Number(amount);
  if (!(n > 0)) return { ok: false, msg: '数量不合法' };
  if (action === 'buy') {
    const price = buyPriceOf(u);
    const grams = n / price;
    if (u.cash < n) return { ok: false, msg: '资金不足' };
    u.avg = (u.avg * u.grams + price * grams) / (u.grams + grams);
    u.cash -= n;
    u.grams += grams;
    return { ok: true, msg: `买入 ${grams.toFixed(3)}g @ ¥${price.toFixed(2)}/g` };
  }
  if (action === 'sell') {
    const price = sellPriceOf(u);
    const grams = Math.min(n, u.grams);
    if (grams <= 0) return { ok: false, msg: '没有持仓' };
    const proceeds = grams * price;
    const profit = (price - u.avg) * grams;
    u.cash += proceeds;
    u.grams -= grams;
    if (u.grams < 1e-9) { u.grams = 0; u.avg = 0; }
    gainXp(u, profit > 0 ? Math.round(profit / 100) : 0);
    return { ok: true, msg: `卖出 ${grams.toFixed(3)}g @ ¥${price.toFixed(2)}/g，${profit >= 0 ? '盈利' : '亏损'} ¥${Math.abs(profit).toFixed(2)}` };
  }
  return { ok: false, msg: '未知操作' };
}
function contractOpen(u, dir, L, margin) {
  const un = unlocks(u.level);
  if (dir === 'short' && !un.short) return { ok: false, msg: 'Lv.5 解锁做空' };
  if (L > 1 && !un.leverage) return { ok: false, msg: 'Lv.10 解锁杠杆' };
  if (!(L >= 1 && L <= Math.max(un.maxL, 1))) return { ok: false, msg: `当前最高 ${un.maxL} 倍杠杆` };
  margin = Math.round(Number(margin));
  if (!(margin >= 100)) return { ok: false, msg: '保证金至少 ¥100' };
  if (u.cash < margin) return { ok: false, msg: '资金不足' };
  u.cash -= margin;
  const c = { id: rid(), dir, L, margin, entry: effPrice(), opened: T() };
  u.contracts.push(c);
  addLog(`${u.name} 开${dir === 'long' ? '多' : '空'}单 ${L}x 保证金 ¥${margin} @ ¥${c.entry.toFixed(2)}`, 'trade');
  return { ok: true, msg: '开仓成功' };
}
function contractClose(u, id) {
  const i = u.contracts.findIndex(c => c.id === id);
  if (i < 0) return { ok: false, msg: '找不到该仓位' };
  const c = u.contracts[i];
  const pnl = contractPnl(c);
  u.cash += c.margin + pnl;
  u.contracts.splice(i, 1);
  if (pnl > 0) gainXp(u, Math.round(pnl / 100));
  addLog(`${u.name} 平仓 ${c.dir === 'long' ? '多' : '空'}${c.L}x，${pnl >= 0 ? '盈利' : '亏损'} ¥${Math.abs(pnl).toFixed(2)}`, 'trade');
  return { ok: true, msg: `平仓${pnl >= 0 ? '盈利' : '亏损'} ¥${Math.abs(pnl).toFixed(2)}` };
}
function checkLiquidation() {
  for (const u of Object.values(state.users)) {
    for (const c of [...u.contracts]) {
      const raw = (() => {
        const p = effPrice();
        const geq = (c.margin * c.L) / c.entry;
        return c.dir === 'long' ? (p - c.entry) * geq : (c.entry - p) * geq;
      })();
      if (raw <= -c.margin * 0.9) {
        u.cash += c.margin * 0.1;
        u.contracts.splice(u.contracts.indexOf(c), 1);
        addLog(`💥 ${u.name} 的${c.dir === 'long' ? '多' : '空'}单被强平，损失 ¥${(c.margin * 0.9).toFixed(0)}`, 'warn');
      }
    }
  }
}

/* ---------------- 生活成本 ---------------- */
function chargeDaily() {
  const today = todaySH();
  for (const u of Object.values(state.users)) {
    if (u.lastDay !== today) {
      u.lastDay = today;
      u.cash -= 200;
      addLog(`🧾 ${u.name} 支付今日生活成本 ¥200`, 'sys');
    }
  }
  for (const b of state.bots) {
    if (b.lastDay !== today) {
      b.lastDay = today;
      b.cash -= 200;
    }
  }
}

/* ---------------- AI 专家（无技能卡） ---------------- */
const ma = (arr, n) => arr.slice(-n).reduce((s, x) => s + x, 0) / Math.min(n, arr.length);
function botAct(b) {
  const p = effPrice();
  b.hist.push(p);
  if (b.hist.length > 120) b.hist.shift();
  if (Math.random() > 0.45) return;

  let doBuy = 0, doSell = 0;
  if (b.strategy === 'trend' && b.hist.length >= 40) {
    const f = ma(b.hist, 10), s = ma(b.hist, 40);
    if (f > s * 1.0002) doBuy = b.cash * 0.3;
    else if (f < s * 0.9998) doSell = b.grams;
  } else if (b.strategy === 'meanrev' && b.hist.length >= 40) {
    const m = ma(b.hist, 40);
    if (p < m * 0.997) doBuy = b.cash * 0.25;
    else if (p > m * 1.003) doSell = b.grams * 0.6;
  } else if (b.strategy === 'gambler') {
    if (Math.random() < 0.5) doBuy = b.cash * rnd(0.2, 0.6);
    else doSell = b.grams * rnd(0.3, 1);
  }
  if (doBuy > 100) {
    const price = p, grams = doBuy / price;
    b.avg = (b.avg * b.grams + price * grams) / (b.grams + grams);
    b.cash -= doBuy; b.grams += grams;
  } else if (doSell > 0 && b.grams > 1e-9) {
    const profit = (p - b.avg) * b.grams;
    b.cash += b.grams * p;
    b.grams = 0; b.avg = 0;
  }
  if (b.grams < 1e-9) { b.grams = 0; b.avg = 0; }
}
function checkBots() {
  for (const b of state.bots) {
    if (botEquity(b) < 150) {
      b.failCount++;
      b.cash = Math.round(10000 * (1 + 0.1 * b.failCount));
      b.grams = 0; b.avg = 0;
      addLog(`💀 AI专家「${b.name}」破产（第 ${b.failCount} 次）！全体玩家获得一张随机技能卡，AI 重组资金 ¥${b.cash}`, 'bankrupt');
      for (const u of Object.values(state.users)) {
        const t = grantCard(u);
        addLog(`🎁 ${u.name} 获得 ${CARD_META[t].icon}${CARD_META[t].name}`, 'gift');
      }
    }
  }
}

/* ---------------- 21点 ---------------- */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ s, r });
  for (let i = d.length - 1; i > 0; i--) { const j = ri(0, i); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function handVal(cards) {
  let v = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { v += 11; aces++; }
    else if (['J', 'Q', 'K'].includes(c.r)) v += 10;
    else v += Number(c.r);
  }
  while (v > 21 && aces > 0) { v -= 10; aces--; }
  return v;
}
function bjOf(token) {
  if (!state.bj) state.bj = {};
  if (!state.bj[token]) state.bj[token] = { phase: 'bet', player: [], dealer: [], bet: 0, msg: '' };
  return state.bj[token];
}
function bjAction(token, action, amount) {
  const u = state.users[token];
  const g = bjOf(token);
  if (action === 'bet') {
    if (g.phase !== 'bet' && g.phase !== 'done') return { ok: false, msg: '本局进行中' };
    const bet = Math.round(Number(amount));
    if (!(bet >= 50 && bet <= 2000)) return { ok: false, msg: '下注 ¥50 ~ ¥2000' };
    if (u.cash < bet) return { ok: false, msg: '资金不足' };
    u.cash -= bet;
    g.deck = newDeck();
    g.bet = bet;
    g.player = [g.deck.pop(), g.deck.pop()];
    g.dealer = [g.deck.pop()];
    g.phase = 'player';
    g.result = '';
    if (handVal(g.player) === 21) return bjStand(token, true);
    g.msg = '要牌还是停牌？';
    return { ok: true };
  }
  if (action === 'hit') {
    if (g.phase !== 'player') return { ok: false, msg: '不是要牌阶段' };
    g.player.push(g.deck.pop());
    const v = handVal(g.player);
    if (v > 21) { g.phase = 'done'; g.result = 'bust'; u.xp += 0; return bjSettle(token); }
    if (v === 21) return bjStand(token);
    return { ok: true };
  }
  if (action === 'double') {
    if (g.phase !== 'player' || g.player.length !== 2) return { ok: false, msg: '只能在前两张加倍' };
    if (u.cash < g.bet) return { ok: false, msg: '资金不足，无法加倍' };
    u.cash -= g.bet;
    g.bet *= 2;
    g.player.push(g.deck.pop());
    if (handVal(g.player) > 21) { g.phase = 'done'; g.result = 'bust'; return bjSettle(token); }
    return bjStand(token);
  }
  if (action === 'stand') {
    if (g.phase !== 'player') return { ok: false, msg: '不是停牌阶段' };
    return bjStand(token);
  }
  return { ok: false, msg: '未知操作' };
}
function bjStand(token, auto) {
  const g = bjOf(token);
  if (g.phase !== 'player' && !auto) return { ok: false, msg: '状态错误' };
  g.phase = 'done';
  while (handVal(g.dealer) < 17) g.dealer.push(g.deck.pop());
  return bjSettle(token);
}
function bjSettle(token) {
  const u = state.users[token];
  const g = bjOf(token);
  const pv = handVal(g.player), dv = handVal(g.dealer);
  let net = 0, text = '';
  const bj = g.player.length === 2 && pv === 21;
  if (pv > 21) { text = '爆牌，输了'; }
  else if (bj && dv !== 21) { net = Math.round(g.bet * 2.5); text = 'BLACKJACK！赔率 3:2'; u.xp += 8; }
  else if (dv > 21 || pv > dv) { net = g.bet * 2; text = '你赢了！'; u.xp += 5; }
  else if (pv === dv) { net = g.bet; text = '平局，退回注金'; }
  else { text = '庄家赢了'; }
  if (net > 0) u.cash += net;
  g.phase = 'done';
  g.msg = `${text}（庄 ${dv} 点 / 你 ${pv} 点）`;
  if (net > g.bet) addLog(`🃏 ${u.name} 在21点赢下 ¥${net - g.bet}`, 'casino');
  return { ok: true };
}

/* ---------------- 轮盘 ---------------- */
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
function roulette(token, type, amount, num) {
  const u = state.users[token];
  const bet = Math.round(Number(amount));
  if (!(bet >= 10 && bet <= 2000)) return { ok: false, msg: '下注 ¥10 ~ ¥2000' };
  if (u.cash < bet) return { ok: false, msg: '资金不足' };
  const n = ri(0, 36);
  let win = false, payout = 0, label = '';
  if (type === 'red') { win = RED.has(n); payout = 2; label = '红'; }
  else if (type === 'black') { win = n !== 0 && !RED.has(n); payout = 2; label = '黑'; }
  else if (type === 'odd') { win = n !== 0 && n % 2 === 1; payout = 2; label = '单'; }
  else if (type === 'even') { win = n !== 0 && n % 2 === 0; payout = 2; label = '双'; }
  else if (type === 'low') { win = n >= 1 && n <= 18; payout = 2; label = '1-18'; }
  else if (type === 'high') { win = n >= 19; payout = 2; label = '19-36'; }
  else if (type === 'num') {
    num = Number(num);
    if (!(num >= 0 && num <= 36)) return { ok: false, msg: '选 0-36 的号码' };
    win = n === num; payout = 36; label = `数字 ${num}`;
  } else return { ok: false, msg: '未知玩法' };
  u.cash -= bet;
  let got = 0;
  if (win) { got = bet * payout; u.cash += got; u.xp += 2; }
  if (win && payout > 2) addLog(`🎰 ${u.name} 轮盘押中 ${label}，赢 ¥${got - bet}！`, 'casino');
  return { ok: true, n, win, got, msg: `开出 ${n}（${n === 0 ? '绿' : RED.has(n) ? '红' : '黑'}）` };
}

/* ---------------- 聊天 / 贴吧 ---------------- */
function chatPost(room, from, text) {
  if (!state.chats[room]) return null;
  const m = { id: state.seq++, t: T(), from, text: String(text).slice(0, 300) };
  state.chats[room].push(m);
  if (state.chats[room].length > 200) state.chats[room].splice(0, state.chats[room].length - 200);
  return m;
}
const RUMORS = [
  ['劲爆：某央行连夜增持黄金，明天必涨！', '内部消息灵通人士'],
  ['听说今晚有大户要砸盘清仓，大家快跑', '热心群友'],
  ['突发：全球最大金矿宣布停产检修！', '财经快讯bot'],
  ['刚从交易所朋友圈看到：主力正在悄悄吸筹', '神秘的微笑'],
  ['重磅分析：黄金已经见顶，赶紧清仓保平安', '首席瞎蒙师'],
  ['小道消息：下个月金价要翻倍，现在不买等什么', '财富自由倒计时'],
  ['辟谣！之前说要涨的都是骗子，马上要崩了', '理性合伙人'],
];
const RUMOR_REPLIES = [
  '又来？上次信你的话我亏了三个月生活费',
  '楼主是不是庄家派来的托？',
  '先立个帖，明天回来看打脸',
  '真的假的？我已经全仓了怎么办',
  '建议把楼主的话反着听，稳赚',
  '蹲一个后续',
];
function fakeForumTick() {
  if (Math.random() < 0.85) {
    const [title, author] = RUMORS[ri(0, RUMORS.length - 1)];
    const th = { id: state.seq++, title, author, t: T(), fake: true, posts: [{ author, t: T(), content: '如题。信不信由你们，反正我是押上了全部身家。' }] };
    state.threads.unshift(th);
    if (state.threads.length > 60) state.threads.pop();
    broadcast('threads', { action: 'new', id: th.id });
  }
  // 偶尔水帖回复
  if (state.threads.length && Math.random() < 0.7) {
    const th = state.threads[ri(0, Math.min(5, state.threads.length - 1))];
    th.posts.push({ author: RUMOR_REPLIES && '路人鸽友' + ri(100, 999), t: T(), content: RUMOR_REPLIES[ri(0, RUMOR_REPLIES.length - 1)] });
  }
}

/* ---------------- SSE ---------------- */
const clients = new Set();
function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { }
}
function broadcast(event, data) {
  for (const c of clients) sseWrite(c.res, event, data);
}
function privateOf(u) {
  return {
    name: u.name,
    cash: Math.round(u.cash * 100) / 100,
    grams: Math.round(u.grams * 1000) / 1000,
    avg: Math.round(u.avg * 100) / 100,
    cards: u.cards,
    xp: u.xp, level: u.level,
    xpNeed: needXp(u.level),
    unlocks: unlocks(u.level),
    unlockDesc: unlockDesc(u.level),
    contracts: u.contracts.map(c => ({ ...c, pnl: Math.round(contractPnl(c) * 100) / 100 })),
    armedYellow: Math.max(0, u.armedYellowUntil - T()),
    armedBlue: Math.max(0, u.armedBlueUntil - T()),
    stealUses: u.stealUses || 0,
    equity: Math.round(equity(u) * 100) / 100,
  };
}
function tickPayload(token) {
  const p = effPrice();
  return {
    t: T(),
    price: {
      cnyg: Math.round(p * 100) / 100,
      usd: state.price.usd ? Math.round(state.price.usd * 100) / 100 : 0,
      usdcny: state.price.usdcny ? Math.round(state.price.usdcny * 10000) / 10000 : 0,
      real: state.price.real,
    },
    cards: state.cards.map(c => ({ type: c.type, peak: c.peak, start: c.start, ramp: c.ramp, decay: c.decay })),
    log: state.log.slice(-40),
    users: Object.values(state.users).map(u => ({ token: u.token, name: u.name, level: u.level, equity: Math.round(equity(u) * 100) / 100 }))
      .sort((a, b) => b.equity - a.equity),
    bots: state.bots.map(b => ({ name: b.name, strategy: b.strategy, failCount: b.failCount, equity: Math.round(botEquity(b) * 100) / 100 })),
    you: state.users[token] ? privateOf(state.users[token]) : null,
  };
}

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function sendJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}
function userByReq(req, body) {
  const token = (req.headers['x-token'] || body.token || '').toString();
  return { token, u: state.users[token] || null };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    /* 静态文件 */
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      let file = p === '/' ? '/index.html' : p;
      const fp = path.join(PUB, path.normalize(file).replace(/^([.][.][/\\])+/, ''));
      if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return fs.createReadStream(fp).pipe(res);
      }
      res.writeHead(404); return res.end('404');
    }

    /* SSE 数据流 */
    if (p === '/api/stream' && req.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':ok\n\n');
      const c = { res, token };
      clients.add(c);
      sseWrite(res, 'tick', tickPayload(token));
      const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch (e) { } }, 15000);
      req.on('close', () => { clearInterval(hb); clients.delete(c); });
      return;
    }

    const body = await readBody(req);
    const { token, u } = userByReq(req, body);

    if (p === '/api/join' && req.method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 12);
      if (!name) return sendJSON(res, { ok: false, msg: '起个名字吧' });
      let tk = rid();
      const isNew = !body.token || !state.users[body.token];
      if (!isNew) { tk = body.token; state.users[tk].name = name; }
      else {
        state.users[tk] = {
          token: tk, name, cash: 10000, grams: 0, avg: 0,
          cards: { red: 0, green: 0, yellow: 0, blue: 0, hand: 1 },
          xp: 0, level: 1, stealUses: 0, contracts: [],
          armedYellowUntil: 0, armedBlueUntil: 0,
          lastDay: todaySH(), created: T(),
        };
        addLog(`👋 新玩家「${name}」入场，初始资金 ¥10000`, 'sys');
      }
      return sendJSON(res, { ok: true, token: tk, you: privateOf(state.users[tk]) });
    }

    if (!u) return sendJSON(res, { ok: false, msg: '请先加入游戏', needJoin: true }, 401);

    if (p === '/api/state') return sendJSON(res, { ok: true, you: privateOf(u) });

    if (p === '/api/trade' && req.method === 'POST') {
      const r = trade(u, body.action, body.amount);
      return sendJSON(res, r);
    }
    if (p === '/api/contract' && req.method === 'POST') {
      const r = body.action === 'open'
        ? contractOpen(u, body.dir, Number(body.L) || 1, body.margin)
        : contractClose(u, body.id);
      return sendJSON(res, r);
    }
    if (p === '/api/card' && req.method === 'POST') {
      const r = useCard(u, body.type, body.target);
      return sendJSON(res, r);
    }
    if (p === '/api/chat' && req.method === 'POST') {
      const m = chatPost(String(body.room || '大厅'), u.name, body.text);
      if (!m) return sendJSON(res, { ok: false, msg: '房间不存在' });
      broadcast('chat', { room: body.room, m });
      return sendJSON(res, { ok: true });
    }
    if (p === '/api/chat' && req.method === 'GET') {
      const room = url.searchParams.get('room') || '大厅';
      return sendJSON(res, { ok: true, list: (state.chats[room] || []).slice(-80) });
    }
    if (p === '/api/threads' && req.method === 'GET') {
      return sendJSON(res, {
        ok: true,
        list: state.threads.map(t => ({ id: t.id, title: t.title, author: t.author, t: t.t, replies: t.posts.length - 1, fake: !!t.fake })),
      });
    }
    if (p === '/api/thread' && req.method === 'GET') {
      const th = state.threads.find(t => t.id === Number(url.searchParams.get('id')));
      if (!th) return sendJSON(res, { ok: false, msg: '帖子不存在' }, 404);
      return sendJSON(res, { ok: true, thread: th });
    }
    if (p === '/api/thread' && req.method === 'POST') {
      const title = String(body.title || '').trim().slice(0, 40);
      const content = String(body.content || '').trim().slice(0, 1000);
      if (!title || !content) return sendJSON(res, { ok: false, msg: '标题和内容都要写' });
      const th = { id: state.seq++, title, author: u.name, t: T(), fake: false, posts: [{ author: u.name, t: T(), content }] };
      state.threads.unshift(th);
      broadcast('threads', { action: 'new', id: th.id });
      return sendJSON(res, { ok: true, id: th.id });
    }
    if (p === '/api/reply' && req.method === 'POST') {
      const th = state.threads.find(t => t.id === Number(body.id));
      if (!th) return sendJSON(res, { ok: false, msg: '帖子不存在' });
      const content = String(body.content || '').trim().slice(0, 1000);
      if (!content) return sendJSON(res, { ok: false, msg: '说点什么吧' });
      th.posts.push({ author: u.name, t: T(), content });
      return sendJSON(res, { ok: true });
    }
    if (p === '/api/bj' && req.method === 'POST') {
      const r = bjAction(token, body.action, body.amount);
      const g = bjOf(token);
      return sendJSON(res, {
        ...r,
        table: {
          phase: g.phase, bet: g.bet, msg: g.msg,
          player: g.player, dealer: g.phase === 'done' ? g.dealer : g.dealer.map((c, i) => i === 0 ? c : { s: '?', r: '?' }),
          cash: Math.round(u.cash * 100) / 100,
          xp: u.xp, level: u.level,
        },
      });
    }
    if (p === '/api/roulette' && req.method === 'POST') {
      const r = roulette(token, body.type, body.amount, body.num);
      return sendJSON(res, { ...r, cash: Math.round(u.cash * 100) / 100 });
    }
    return sendJSON(res, { ok: false, msg: '未知接口' }, 404);
  } catch (e) {
    console.error('[http]', e);
    try { sendJSON(res, { ok: false, msg: '服务器内部错误' }, 500); } catch (_) { }
  }
});

/* ---------------- 主循环 ---------------- */
let lastBotTick = 0, lastSave = 0, lastFake = 0;
function loop() {
  try {
    const t = T();
    // 行情：每 5s 拉新浪
    if (t - (state.price.ts || 0) > 5000) fetchSina();
    // 微抖动：即使休市也让游戏有生命
    state.price.jWalk = clamp(state.price.jWalk * 0.995 + gauss() * 0.00018, -0.0018, 0.0018);
    const p = effPrice();
    state.hist.push({ t, p: Math.round(p * 100) / 100 });
    if (state.hist.length > 3600) state.hist.shift();

    chargeDaily();
    checkLiquidation();
    if (t - lastBotTick > 2000) { lastBotTick = t; for (const b of state.bots) botAct(b); checkBots(); }
    if (t - lastFake > 300000) { lastFake = t; fakeForumTick(); }
    if (t - lastSave > 15000) { lastSave = t; saveState(); }

    for (const c of clients) sseWrite(c.res, 'tick', tickPayload(c.token));
  } catch (e) { console.error('[loop]', e); }
}

loadState();
setInterval(loop, 1000);
process.on('SIGINT', () => { saveState(); process.exit(0); });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`金融肉鸽 demo 已启动: http://127.0.0.1:${PORT}`);
});
