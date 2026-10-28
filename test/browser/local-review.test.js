/* global window, document, Worker, innerWidth, PageTransitionEvent */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { SearchIndex } from 'searchlite';
import { assertSameReport } from './report-parity.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
let server, browser, origin, directory;
before(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), 'searchlite-local-browser-')));
  if (process.env.SEARCHLITE_BROWSER_ORIGIN) {
    assert.equal(process.env.SEARCHLITE_BROWSER_ORIGIN, 'https://ult666666.github.io');
    origin = process.env.SEARCHLITE_BROWSER_ORIGIN;
  } else {
    server = await preview({
      root: path.join(root, 'demo'),
      configFile: path.join(root, 'demo/vite.config.ts'),
      preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
    });
    const address = server.httpServer.address();
    assert(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
  }
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.httpServer.close(resolve) : resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
const encode = (value) => Buffer.from(JSON.stringify(value) + '\n');
function fixture(changed = true, hostile = false) {
  const id = hostile ? '<img onerror=alert(1)>.md' : 'a.md';
  const docs = [
    { id, title: 'quartz', body: 'other' },
    { id: 'b.md', title: 'other', body: 'quartz' },
  ];
  const make = (fields) => {
    const index = new SearchIndex({ fields });
    index.addAll(docs);
    return encode(index.toJSON());
  };
  return {
    baseline: make({ title: { boost: 3 }, body: {} }),
    candidate: make(
      changed ? { title: {}, body: { boost: 3 } } : { title: { boost: 3 }, body: {} },
    ),
    judgments: encode({
      schema: 'searchlite.local-judgments/1',
      queries: [
        {
          id: 'title-task',
          text: hostile ? 'quartz OR "unsafe\u202e"' : 'quartz',
          minimumNdcgAt10: 0.5,
          relevance: [{ documentId: id, grade: 3 }],
        },
        {
          id: 'body-task',
          text: 'quartz',
          minimumNdcgAt10: 0.5,
          relevance: [{ documentId: 'b.md', grade: 3 }],
        },
      ],
    }),
  };
}
async function native(inputs) {
  const key = String(Math.random()).slice(2),
    files = [];
  for (const name of ['baseline', 'candidate', 'judgments']) {
    const file = path.join(directory, key + '-' + name + '.json');
    await writeFile(file, inputs[name]);
    files.push(file);
  }
  const r = spawnSync(
    process.execPath,
    [path.join(root, 'examples/search-docs.js'), 'compare', ...files],
    { cwd: root, encoding: 'utf8', timeout: 15000 },
  );
  assert([0, 3].includes(r.status), r.stderr);
  return r.stdout;
}
async function pageFor(t, initialize) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
  });
  t.after(() => context.close());
  const requests = [],
    external = [],
    errors = [];
  await context.route('**/*', (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin) {
      external.push(request.url());
      return route.abort();
    }
    requests.push({ url: request.url(), method: request.method(), body: request.postData() });
    return route.continue();
  });
  if (initialize) await context.addInitScript(initialize);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/searchlite/local.html');
  await page.getByRole('heading', { name: 'Local file workbench', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#load-example').disabled);
  t.after(() => {
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    assert(requests.every((r) => r.method === 'GET' && r.body === null));
  });
  return { page, context, requests };
}
async function select(page, inputs, filename = 'baseline.json') {
  await page
    .getByLabel('Baseline index', { exact: true })
    .setInputFiles({ name: filename, mimeType: 'application/json', buffer: inputs.baseline });
  await page.getByLabel('Candidate index', { exact: true }).setInputFiles({
    name: 'candidate.json',
    mimeType: 'application/json',
    buffer: inputs.candidate,
  });
  await page.getByLabel('Judgments file', { exact: true }).setInputFiles({
    name: 'judgments.json',
    mimeType: 'application/json',
    buffer: inputs.judgments,
  });
}
async function run(page) {
  await page.getByRole('button', { name: 'Compare saved indexes', exact: true }).click();
  await page.locator('#verdict').waitFor();
}
async function report(page) {
  const event = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download local comparison JSON', exact: true }).click();
  return readFile(await (await event).path(), 'utf8');
}

test(
  'local files produce native-equivalent reports and literal safe query inspection',
  { timeout: 60000 },
  async (t) => {
    const { page, requests } = await pageFor(t);
    const input = fixture(true, true);
    const positiveMean = JSON.parse(input.judgments);
    positiveMean.queries.push({ ...positiveMean.queries[1], id: 'body-task-second' });
    input.judgments = encode(positiveMean);
    await select(page, input, '<img src=x onerror=alert(1)>.json');
    await run(page);
    assert.equal(await page.locator('#verdict').innerText(), 'Comparison failed');
    const actual = await report(page);
    assertSameReport(actual, await native(input));
    const compared = JSON.parse(actual);
    assert(compared.queries.reduce((sum, query) => sum + query.delta.ndcgAt10, 0) > 0);
    assert.deepEqual(compared.regressedQueries, ['title-task']);
    assert.match(await page.locator('#baseline-selection').innerText(), /<img src=x/);
    assert.equal(await page.locator('#results img').count(), 0);
    assert.equal(await page.locator('input img').count(), 0);
    assert.match(await page.locator('#query-detail').innerText(), /\\u\{202e\}/);
    assert.match(
      await page.locator('#baseline-ranking li').first().innerText(),
      /<img onerror=alert\(1\)>\.md/,
    );
    const link = await page
      .getByRole('link', { name: 'Download local comparison JSON', exact: true })
      .getAttribute('href');
    assert(link.startsWith('blob:'));
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.getByLabel('Inspect local query', { exact: true }).focus();
    await page.keyboard.press('b');
    await page.keyboard.press('Enter');
    assert.equal(
      await page.getByLabel('Inspect local query', { exact: true }).inputValue(),
      'body-task',
    );
    assert.match(await page.locator('#query-detail').innerText(), /body-task/);
    const changedRequests = requests.length;
    const unchanged = fixture(false);
    await select(page, unchanged);
    await run(page);
    assert.equal(await page.locator('#verdict').innerText(), 'Comparison passed');
    assertSameReport(await report(page), await native(unchanged));
    assert.equal(requests.length, changedRequests);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
    );
    assertSameReport(await report(page), await native(unchanged));
    assert.equal(new URL(page.url()).search, '');
    assert.deepEqual(
      await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
      { local: {}, session: {} },
    );
  },
);

test(
  'synthetic controls run after load while offline and reproduce downloaded input bytes',
  { timeout: 60000 },
  async (t) => {
    const { page, context } = await pageFor(t);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Load synthetic example', exact: true }).click();
    await page.locator('#verdict').waitFor();
    assert.equal(await page.locator('#verdict').innerText(), 'Comparison failed');
    const inputs = {};
    for (const name of ['baseline', 'candidate', 'judgments']) {
      const event = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download synthetic ' + name, exact: true }).click();
      inputs[name] = await readFile(await (await event).path());
    }
    assertSameReport(await report(page), await native(inputs));
    await page.getByLabel('Example control', { exact: true }).selectOption('unchanged');
    await page.getByRole('button', { name: 'Load synthetic example', exact: true }).click();
    await page.getByText('Comparison passed', { exact: true }).waitFor();
    assert.equal(JSON.parse(await report(page)).regressedQueries.length, 0);
    await page.getByRole('button', { name: 'Clear local files', exact: true }).click();
    assert.equal(await page.locator('#results').isVisible(), false);
    assert.equal(
      await page.getByRole('link', { name: 'Download local comparison JSON', exact: true }).count(),
      0,
    );
    assert.equal(await page.locator('#baseline-selection').innerText(), 'None selected.');
    await select(page, fixture(false));
    await run(page);
    assert.equal(await page.locator('#verdict').innerText(), 'Comparison passed');
  },
);

test(
  'invalid inputs discard prior reports without partial results',
  { timeout: 60000 },
  async (t) => {
    const { page } = await pageFor(t);
    const good = fixture(false);
    await select(page, good);
    await run(page);
    const mutations = [
      ['candidate', Buffer.from([255]), 'INVALID_SNAPSHOT'],
      ['candidate', encode({}), 'INVALID_SNAPSHOT'],
      ['judgments', encode({}), 'INVALID_JUDGMENTS'],
      ['judgments', Buffer.alloc(256 * 1024 + 1), 'FILE_LIMIT'],
      ['baseline', Buffer.alloc(16 * 1024 * 1024 + 1), 'FILE_LIMIT'],
    ];
    const different = JSON.parse(good.candidate);
    different.documents[0].stored.body = 'edited';
    mutations.push(['candidate', encode(different), 'INCOMPARABLE_COLLECTION']);
    const query = JSON.parse(good.judgments);
    query.queries[1].text = '(';
    mutations.push(['judgments', encode(query), 'INVALID_QUERY']);
    for (const [name, buffer, code] of mutations) {
      await select(page, { ...good, [name]: buffer });
      assert.equal(await page.locator('#results').isVisible(), false);
      await page.getByRole('button', { name: 'Compare saved indexes', exact: true }).click();
      await page.locator('#local-status').filter({ hasText: code }).waitFor();
      assert.equal(await page.locator('#results').isVisible(), false);
      assert.equal(
        await page
          .getByRole('link', { name: 'Download local comparison JSON', exact: true })
          .count(),
        0,
      );
    }
  },
);

test('Clear and changed files invalidate a deferred byte read', { timeout: 60000 }, async (t) => {
  const { page } = await pageFor(t, () => {
    const original = File.prototype.arrayBuffer;
    window.__readHeld = false;
    window.__releaseRead = null;
    File.prototype.arrayBuffer = function () {
      if (!window.__readHeld) {
        window.__readHeld = true;
        return new Promise((resolve) => {
          window.__releaseRead = () => original.call(this).then(resolve);
        });
      }
      return original.call(this);
    };
  });
  await select(page, fixture());
  await page.getByRole('button', { name: 'Compare saved indexes', exact: true }).click();
  await page.waitForFunction(() => typeof window.__releaseRead === 'function');
  await page.getByRole('button', { name: 'Clear local files', exact: true }).click();
  await page.evaluate(() => window.__releaseRead());
  await page.getByText('Cleared local inputs and results.', { exact: true }).waitFor();
  assert.equal(await page.locator('#results').isVisible(), false);
  await select(page, fixture(false));
  await run(page);
  assert.equal(await page.locator('#verdict').innerText(), 'Comparison passed');
});

test(
  'deadline terminates the owned worker and ignores its late report',
  { timeout: 60000 },
  async (t) => {
    const { page } = await pageFor(t, () => {
      const NativeWorker = Worker;
      window.__terminated = 0;
      window.__stalled = false;
      window.__lateReply = null;
      window.Worker = class extends NativeWorker {
        postMessage(message, options) {
          if (window.__stalled) {
            super.postMessage(message, options);
            return;
          }
          window.__stalled = true;
          window.__lateReply = () =>
            this.dispatchEvent(
              new MessageEvent('message', { data: { kind: 'report', text: '{}' } }),
            );
        }
        terminate() {
          window.__terminated++;
          super.terminate();
        }
      };
    });
    await page.clock.install();
    await select(page, fixture());
    await page.getByRole('button', { name: 'Compare saved indexes', exact: true }).click();
    await page.waitForFunction(() => window.__stalled);
    await page.clock.fastForward(15001);
    await page.locator('#local-status').filter({ hasText: 'DEADLINE' }).waitFor();
    assert.equal(await page.evaluate(() => window.__terminated), 1);
    await page.evaluate(() => window.__lateReply());
    assert.equal(await page.locator('#results').isVisible(), false);
    await page.clock.resume();
    await page.getByRole('button', { name: 'Compare saved indexes', exact: true }).click();
    await page.locator('#verdict').waitFor();
    assert.equal(await page.locator('#verdict').innerText(), 'Comparison failed');
  },
);

test(
  'changing a file terminates a pending worker and ignores its late message',
  { timeout: 60000 },
  async (t) => {
    const { page } = await pageFor(t, () => {
      const NativeWorker = Worker;
      window.__held = false;
      window.__terminated = 0;
      window.__lateReply = null;
      window.Worker = class extends NativeWorker {
        postMessage(message, options) {
          if (window.__held) {
            super.postMessage(message, options);
            return;
          }
          window.__held = true;
          window.__lateReply = () =>
            this.dispatchEvent(
              new MessageEvent('message', { data: { kind: 'report', text: '{}' } }),
            );
        }
        terminate() {
          window.__terminated++;
          super.terminate();
        }
      };
    });
    await select(page, fixture());
    await page.getByRole('button', { name: 'Compare saved indexes', exact: true }).click();
    await page.waitForFunction(() => window.__held);
    await page.getByLabel('Candidate index', { exact: true }).setInputFiles({
      name: 'replacement.json',
      mimeType: 'application/json',
      buffer: fixture(false).candidate,
    });
    assert.equal(await page.evaluate(() => window.__terminated), 1);
    await page.evaluate(() => window.__lateReply());
    assert.equal(await page.locator('#results').isVisible(), false);
    assert.match(await page.locator('#local-status').innerText(), /Inputs changed/);
    await run(page);
    assert.equal(await page.locator('#verdict').innerText(), 'Comparison passed');
    assert.equal(await page.evaluate(() => window.__terminated), 2);
  },
);

test(
  'long valid query text and IDs remain usable at narrow widths',
  { timeout: 60000 },
  async (t) => {
    const { page } = await pageFor(t);
    const inputs = fixture(false);
    inputs.judgments = encode({
      schema: 'searchlite.local-judgments/1',
      queries: [
        {
          id: 'q'.repeat(64),
          text: 'x'.repeat(1000),
          minimumNdcgAt10: 0,
          relevance: [{ documentId: 'a.md', grade: 3 }],
        },
      ],
    });
    await select(page, inputs);
    await run(page);
    assertSameReport(await report(page), await native(inputs));
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `valid long query overflow at${width}`,
      );
    }
  },
);
