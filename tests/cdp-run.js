/* node tests/cdp-run.js <url> <steps.json> [outDir] — drive headless Chrome over the DevTools
   protocol (Node ≥22 global WebSocket, no deps). Steps run in order:
     {"wait": "<js expr>", "timeout": 60000}   poll until truthy
     {"eval": "<js expr>", "print": true}      evaluate (promises awaited), optionally print the value
     {"delay": 500}
     {"shot": "name.png", "full": false}        screenshot into outDir
   Console errors and uncaught exceptions are printed as they happen. Exit code 1 on any failure. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [url, stepsFile, outDir = '.'] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  let failed = false;
  const done = code => {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    // Chrome can still be flushing its profile for a moment after the kill — never fail a run on cleanup
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
    process.exit(code);
  };
  try {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      await wait(150);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) {}
    }
    if (!target) throw new Error('chrome did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') console.log('  [page exception]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) console.log(`  [console.${m.params.type}]`, m.params.args.map(a => a.value ?? a.description).join(' '));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') console.log('  [log]', m.params.entry.text, m.params.entry.url || '');
    };
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    for (const st of steps) {
      if (st.wait) {
        const t0 = Date.now(), limit = st.timeout || 60000;
        let v;
        while (!(v = await evaluate(st.wait).catch(() => false))) {
          if (Date.now() - t0 > limit) throw new Error('timed out waiting for: ' + st.wait);
          await wait(250);
        }
      }
      if (st.eval) { const v = await evaluate(st.eval); if (st.print) console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1)); }
      if (st.delay) await wait(st.delay);
      if (st.shot) {
        const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!st.full });
        fs.writeFileSync(path.join(outDir, st.shot), Buffer.from(r.data, 'base64'));
        console.log('  shot', st.shot);
      }
    }
    ws.close();
  } catch (e) {
    console.log('cdp-run FAILED:', e.message);
    failed = true;
  }
  done(failed ? 1 : 0);
})();
