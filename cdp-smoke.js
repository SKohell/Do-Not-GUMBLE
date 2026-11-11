/* UI 交互冒烟：点击各按钮并捕获页面异常 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334, BASE = 'http://127.0.0.1:8787';
const TOKEN = process.argv[2] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJSON(url) { return new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej); }); }
async function main() {
  const chrome = spawn(CHROME, ['--headless=old', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--user-data-dir=D:\\戒赌\\.chrome-test2', '--window-size=1500,940', 'about:blank'], { stdio: 'ignore' });
  await sleep(2200);
  const page = (await getJSON(`http://127.0.0.1:${PORT}/json/list`)).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map(); const pageErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.text + ' ' + ((m.params.exceptionDetails.exception || {}).description || '').split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push('console.error: ' + JSON.stringify(m.params.args).slice(0, 200));
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evaljs = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}/#token=${TOKEN}` });
  await sleep(5000);
  const report = [];
  report.push(await evaljs(`(async()=>{
    const out=[]; const step=async(n,f)=>{try{out.push(n+':'+await f())}catch(e){out.push(n+':ERR '+e.message)}};
    await step('buy', async()=>{ document.getElementById('buyAmt').value='300'; document.getElementById('buyBtn').click(); await new Promise(r=>setTimeout(r,400)); return document.getElementById('tPos').textContent+'g'; });
    await step('sell', async()=>{ document.getElementById('sellAmt').value='1'; document.getElementById('sellBtn').click(); await new Promise(r=>setTimeout(r,400)); return document.getElementById('toast').textContent; });
    await step('chat', async()=>{ document.querySelector('.tab[data-tab="chat"]').click(); await new Promise(r=>setTimeout(r,300)); document.getElementById('chatInput').value='冒烟测试聊天'; document.getElementById('chatSend').click(); await new Promise(r=>setTimeout(r,500)); const l=[...document.querySelectorAll('.chat-msg .bubble')]; return l.length? l[l.length-1].textContent : 'empty'; });
    await step('bj', async()=>{ document.querySelector('.tab[data-tab="casino"]').click(); await new Promise(r=>setTimeout(r,300)); document.getElementById('bjBetBtn').click(); await new Promise(r=>setTimeout(r,400)); return 'phase-buttons hit=' + !document.getElementById('bjHitBtn').disabled; });
    await step('rl', async()=>{ document.querySelector('.rl-bet[data-type="red"]').click(); document.getElementById('rlSpin').click(); await new Promise(r=>setTimeout(r,500)); return document.getElementById('rlResult').textContent.trim().slice(0,30); });
    await step('forum', async()=>{ document.querySelector('.tab[data-tab="forum"]').click(); await new Promise(r=>setTimeout(r,600)); return 'threads=' + document.querySelectorAll('.ft-item').length; });
    return out.join(' | ');
  })()`));
  report.push('pageErrors: ' + (pageErrors.length ? pageErrors.join(' ;; ') : 'NONE'));
  console.log(report.join('\n'));
  ws.close(); chrome.kill();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
