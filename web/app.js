const token = document.querySelector('meta[name="gptime-token"]').content;
const $ = id => document.getElementById(id);
async function api(path, data) {
  const r = await fetch(path, { method: data ? 'POST' : 'GET', headers: {
    Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {})
  }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || '接続できません。');
  return result;
}
function error(e) { $('message').textContent = e.message; }
async function status() {
  const s = await api('/status');
  $('account').textContent = s.signedIn ? `接続済み · ${s.email || 'ChatGPTアカウント'}` : '未接続';
  $('logout').hidden = !s.signedIn;
  $('enabled').checked = s.enabled;
  $('enabled').disabled = !s.signedIn;
}
$('login').onclick = async () => {
  try { const r = await api('/login', {}); location.assign(r.url); } catch (e) { error(e); }
};
$('logout').onclick = async () => {
  try { const r = await api('/logout', {}); $('message').textContent = r.revoked ? 'ログアウトしました。' : '端末からログアウトしました。接続解除は未確認です。ChatGPTの設定からアプリを切断してください。'; await status(); }
  catch (e) { error(e); }
};
$('enabled').onchange = async () => {
  try { await api('/settings', { enabled: $('enabled').checked }); $('message').textContent = ''; }
  catch (e) { error(e); } finally { await status().catch(error); }
};
let request = 0;
$('convert').onsubmit = async e => {
  e.preventDefault(); const id = ++request;
  $('message').textContent = ''; $('result').textContent = '変換中…'; $('latency').textContent = '';
  try {
    const r = await api('/convert', { reading: $('reading').value });
    if (id !== request) return;
    $('result').textContent = r.text;
    $('latency').textContent = r.cached ? 'キャッシュから表示' : `${r.elapsedMs} ms`;
  } catch (e) { if (id === request) { $('result').textContent = '変換できませんでした。'; error(e); } }
};
status().catch(error);
