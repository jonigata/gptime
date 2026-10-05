import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

export class Auth {
  constructor(directory, fetcher = fetch) {
    this.directory = directory;
    this.fetch = fetcher;
    this.data = {};
    this.pending = null;
    this.refreshing = null;
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.data = JSON.parse(await readFile(join(this.directory, 'account.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.data.host ??= `urn:uuid:${randomUUID()}`;
    await this.save();
  }
  async save() {
    const path = join(this.directory, 'account.json');
    const temporary = `${path}.${random()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
  begin(redirectUri) {
    const p = { state: random(), nonce: random(), verifier: random(), redirectUri,
      client: this.data.client_id, subject: this.data.subject, expires: Date.now() + 600_000 };
    this.pending = p;
    const params = new URLSearchParams({ client_id: p.client || 'dynamic_agent_client',
      ext_agent_host_id: this.data.host, response_type: 'code', redirect_uri: redirectUri,
      scope: scopes, resource, state: p.state, nonce: p.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(p.verifier).digest('base64url') });
    if (!p.client) params.set('agent_name_hint', 'GPTIME');
    if (p.client && this.data.id_token) params.set('id_token_hint', this.data.id_token);
    return `${issuer}/api/accounts/authorize?${params}`;
  }
  async tokenRequest(values) {
    const res = await this.fetch(tokenEndpoint, { method: 'POST',
      body: new URLSearchParams({ ...values, resource }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`ChatGPT認証エラー (${res.status})。再ログインしてください。`);
    return res.json();
  }
  async complete(params) {
    const p = this.pending;
    if (!p || p.expires <= Date.now() || params.get('state') !== p.state)
      throw new Error('ログイン確認に失敗しました。ログインをやり直してください。');
    this.pending = null;
    if (params.has('error')) throw new Error('ログインが取り消されました。');
    const client = params.get('client_id') || p.client;
    if (!client || client === 'dynamic_agent_client' || (p.client && client !== p.client) || !params.get('code'))
      throw new Error('ChatGPTの登録情報が一致しません。');
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', client_id: client,
      code: params.get('code'), code_verifier: p.verifier, redirect_uri: p.redirectUri });
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer, audience: client, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
    if (payload.nonce !== p.nonce || typeof payload.sub !== 'string' || !payload.sub ||
        (p.subject && payload.sub !== p.subject)) throw new Error('ChatGPTアカウントの確認に失敗しました。');
    this.validateTokens(tokens);
    this.data = { host: this.data.host, client_id: client, subject: payload.sub,
      email: payload.email, ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };
    await this.save();
  }
  validateTokens(tokens) {
    if (!tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
      !tokens.scope?.split(' ').includes('chatgpt.tokens.use.direct'))
      throw new Error('ChatGPTプランでの利用が許可されていません。ログインし直してください。');
  }
  async accessToken() {
    if (!this.data.access_token) throw new Error('Continue with ChatGPT からログインしてください。');
    if (Date.now() < this.data.expires_at - 60000) return this.data.access_token;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    await this.refreshing;
    return this.data.access_token;
  }
  async refresh() {
    if (!this.data.refresh_token) throw new Error('ChatGPTに再ログインしてください。');
    const tokens = await this.tokenRequest({ grant_type: 'refresh_token', client_id: this.data.client_id,
      refresh_token: this.data.refresh_token });
    tokens.scope ??= this.data.scope;
    this.validateTokens(tokens);
    this.data = { ...this.data, ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };
    await this.save();
  }
  async logout() {
    if (this.refreshing) await this.refreshing.catch(() => {});
    let revoked = !this.data.refresh_token;
    try {
      if (!revoked) {
        const config = await this.fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
        const endpoint = new URL(config.revocation_endpoint);
        if (endpoint.origin !== issuer) throw new Error('Unexpected revocation endpoint');
        const response = await this.fetch(endpoint, { method: 'POST', body: new URLSearchParams({
          token: this.data.refresh_token, token_type_hint: 'refresh_token', client_id: this.data.client_id
        }), signal: AbortSignal.timeout(5000) });
        revoked = response.status === 200;
      }
    } catch { /* Always clear local tokens. */ }
    const { host, client_id, subject, email } = this.data;
    this.data = { host, client_id, subject, email };
    this.pending = null;
    await this.save();
    return revoked;
  }
}
