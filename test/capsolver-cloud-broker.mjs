import test from 'node:test';
import assert from 'node:assert/strict';
import { solveCaptcha as solveChrome } from '../src/chrome/src/agent/captcha-solver.js';
import { solveCaptcha as solveFirefox } from '../src/firefox/src/agent/captcha-solver.js';

for (const [browser, solveCaptcha] of [['Chrome', solveChrome], ['Firefox', solveFirefox]]) {
  test(`${browser} sends brokered challenges without a CapSolver key`, async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return Response.json({ taskId: 'broker-task', solution: { token: 'challenge-token' } });
    };
    try {
      const result = await solveCaptcha('', {
        type: 'turnstile',
        websiteURL: 'https://example.com/signup',
        websiteKey: 'public-site-key',
      }, { useCloudBroker: true });
      assert.equal(result.taskId, 'broker-task');
      assert.equal(result.token, 'challenge-token');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://127.0.0.1:17373/capsolver/solve');
      assert.equal(calls[0].options.headers['X-WebBrain-CapSolver-Broker'], '1');
      assert.deepEqual(JSON.parse(calls[0].options.body), {
        task: {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: 'https://example.com/signup',
          websiteKey: 'public-site-key',
        },
      });
      assert.equal(calls[0].options.body.includes('clientKey'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
