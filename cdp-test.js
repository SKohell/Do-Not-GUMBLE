/* CDP 驱动 headless Chrome 做端到端验证 + 截图（无第三方依赖） */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:8787';
const TOKEN = process.argv[2] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=old', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=D:\\戒赌\\.chrome-test',
    '--window-size=1500,940',
    'about:blank',
  ], { stdio: 'ignore' });
  await sleep(2500);

  const targets = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find(t => t.type === 'page');
  if (!page) { console.error('no page target'); chrome.kill(); return; }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaljs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  const errors = [];
  // 捕获页面异常与控制台错误
  send('Runtime.evaluate', { expression: '0' }); // keepalive

  await send('Page.navigate', { url: `${BASE}/#token=${TOKEN}&debug=1` });
  await sleep(6000);

  const boot = await evaljs('document.body.dataset.boot || ""');
  const name = await evaljs('document.getElementById("tbName").textContent');
  const price = await evaljs('document.getElementById("priceBig").textContent');
  const ticks = await evaljs('(typeof dbg!=="undefined"?dbg.filter(x=>x==="tick").length:-1)');
  const histLen = await evaljs('hist.length');
  const logN = await evaljs('document.querySelectorAll(".log-item").length');
  const lbN = await evaljs('document.querySelectorAll("#lbList li").length');
  const botsTxt = await evaljs('document.getElementById("botList").textContent.slice(0,80)');
  const posTxt = await evaljs('document.getElementById("tPos").textContent');
  console.log(JSON.stringify({ boot, name, price, ticks, histLen, logN, lbN, posTxt, botsTxt }, null, 1));

  // 逐 tab 截图
  const shot = async file => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  };
  await shot('D:\\戒赌\\shot_main.png');
  await evaljs('document.querySelector(\'.tab[data-tab="casino"]\').click()');
  await sleep(600);
  await shot('D:\\戒赌\\shot_casino.png');
  await evaljs('document.querySelector(\'.tab[data-tab="forum"]\').click()');
  await sleep(800);
  await shot('D:\\戒赌\\shot_forum.png');
  await evaljs('document.querySelector(\'.tab[data-tab="chat"]\').click()');
  await sleep(600);
  await shot('D:\\戒赌\\shot_chat.png');

  // 互动冒烟测试：买入 → 用卡 → 21点下注
  const smoke = await evaljs(`(async () => {
    const out = [];
    const api = (p, b) => fetch(p, { method: b ? 'POST' : 'GET', headers: { 'x-token': token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
    document.getElementById('buyAmt').value = '500';
    document.getElementById('buyBtn').click();
    await new Promise(r => setTimeout(r, 300));
    out.push('buy done');
    const bj = await api('/api/bj', { action: 'bet', amount: 50 });
    out.push('bj:' + (bj.ok ? bj.table.phase : bj.msg));
    const rl = await api('/api/roulette', { type: 'red', amount: 20 });
    out.push('rl:' + (rl.ok ? 'n=' + rl.n + ' win=' + rl.win : rl.msg));
    const th = await api('/api/thread', { title: '冒烟测试帖', content: '自动测试内容' });
    out.push('thread:' + th.ok);
    return out.join(' | ') + ' | errors:' + errors.length;
  })()`);
  console.log('SMOKE:', smoke);

  await sleep(500);
  await evaljs('document.querySelector(\'.tab[data-tab="main"]\').click()');
  await sleep(400);
  await shot('D:\\戒赌\\shot_after.png');

  ws.close();
  chrome.kill();
  console.log('DONE');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
