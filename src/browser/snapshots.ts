import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { PageSnapshot, ProgressReporter } from '../types.js';

export async function collectPageSnapshots(url: string, maxPages = 4, progress?: ProgressReporter): Promise<PageSnapshot[]> {
  progress?.info('Launching browser for UI snapshots.');
  const browser = await chromium.launch({ headless: true });
  const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibin-screenshots-'));

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    progress?.info('Discovering same-origin pages to review.');
    const discoveredUrls = await discoverUrls(page, url, maxPages);
    progress?.info(`Discovered ${discoveredUrls.length} page${discoveredUrls.length === 1 ? '' : 's'} for desktop snapshots.`);
    const snapshots: PageSnapshot[] = [];

    for (const [index, discoveredUrl] of discoveredUrls.entries()) {
      const snapshotPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      progress?.info(`Capturing desktop snapshot ${index + 1}/${discoveredUrls.length}: ${discoveredUrl}.`);
      snapshots.push(await snapshotPageState(snapshotPage, discoveredUrl, path.join(screenshotDir, `page-${index + 1}.png`)));
      await snapshotPage.close();
    }

    const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    progress?.info(`Capturing mobile snapshot: ${url}.`);
    snapshots.push(await snapshotPageState(mobilePage, url, path.join(screenshotDir, 'mobile-home.png')));
    await mobilePage.close();

    return snapshots;
  } finally {
    await browser.close();
  }
}

export async function openBrowserPage(url: string, progress?: ProgressReporter): Promise<{ browser: Browser; page: Page; consoleErrors: string[] }> {
  progress?.info('Launching browser for fake-user session.');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  progress?.info(`Opening ${url} in the browser.`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  return { browser, page, consoleErrors };
}

export async function getCurrentPageSnapshot(page: Page, consoleErrors: string[] = []): Promise<PageSnapshot> {
  return {
    url: page.url(),
    title: await page.title(),
    text: await visibleText(page),
    interactiveElements: await interactiveElements(page),
    consoleErrors: [...consoleErrors],
    brokenImages: await brokenImageCount(page)
  };
}

async function discoverUrls(page: Page, startUrl: string, maxPages: number): Promise<string[]> {
  const origin = new URL(startUrl).origin;
  await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  const links = await page
    .locator('a[href]')
    .evaluateAll((elements) =>
      elements
        .map((element) => (element as HTMLAnchorElement).href)
        .filter(Boolean)
    )
    .catch(() => []);

  return [startUrl, ...links.filter((link) => link.startsWith(origin) && !link.includes('#'))]
    .filter((link, index, all) => all.indexOf(link) === index)
    .slice(0, maxPages);
}

async function snapshotPageState(page: Page, url: string, screenshotPath: string): Promise<PageSnapshot> {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return {
    url,
    title: await page.title(),
    text: await visibleText(page),
    interactiveElements: await interactiveElements(page),
    consoleErrors,
    brokenImages: await brokenImageCount(page),
    screenshotPath
  };
}

async function visibleText(page: Page): Promise<string> {
  return page
    .locator('body')
    .innerText({ timeout: 5_000 })
    .then((text) => text.replace(/\s+/g, ' ').slice(0, 8_000))
    .catch(() => '');
}

async function interactiveElements(page: Page): Promise<string[]> {
  return page
    .locator('a,button,input,textarea,select,[role=button],[role=link]')
    .evaluateAll((elements) =>
      elements.slice(0, 80).map((element) => {
        const htmlElement = element as HTMLElement;
        const label =
          htmlElement.getAttribute('aria-label') ??
          htmlElement.getAttribute('placeholder') ??
          htmlElement.innerText ??
          htmlElement.getAttribute('name') ??
          htmlElement.getAttribute('href') ??
          htmlElement.tagName.toLowerCase();
        return `${htmlElement.tagName.toLowerCase()}: ${label}`.replace(/\s+/g, ' ').trim();
      })
    )
    .catch(() => []);
}

async function brokenImageCount(page: Page): Promise<number> {
  return page
    .locator('img')
    .evaluateAll((images) => images.filter((image) => !(image as HTMLImageElement).complete || (image as HTMLImageElement).naturalWidth === 0).length)
    .catch(() => 0);
}
