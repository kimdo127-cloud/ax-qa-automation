// QA 실행기: 구글 시트(Apps Script 웹앱)에서 테스트케이스를 받아
// Playwright로 실제 브라우저에서 실행하고, 결과와 실패 화면을 시트로 돌려보낸다.
const { chromium } = require('playwright');

const CALLBACK = process.env.CALLBACK_URL;
const RUN_ID = process.env.RUN_ID;
const NONCE = process.env.NONCE;
const TIMEOUT = 4000;

function rgbToHex(rgb) {
  const m = String(rgb).match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return String(rgb);
  return '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function getCases() {
  const url = `${CALLBACK}?action=cases&run=${encodeURIComponent(RUN_ID)}&nonce=${encodeURIComponent(NONCE)}`;
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('케이스 응답이 JSON이 아님: ' + text.slice(0, 200)); }
  if (data.error) throw new Error(data.error);
  return data;
}

async function post(body) {
  const res = await fetch(CALLBACK, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ run: RUN_ID, nonce: NONCE }, body)),
  });
  console.log('결과 전송:', res.status, (await res.text()).slice(0, 300));
}

async function runStep(page, step, baseUrl, state) {
  const a = step.action;
  if (a === 'goto') {
    const target = new URL(step.url || '', baseUrl).toString();
    const resp = await page.goto(target, { waitUntil: 'load' });
    if (resp && resp.status() >= 400) throw new Error(`페이지가 열리지 않음 (${resp.status()}): ${target}`);
  } else if (a === 'fill') {
    await page.fill(step.selector, String(step.value ?? ''), { timeout: TIMEOUT });
  } else if (a === 'click') {
    state.lastStatus = null;
    const loc = step.selector ? page.locator(step.selector).first() : page.getByText(step.text, { exact: false }).first();
    await loc.click({ timeout: TIMEOUT });
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(700);
    if (state.lastStatus && state.lastStatus >= 400) throw new Error(`이동한 페이지가 열리지 않음 (${state.lastStatus}): ${page.url()}`);
  } else if (a === 'expectUrlContains') {
    try {
      await page.waitForURL(u => u.toString().includes(step.value), { timeout: TIMEOUT });
    } catch (e) {
      throw new Error(`화면 이동 안 됨. 기대 주소에 "${step.value}" 포함, 실제 주소: ${page.url()}`);
    }
  } else if (a === 'expectText') {
    try {
      await page.getByText(step.text, { exact: false }).first().waitFor({ state: 'visible', timeout: TIMEOUT });
    } catch (e) {
      const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 150);
      throw new Error(`문구 "${step.text}"가 화면에 없음. 실제 화면 문구: ${body}`);
    }
  } else if (a === 'expectTextIn') {
    const el = page.locator(step.selector).first();
    let actual = '';
    try {
      await el.waitFor({ state: 'visible', timeout: TIMEOUT });
      actual = (await el.innerText()).replace(/\s+/g, ' ').trim();
    } catch (e) {
      throw new Error(`요소 ${step.selector}가 보이지 않음`);
    }
    if (actual.indexOf(String(step.text).trim()) === -1) throw new Error(`문구 다름 (${step.selector}). 기대 "${step.text}", 실제 "${actual}"`);
  } else if (a === 'expectVisible') {
    try {
      await page.locator(step.selector).first().waitFor({ state: 'visible', timeout: TIMEOUT });
    } catch (e) {
      throw new Error(`요소 ${step.selector}가 보이지 않음`);
    }
  } else if (a === 'expectColor') {
    const prop = step.property || 'background-color';
    const el = page.locator(step.selector).first();
    await el.waitFor({ state: 'visible', timeout: TIMEOUT });
    const actual = rgbToHex(await el.evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop));
    const expected = String(step.value).toUpperCase();
    if (actual !== expected) throw new Error(`색상 다름 (${prop}). 기대 ${expected}, 실제 ${actual}`);
  } else if (a === 'wait') {
    await page.waitForTimeout(Number(step.value) || 500);
  } else {
    throw new Error('알 수 없는 단계: ' + a);
  }
}

async function main() {
  if (!CALLBACK || !RUN_ID || !NONCE) throw new Error('CALLBACK_URL, RUN_ID, NONCE 필요');
  const data = await getCases();
  console.log(`대상 ${data.baseUrl}, 케이스 ${data.cases.length}건`);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const results = [];
  for (const tc of data.cases) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    const page = await context.newPage();
    const state = { lastStatus: null };
    page.on('response', r => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) state.lastStatus = r.status(); });
    const r = { id: tc.id, status: '통과', actual: '기대 결과와 같음' };
    for (let i = 0; i < tc.steps.length; i++) {
      try {
        await runStep(page, tc.steps[i], data.baseUrl, state);
      } catch (e) {
        r.status = '실패';
        r.failedStep = i + 1;
        r.failedAction = tc.steps[i].action;
        r.actual = String(e.message).split('\n')[0].slice(0, 300);
        r.url = page.url();
        try { r.screenshot = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64'); } catch (_) {}
        break;
      }
    }
    console.log(`${tc.id} ${r.status}${r.status === '실패' ? ' - ' + r.actual : ''}`);
    results.push(r);
    await context.close();
  }
  await browser.close();
  await post({ results });
}

main().catch(async e => {
  console.error(e);
  try { await post({ error: String(e.message || e) }); } catch (_) {}
  process.exit(1);
});
