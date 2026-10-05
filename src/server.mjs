import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Auth } from './auth.mjs';
import { Converter, MODEL } from './converter.mjs';

const directory = process.env.GPTIME_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), '.config'), 'GPTIME');
await mkdir(directory, { recursive: true, mode: 0o700 });
// Windows does not enforce POSIX file modes. Restrict the directory before writing credentials.
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $p=$env:GPTIME_ACL_PATH; ' +
    '$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); ' +
    '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($sid); ' +
    '$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); ' +
    '$acl.SetAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl'],
    { env: { ...process.env, GPTIME_ACL_PATH: directory }, stdio: 'pipe' });
}
const port = 18765;
const origin = `http://127.0.0.1:${port}`;
const localToken = randomBytes(32).toString('hex');
const auth = new Auth(directory);
const converter = new Converter(auth);
let enabled = false, accountBusy = false;
const page = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');

function reply(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSONが必要です。');
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 4096) throw new Error('入力が長すぎます。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin))
      return reply(res, 403, { error: 'アクセスできません。' });
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/')
      return reply(res, 200, page.replace('__LOCAL_TOKEN__', localToken), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.js') return reply(res, 200, script, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/style.css') return reply(res, 200, style, 'text/css; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      if (accountBusy) return reply(res, 409, '認証処理中です。', 'text/plain; charset=utf-8');
      accountBusy = true;
      try {
        await auth.complete(url.searchParams); converter.clear();
        res.writeHead(303, { Location: '/' }); res.end();
      } finally { accountBusy = false; }
      return;
    }
    if (req.headers.authorization !== `Bearer ${localToken}`) return reply(res, 401, { error: '認証が必要です。' });
    if (req.method === 'GET' && url.pathname === '/status') return reply(res, 200, {
      signedIn: !!auth.data.access_token, email: auth.data.email, enabled, model: MODEL,
      reasoning: 'none', timeoutMs: converter.timeout });
    if (req.method !== 'POST') return reply(res, 404, { error: '見つかりません。' });
    const input = await body(req);
    if (url.pathname === '/login') {
      if (accountBusy || auth.refreshing) throw new Error('認証処理中です。');
      return reply(res, 200, { url: auth.begin(`${origin}/auth/callback`) });
    }
    if (url.pathname === '/logout') {
      if (accountBusy) throw new Error('認証処理中です。');
      accountBusy = true; enabled = false; converter.clear();
      try { return reply(res, 200, { revoked: await auth.logout() }); }
      finally { accountBusy = false; }
    }
    if (url.pathname === '/settings') {
      if (typeof input.enabled !== 'boolean') throw new Error('設定が不正です。');
      if (input.enabled && !auth.data.access_token) throw new Error('先にChatGPTにログインしてください。');
      enabled = input.enabled;
      if (!enabled) converter.clear();
      return reply(res, 200, { enabled });
    }
    if (url.pathname === '/convert') {
      if (!enabled || accountBusy) return reply(res, 503, { error: 'クラウド変換は停止中です。' });
      try {
        const result = await converter.convert(input.reading);
        return reply(res, 200, { ...result, candidates: [{ text: result.text,
          correspondingCount: [...input.reading.normalize('NFC')].length }] });
      } catch (e) {
        return reply(res, 503, { error: e.name === 'AbortError' ? '時間内に応答がありませんでした。辞書候補を使います。' : e.message });
      }
    }
    return reply(res, 404, { error: '見つかりません。' });
  } catch (e) { reply(res, 400, { error: e.message }); }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
// Bind before reading or refreshing credentials, so only one owner can use rotating tokens.
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
await auth.init();
const bridgePath = join(directory, 'bridge.json');
await writeFile(`${bridgePath}.tmp`, JSON.stringify({ endpoint: `${origin}/convert`, token: localToken }), { mode: 0o600 });
await rename(`${bridgePath}.tmp`, bridgePath);
// Refresh outside the IME keystroke path. No inference runs until the user enables conversion.
const timer = setInterval(() => {
  if (!accountBusy && auth.data.access_token) auth.accessToken().catch(() => {});
}, 30000);
console.log(`GPTIME: ${origin}\nブラウザで開き、Continue with ChatGPT でログインしてください。`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(timer); converter.clear(); server.close(); server.closeAllConnections();
});
