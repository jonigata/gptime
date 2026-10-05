import test from 'node:test';
import assert from 'node:assert/strict';
import { Converter, readResponse } from '../src/converter.mjs';

const stream = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('')).body;
const delta = text => ({ type: 'response.output_text.delta', delta: text });
const done = { type: 'response.completed', response: { status: 'completed' } };
const auth = { data: { access_token: 'test-only' }, accessToken: async () => 'test-only' };

test('Japanese UTF-8 survives arbitrary SSE chunk boundaries', async () => {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(delta('今日は晴れ'))}\n\ndata: ${JSON.stringify(done)}\n\n`);
  const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.equal(await readResponse(body), '今日は晴れ');
});
test('never accept partial, failed, incomplete or multiline responses', async () => {
  for (const events of [[delta('今日')], [delta('今日'), { type: 'response.failed' }],
    [delta('今日'), { type: 'response.incomplete' }], [delta('今日\n説明'), done],
    [delta('今日'), { type: 'response.completed', response: { status: 'failed' } }]]) {
    await assert.rejects(readResponse(stream(events)));
  }
});
test('uses Luna without reasoning; deduplicates in-flight conversions and caches success only', async () => {
  let calls = 0;
  const c = new Converter(auth, { fetcher: async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.store, false); assert.equal(body.stream, true);
    return { ok: true, body: stream([delta('漢字'), done]) };
  }});
  const results = await Promise.all([c.convert('かんじ'), c.convert('かんじ')]);
  assert.equal(results[0].text, '漢字'); assert.equal(calls, 1);
  assert.equal((await c.convert('かんじ')).cached, true);
  c.clear(); await c.convert('かんじ'); assert.equal(calls, 2);
});
test('failures are retried on a later explicit request, not cached', async () => {
  let calls = 0;
  const c = new Converter(auth, { fetcher: async () => { calls++; return { ok: true, body: stream([delta('漢')]) }; } });
  await assert.rejects(c.convert('かんじ')); await assert.rejects(c.convert('かんじ'));
  assert.equal(calls, 2);
});
test('request deadline cancels remote inference', async () => {
  const c = new Converter(auth, { timeout: 20, fetcher: async (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }) });
  await assert.rejects(c.convert('かんじ'), { name: 'AbortError' });
  assert.equal(c.pending.size, 0);
});
test('logout cancels requests and discards cached results', async () => {
  const c = new Converter(auth, { fetcher: async (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }) });
  const pending = c.convert('かんじ');
  await new Promise(r => setImmediate(r)); c.clear();
  await assert.rejects(pending); assert.equal(c.cache.size, 0);
});
test('invalid inputs never reach the network', async () => {
  const c = new Converter(auth, { fetcher: async () => assert.fail('network request') });
  for (const reading of ['', ' ', null, 'あ'.repeat(129), '\u0000']) await assert.rejects(c.convert(reading));
});
test('slow credential refresh cannot block the IME deadline', async () => {
  const slowAuth = { data: { access_token: 'test' }, accessToken: () => new Promise(() => {}) };
  const c = new Converter(slowAuth, { timeout: 20, fetcher: async () => assert.fail('network request') });
  await assert.rejects(c.convert('かんじ'), { name: 'AbortError' });
});
