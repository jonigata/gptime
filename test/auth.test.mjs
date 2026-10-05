import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.mjs';

test('registration has PKCE, stable host, nonce; rejects wrong state and missing issued client', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gptime-auth-')); t.after(() => rm(dir, { recursive: true }));
  const auth = new Auth(dir, async () => assert.fail('must not exchange invalid callback'));
  await auth.init();
  const url = new URL(auth.begin('http://127.0.0.1:18765/auth/callback'));
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('ext_agent_host_id'), auth.data.host);
  await assert.rejects(auth.complete(new URLSearchParams({ state: 'wrong', code: 'x', client_id: 'oaiapp_test' })));
  await assert.rejects(auth.complete(new URLSearchParams({ state: auth.pending.state, code: 'x' })));
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'account.json'))).mode & 0o777, 0o600);
});
test('returning login preserves issued client and rejects client switching', async () => {
  const auth = new Auth('/unused', async () => assert.fail('must not exchange'));
  auth.data = { client_id: 'oaiapp_original', subject: 'original', host: 'host' };
  const url = new URL(auth.begin('http://127.0.0.1:18765/auth/callback'));
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_original');
  assert.equal(url.searchParams.has('agent_name_hint'), false);
  await assert.rejects(auth.complete(new URLSearchParams({ state: auth.pending.state, code: 'x', client_id: 'oaiapp_other' })));
});
test('concurrent refreshes rotate tokens once and preserve grants when scope is omitted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gptime-auth-')); t.after(() => rm(dir, { recursive: true }));
  let calls = 0;
  const auth = new Auth(dir, async (_, init) => {
    calls++; assert.equal(init.body.get('client_id'), 'oaiapp_test');
    assert.equal(init.body.get('resource'), 'https://api.openai.com/v1');
    return Response.json({ access_token: 'replacement', refresh_token: 'rotated', expires_in: 3600 });
  });
  auth.data = { client_id: 'oaiapp_test', access_token: 'old', refresh_token: 'old-refresh',
    expires_at: 0, scope: 'chatgpt.tokens.use.direct' };
  assert.deepEqual(await Promise.all([auth.accessToken(), auth.accessToken()]), ['replacement', 'replacement']);
  assert.equal(calls, 1); assert.equal(auth.data.refresh_token, 'rotated');
});
