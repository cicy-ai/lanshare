#!/usr/bin/env node
// lanshare — share a directory over HTTP on the LAN with an auto-generated
// directory index, optional HTTP Basic auth, and LAN IP discovery.
// Zero dependencies (Node >= 18).
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const DB_DIR = path.join(process.env.CICY_HOME || path.join(os.homedir(), 'cicy-ai'), 'db');
const STATE_FILE = path.join(DB_DIR, 'lanshare.json');

const HELP = `Usage:
  lanshare serve <dir> [options]   Share <dir> over HTTP with a directory index
  lanshare note [file] [options]   Shared LAN notebook: one full-page textarea, autosaved to [file]
  lanshare ip [--json]             Print LAN (private IPv4) addresses
  lanshare status [--json]         Show background servers started with --daemon
  lanshare stop [serve|note]       Stop background server(s)
  lanshare --help

Options for serve / note:
  -p, --port <n>        Listen port (default: serve 8080, note 8081; 0 = random free port)
  -H, --host <addr>     Bind address (default 0.0.0.0 = all interfaces)
  -a, --auth <u:p>      Require HTTP Basic auth (user:password)
  -d, --daemon          Run in the background; pid/url saved to ~/cicy-ai/db/lanshare.json
      --no-hidden       serve only: hide dotfiles from the index and refuse to serve them
      --json            Print startup info as JSON

Examples:
  lanshare serve ~/Downloads
  lanshare serve ./dist -p 9000 -a admin:secret
  lanshare serve /data --daemon && lanshare status
  lanshare note -a team:pass          # notebook saved to ~/cicy-ai/db/lanshare-note.txt
  lanshare note ~/notes/lan.md -p 9001 --daemon
  lanshare ip
`;

// ── arg parsing ────────────────────────────────────────────────────────────
function parse(args) {
  const o = { _: [], port: null, host: '0.0.0.0', auth: null, daemon: false, hidden: true, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => { if (i + 1 >= args.length) fail(`${a} needs a value`); return args[++i]; };
    if (a === '-p' || a === '--port') o.port = Number(next());
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '-H' || a === '--host') o.host = next();
    else if (a.startsWith('--host=')) o.host = a.slice(7);
    else if (a === '-a' || a === '--auth') o.auth = next();
    else if (a.startsWith('--auth=')) o.auth = a.slice(7);
    else if (a === '-d' || a === '--daemon') o.daemon = true;
    else if (a === '--no-hidden') o.hidden = false;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
    else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else o._.push(a);
  }
  if (o.port !== null && (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535)) fail(`invalid port ${o.port}`);
  if (o.auth !== null && !o.auth.includes(':')) fail('--auth must be user:password');
  return o;
}

function fail(msg, code = 2) {
  process.stderr.write(`lanshare: ${msg}\n`);
  process.exit(code);
}

// ── LAN IPs ────────────────────────────────────────────────────────────────
function lanIps() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ iface, address: a.address, private: isPrivate(a.address) });
    }
  }
  // private LAN addresses first, then anything else
  return out.sort((x, y) => Number(y.private) - Number(x.private));
}
function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// ── HTTP server ────────────────────────────────────────────────────────────
const MIME = {
  '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.webm': 'video/webm',
  '.webp': 'image/webp', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.wav': 'audio/wav', '.xml': 'application/xml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function resolveInsideRoot(root, url) {
  let decoded;
  try { decoded = decodeURIComponent(url.split(/[?#]/, 1)[0]); } catch { return null; }
  const rel = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = path.resolve(root, rel);
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return candidate;
  return null;
}

function hasHiddenSegment(root, target) {
  return path.relative(root, target).split(path.sep).some((s) => s.startsWith('.'));
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(1)} ${u[i]}`;
}

function indexPage(root, dir, showHidden) {
  const rel = path.relative(root, dir);
  const urlPath = '/' + rel.split(path.sep).filter(Boolean).map(encodeURIComponent).join('/') + (rel ? '/' : '');
  const entries = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!showHidden && e.name.startsWith('.')) continue;
    let st;
    try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
    entries.push({ name: e.name, dir: st.isDirectory(), size: st.size, mtime: st.mtime });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  const rows = [];
  if (rel) rows.push('<tr><td><a href="../">📁 ../</a></td><td>—</td><td>—</td></tr>');
  for (const e of entries) {
    const href = encodeURIComponent(e.name) + (e.dir ? '/' : '');
    rows.push(`<tr><td><a href="${href}">${e.dir ? '📁' : '📄'} ${esc(e.name)}${e.dir ? '/' : ''}</a></td><td>${e.dir ? '—' : fmtSize(e.size)}</td><td>${esc(e.mtime.toISOString().replace('T', ' ').slice(0, 19))}</td></tr>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Index of ${esc(urlPath)}</title><style>body{font:15px system-ui,sans-serif;margin:32px;color:#202124}h1{font-size:20px;word-break:break-all}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #ddd}a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}td:nth-child(2){width:110px;white-space:nowrap}td:nth-child(3){width:180px;color:#666;white-space:nowrap}</style></head><body><h1>Index of ${esc(urlPath)}</h1><table><thead><tr><th>Name</th><th>Size</th><th>Modified (UTC)</th></tr></thead><tbody>${rows.join('')}</tbody></table></body></html>`;
}

function checkAuth(req, res, auth) {
  if (!auth) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const given = Buffer.from(h.slice(6), 'base64').toString('utf8');
    if (given === auth) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="lanshare", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Unauthorized');
  return false;
}

function createServer(root, { auth, showHidden }) {
  return http.createServer((req, res) => {
    const text = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method Not Allowed');
    if (!checkAuth(req, res, auth)) return;
    const target = resolveInsideRoot(root, req.url || '/');
    if (!target) return text(403, 'Forbidden');
    if (!showHidden && hasHiddenSegment(root, target)) return text(404, 'Not Found');
    let st;
    try { st = fs.statSync(target); } catch { return text(404, 'Not Found'); }
    if (st.isDirectory()) {
      const p = req.url.split(/[?#]/, 1)[0];
      if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); return res.end(); }
      let html;
      try { html = indexPage(root, target, showHidden); } catch (e) { return text(500, e.message); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if (!st.isFile()) return text(404, 'Not Found');
    const headers = { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size > 0) {
      let start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
  });
}

// ── state file for --daemon ────────────────────────────────────────────────
function readState() { try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return s && typeof s === 'object' && !('pid' in s) ? s : {}; } catch { return {}; } }
function writeState(mode, entry) {
  const s = readState();
  if (entry) s[mode] = entry; else delete s[mode];
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// ── notebook server ────────────────────────────────────────────────────────
function notePage(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#1e1e1e;color:#ddd}
#bar{display:flex;gap:12px;align-items:center;padding:6px 12px;background:#2b2b2b;color:#aaa;font:13px system-ui,sans-serif;border-bottom:1px solid #444}
#bar b{color:#eee}#st{margin-left:auto}#st.err{color:#f66}#st.ok{color:#8c8}
textarea{flex:1;width:100%;box-sizing:border-box;margin:0;padding:14px;border:0;outline:0;resize:none;background:#1e1e1e;color:#ddd;font:inherit;tab-size:4}
</style></head><body><div id="bar"><b>${esc(title)}</b><span id="sz"></span><span id="st">loading…</span></div><textarea id="t" spellcheck="false" placeholder="Type here — saved automatically, shared with everyone on the LAN."></textarea>
<script>
const t=document.getElementById('t'),st=document.getElementById('st'),sz=document.getElementById('sz');
let etag=null,dirty=false,timer=null,saving=false;
const setSt=(m,c)=>{st.textContent=m;st.className=c||''};
async function load(){try{const r=await fetch('/api/note',{cache:'no-store'});if(!r.ok)throw new Error(r.status);const e=r.headers.get('etag');if(e===etag)return;const txt=await r.text();if(dirty)return;const s=t.selectionStart,d=t.selectionEnd;t.value=txt;t.setSelectionRange(s,d);etag=e;sz.textContent=txt.length+' chars';setSt('synced','ok')}catch(e){setSt('offline: '+e.message,'err')}}
async function save(){if(saving||!dirty)return;saving=true;const v=t.value;try{const r=await fetch('/api/note',{method:'PUT',headers:{'content-type':'text/plain; charset=utf-8'},body:v});if(!r.ok)throw new Error(r.status);etag=r.headers.get('etag');if(t.value===v)dirty=false;sz.textContent=v.length+' chars';setSt(dirty?'unsaved':'saved','ok')}catch(e){setSt('save failed: '+e.message,'err')}finally{saving=false;if(dirty)schedule()}}
function schedule(){clearTimeout(timer);timer=setTimeout(save,400)}
t.addEventListener('input',()=>{dirty=true;setSt('unsaved');schedule()});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();clearTimeout(timer);save()}
if(e.key==='Tab'&&document.activeElement===t){e.preventDefault();const s=t.selectionStart,d=t.selectionEnd;t.setRangeText('\\t',s,d,'end');t.dispatchEvent(new Event('input'))}});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
load();setInterval(()=>{if(!dirty&&!saving)load()},2000);
</script></body></html>`;
}

function createNoteServer(file, { auth, title }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  const etagOf = (st) => `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  return http.createServer((req, res) => {
    const text = (code, body, extra = {}) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...extra }); res.end(body); };
    if (!checkAuth(req, res, auth)) return;
    const p = (req.url || '/').split(/[?#]/, 1)[0];
    if (p === '/api/note') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        let st, body;
        try { st = fs.statSync(file); body = fs.readFileSync(file, 'utf8'); } catch (e) { return text(500, e.message); }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ETag: etagOf(st) });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const chunks = []; let size = 0;
        req.on('data', (c) => { size += c.length; if (size > 16 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
        req.on('end', () => {
          try {
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, Buffer.concat(chunks));
            fs.renameSync(tmp, file);
            text(204, undefined, { ETag: etagOf(fs.statSync(file)) });
          } catch (e) { text(500, e.message); }
        });
        req.on('error', () => text(400, 'Bad Request'));
        return;
      }
      return text(405, 'Method Not Allowed');
    }
    if (p === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : notePage(title));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method Not Allowed');
    text(404, 'Not Found');
  });
}

// ── commands ───────────────────────────────────────────────────────────────
function cmdIp(o) {
  const ips = lanIps();
  if (o.json) return console.log(JSON.stringify({ ok: true, data: { ips } }));
  if (!ips.length) return console.log('(no external IPv4 address found)');
  for (const ip of ips) console.log(`${ip.address}\t${ip.iface}${ip.private ? '' : '\t(public)'}`);
}

function startServer(mode, o, { root, makeServer, extra }) {
  const port = o.port === null ? (mode === 'note' ? 8081 : 8080) : o.port;
  if (o.daemon) {
    const prev = readState()[mode];
    if (prev && alive(prev.pid)) fail(`${mode} already running (pid ${prev.pid}, ${prev.urls?.[0] || ''}); run "lanshare stop ${mode}" first`);
    const args = [mode, root, '--port', String(port), '--host', o.host, '--json'];
    if (o.auth) args.push('--auth', o.auth);
    if (!o.hidden) args.push('--no-hidden');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d; });
    const timer = setTimeout(() => { child.kill(); fail('daemon did not start in time' + (errBuf ? ': ' + errBuf.trim() : ''), 1); }, 5000);
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.startsWith('{'));
      if (!line) return;
      clearTimeout(timer);
      let info;
      try { info = JSON.parse(line).data; } catch { return; }
      writeState(mode, { ...info, pid: child.pid, startedAt: new Date().toISOString() });
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      report(mode, info, o.json, child.pid);
      process.exit(0);
    });
    child.on('exit', (code) => { clearTimeout(timer); fail(`daemon exited with code ${code}` + (errBuf ? ': ' + errBuf.trim() : ''), 1); });
    return;
  }

  const server = makeServer();
  server.on('error', (e) => fail(e.code === 'EADDRINUSE' ? `port ${port} is already in use` : e.message, 1));
  server.listen(port, o.host, () => {
    const p = server.address().port;
    const hosts = o.host === '0.0.0.0' || o.host === '::' ? lanIps().map((i) => i.address) : [o.host];
    const info = { mode, root, host: o.host, port: p, auth: !!o.auth, user: o.auth ? o.auth.split(':')[0] : null, ...extra, ips: hosts, urls: hosts.map((h) => `http://${h}:${p}/`) };
    if (!info.urls.length) info.urls.push(`http://127.0.0.1:${p}/`);
    report(mode, info, o.json, null);
    if (!o.json) process.stderr.write('Press Ctrl+C to stop.\n');
  });
  const shutdown = () => { server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdServe(o) {
  const dirArg = o._[1];
  if (!dirArg) fail('serve needs a directory\n' + HELP);
  const root = path.resolve(dirArg);
  let st;
  try { st = fs.statSync(root); } catch { fail(`no such directory: ${root}`); }
  if (!st.isDirectory()) fail(`not a directory: ${root}`);
  startServer('serve', o, { root, extra: { showHidden: o.hidden }, makeServer: () => createServer(root, { auth: o.auth, showHidden: o.hidden }) });
}

function cmdNote(o) {
  const file = path.resolve(o._[1] || path.join(DB_DIR, 'lanshare-note.txt'));
  try { if (fs.statSync(file).isDirectory()) fail(`${file} is a directory; give a file path`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const title = path.basename(file);
  startServer('note', o, { root: file, extra: { file, title }, makeServer: () => createNoteServer(file, { auth: o.auth, title }) });
}

function report(mode, info, json, pid) {
  if (json) return console.log(JSON.stringify({ ok: true, data: pid ? { ...info, pid } : info }));
  console.log(mode === 'note' ? `Notebook file ${info.root}` : `Sharing ${info.root}`);
  console.log(`Listening on ${info.host}:${info.port}${pid ? ` (daemon pid ${pid})` : ''}`);
  console.log(`Auth: ${info.auth ? `basic (user ${info.user})` : 'none'}`);
  console.log('LAN URLs:');
  for (const u of info.urls) console.log(`  ${u}`);
}

function cmdStatus(o) {
  const s = readState();
  const modes = ['serve', 'note'];
  const running = {};
  for (const m of modes) if (s[m] && alive(s[m].pid)) running[m] = s[m];
  if (o.json) return console.log(JSON.stringify({ ok: true, data: running }));
  if (!Object.keys(running).length) return console.log('not running');
  for (const [m, e] of Object.entries(running)) {
    console.log(`[${m}]`);
    report(m, e, false, e.pid);
    console.log(`Started: ${e.startedAt}`);
  }
}

function cmdStop(o) {
  const want = o._[1];
  if (want && want !== 'serve' && want !== 'note') fail('stop takes "serve" or "note"');
  const s = readState();
  const stopped = [];
  for (const m of want ? [want] : ['serve', 'note']) {
    const e = s[m];
    if (!e) continue;
    if (alive(e.pid)) { try { process.kill(e.pid, 'SIGTERM'); stopped.push({ mode: m, pid: e.pid }); } catch (err) { fail(err.message, 1); } }
    writeState(m, null);
  }
  if (o.json) return console.log(JSON.stringify({ ok: true, data: { stopped } }));
  if (!stopped.length) return console.log('not running');
  for (const x of stopped) console.log(`stopped ${x.mode} (pid ${x.pid})`);
}

// ── main ───────────────────────────────────────────────────────────────────
const o = parse(argv);
const cmd = o._[0];
if (!cmd || cmd === 'help') { process.stdout.write(HELP); process.exit(cmd ? 0 : 2); }
switch (cmd) {
  case 'serve': cmdServe(o); break;
  case 'note': cmdNote(o); break;
  case 'ip': cmdIp(o); break;
  case 'status': cmdStatus(o); break;
  case 'stop': cmdStop(o); break;
  default: fail(`unknown command "${cmd}"\n` + HELP);
}
