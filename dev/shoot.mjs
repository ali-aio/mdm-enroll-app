// node shoot.mjs <base-url> <outdir> : screenshots every scenario (run inside the Playwright image)
import { chromium } from 'playwright';
const [base, out] = process.argv.slice(2);
const b = await chromium.launch();
const errs = [];
for (const [s, theme] of [['devices','light'],['devices','dark'],['empty','light'],['pair','light'],['noadb','light'],['picker','light'],['signin','dark']]) {
  const p = await b.newPage({ viewport: { width: 1100, height: 720 }, colorScheme: theme });
  p.on('pageerror', e => errs.push(`${s}: ${e.message}`));
  await p.goto(`${base}/?s=${s}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(3200);
  await p.screenshot({ path: `${out}/${s}-${theme}.png` });
  if (s === 'devices' && theme === 'light') {
    for (const [i, n] of [[1,'firmware'],[2,'enrolled'],[3,'blocked']]) {
      const items = p.locator('#rail .sitem'); if (await items.count() > i) { await items.nth(i).click(); await p.waitForTimeout(700); await p.screenshot({ path: `${out}/devices-${n}.png` }); }
    }
  }
  await p.close();
}
console.log('errors:', errs.length ? errs.join('\n') : 'none');
await b.close();
