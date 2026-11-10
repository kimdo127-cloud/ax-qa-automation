// QA 실행기: 구글 시트(Apps Script 웹앱)에서 테스트케이스를 받아
// Playwright로 실제 브라우저에서 실행하고, 결과와 실패 화면을 시트로 돌려보낸다.
//
// 결과 상태
//   통과       기대 결과와 같음
//   실패       화면이 기대와 다름 (문구·색·이동·페이지 없음) → 결함
//   확인 필요  테스트가 가리킨 요소를 화면에서 찾지 못함 → 테스트 오류일 수 있어 기획자 판정
//   실행 불가  실행 단계가 비어 있음
// 실패·확인 필요는 새 브라우저로 한 번 더 실행해서, 두 번 다 실패할 때만 기록한다 (일시적 오류 제외).
const { chromium } = require('playwright');

const CALLBACK = process.env.CALLBACK_URL;
const RUN_ID = process.env.RUN_ID;
const NONCE = process.env.NONCE;
const TIMEOUT = 8000;

class TestError extends Error {} // 요소를 찾지 못한 경우 (테스트 오류 가능)

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
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(CALLBACK, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ run: RUN_ID, nonce: NONCE }, body)),
      });
      const t = (await res.text()).slice(0, 300);
      console.log('결과 전송:', res.status, t);
      if (res.ok) return;
    } catch (e) {
      console.log('결과 전송 실패, 재시도', e.message);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

// 선택자로 요소를 찾되, 화면에 아예 없으면 TestError
async function find(page, step) {
  const loc = step.selector ? page.locator(step.selector) : page.getByText(String(step.text || ''), { exact: false });
  try {
    await loc.first().waitFor({ state: 'attached', timeout: TIMEOUT });
  } catch (e) {
    throw new TestError(`화면에서 요소를 찾지 못함: ${step.selector || '"' + step.text + '"'}`);
  }
  return loc.first();
}

async function runStep(page, step, baseUrl, state) {
  const a = step.action;
  if (a === 'goto') {
    const target = new URL(step.url || '', baseUrl).toString();
    const resp = await page.goto(target, { waitUntil: 'load', timeout: 20000 });
    if (resp && resp.status() >= 400) throw new Error(`페이지가 열리지 않음 (${resp.status()}): ${target}`);
  } else if (a === 'fill') {
    const el = await find(page, step);
    await el.fill(String(step.value ?? ''), { timeout: TIMEOUT });
  } else if (a === 'click') {
    state.lastStatus = null;
    const el = await find(page, step);
    try {
      await el.click({ timeout: TIMEOUT });
    } catch (e) {
      throw new Error(`버튼을 누를 수 없음 (가려졌거나 비활성): ${step.selector || step.text}`);
    }
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
    const el = await find(page, step);
    let actual = '';
    try {
      await el.waitFor({ state: 'visible', timeout: TIMEOUT });
      actual = (await el.innerText()).replace(/\s+/g, ' ').trim();
    } catch (e) {
      throw new Error(`요소 ${step.selector}가 화면에 보이지 않음`);
    }
    if (actual.indexOf(String(step.text).trim()) === -1) throw new Error(`문구 다름 (${step.selector}). 기대 "${step.text}", 실제 "${actual}"`);
  } else if (a === 'expectVisible') {
    const el = await find(page, step);
    try {
      await el.waitFor({ state: 'visible', timeout: TIMEOUT });
    } catch (e) {
      throw new Error(`요소 ${step.selector}가 화면에 보이지 않음`);
    }
  } else if (a === 'expectColor') {
    const prop = step.property || 'background-color';
    const el = await find(page, step);
    const actual = rgbToHex(await el.evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop));
    const expected = String(step.value).toUpperCase();
    if (actual !== expected) throw new Error(`색상 다름 (${prop}). 기대 ${expected}, 실제 ${actual}`);
  } else if (a === 'wait') {
    await page.waitForTimeout(Math.min(Number(step.value) || 500, 5000));
  } else {
    throw new TestError('알 수 없는 테스트 단계: ' + a);
  }
}

async function runCase(browser, tc, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
  const page = await context.newPage();
  const state = { lastStatus: null };
  page.on('response', r => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) state.lastStatus = r.status(); });
  const r = { id: tc.id, status: '통과', actual: '기대 결과와 같음' };
  for (let i = 0; i < tc.steps.length; i++) {
    try {
      await runStep(page, tc.steps[i], baseUrl, state);
    } catch (e) {
      r.status = e instanceof TestError ? '확인 필요' : '실패';
      r.failedStep = i + 1;
      r.failedAction = tc.steps[i].action;
      r.actual = String(e.message).split('\n')[0].slice(0, 300);
      r.url = page.url();
      try { r.screenshot = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64'); } catch (_) {}
      break;
    }
  }
  await context.close();
  return r;
}

async function main() {
  if (!CALLBACK || !RUN_ID || !NONCE) throw new Error('CALLBACK_URL, RUN_ID, NONCE 필요');
  const data = await getCases();
  console.log(`대상 ${data.baseUrl}, 케이스 ${data.cases.length}건`);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const results = [];
  for (const tc of data.cases) {
    let r;
    if (!tc.steps || !tc.steps.length) {
      r = { id: tc.id, status: '실행 불가', actual: '실행 단계가 비어 있음' };
    } else {
      try {
        r = await runCase(browser, tc, data.baseUrl);
        if (r.status !== '통과') {
          const again = await runCase(browser, tc, data.baseUrl); // 일시적 오류 거르기
          if (again.status === '통과') { r = again; r.actual = '첫 실행 실패, 재실행 통과'; }
        }
      } catch (e) {
        r = { id: tc.id, status: '확인 필요', actual: '실행 중 오류: ' + String(e.message).slice(0, 200) };
      }
    }
    console.log(`${tc.id} ${r.status}${r.status !== '통과' ? ' - ' + r.actual : ''}`);
    results.push(r);
  }
  await browser.close();
  await post({ results });
}

main().catch(async e => {
  console.error(e);
  try { await post({ error: String(e.message || e) }); } catch (_) {}
  process.exit(1);
});
