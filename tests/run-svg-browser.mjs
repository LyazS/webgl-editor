import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let binary;
for (const path of candidates)
    try {
        await access(path);
        binary = path;
        break;
    }
    catch {
    }
if (!binary)
    throw new Error('Set CHROME_BIN to a Chromium/Chrome executable');
const profile = await mkdtemp(join(tmpdir(), 'svg-render-test-')), server = await createServer({ server: { host: '127.0.0.1', port: 5189, strictPort: true }, optimizeDeps: { noDiscovery: true, include: ['wasmoon', 'vue'] } });
await server.listen();
const address = server.httpServer.address(), url = `http://127.0.0.1:${address.port}/tests/svg-browser.html`;
const browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader', url], { stdio: 'ignore' });
let socket;
try {
    let port;
    for (let i = 0; i < 100; i++) {
        try {
            port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
            break;
        }
        catch {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    if (!port)
        throw new Error('Chrome did not expose a debugging port');
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(tabs.find(tab => tab.type === 'page' && tab.url.startsWith('http://127.0.0.1:')).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let seq = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Network.loadingFailed')
            console.error('Network failure:', JSON.stringify(message.params));
        if (message.method === 'Runtime.exceptionThrown')
            console.error('Browser exception:', JSON.stringify(message.params));
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
            console.error('Browser console:', JSON.stringify(message.params.args));
        if (message.id) {
            const p = pending.get(message.id);
            pending.delete(message.id);
            message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
        }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.enable');
    console.log('Browser tests:', url);
    let result;
    for (let i = 0; i < 300; i++) {
        const r = await send('Runtime.evaluate', { expression: 'window.svgTestResults', returnByValue: true });
        if (r.result?.value) {
            result = r.result.value;
            break;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    if (!result) {
        console.error(await send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,state:document.readyState,body:document.body.innerHTML,resources:performance.getEntriesByType("resource").map(r=>r.name)})', returnByValue: true }));
        throw new Error('SVG browser tests timed out');
    }
    const waitFor = async (expression) => {
        for (let i = 0; i < 200; i++) {
            const response = await send('Runtime.evaluate', { expression, returnByValue: true });
            if (response.result?.value)
                return response.result.value;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Browser condition timed out: ${expression}`);
    };
    try {
        await send('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
        await waitFor('document.querySelector(".status-pill")?.textContent.includes("Frame")');
        await send('Runtime.evaluate', { expression: 'document.querySelector("select").value="vector";document.querySelector("select").dispatchEvent(new Event("change",{bubbles:true}));' });
        await waitFor('document.querySelector(".status-pill")?.textContent.includes("Frame") && parseInt(document.querySelector(".graph-stats").textContent)>1');
        await send('Runtime.evaluate', { expression: 'window.svgLossExtension=document.querySelector("canvas").getContext("webgl2").getExtension("WEBGL_lose_context");window.svgLossExtension.loseContext();' });
        await waitFor('document.querySelector(".status-pill")?.textContent.includes("context lost")');
        await send('Runtime.evaluate', { expression: 'window.svgLossExtension.restoreContext();' });
        await waitFor('document.querySelector(".status-pill")?.textContent.includes("Frame")');
        result.push({ name: 'Editor SVG showcase and context restoration', pass: true });
        if (process.env.SVG_SCREENSHOT) {
            const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
            await writeFile(process.env.SVG_SCREENSHOT, Buffer.from(shot.data, 'base64'));
        }
    }
    catch (error) {
        result.push({ name: 'Editor SVG showcase and context restoration', pass: false, error: String(error) });
    }
    console.log(`${result.filter(r => r.pass).length}/${result.length} browser checks passed`);
    if (process.env.SVG_TEST_VERBOSE)
        console.log(JSON.stringify(result, null, 2));
    else
        for (const item of result.filter(r => !r.pass))
            console.error(JSON.stringify(item, null, 2));
    if (result.some(r => !r.pass))
        process.exitCode = 1;
}
finally {
    socket?.close();
    browser.kill();
    await server.close();
    await new Promise(r => setTimeout(r, 500));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
