/* global window, document, innerWidth, PageTransitionEvent */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const nativeReport = (baseline = 'bm25f', candidate = 'no-stemming') =>
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      path.join(root, 'scripts/eval-compare.ts'),
      `--baseline=${baseline}`,
      `--candidate=${candidate}`,
    ],
    { cwd: root, encoding: 'utf8', timeout: 15_000 },
  );

test(
  'built relevance workflow reconciles config, query, export and existing search',
  { timeout: 90_000 },
  async () => {
    const server = await preview({
      root: path.join(root, 'demo'),
      configFile: path.join(root, 'demo/vite.config.ts'),
      preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
    });
    let browser;
    try {
      const address = server.httpServer.address();
      assert(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ ignoreDefaultArgs: ['--disable-back-forward-cache'] });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        serviceWorkers: 'block',
      });
      const external = [],
        errors = [];
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(10_000);
      const response = await page.goto(origin + '/searchlite/relevance.html');
      assert.equal(response.status(), 200);
      await page.getByRole('heading', { name: 'Relevance workbench', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Baseline configuration').inputValue(), 'bm25f');
      assert.equal(await page.getByLabel('Candidate configuration').inputValue(), 'no-stemming');
      assert.equal(await page.locator('#query-overview tbody tr').count(), 22);
      assert.match(await page.locator('#summary').innerText(), /0\.927[\s\S]*0\.904[\s\S]*-0\.023/);
      const download = async () => {
        const event = page.waitForEvent('download');
        await page.getByRole('link', { name: 'Download comparison JSON', exact: true }).click();
        const result = await event;
        const filename = await result.path();
        assert(filename);
        return { bytes: await readFile(filename, 'utf8'), filename: result.suggestedFilename() };
      };
      const first = await download();
      assert.equal(first.bytes, nativeReport());
      assert.equal(first.filename, 'searchlite-bm25f-vs-no-stemming.json');
      const retained = await page.evaluate(async () => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        const link = document.querySelector('#download');
        return await (await fetch(link.href)).text();
      });
      assert.equal(retained, first.bytes, 'A persisted page must retain its live report URL');
      await page.getByRole('button', { name: 'Inspect q22', exact: true }).click();
      assert.equal(await page.getByLabel('Inspect query').inputValue(), 'q22');
      assert.match(await page.locator('#query-title').innerText(), /token bucket/);
      assert.match(
        await page.locator('#baseline-ranking li').first().innerText(),
        /Rate limiting[\s\S]*grade 3/,
      );
      assert.match(await page.locator('#query-metrics').innerText(), /P@5[\s\S]*0\.200/);
      assert.equal(
        (await download()).bytes,
        first.bytes,
        'Inspecting another query must not replace aggregate data',
      );
      await page.getByRole('button', { name: 'Swap configurations', exact: true }).click();
      assert.equal((await download()).bytes, nativeReport('no-stemming', 'bm25f'));
      await page.getByLabel('Candidate configuration').selectOption('no-stemming');
      const identical = JSON.parse((await download()).bytes);
      assert.deepEqual(Object.values(identical.meanDelta), [0, 0, 0, 0, 0]);
      await page.getByLabel('Candidate configuration').selectOption('toy-hybrid');
      assert.match(await page.locator('#candidate-ranking').innerText(), /RRF score/);
      assert.match(await page.locator('#methodology').innerText(), /spelling overlap, not meaning/);
      assert.equal((await download()).bytes, nativeReport('no-stemming', 'toy-hybrid'));
      await page.reload();
      assert.equal(await page.getByLabel('Candidate configuration').inputValue(), 'toy-hybrid');
      assert.equal(await page.getByLabel('Inspect query').inputValue(), 'q22');
      await page.getByRole('button', { name: 'Inspect q02', exact: true }).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.getByLabel('Inspect query').inputValue(), 'q02');
      assert.equal(
        await page.getByLabel('Inspect query').evaluate((node) => node === document.activeElement),
        true,
      );
      assert.match(await page.locator('#baseline-missing').innerText(), /Precision and recall/);
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `${width}px page overflow`,
        );
        if (width === 320) {
          await page
            .getByRole('region', { name: 'Aggregate relevance metrics', exact: true })
            .focus();
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(
            () => document.querySelector('#summary').parentElement.scrollLeft > 0,
          );
        }
      }
      await page.goto(
        origin +
          '/searchlite/relevance.html?baseline=__proto__&candidate=%3Cscript%3E&query=unknown',
      );
      assert.match(await page.getByRole('status').innerText(), /Unknown.*defaults/);
      assert.equal(await page.getByLabel('Baseline configuration').inputValue(), 'bm25f');
      assert.equal(await page.getByLabel('Candidate configuration').inputValue(), 'no-stemming');
      assert.equal((await download()).bytes, first.bytes);
      assert.equal(await page.locator('script:not([src])').count(), 0);
      await page.getByRole('link', { name: 'Search demo', exact: true }).click();
      // Static inputs can be actionable before the module hydrates and restores its URL query.
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('60 glossary entries indexed'),
      );
      await page.getByLabel('Search the glossary').fill('"binary heap"');
      await page.locator('#results .result').first().waitFor();
      assert.match(await page.locator('#results').innerText(), /Binary heap/);
      await page.getByLabel('Explain scores').check();
      assert.match(await page.locator('#results .explain').first().innerText(), /Score/);
      await page.goBack();
      await page.getByRole('heading', { name: 'Relevance workbench', exact: true }).waitFor();
      assert.equal((await download()).bytes, first.bytes);
      await page.getByRole('link', { name: 'Search demo', exact: true }).click();
      await page
        .getByRole('link', { name: 'Compare relevance configurations', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Relevance workbench', exact: true }).waitFor();
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(await context.cookies(), []);
      assert.deepEqual(
        await page.evaluate(() => [localStorage.length, sessionStorage.length]),
        [0, 0],
      );
      await context.close();
      const nojs = await browser.newContext({ javaScriptEnabled: false });
      const plain = await nojs.newPage();
      await plain.goto(origin + '/searchlite/relevance.html');
      assert.match(await plain.locator('noscript').innerText(), /JavaScript/);
      await nojs.close();
    } finally {
      await browser?.close();
      await new Promise((resolve, reject) => {
        server.httpServer.close((error) => (error ? reject(error) : resolve()));
        server.httpServer.closeAllConnections();
      });
    }
  },
);
