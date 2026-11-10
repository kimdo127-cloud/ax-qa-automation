/**
 * QA 자동화 (구글 시트 + Apps Script)
 * 흐름: 입력(피그마·테스트 URL·기획 메모) → Gemini가 IA·시나리오·테스트케이스 작성
 *      → GitHub Actions(Playwright)가 실제 브라우저로 실행 → 결과·결함·스크린샷을 시트에 기록
 *      → 개발자가 '수정완료' 표기 → 다음 차수 실행 때 다시 확인해 통과면 종료, 아니면 재오픈
 * 비밀 값(Gemini 키, GitHub 토큰, 피그마 토큰)은 스크립트 속성에만 저장한다.
 */

var SHEETS = {
  INPUT: '입력',
  IA: 'IA',
  SC: '테스트 시나리오',
  TC: '테스트케이스',
  DEFECT: '결함',
  RUN: '실행 기록',
  SUMMARY: '요약'
};

var HEADERS = {
  '입력': ['입력 일시', '피그마 링크', '테스트 대상 URL', '기획 메모', '생성 결과'],
  'IA': ['IA ID', '화면', '영역', '요소', '유형', '디자인 기준(피그마)', '연결 테스트케이스', '최근 결과'],
  '테스트 시나리오': ['시나리오 ID', '시나리오', '관련 IA', '설명'],
  '테스트케이스': ['TC ID', '시나리오 ID', '테스트 항목', '관련 IA', '사전 조건', '수행 단계', '기대 결과', '실행 단계(자동)'],
  '결함': ['결함 ID', '발견 차수', 'TC ID', '관련 IA', '화면', '결함 내용', '재현 절차', '기대 결과', '실제 결과', '스크린샷', '스크린샷 원본', '심각도', '개발자 표기', '재확인 결과', '상태', '처리 이력'],
  '실행 기록': ['차수', '실행 ID', '시작', '종료', '테스트 대상 URL', '전체', '통과', '실패', '새 결함', '재확인 통과', '재오픈', '상태'],
  '요약': []
};

var TC_FIXED_COLS = 8; // 테스트케이스 시트의 고정 열 수 (이후는 차수별 결과 열)
var DEFAULT_MODEL = 'gemini-2.5-flash';
var DEFAULT_REPO = 'kimdo127-cloud/ax-qa-automation';

/* ───────────── 메뉴 · 화면 ───────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('QA 자동화')
    .addItem('QA 실행 창 열기', 'showSidebar')
    .addSeparator()
    .addItem('설정 (키 입력)', 'showSettings')
    .addItem('시트 초기 구성', 'setupSheets')
    .addToUi();
}

function showSidebar() {
  setupSheets();
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('QA 자동화');
  SpreadsheetApp.getUi().showSidebar(html);
}

function showSettings() {
  var html = HtmlService.createHtmlOutputFromFile('Settings').setWidth(460).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'QA 자동화 설정');
}

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  props_().setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var h = HEADERS[name];
    if (h.length && sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#F2F4F6');
      sh.setFrozenRows(1);
    }
  });
  var tc = ss.getSheetByName(SHEETS.TC);
  tc.hideColumns(8);
  var d = ss.getSheetByName(SHEETS.DEFECT);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(['수정중', '수정완료'], true).setAllowInvalid(false).build();
  d.getRange(2, 13, 500, 1).setDataValidation(rule);
  var first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' || first.getName() === '시트1') {
    if (first.getLastRow() === 0) ss.deleteSheet(first);
  }
  return true;
}

/* ───────────── 설정 ───────────── */

function props_() { return PropertiesService.getScriptProperties(); }

function getSettingsStatus() {
  var p = props_().getProperties();
  return {
    gemini: !!p.GEMINI_API_KEY,
    github: !!p.GITHUB_TOKEN,
    figma: !!p.FIGMA_TOKEN,
    repo: p.GITHUB_REPO || DEFAULT_REPO,
    webappUrl: p.WEBAPP_URL || '',
    model: p.GEMINI_MODEL || DEFAULT_MODEL
  };
}

function saveSettings(form) {
  var p = props_();
  var map = { gemini: 'GEMINI_API_KEY', github: 'GITHUB_TOKEN', figma: 'FIGMA_TOKEN', repo: 'GITHUB_REPO', webappUrl: 'WEBAPP_URL', model: 'GEMINI_MODEL' };
  Object.keys(map).forEach(function (k) {
    var v = (form[k] || '').trim();
    if (v) p.setProperty(map[k], v);
  });
  return getSettingsStatus();
}

/* ───────────── ① IA·시나리오·테스트케이스 만들기 ───────────── */

function generateTestDesign(form) {
  var ss = ss_();
  var figmaUrl = (form.figmaUrl || '').trim();
  var targetUrl = (form.targetUrl || '').trim();
  var memo = (form.memo || '').trim();
  if (!targetUrl) throw new Error('테스트 대상 URL을 입력하세요.');
  if (!props_().getProperty('GEMINI_API_KEY')) throw new Error('설정에서 Gemini API 키를 먼저 입력하세요.');

  var design = figmaUrl ? readFigma_(figmaUrl) : '(피그마 없음: 기획 메모만 기준으로 함)';
  var pages = crawl_(targetUrl);
  var prompt = buildPrompt_(design, pages, memo, targetUrl);
  var out = callGemini_(prompt);

  // 기존 테스트케이스가 있으면 백업 후 새로 작성
  var tcSheet = ss.getSheetByName(SHEETS.TC);
  if (tcSheet.getLastRow() > 1) {
    var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'MMdd_HHmm');
    tcSheet.copyTo(ss).setName('테스트케이스_백업_' + stamp);
  }
  writeRows_(SHEETS.IA, (out.ia || []).map(function (r) {
    return [r.id, r.screen, r.area, r.element, r.type, r.design || '', '', ''];
  }));
  writeRows_(SHEETS.SC, (out.scenarios || []).map(function (r) {
    return [r.id, r.title, (r.iaIds || []).join(', '), r.description || ''];
  }));
  resetTcSheet_();
  writeRows_(SHEETS.TC, (out.testcases || []).map(function (r) {
    return [r.id, r.scenarioId, r.title, (r.iaIds || []).join(', '), r.precondition || '', r.stepsText || '', r.expected || '', JSON.stringify(r.steps || [])];
  }));
  linkIaToTc_();
  ss.getSheetByName(SHEETS.INPUT).appendRow([now_(), figmaUrl, targetUrl, memo,
    'IA ' + (out.ia || []).length + '행 · 시나리오 ' + (out.scenarios || []).length + '개 · 테스트케이스 ' + (out.testcases || []).length + '개']);
  props_().setProperty('TARGET_URL', targetUrl);
  rebuildSummary_();
  return { ia: (out.ia || []).length, scenarios: (out.scenarios || []).length, testcases: (out.testcases || []).length };
}

function resetTcSheet_() {
  var sh = ss_().getSheetByName(SHEETS.TC);
  if (sh.getMaxColumns() > TC_FIXED_COLS) sh.deleteColumns(TC_FIXED_COLS + 1, sh.getMaxColumns() - TC_FIXED_COLS);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).clearContent().setBackground(null);
  var d = ss_().getSheetByName(SHEETS.DEFECT);
  if (d.getLastRow() > 1) {
    // 테스트케이스를 새로 만들면 이전 결함은 그대로 두되 종료 처리하지 않는다 (기록 보존)
  }
}

function writeRows_(name, rows) {
  var sh = ss_().getSheetByName(name);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent().setBackground(null);
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  sh.autoResizeColumns(1, Math.min(sh.getLastColumn(), 7));
}

function readFigma_(url) {
  var token = props_().getProperty('FIGMA_TOKEN');
  if (!token) throw new Error('설정에서 피그마 토큰을 먼저 입력하세요.');
  var m = url.match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('피그마 링크 형식이 아닙니다.');
  var res = UrlFetchApp.fetch('https://api.figma.com/v1/files/' + m[1], { headers: { 'X-Figma-Token': token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('피그마 파일을 읽지 못했습니다 (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  var doc = JSON.parse(res.getContentText()).document;
  var lines = [];
  (doc.children || []).forEach(function (canvas) {
    (canvas.children || []).forEach(function (frame) {
      if (frame.type !== 'FRAME' && frame.type !== 'SECTION' && frame.type !== 'COMPONENT') return;
      lines.push('[화면] ' + frame.name);
      walkFigma_(frame, 1, lines);
    });
  });
  return lines.slice(0, 600).join('\n');
}

function walkFigma_(node, depth, lines) {
  (node.children || []).forEach(function (c) {
    if (c.visible === false) return;
    var pad = new Array(depth + 1).join('  ');
    var fill = solidHex_(c.fills);
    if (c.type === 'TEXT') {
      var st = c.style || {};
      lines.push(pad + 'TEXT "' + (c.characters || '').replace(/\s+/g, ' ').slice(0, 80) + '"' +
        (st.fontSize ? ' size ' + st.fontSize : '') + (st.fontWeight ? ' weight ' + st.fontWeight : '') + (fill ? ' color ' + fill : ''));
    } else {
      if (fill || (c.children && c.children.length)) {
        lines.push(pad + c.type + ' "' + c.name + '"' + (fill ? ' fill ' + fill : ''));
      }
      if (depth < 8) walkFigma_(c, depth + 1, lines);
    }
  });
}

function solidHex_(fills) {
  if (!fills || !fills.length) return '';
  var f = fills.filter(function (x) { return x.type === 'SOLID' && x.visible !== false; })[0];
  if (!f) return '';
  var c = f.color;
  return '#' + [c.r, c.g, c.b].map(function (v) { var h = Math.round(v * 255).toString(16); return h.length < 2 ? '0' + h : h; }).join('').toUpperCase();
}

function crawl_(startUrl) {
  var base = startUrl.replace(/[^\/]*$/, '');
  var queue = [startUrl], seen = {}, pages = [];
  while (queue.length && pages.length < 6) {
    var url = queue.shift();
    if (seen[url]) continue;
    seen[url] = true;
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() >= 400) continue;
    var html = res.getContentText();
    var re = /href="([^"#?]+\.html)"/g, mm;
    while ((mm = re.exec(html))) {
      var abs = mm[1].indexOf('http') === 0 ? mm[1] : base + mm[1].replace(/^\.\//, '');
      if (abs.indexOf(base) === 0 && !seen[abs]) queue.push(abs);
    }
    var clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\s{2,}/g, ' ');
    pages.push({ path: url.replace(base, '') || 'index.html', html: clean.slice(0, 6000) });
  }
  if (!pages.length) throw new Error('테스트 대상 URL을 열지 못했습니다: ' + startUrl);
  return pages;
}

function buildPrompt_(design, pages, memo, targetUrl) {
  return [
    '너는 웹 서비스 QA 담당자다. 디자인(피그마)과 기획 메모를 기준으로 IA, 테스트 시나리오, 테스트케이스를 작성한다.',
    '',
    '규칙',
    '1. 기대 결과는 반드시 피그마 디자인과 기획 메모에서만 가져온다. HTML은 요소를 찾을 선택자와 페이지 경로를 확인하는 용도로만 쓴다. HTML 내용이 피그마와 달라도 기대 결과는 피그마 기준이다.',
    '2. IA는 화면 > 영역 > 요소(제목, 입력칸, 버튼, 링크, 탭, 카드, 안내 문구) 단위까지 빠짐없이 쓴다. ID는 IA-01부터.',
    '3. 시나리오는 사용자 흐름 단위(SC-01부터), 테스트케이스는 시나리오별 확인 항목(TC-01부터). 테스트케이스는 12~18개.',
    '4. 꼭 포함: 각 화면 제목·버튼·탭 문구가 피그마와 같은지(expectTextIn으로 해당 요소를 지정. 같은 글자가 화면 다른 곳에 있어도 구분되게), 주요 버튼 색이 피그마와 같은지(expectColor, 피그마 fill 값), 모든 버튼·링크·탭을 눌렀을 때 맞는 화면으로 이동하는지(click 후 expectUrlContains와 expectText), 기획 메모의 예외 동작(오류 문구 등).',
    '5. 각 테스트케이스는 goto로 시작한다(url은 페이지 파일명). 로그인이 필요한 화면은 기획 메모의 테스트 계정으로 로그인 단계를 먼저 넣는다. 테스트케이스끼리 상태를 공유하지 않는다.',
    '6. steps에 쓸 수 있는 action과 필드:',
    '   goto {url} / fill {selector, value} / click {selector 또는 text} / expectUrlContains {value} / expectText {text} / expectTextIn {selector, text} / expectVisible {selector} / expectColor {selector, property(기본 background-color), value(#RRGGBB)} / wait {value(ms)}',
    '   selector는 아래 HTML에 실제로 있는 id·class 기반 CSS 선택자만 쓴다. 같은 클래스가 여럿이면 첫 번째 요소가 선택된다.',
    '7. stepsText는 사람이 읽는 수행 단계(1. 2. 3.), expected는 사람이 읽는 기대 결과. 모두 한국어.',
    '',
    'JSON으로만 답한다. 형식:',
    '{"ia":[{"id","screen","area","element","type","design"}],',
    ' "scenarios":[{"id","title","iaIds":[],"description"}],',
    ' "testcases":[{"id","scenarioId","title","iaIds":[],"precondition","stepsText","expected","steps":[{"action","url","selector","text","value","property"}]}]}',
    '(design 필드에는 피그마 기준 값: 문구, 색, 크기 등을 짧게)',
    '',
    '=== 피그마 디자인 ===',
    design,
    '',
    '=== 기획 메모 ===',
    memo || '(없음)',
    '',
    '=== 테스트 대상 HTML (시작 주소 ' + targetUrl + ') ===',
    pages.map(function (p) { return '--- ' + p.path + ' ---\n' + p.html; }).join('\n')
  ].join('\n');
}

function callGemini_(prompt) {
  var key = props_().getProperty('GEMINI_API_KEY');
  var model = props_().getProperty('GEMINI_MODEL') || DEFAULT_MODEL;
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  var body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
  };
  var lastErr = '';
  for (var i = 0; i < 3; i++) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200) {
      var data = JSON.parse(res.getContentText());
      var text = data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
      text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');
      return JSON.parse(text);
    }
    lastErr = code + ' ' + res.getContentText().slice(0, 300);
    if (code !== 429 && code < 500) break;
    Utilities.sleep(4000 * (i + 1));
  }
  throw new Error('Gemini 호출 실패: ' + lastErr);
}

function linkIaToTc_() {
  var ss = ss_();
  var tc = ss.getSheetByName(SHEETS.TC), ia = ss.getSheetByName(SHEETS.IA);
  if (tc.getLastRow() < 2 || ia.getLastRow() < 2) return;
  var map = {};
  tc.getRange(2, 1, tc.getLastRow() - 1, 4).getValues().forEach(function (r) {
    String(r[3]).split(/\s*,\s*/).forEach(function (id) { if (id) (map[id] = map[id] || []).push(r[0]); });
  });
  var ids = ia.getRange(2, 1, ia.getLastRow() - 1, 1).getValues();
  ia.getRange(2, 7, ids.length, 1).setValues(ids.map(function (r) { return [(map[r[0]] || []).join(', ')]; }));
}

/* ───────────── ② N차 QA 실행 ───────────── */

function startQaRun() {
  var p = props_();
  ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'WEBAPP_URL'].forEach(function (k) {
    if (!p.getProperty(k)) throw new Error('설정에서 ' + k + ' 값을 먼저 입력하세요.');
  });
  var ss = ss_();
  var tc = ss.getSheetByName(SHEETS.TC);
  if (tc.getLastRow() < 2) throw new Error('먼저 ① IA·테스트케이스를 만드세요.');
  var run = ss.getSheetByName(SHEETS.RUN);
  var round = Math.max(0, run.getLastRow() - 1) + 1;
  var runId = 'R' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd-HHmmss');
  var nonce = Utilities.getUuid();
  var target = p.getProperty('TARGET_URL');
  p.setProperty('RUN_' + runId, JSON.stringify({ nonce: nonce, round: round, target: target }));
  run.appendRow([round + '차', runId, now_(), '', target, '', '', '', '', '', '', '실행 중']);

  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + (p.getProperty('GITHUB_REPO') || DEFAULT_REPO) + '/actions/workflows/qa.yml/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + p.getProperty('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ ref: 'main', inputs: { callback_url: p.getProperty('WEBAPP_URL'), run_id: runId, nonce: nonce } })
  });
  if (res.getResponseCode() !== 204) {
    setRunStatus_(runId, '시작 실패: ' + res.getResponseCode());
    throw new Error('GitHub Actions 실행 요청 실패 (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
  return { runId: runId, round: round };
}

function getRunStatus(runId) {
  var row = findRunRow_(runId);
  if (!row) return { status: '없음' };
  var v = ss_().getSheetByName(SHEETS.RUN).getRange(row, 1, 1, 12).getValues()[0];
  return { round: v[0], total: v[5], pass: v[6], fail: v[7], newDefects: v[8], verified: v[9], reopened: v[10], status: v[11] };
}

function findRunRow_(runId) {
  var sh = ss_().getSheetByName(SHEETS.RUN);
  if (sh.getLastRow() < 2) return 0;
  var ids = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === runId) return i + 2;
  return 0;
}

function setRunStatus_(runId, status) {
  var row = findRunRow_(runId);
  if (row) ss_().getSheetByName(SHEETS.RUN).getRange(row, 12).setValue(status);
}

/* ───────────── 웹앱: GitHub Actions와 주고받기 ───────────── */

function doGet(e) {
  var q = e.parameter || {};
  if (q.action !== 'cases') return json_({ ok: true, service: 'QA 자동화' });
  var info = checkRun_(q.run, q.nonce);
  if (!info) return json_({ error: '실행 정보가 맞지 않습니다.' });
  var tc = ss_().getSheetByName(SHEETS.TC);
  var rows = tc.getRange(2, 1, tc.getLastRow() - 1, TC_FIXED_COLS).getValues();
  var cases = rows.filter(function (r) { return r[0]; }).map(function (r) {
    var steps = [];
    try { steps = JSON.parse(r[7] || '[]'); } catch (err) {}
    return { id: r[0], steps: steps };
  });
  return json_({ baseUrl: info.target, round: info.round, cases: cases });
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var info = checkRun_(body.run, body.nonce);
  if (!info) return json_({ error: '실행 정보가 맞지 않습니다.' });
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (body.error) {
      setRunStatus_(body.run, '오류: ' + String(body.error).slice(0, 200));
    } else {
      applyResults_(body.run, info, body.results || []);
    }
    props_().deleteProperty('RUN_' + body.run);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true });
}

function checkRun_(runId, nonce) {
  if (!runId || !nonce) return null;
  var raw = props_().getProperty('RUN_' + runId);
  if (!raw) return null;
  var info = JSON.parse(raw);
  return info.nonce === nonce ? info : null;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────── 결과 반영: 테스트케이스 · 결함 · IA · 요약 ───────────── */

function applyResults_(runId, info, results) {
  var ss = ss_();
  var round = info.round;
  var tc = ss.getSheetByName(SHEETS.TC);
  var d = ss.getSheetByName(SHEETS.DEFECT);

  // 1) 테스트케이스 시트에 이번 차수 열 추가
  var col = tc.getLastColumn() + 1;
  tc.getRange(1, col).setValue(round + '차 결과').setFontWeight('bold').setBackground('#F2F4F6');
  var tcRows = tc.getRange(2, 1, tc.getLastRow() - 1, TC_FIXED_COLS).getValues();
  var tcById = {};
  tcRows.forEach(function (r, i) { tcById[r[0]] = { row: i + 2, data: r }; });

  // 2) 열린 결함 목록 (TC별 하나)
  var defects = d.getLastRow() > 1 ? d.getRange(2, 1, d.getLastRow() - 1, 16).getValues() : [];
  var openByTc = {};
  defects.forEach(function (r, i) { if (r[0] && r[14] !== '종료') openByTc[r[2]] = { row: i + 2, data: r }; });
  var seq = defects.length;

  var iaScreen = iaScreenMap_();
  var folder = shotFolder_();
  var stat = { total: 0, pass: 0, fail: 0, newDefects: 0, verified: 0, reopened: 0 };

  results.forEach(function (r) {
    var t = tcById[r.id];
    if (!t) return;
    stat.total++;
    var cell = tc.getRange(t.row, col);
    var open = openByTc[r.id];
    if (r.status === '통과') {
      stat.pass++;
      cell.setValue('통과').setBackground('#E8F5E9');
      if (open) {
        var wasMarked = open.data[12] === '수정완료';
        d.getRange(open.row, 14, 1, 3).setValues([[round + '차 재확인 통과', '종료',
          appendLog_(open.data[15], round + '차: 다시 실행해 통과 확인 → 종료' + (wasMarked ? '' : ' (개발자 표기 없이 통과)'))]]);
        d.getRange(open.row, 1, 1, 16).setBackground('#F1F8E9');
        stat.verified++;
      }
    } else {
      stat.fail++;
      var shot = r.screenshot ? saveShot_(folder, runId + '_' + r.id, r.screenshot) : null;
      if (open) {
        cell.setValue('실패 → ' + open.data[0]).setBackground('#FDECEA');
        if (open.data[12] === '수정완료') {
          d.getRange(open.row, 13, 1, 4).setValues([['', round + '차 재오픈 (수정완료 표기됐지만 재현됨)', '재오픈',
            appendLog_(open.data[15], round + '차: 개발자 수정완료 표기 → 다시 실행해 재현 → 재오픈')]]);
          d.getRange(open.row, 1, 1, 16).setBackground('#FFF3E0');
          stat.reopened++;
        } else {
          d.getRange(open.row, 16).setValue(appendLog_(open.data[15], round + '차: 계속 실패'));
        }
        if (shot) setShot_(d, open.row, shot);
        d.getRange(open.row, 9).setValue(r.actual);
      } else {
        seq++;
        var id = 'D-' + ('00' + seq).slice(-3);
        var ia = String(t.data[3]);
        var screen = ia.split(/\s*,\s*/).map(function (x) { return iaScreen[x]; }).filter(String)[0] || '';
        var sev = (r.failedAction === 'expectColor' || r.failedAction === 'expectText' || r.failedAction === 'expectTextIn') ? '보통' : '높음';
        d.appendRow([id, round + '차', r.id, ia, screen, t.data[2], t.data[5], t.data[6], r.actual, '', '', sev, '', '', '열림',
          round + '차: 발견 (' + now_() + ')']);
        var row = d.getLastRow();
        if (shot) setShot_(d, row, shot);
        cell.setValue('실패 → ' + id).setBackground('#FDECEA');
        stat.newDefects++;
      }
    }
  });

  var runRow = findRunRow_(runId);
  ss.getSheetByName(SHEETS.RUN).getRange(runRow, 4, 1, 9).setValues([[now_(), info.target, stat.total, stat.pass, stat.fail, stat.newDefects, stat.verified, stat.reopened, '완료']]);
  updateIaResults_(round, col);
  rebuildSummary_();
}

function appendLog_(prev, line) { return (prev ? prev + '\n' : '') + line; }

function iaScreenMap_() {
  var ia = ss_().getSheetByName(SHEETS.IA);
  var m = {};
  if (ia.getLastRow() > 1) ia.getRange(2, 1, ia.getLastRow() - 1, 2).getValues().forEach(function (r) { m[r[0]] = r[1]; });
  return m;
}

function updateIaResults_(round, col) {
  var ss = ss_();
  var tc = ss.getSheetByName(SHEETS.TC), ia = ss.getSheetByName(SHEETS.IA);
  if (ia.getLastRow() < 2) return;
  var res = {};
  tc.getRange(2, 1, tc.getLastRow() - 1, col).getValues().forEach(function (r) {
    var v = String(r[col - 1]);
    String(r[3]).split(/\s*,\s*/).forEach(function (id) {
      if (!id) return;
      if (v.indexOf('실패') === 0) (res[id] = res[id] || []).push(v.replace('실패 → ', ''));
      else if (!res[id]) res[id] = [];
    });
  });
  var ids = ia.getRange(2, 1, ia.getLastRow() - 1, 1).getValues();
  var vals = ids.map(function (r) {
    var x = res[r[0]];
    if (!x) return ['테스트 없음'];
    return [x.length ? round + '차 실패 (' + x.join(', ') + ')' : round + '차 통과'];
  });
  var range = ia.getRange(2, 8, ids.length, 1);
  range.setValues(vals);
  range.setBackgrounds(vals.map(function (v) { return [v[0].indexOf('실패') > -1 ? '#FDECEA' : (v[0].indexOf('통과') > -1 ? '#E8F5E9' : null)]; }));
}

function shotFolder_() {
  var p = props_();
  var id = p.getProperty('SHOT_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var f = DriveApp.createFolder('QA 자동화 스크린샷');
  p.setProperty('SHOT_FOLDER_ID', f.getId());
  return f;
}

function saveShot_(folder, name, b64) {
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', name + '.jpg');
  var file = folder.createFile(blob);
  return { url: file.getUrl(), b64: b64 };
}

function setShot_(sheet, row, shot) {
  try {
    var img = SpreadsheetApp.newCellImage().setSourceUrl('data:image/jpeg;base64,' + shot.b64)
      .setAltTextTitle('실패 화면').build();
    sheet.getRange(row, 10).setValue(img);
    sheet.setRowHeight(row, 180);
  } catch (e) {
    sheet.getRange(row, 10).setValue('(원본 링크 참고)');
  }
  sheet.getRange(row, 11).setFormula('=HYPERLINK("' + shot.url + '","원본 보기")');
}

function rebuildSummary_() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEETS.SUMMARY);
  sh.clear();
  var ia = ss.getSheetByName(SHEETS.IA), tc = ss.getSheetByName(SHEETS.TC), d = ss.getSheetByName(SHEETS.DEFECT), run = ss.getSheetByName(SHEETS.RUN);
  var iaRows = ia.getLastRow() > 1 ? ia.getRange(2, 1, ia.getLastRow() - 1, 8).getValues() : [];
  var dRows = d.getLastRow() > 1 ? d.getRange(2, 1, d.getLastRow() - 1, 16).getValues() : [];
  var screens = {};
  iaRows.forEach(function (r) {
    var s = screens[r[1]] = screens[r[1]] || { ia: 0, fail: 0, open: 0, closed: 0 };
    s.ia++;
    if (String(r[7]).indexOf('실패') > -1) s.fail++;
  });
  dRows.forEach(function (r) {
    var s = screens[r[4]] = screens[r[4]] || { ia: 0, fail: 0, open: 0, closed: 0 };
    if (r[14] === '종료') s.closed++; else s.open++;
  });
  var out = [['화면별 현황', '', '', '', ''], ['화면', 'IA 요소 수', '최근 차수 실패 요소', '열린 결함', '종료 결함']];
  Object.keys(screens).forEach(function (k) { var s = screens[k]; out.push([k, s.ia, s.fail, s.open, s.closed]); });
  sh.getRange(1, 1, out.length, 5).setValues(out);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sh.getRange(2, 1, 1, 5).setFontWeight('bold').setBackground('#F2F4F6');
  var start = out.length + 2;
  var runRows = run.getLastRow() > 1 ? run.getRange(2, 1, run.getLastRow() - 1, 12).getValues() : [];
  var r2 = [['차수별 결과', '', '', '', '', ''], ['차수', '전체', '통과', '실패', '재확인 통과', '재오픈']];
  runRows.forEach(function (r) { if (r[11] === '완료') r2.push([r[0], r[5], r[6], r[7], r[9], r[10]]); });
  sh.getRange(start, 1, r2.length, 6).setValues(r2);
  sh.getRange(start, 1).setFontWeight('bold').setFontSize(13);
  sh.getRange(start + 1, 1, 1, 6).setFontWeight('bold').setBackground('#F2F4F6');
  sh.autoResizeColumns(1, 6);
}

/* ───────────── 공통 ───────────── */

function ss_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'); }
