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
  HISTORY: '히스토리',
  SUMMARY: '요약'
};

var HEADERS = {
  '입력': ['입력 일시', '피그마 링크', '테스트 대상 URL', '추가 전달 사항', '생성 결과'],
  'IA': ['IA ID', '화면', '영역', '요소', '유형', '디자인 기준(피그마)', '연결 테스트케이스', '최근 결과'],
  '테스트 시나리오': ['시나리오 ID', '시나리오', '관련 IA', '설명'],
  '테스트케이스': ['TC ID', '시나리오 ID', '테스트 항목', '관련 IA', '사전 조건', '수행 단계', '기대 결과', '실행 단계(자동)', '내용 확인값(자동)'],
  '결함': ['결함 ID', '발견 차수', 'TC ID', '관련 IA', '화면', '결함 내용', '재현 절차', '기대 결과', '실제 결과', '스크린샷', '스크린샷 원본', '심각도', '개발자 표기', '재확인 결과', '상태', '처리 이력', '확인 방식'],
  '실행 기록': ['차수', '실행 ID', '시작', '종료', '테스트 대상 URL', '전체', '통과', '실패', '새 결함', '재확인 통과', '재오픈', '상태'],
  '히스토리': ['일시', '구분', '대상', '내용', '결과', '처리'],
  '요약': []
};

var TC_FIXED_COLS = 9;          // 테스트케이스 고정 열 (이후는 차수별 결과 열)
var DCOLS = 17;                 // 결함 탭 열 수
var DEFECT_STATUS = ['열림', '재오픈', '확인 필요', '종료', '제외'];
var OPEN_STATUS = { '열림': 1, '재오픈': 1, '확인 필요': 1 };   // 아직 끝나지 않은 결함
var RUN_TIMEOUT_MIN = 15;       // 이 시간 동안 결과가 안 오면 실행 실패로 처리
var GEN_TIME_LIMIT_MS = 270000; // Apps Script 6분 제한 전에 멈추기
var DEFAULT_REPO = 'kimdo127-cloud/ax-qa-automation';
// 시연용 예제 피그마(4회차_QA자동화_디자인)는 미리 읽어 둔 내용을 쓴다 (피그마 읽기 한도 회피)
var EXAMPLE_FIGMA = { key: 'tDCEsd7ZqCDYvOAV0fyC2M', text: "[화면] 로그인\n  TEXT \"한빛수학\" size 15 weight 700 color #3182F6\n  TEXT \"학부모 로그인\" size 24 weight 700 color #191F28\n  TEXT \"이메일\" size 13 weight 400 color #4E5968\n  FRAME \"이메일 입력칸\" fill #FFFFFF\n    TEXT \"example@email.com\" size 16 weight 400 color #8B95A1\n  TEXT \"비밀번호\" size 13 weight 400 color #4E5968\n  FRAME \"비밀번호 입력칸\" fill #FFFFFF\n    TEXT \"비밀번호 입력\" size 16 weight 400 color #8B95A1\n  TEXT \"이메일 또는 비밀번호가 맞지 않습니다.\" size 13 weight 400 color #F04452\n  FRAME \"로그인 버튼\" fill #3182F6\n    TEXT \"로그인\" size 16 weight 700 color #FFFFFF\n  TEXT \"비밀번호를 잊으셨나요?\" size 13 weight 400 color #8B95A1\n[화면] 수강 신청\n  TEXT \"수강 신청\" size 20 weight 700 color #191F28\n  FRAME \"탭\"\n    FRAME \"수강 신청 탭\"\n      TEXT \"수강 신청\" size 15 weight 700 color #191F28\n    FRAME \"신청 내역 탭\"\n      TEXT \"신청 내역\" size 15 weight 400 color #8B95A1\n  FRAME \"중2 내신 대비반 카드\" fill #FFFFFF\n    FRAME \"수업 정보\"\n      TEXT \"중2 내신 대비반\" size 16 weight 700 color #191F28\n      TEXT \"화·목 19:00 · 월 32만원\" size 13 weight 400 color #4E5968\n    FRAME \"신청하기 버튼\" fill #3182F6\n      TEXT \"신청하기\" size 14 weight 700 color #FFFFFF\n  FRAME \"중3 심화반 카드\" fill #FFFFFF\n    FRAME \"수업 정보\"\n      TEXT \"중3 심화반\" size 16 weight 700 color #191F28\n      TEXT \"월·수 18:00 · 월 35만원\" size 13 weight 400 color #4E5968\n    FRAME \"신청하기 버튼\" fill #3182F6\n      TEXT \"신청하기\" size 14 weight 700 color #FFFFFF\n  FRAME \"고1 선행반 카드\" fill #FFFFFF\n    FRAME \"수업 정보\"\n      TEXT \"고1 선행반\" size 16 weight 700 color #191F28\n      TEXT \"토 10:00 · 월 30만원\" size 13 weight 400 color #4E5968\n    FRAME \"마감 버튼\" fill #E5E8EB\n      TEXT \"마감\" size 14 weight 700 color #8B95A1\n[화면] 신청 완료\n  FRAME \"완료 아이콘\" fill #3182F6\n    TEXT \"✓\" size 32 weight 700 color #FFFFFF\n  TEXT \"신청이 완료되었습니다\" size 20 weight 700 color #191F28\n  TEXT \"중2 내신 대비반 수강 신청이 접수되었습니다.\" size 15 weight 400 color #4E5968\n  FRAME \"신청 내역 보기 버튼\" fill #3182F6\n    TEXT \"신청 내역 보기\" size 16 weight 700 color #FFFFFF\n[화면] 신청 내역\n  TEXT \"신청 내역\" size 20 weight 700 color #191F28\n  FRAME \"탭\"\n    FRAME \"수강 신청 탭\"\n      TEXT \"수강 신청\" size 15 weight 400 color #8B95A1\n    FRAME \"신청 내역 탭\"\n      TEXT \"신청 내역\" size 15 weight 700 color #191F28\n  FRAME \"중2 내신 대비반 카드\" fill #FFFFFF\n    FRAME \"수업 정보\"\n      TEXT \"중2 내신 대비반\" size 16 weight 700 color #191F28\n      TEXT \"신청 접수\" size 13 weight 400 color #4E5968" };
var TAB_ORDER = ['요약', '결함', '테스트케이스', '히스토리', 'IA', '테스트 시나리오'];

/* ───────────── 메뉴 · 화면 ───────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('QA 자동화')
    .addItem('QA 실행', 'showRunDialog')
    .addItem('재확인 · 처리할 결함', 'showSidebar')
    .addSeparator()
    .addItem('설정 (키 입력)', 'showSettings')
    .addItem('처음부터 다시 (모든 기록 지우기)', 'resetAll')
    .addToUi();
}

// QA 실행 팝업: 무엇을 테스트할지 입력
function showRunDialog() {
  setupSheets();
  var html = HtmlService.createHtmlOutputFromFile('Run').setWidth(480).setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'QA 실행');
}

// 사이드 패널: 진행 상황 + 재확인 대기 + 기획자 확인 필요
function showSidebar() {
  setupSheets();
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('재확인 · 처리할 결함');
  SpreadsheetApp.getUi().showSidebar(html);
}

function openSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (sh) ss.setActiveSheet(sh);
}

function openDefectRow(defectId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var d = ss.getSheetByName(SHEETS.DEFECT);
  var row = findDefectRow_(defectId);
  ss.setActiveSheet(d);
  if (row) d.setActiveRange(d.getRange(row, 1, 1, DCOLS));
}

function showSettings() {
  var html = HtmlService.createHtmlOutputFromFile('Settings').setWidth(460).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'QA 자동화 설정');
}

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  props_().setProperty('SPREADSHEET_ID', ss.getId());
  var created = false;
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); created = true; }
    var h = HEADERS[name];
    if (h.length && sh.getRange(1, 1, 1, h.length).getValues()[0].join('|') !== h.join('|')) writeHeaderOnly_(sh, h);
  });
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName();
    if ((n === 'Sheet1' || n === '시트1') && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  // 탭 순서·서식은 처음 구성할 때나 순서가 틀렸을 때만 (매번 하면 탭이 차례로 열려 보임)
  var names = ss.getSheets().map(function (s) { return s.getName(); });
  var ok = TAB_ORDER.every(function (n, i) { return names[i] === n; });
  if (created || !ok) arrangeSheets_(ss);
  return true;
}

function clearBody_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return;
  sh.insertRowAfter(last);
  sh.deleteRows(2, last - 1);
}

// 머리글만 다시 쓴다 (기존 데이터·차수 열 보존)
function writeHeaderOnly_(sh, h) {
  sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#F2F4F6');
  sh.setFrozenRows(1);
}

function writeHeader_(sh, h) {
  sh.getRange(1, 1, 1, sh.getMaxColumns()).clearContent();
  writeHeaderOnly_(sh, h);
}

function arrangeSheets_(ss) {
  var color = { '요약': '#191F28', '결함': '#F04452', '테스트케이스': '#3182F6', '히스토리': '#4E5968', 'IA': '#8B95A1', '테스트 시나리오': '#8B95A1' };
  var active = ss.getActiveSheet();
  TAB_ORDER.forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (!sh) return;
    ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1);
    sh.setTabColor(color[n]); sh.showSheet();
  });
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName();
    if (n === SHEETS.INPUT || n === SHEETS.RUN || n.indexOf('백업') > -1) sh.hideSheet();
  });
  var d = ss.getSheetByName(SHEETS.DEFECT);
  [70, 50, 70, 90, 80, 200, 200, 180, 200, 130, 70, 50, 90, 160, 80, 260, 70].forEach(function (w, i) { d.setColumnWidth(i + 1, w); });
  d.getRange('A:Q').setWrap(true).setVerticalAlignment('top');
  d.getRange(2, 13, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['수정중', '수정완료'], true).setAllowInvalid(false).build());
  d.getRange(2, 15, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(DEFECT_STATUS, true).setAllowInvalid(false).build());
  d.getRange(2, 17, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['AI', '직접'], true).setAllowInvalid(false).build());
  var tc = ss.getSheetByName(SHEETS.TC);
  [55, 60, 200, 110, 160, 240, 240].forEach(function (w, i) { tc.setColumnWidth(i + 1, w); });
  tc.getRange('A:G').setWrap(true).setVerticalAlignment('top');
  tc.hideColumns(8, 2);
  var h = ss.getSheetByName(SHEETS.HISTORY);
  [120, 80, 90, 360, 160, 70].forEach(function (w, i) { h.setColumnWidth(i + 1, w); });
  var ia = ss.getSheetByName(SHEETS.IA);
  [55, 80, 70, 140, 60, 260, 120, 140].forEach(function (w, i) { ia.setColumnWidth(i + 1, w); });
  ss.setActiveSheet(active && active.isSheetHidden && !active.isSheetHidden() ? active : ss.getSheetByName(SHEETS.SUMMARY));
}

// 새 프로젝트·시연용: 모든 기록을 지우고 빈 상태로
function resetAll() {
  var ss = ss_();
  [SHEETS.INPUT, SHEETS.IA, SHEETS.SC, SHEETS.TC, SHEETS.DEFECT, SHEETS.RUN, SHEETS.HISTORY].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh) return;
    clearBody_(sh);
    writeHeader_(sh, HEADERS[n]);
  });
  var tc = ss.getSheetByName(SHEETS.TC);
  if (tc && tc.getMaxColumns() > TC_FIXED_COLS) tc.deleteColumns(TC_FIXED_COLS + 1, tc.getMaxColumns() - TC_FIXED_COLS);
  ss.getSheets().forEach(function (sh) { if (sh.getName().indexOf('백업') > -1) ss.deleteSheet(sh); });
  var p = props_();
  Object.keys(p.getProperties()).forEach(function (k) { if (k.indexOf('RUN_') === 0) p.deleteProperty(k); });
  ['PROGRESS', 'TARGET_URL', 'CTX_FILE_ID', 'JOB'].forEach(function (k) { p.deleteProperty(k); });
  setupSheets();
  arrangeSheets_(ss);
  rebuildSummary_();
  log_('초기화', '-', '모든 기록 지움', '', '기획자');
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
    model: p.GEMINI_MODEL || ''
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

/* ───────────── QA 실행 팝업 ───────────── */

function getRunDialogState() {
  var rows = tcRows_();
  return { input: lastInput_(), testcases: rows.filter(function (r) { return r.id; }).length, running: !!findRunning_(), settings: getSettingsStatus() };
}

// 팝업에서 '실행'을 누르면: 할 일(JOB)을 저장하고 사이드 패널을 열어 거기서 진행한다
function submitRun(form) {
  var figmaUrl = (form.figmaUrl || '').trim(), targetUrl = (form.targetUrl || '').trim(), memo = (form.memo || '').trim();
  if (!targetUrl) throw new Error('테스트할 화면 주소를 입력하세요.');
  if (!/^https?:\/\//.test(targetUrl)) throw new Error('화면 주소는 http:// 또는 https://로 시작해야 합니다.');
  var s = getSettingsStatus();
  if (!s.gemini || !s.github || !s.webappUrl) throw new Error('먼저 메뉴 QA 자동화 → 설정에서 키를 입력하세요.');
  if (findRunning_()) throw new Error('이미 QA가 실행 중입니다. 오른쪽 패널에서 진행 상황을 확인하세요.');
  var last = lastInput_();
  var hasTests = tcRows_().some(function (r) { return r.id; });
  // 피그마나 추가 전달 사항이 바뀌었거나 테스트가 없으면 테스트를 새로 만든다. 주소만 바뀌면 테스트는 그대로 둔다.
  var needGen = !hasTests || !last || last.figmaUrl !== figmaUrl || last.memo !== memo;
  var urlChanged = !needGen && last && last.targetUrl !== targetUrl;
  if (urlChanged) {
    props_().setProperty('TARGET_URL', targetUrl);
    ss_().getSheetByName(SHEETS.INPUT).appendRow([now_(), figmaUrl, targetUrl, memo, '화면 주소만 변경 (테스트 유지)']);
    log_('입력 변경', '-', '화면 주소 변경: ' + targetUrl, '테스트 유지', '기획자');
  }
  props_().setProperty('JOB', JSON.stringify({ figmaUrl: figmaUrl, targetUrl: targetUrl, memo: memo, needGen: needGen, at: Date.now() }));
  showSidebar();
  return { needGen: needGen };
}

// 사이드 패널이 할 일을 가져간다 (한 번만)
function countEditedTests() {
  return tcRows_().filter(function (r) { return !r.id || r.hash !== tcHash_(r.data) || !r.stepsOk; }).length;
}

function takeJob() {
  var p = props_(), raw = p.getProperty('JOB');
  if (!raw) return null;
  p.deleteProperty('JOB');
  var job = JSON.parse(raw);
  if (Date.now() - job.at > 10 * 60000) return null;
  job.edited = tcRows_().filter(function (r) { return !r.id || r.hash !== tcHash_(r.data) || !r.stepsOk; }).length;
  return job;
}

/* ───────────── 사이드 패널: 재확인 · 처리할 결함 ───────────── */

function getPanelState() {
  var running = findRunning_();
  var run = ss_().getSheetByName(SHEETS.RUN);
  var runRows = run.getLastRow() > 1 ? run.getRange(2, 1, run.getLastRow() - 1, 12).getValues() : [];
  var done = runRows.filter(function (r) { return r[11] === '완료'; });
  var last = runRows.length ? runRows[runRows.length - 1] : null;
  return {
    running: running,
    runningRound: running && last ? last[0] : '',
    nextRound: done.length + 1,
    testcases: tcRows_().filter(function (r) { return r.id; }).length,
    review: getReviewList_()
  };
}

// 재확인 대기(개발자 수정완료) + 기획자 확인 필요
function getReviewList_() {
  var d = ss_().getSheetByName(SHEETS.DEFECT);
  if (d.getLastRow() < 2) return { fixed: [], check: [] };
  var tcMap = {};
  tcRows_().forEach(function (r) { if (r.id) tcMap[r.id] = r; });
  var base = (props_().getProperty('TARGET_URL') || '').replace(/[^\/]*$/, '');
  var rows = d.getRange(2, 1, d.getLastRow() - 1, DCOLS).getValues();
  var links = d.getRange(2, 11, d.getLastRow() - 1, 1).getFormulas();
  var fixed = [], check = [];
  rows.forEach(function (r, i) {
    if (!r[0] || !OPEN_STATUS[r[14]]) return;
    var page = '';
    var t = tcMap[String(r[2]).trim()];
    if (t) { try { var st = JSON.parse(t.data[7] || '[]'); var g = st.filter(function (x) { return x.action === 'goto'; })[0]; if (g) page = base + String(g.url || '').replace(/^\.?\//, ''); } catch (e) {} }
    var m = String(links[i][0]).match(/HYPERLINK\("([^"]+)"/);
    var item = { id: r[0], tc: r[2], screen: r[4], title: r[5], steps: String(r[6]), expected: String(r[7]), actual: String(r[8]),
                 status: r[14], method: r[16] || 'AI', page: page || base, shot: m ? m[1] : '' };
    if (r[14] === '확인 필요') check.push(item);
    else if (r[12] === '수정완료') fixed.push(item);
  });
  return { fixed: fixed, check: check };
}

function setCheckMethod(defectId, method) {
  var row = findDefectRow_(defectId);
  if (!row) throw new Error('결함을 찾을 수 없습니다: ' + defectId);
  ss_().getSheetByName(SHEETS.DEFECT).getRange(row, 17).setValue(method);
  return true;
}

// 사람이 직접 확인한 결과를 기록
function manualVerdict(defectId, verdict) {
  var d = ss_().getSheetByName(SHEETS.DEFECT);
  var row = findDefectRow_(defectId);
  if (!row) throw new Error('결함을 찾을 수 없습니다: ' + defectId);
  var r = d.getRange(row, 1, 1, DCOLS).getValues()[0];
  var map = {
    '통과': { status: '종료', result: '직접 확인 통과', color: '#F1F8E9', mark: r[12] },
    '재오픈': { status: '재오픈', result: '직접 확인 재오픈 (아직 안 고쳐짐)', color: '#FFF3E0', mark: '' },
    '결함 맞음': { status: '열림', result: '기획자 판정: 실제 결함', color: null, mark: r[12] },
    '제외': { status: '제외', result: '기획자 판정: 테스트 오류로 제외', color: '#F2F4F6', mark: r[12] }
  };
  var v = map[verdict];
  if (!v) throw new Error('알 수 없는 판정');
  d.getRange(row, 13, 1, 4).setValues([[v.mark, v.result, v.status, appendLog_(r[15], now_() + ' ' + v.result)]]);
  d.getRange(row, 17).setValue('직접');
  if (v.color) d.getRange(row, 1, 1, DCOLS).setBackground(v.color); else d.getRange(row, 1, 1, DCOLS).setBackground(null);
  log_('직접 확인', defectId, r[5], v.result, '기획자');
  rebuildSummary_();
  return getReviewList_();
}

function findDefectRow_(defectId) {
  var d = ss_().getSheetByName(SHEETS.DEFECT);
  if (d.getLastRow() < 2) return 0;
  var ids = d.getRange(2, 1, d.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === defectId) return i + 2;
  return 0;
}

/* ───────────── 히스토리 ───────────── */

function log_(kind, target, content, result, who) {
  try {
    ss_().getSheetByName(SHEETS.HISTORY).appendRow([now_(), kind, target, String(content || '').slice(0, 300), result || '', who || '시스템']);
  } catch (e) {}
}

// 사람이 결함 탭에서 개발자 표기·상태를 바꾸면 히스토리에 남긴다
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (sh.getName() !== SHEETS.DEFECT || e.range.getRow() < 2 || e.range.getNumRows() > 50) return;
    var c1 = e.range.getColumn(), c2 = c1 + e.range.getNumColumns() - 1;
    var rows = sh.getRange(e.range.getRow(), 1, e.range.getNumRows(), DCOLS).getValues();
    var logs = [];
    rows.forEach(function (r) {
      if (!r[0]) return;
      if (c1 <= 13 && c2 >= 13) logs.push([now_(), '개발자 표기', r[0], '개발자 표기 → ' + (r[12] || '(비움)'), '', '개발자']);
      if (c1 <= 15 && c2 >= 15) logs.push([now_(), '상태 변경', r[0], '상태 → ' + r[14], '', '기획자']);
      if (c1 <= 17 && c2 >= 17) logs.push([now_(), '확인 방식', r[0], '확인 방식 → ' + (r[16] || 'AI'), '', '기획자']);
    });
    if (logs.length) {
      var h = e.source.getSheetByName(SHEETS.HISTORY);
      h.getRange(h.getLastRow() + 1, 1, logs.length, 6).setValues(logs);
    }
  } catch (err) {}
}

function lastInput_() {
  var sh = ss_().getSheetByName(SHEETS.INPUT);
  if (sh.getLastRow() < 2) return null;
  var v = sh.getRange(sh.getLastRow(), 1, 1, 4).getValues()[0];
  return { figmaUrl: v[1], targetUrl: v[2], memo: v[3] };
}

/* ───────────── ① 테스트 만들기 ───────────── */

function generateTestDesign(form) {
  var figmaUrl = (form.figmaUrl || '').trim();
  var targetUrl = (form.targetUrl || '').trim();
  var memo = (form.memo || '').trim();
  if (!targetUrl) throw new Error('테스트할 화면 주소를 입력하세요.');
  if (!/^https?:\/\//.test(targetUrl)) throw new Error('화면 주소는 http:// 또는 https://로 시작해야 합니다.');
  if (!props_().getProperty('GEMINI_API_KEY')) throw new Error('설정에서 Gemini API 키를 먼저 입력하세요.');
  if (findRunning_()) throw new Error('QA 실행 중에는 테스트를 다시 만들 수 없습니다. 실행이 끝난 뒤 다시 시도하세요.');

  progress_('피그마 읽는 중');
  var design = figmaUrl ? readFigma_(figmaUrl) : '(피그마 없음: 기획 메모만 기준으로 함)';
  progress_('화면 확인 중');
  var pages = crawl_(targetUrl, memo);
  saveCtx_({ design: design, pages: pages, memo: memo, targetUrl: targetUrl, figmaUrl: figmaUrl });

  var out = callGemini_(buildPrompt_('ia', design, pages, memo, targetUrl, ''));
  if (!(out.ia || []).length || !(out.scenarios || []).length) throw new Error('AI가 화면 목록을 만들지 못했습니다. 피그마 링크와 화면 주소를 확인한 뒤 다시 시도하세요.');
  progress_('IA · 시나리오 기록 중');
  writeRows_(SHEETS.IA, (out.ia || []).map(function (r) {
    return [r.id, r.screen, r.area, r.element, r.type, r.design || '', '', ''];
  }));
  writeRows_(SHEETS.SC, (out.scenarios || []).map(function (r) {
    return [r.id, r.title, (r.iaIds || []).join(', '), r.description || ''];
  }));
  return { ia: out.ia.length, scenarios: out.scenarios.length };
}

function generateTestCases() {
  var t0 = Date.now();
  var ss = ss_();
  var c = loadCtx_();
  if (!c) throw new Error('먼저 화면 정보를 입력하고 테스트 만들기를 누르세요.');
  var ia = ss.getSheetByName(SHEETS.IA), sc = ss.getSheetByName(SHEETS.SC);
  var iaText = sheetText_(ia, 6), scText = sheetText_(sc, 4);
  var scRows = sc.getRange(2, 1, Math.max(sc.getLastRow() - 1, 1), 4).getValues().filter(function (r) { return r[0]; });
  var all = [], skipped = [];
  scRows.forEach(function (r, idx) {
    if (Date.now() - t0 > GEN_TIME_LIMIT_MS) { skipped.push(r[0]); return; }
    progress_('테스트 작성 중 (' + (idx + 1) + '/' + scRows.length + ')');
    try {
      var o = callGemini_(buildPrompt_('tc', c.design, c.pages, c.memo, c.targetUrl,
        '=== IA ===\n' + iaText + '\n\n=== 전체 시나리오 ===\n' + scText + '\n\n=== 이번에 작성할 시나리오 ===\n' + r.join(' | ') +
        '\n이 시나리오 하나에 대한 테스트케이스만 2~4개 작성한다. scenarioId는 ' + r[0] + '.'));
      (o.testcases || []).forEach(function (t) { if (t.steps && t.steps.length) { t.scenarioId = r[0]; all.push(t); } });
    } catch (e) {
      skipped.push(r[0]);
    }
  });
  if (!all.length) throw new Error('테스트케이스를 하나도 만들지 못했습니다. 잠시 뒤 다시 시도하세요.');
  all.forEach(function (t, i) { t.id = 'TC-' + ('0' + (i + 1)).slice(-2); });

  progress_('테스트케이스 기록 중');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var tcSheet = ss.getSheetByName(SHEETS.TC);
    if (tcSheet.getLastRow() > 1) {
      var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'MMdd_HHmm');
      tcSheet.copyTo(ss).setName('테스트케이스_백업_' + stamp).hideSheet();
    }
    var detached = detachOpenDefects_();
    resetTcSheet_();
    var rows = all.map(function (r) {
      var row = [r.id, r.scenarioId, r.title, (r.iaIds || []).join(', '), r.precondition || '', r.stepsText || '', r.expected || '', JSON.stringify(r.steps), ''];
      row[8] = tcHash_(row);
      return row;
    });
    tcSheet.getRange(2, 1, rows.length, TC_FIXED_COLS).setValues(rows);
    linkIaToTc_();
    props_().setProperty('TARGET_URL', c.targetUrl);
    var iaN = ia.getLastRow() - 1, scN = sc.getLastRow() - 1;
    ss.getSheetByName(SHEETS.INPUT).appendRow([now_(), c.figmaUrl, c.targetUrl, c.memo,
      'IA ' + iaN + '행 · 시나리오 ' + scN + '개 · 테스트케이스 ' + rows.length + '개' + (skipped.length ? ' · 미작성 ' + skipped.join(', ') : '')]);
    rebuildSummary_();
  } finally { lock.releaseLock(); }
  log_('테스트 생성', '-', '피그마·화면·추가 전달 사항 기준', 'IA ' + iaN + ' · 시나리오 ' + scN + ' · 테스트 ' + rows.length + (detached ? ' · 결함 ' + detached + '건 확인 필요로 전환' : ''), 'AI');
  return { ia: iaN, scenarios: scN, testcases: rows.length, skipped: skipped, detached: detached };
}

// 테스트를 새로 만들면 TC 번호가 바뀌므로, 진행 중인 결함은 연결을 끊고 기획자 확인으로 돌린다
function detachOpenDefects_() {
  var d = ss_().getSheetByName(SHEETS.DEFECT);
  if (d.getLastRow() < 2) return 0;
  var rows = d.getRange(2, 1, d.getLastRow() - 1, DCOLS).getValues();
  var n = 0;
  rows.forEach(function (r, i) {
    if (!r[0] || !OPEN_STATUS[r[14]] || String(r[2]).indexOf('(이전)') > -1) return;
    var row = i + 2;
    d.getRange(row, 3).setValue(r[2] + ' (이전)');
    d.getRange(row, 14, 1, 3).setValues([['테스트 재작성으로 연결 해제 · 기획자 확인 필요', '확인 필요',
      appendLog_(r[15], now_() + ' 테스트케이스를 새로 만들어 이전 TC와 연결 해제')]]);
    n++;
  });
  return n;
}

// 테스트케이스 탭에서 사람이 고친 행만 실행 단계를 다시 만든다 (TC 번호·차수 기록·결함 연결 유지)
function applyEditedTests() {
  var t0 = Date.now();
  if (findRunning_()) throw new Error('QA 실행 중에는 반영할 수 없습니다. 실행이 끝난 뒤 다시 시도하세요.');
  var c = loadCtx_();
  if (!c) throw new Error('테스트 생성 자료가 없습니다. 먼저 테스트 만들기를 하세요.');
  var ss = ss_(), tc = ss.getSheetByName(SHEETS.TC);
  var rows = tcRows_();
  var ids = {}, dup = [];
  rows.forEach(function (r) { if (r.id) { if (ids[r.id]) dup.push(r.id); ids[r.id] = 1; } });
  if (dup.length) throw new Error('TC ID가 중복됩니다: ' + dup.join(', ') + ' → 번호를 고친 뒤 다시 누르세요.');
  var maxNo = 0;
  rows.forEach(function (r) { var m = String(r.id).match(/(\d+)$/); if (m) maxNo = Math.max(maxNo, +m[1]); });
  var targets = rows.filter(function (r) { return (r.data[2] || r.data[5]) && (!r.id || r.hash !== tcHash_(r.data) || !r.stepsOk); });
  if (!targets.length) return { updated: 0, failed: [] };
  var iaText = sheetText_(ss.getSheetByName(SHEETS.IA), 6);
  var done = 0, failed = [];
  targets.forEach(function (r) {
    if (Date.now() - t0 > GEN_TIME_LIMIT_MS) { failed.push(r.id || '(새 행)'); return; }
    if (!r.id) { maxNo++; r.data[0] = 'TC-' + ('0' + maxNo).slice(-2); tc.getRange(r.row, 1).setValue(r.data[0]); }
    progress_('테스트 반영 중: ' + r.data[0]);
    try {
      var o = callGemini_(buildPrompt_('one', c.design, c.pages, c.memo, c.targetUrl,
        '=== IA ===\n' + iaText + '\n\n=== 사람이 고친 테스트케이스 (이 내용을 그대로 실행 단계로 옮긴다) ===\n' +
        '테스트 항목: ' + r.data[2] + '\n사전 조건: ' + r.data[4] + '\n수행 단계:\n' + r.data[5] + '\n기대 결과:\n' + r.data[6]));
      if (!o.steps || !o.steps.length) throw new Error('빈 실행 단계');
      tc.getRange(r.row, 8).setValue(JSON.stringify(o.steps));
      tc.getRange(r.row, 9).setValue(tcHash_(r.data));
      done++;
    } catch (e) {
      failed.push(r.data[0]);
    }
  });
  linkIaToTc_();
  if (done) log_('테스트 반영', '-', '사람이 고친 테스트 ' + done + '건 실행 단계 갱신', failed.length ? '실패 ' + failed.join(', ') : '', 'AI');
  return { updated: done, failed: failed };
}

function tcRows_() {
  var tc = ss_().getSheetByName(SHEETS.TC);
  if (tc.getLastRow() < 2) return [];
  return tc.getRange(2, 1, tc.getLastRow() - 1, TC_FIXED_COLS).getValues().map(function (r, i) {
    var ok = false;
    try { ok = JSON.parse(r[7] || '[]').length > 0; } catch (e) {}
    return { row: i + 2, id: String(r[0]).trim(), data: r, hash: String(r[8]), stepsOk: ok };
  }).filter(function (r) { return r.id || r.data[2] || r.data[5]; });
}

function tcHash_(row) {
  var s = [row[2], row[4], row[5], row[6]].map(function (x) { return String(x || '').trim(); }).join('|');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16); }).join('').slice(0, 12);
}

function sheetText_(sh, cols) {
  if (sh.getLastRow() < 2) return '';
  return sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues().filter(function (r) { return r[0]; })
    .map(function (r) { return r.join(' | '); }).join('\n');
}

// 테스트 생성 자료(피그마·화면 HTML·메모)를 드라이브에 보관 (나중에 '수정한 테스트 반영'에서 사용)
function saveCtx_(obj) {
  var p = props_(), id = p.getProperty('CTX_FILE_ID'), text = JSON.stringify(obj);
  if (id) { try { DriveApp.getFileById(id).setContent(text); return; } catch (e) {} }
  var f = shotFolder_().createFile('QA 생성 자료.json', text, 'application/json');
  p.setProperty('CTX_FILE_ID', f.getId());
}

function loadCtx_() {
  var id = props_().getProperty('CTX_FILE_ID');
  if (!id) return null;
  try { return JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8')); } catch (e) { return null; }
}

function resetTcSheet_() {
  var sh = ss_().getSheetByName(SHEETS.TC);
  if (sh.getMaxColumns() > TC_FIXED_COLS) sh.deleteColumns(TC_FIXED_COLS + 1, sh.getMaxColumns() - TC_FIXED_COLS);
  clearBody_(sh);
  writeHeader_(sh, HEADERS[SHEETS.TC]);
}

function writeRows_(name, rows) {
  var sh = ss_().getSheetByName(name);
  clearBody_(sh);
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function readFigma_(url) {
  var m = url.match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('피그마 링크 형식이 아닙니다. figma.com/design/... 주소를 넣어 주세요.');
  if (m[1] === EXAMPLE_FIGMA.key) return EXAMPLE_FIGMA.text;
  var token = props_().getProperty('FIGMA_TOKEN');
  if (!token) throw new Error('설정에서 피그마 토큰을 먼저 입력하세요. (피그마 없이 하려면 피그마 링크 칸을 비우세요)');
  // 피그마는 읽기 한도가 낮아서, 같은 파일은 저장해 둔 내용을 다시 쓴다 (6시간)
  var cache = loadFigmaCache_(m[1]);
  if (cache && Date.now() - cache.at < 6 * 3600000) return cache.text;
  var res = UrlFetchApp.fetch('https://api.figma.com/v1/files/' + m[1], { headers: { 'X-Figma-Token': token }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 429) {
    if (cache) return cache.text;   // 막혔으면 예전에 읽은 내용으로 진행
    var wait = Number(res.getHeaders()['Retry-After'] || res.getHeaders()['retry-after'] || 0);
    throw new Error('피그마 읽기 한도에 걸렸습니다' + (wait ? ' (약 ' + (wait >= 3600 ? Math.ceil(wait / 3600) + '시간' : Math.ceil(wait / 60) + '분') + ' 뒤 가능)' : '') + '. 피그마 링크 칸을 비우고 추가 전달 사항만으로 실행할 수도 있습니다.');
  }
  if (code === 403) throw new Error('피그마 토큰이 만료됐거나 이 파일을 볼 권한이 없습니다. 설정에서 토큰을 새로 넣어 주세요.');
  if (code === 404) throw new Error('피그마 파일을 찾을 수 없습니다. 링크를 확인하세요.');
  if (code !== 200) throw new Error('피그마 파일을 읽지 못했습니다 (' + code + ')');
  var doc = JSON.parse(res.getContentText()).document;
  var lines = [];
  (doc.children || []).forEach(function (canvas) {
    (canvas.children || []).forEach(function (frame) {
      if (frame.type !== 'FRAME' && frame.type !== 'SECTION' && frame.type !== 'COMPONENT') return;
      lines.push('[화면] ' + frame.name);
      walkFigma_(frame, 1, lines);
    });
  });
  if (!lines.length) throw new Error('피그마 파일에 화면(프레임)이 없습니다.');
  var text = lines.slice(0, 600).join('\n');
  saveFigmaCache_(m[1], text);
  return text;
}

function loadFigmaCache_(key) {
  var id = props_().getProperty('FIGMA_CACHE_' + key);
  if (!id) return null;
  try { return JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8')); } catch (e) { return null; }
}

function saveFigmaCache_(key, text) {
  var p = props_(), id = p.getProperty('FIGMA_CACHE_' + key), body = JSON.stringify({ at: Date.now(), text: text });
  if (id) { try { DriveApp.getFileById(id).setContent(body); return; } catch (e) {} }
  p.setProperty('FIGMA_CACHE_' + key, shotFolder_().createFile('피그마 캐시_' + key + '.json', body, 'application/json').getId());
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

function crawl_(startUrl, memo) {
  var base = startUrl.replace(/[^\/]*$/, '');
  var queue = [startUrl], seen = {}, pages = [];
  var mm0, re0 = /([\w-]+\.html)/g;
  while ((mm0 = re0.exec(memo || ''))) queue.push(base + mm0[1]);
  while (queue.length && pages.length < 8) {
    var url = queue.shift();
    if (seen[url]) continue;
    seen[url] = true;
    var res;
    try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true }); } catch (e) { continue; }
    if (res.getResponseCode() >= 400) continue;
    var html = res.getContentText();
    var re = /["'(]([\w./-]+\.html)(?=["'?#)])/g, mm;
    while ((mm = re.exec(html))) {
      var abs = mm[1].indexOf('http') === 0 ? mm[1] : base + mm[1].replace(/^\.\//, '');
      if (abs.indexOf(base) === 0 && !seen[abs]) queue.push(abs);
    }
    var clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\s{2,}/g, ' ');
    pages.push({ path: url.replace(base, '') || 'index.html', html: clean.slice(0, 6000) });
  }
  if (!pages.length) throw new Error('화면 주소를 열지 못했습니다. 주소가 맞는지, 로그인 없이 열리는지 확인하세요: ' + startUrl);
  return pages;
}

function buildPrompt_(part, design, pages, memo, targetUrl, extra) {
  var common = [
    '너는 웹 서비스 QA 담당자다. 디자인(피그마)과 기획 메모를 기준으로 작업한다.',
    '기대 결과는 반드시 피그마 디자인과 기획 메모에서만 가져온다. HTML은 요소를 찾을 선택자와 페이지 경로를 확인하는 용도로만 쓴다. HTML이 피그마와 달라도 기준은 피그마다.',
    '모두 한국어. JSON으로만 답한다.'
  ];
  var stepRules = [
    '- steps action: goto {url} / fill {selector, value} / click {selector 또는 text} / expectUrlContains {value} / expectText {text} / expectTextIn {selector, text} / expectVisible {selector} / expectColor {selector, property(기본 background-color), value(#RRGGBB)} / wait {value(ms)}',
    '- 첫 단계는 goto(url은 페이지 파일명). 로그인이 필요한 화면은 기획 메모의 테스트 계정으로 로그인 단계를 먼저 넣는다.',
    '- 다른 화면에서 만든 데이터가 필요한 경우(예: 신청 후 내역 확인)는 그 화면부터 실제로 거쳐 가는 단계를 넣는다. 중간 화면으로 바로 goto 하지 않는다.',
    '- selector는 아래 HTML에 실제로 있는 id·class 기반 CSS 선택자만. 같은 클래스가 여럿이면 첫 번째 요소가 선택된다.'
  ];
  var rules;
  if (part === 'ia') {
    rules = [
      '할 일: IA와 테스트 시나리오 작성.',
      '- IA는 화면 > 영역 > 요소(제목, 입력칸, 버튼, 링크, 탭, 카드, 안내 문구) 단위까지 빠짐없이. ID는 IA-01부터. design 필드에는 피그마 기준 값(문구, 색, 크기)을 짧게.',
      '- 시나리오는 사용자 흐름 단위로 5~8개. ID는 SC-01부터. iaIds에 관련 IA ID.',
      '형식: {"ia":[{"id","screen","area","element","type","design"}],"scenarios":[{"id","title","iaIds":[],"description"}]}'
    ];
  } else if (part === 'tc') {
    rules = ['할 일: 아래 IA와 시나리오를 바탕으로 테스트케이스 작성.',
      '- 꼭 포함: 각 화면 제목·버튼·탭 문구가 피그마와 같은지(expectTextIn으로 해당 요소 지정), 주요 버튼 색이 피그마와 같은지(expectColor, 피그마 fill 값), 버튼·링크·탭을 눌렀을 때 맞는 화면으로 이동하는지(click 후 expectUrlContains), 기획 메모의 예외 동작(오류 문구 등).',
      '- 테스트케이스끼리 상태를 공유하지 않는다.']
      .concat(stepRules, [
      '- stepsText는 사람이 읽는 수행 단계(1. 2. 3.), expected는 사람이 읽는 기대 결과.',
      '형식: {"testcases":[{"id","scenarioId","title","iaIds":[],"precondition","stepsText","expected","steps":[{"action","url","selector","text","value","property"}]}]}']);
  } else {
    rules = ['할 일: 사람이 고친 테스트케이스 하나를 실행 단계(steps)로 옮긴다. 사람이 쓴 수행 단계와 기대 결과를 그대로 따른다.']
      .concat(stepRules, ['형식: {"steps":[{"action","url","selector","text","value","property"}]}']);
  }
  return common.concat([''], rules, ['', '=== 피그마 디자인 ===', design, '', '=== 기획 메모 ===', memo || '(없음)', '',
    extra || '', '',
    '=== 테스트 대상 HTML (시작 주소 ' + targetUrl + ') ===',
    pages.map(function (p) { return '--- ' + p.path + ' ---\n' + p.html; }).join('\n')]).join('\n');
}

function pickGeminiModel_(key) {
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
  if (res.getResponseCode() === 400 || res.getResponseCode() === 403) throw new Error('Gemini 키가 잘못됐거나 만료됐습니다. 설정에서 키를 새로 넣어 주세요.');
  if (res.getResponseCode() !== 200) throw new Error('Gemini 모델 목록 조회 실패 (' + res.getResponseCode() + ')');
  var names = (JSON.parse(res.getContentText()).models || []).filter(function (m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') > -1;
  }).map(function (m) { return m.name.replace('models/', ''); });
  var ver = function (n) { var m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  var prefer = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
  for (var k = 0; k < prefer.length; k++) if (names.indexOf(prefer[k]) > -1) { props_().setProperty('GEMINI_MODEL', prefer[k]); return prefer[k]; }
  var flash = names.filter(function (n) { return /flash/.test(n) && !/image|tts|audio|live/.test(n); });
  if (!flash.length) throw new Error('사용 가능한 Gemini 모델이 없습니다.');
  flash.sort(function (a, b) { return ver(b) - ver(a); });
  props_().setProperty('GEMINI_MODEL', flash[0]);
  return flash[0];
}

function callGemini_(prompt) {
  var key = props_().getProperty('GEMINI_API_KEY');
  var model = props_().getProperty('GEMINI_MODEL');
  if (!model || /2\.5-flash$|3\.8-flash$/.test(model)) model = pickGeminiModel_(key);
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  var body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } }
  };
  var lastErr = '';
  for (var i = 0; i < 4; i++) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
    });
    var code = res.getResponseCode(), txt = res.getContentText();
    if (code === 200) {
      try {
        var data = JSON.parse(txt);
        var text = data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
        return JSON.parse(text.replace(/^```json\s*/, '').replace(/```\s*$/, ''));
      } catch (e) {
        lastErr = 'AI 답변 형식 오류';
        continue;   // 형식이 깨진 답은 한 번 더 요청
      }
    }
    lastErr = code + ' ' + txt.slice(0, 200);
    if (code === 400 && /thinking/i.test(txt)) {
      delete body.generationConfig.thinkingConfig;
      if (/2\.5/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
      continue;
    }
    if ((code === 400 && /API key/i.test(txt)) || code === 403) throw new Error('Gemini 키가 잘못됐거나 만료됐습니다. 설정에서 키를 새로 넣어 주세요.');
    if (code === 404) {
      props_().deleteProperty('GEMINI_MODEL');
      model = pickGeminiModel_(key);
      url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
      continue;
    }
    if (code !== 429 && code < 500) break;
    Utilities.sleep(4000 * (i + 1));
  }
  if (/^429/.test(lastErr)) throw new Error('Gemini 무료 사용량을 잠시 넘었습니다. 1~2분 뒤 다시 시도하세요.');
  throw new Error('Gemini 호출 실패: ' + lastErr);
}

function linkIaToTc_() {
  var ss = ss_();
  var tc = ss.getSheetByName(SHEETS.TC), ia = ss.getSheetByName(SHEETS.IA);
  if (tc.getLastRow() < 2 || ia.getLastRow() < 2) return;
  var map = {};
  tc.getRange(2, 1, tc.getLastRow() - 1, 4).getValues().forEach(function (r) {
    String(r[3]).split(/\s*,\s*/).forEach(function (id) { if (id && r[0]) (map[id] = map[id] || []).push(r[0]); });
  });
  var ids = ia.getRange(2, 1, ia.getLastRow() - 1, 1).getValues();
  ia.getRange(2, 7, ids.length, 1).setValues(ids.map(function (r) { return [(map[r[0]] || []).join(', ')]; }));
}

/* ───────────── ② N차 QA 실행 ───────────── */

function findRunning_() {
  var run = ss_().getSheetByName(SHEETS.RUN);
  if (run.getLastRow() < 2) return '';
  var rows = run.getRange(2, 1, run.getLastRow() - 1, 12).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i][11] !== '실행 중') continue;
    var st = getRunStatus(rows[i][1]);   // 시간 초과면 여기서 정리됨
    if (st.status === '실행 중') return rows[i][1];
  }
  return '';
}

function startQaRun(opts) {
  opts = opts || {};
  var only = opts.only && opts.only.length ? opts.only : null;
  var p = props_();
  if (!p.getProperty('GITHUB_TOKEN') || !p.getProperty('WEBAPP_URL')) throw new Error('설정에서 GitHub 토큰과 웹앱 주소를 먼저 입력하세요.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('다른 작업이 진행 중입니다. 잠시 뒤 다시 누르세요.');
  try {
    if (findRunning_()) throw new Error('이미 QA가 실행 중입니다. 끝난 뒤 다시 누르세요.');
    var rows = tcRows_();
    if (!rows.length) throw new Error('먼저 테스트를 만드세요.');
    var ids = {}, dup = [], noId = 0;
    rows.forEach(function (r) { if (!r.id) noId++; else { if (ids[r.id]) dup.push(r.id); ids[r.id] = 1; } });
    if (dup.length) throw new Error('TC ID가 중복됩니다: ' + dup.join(', ') + ' → 테스트케이스 탭에서 번호를 고치세요.');
    var edited = rows.filter(function (r) { return !r.id || r.hash !== tcHash_(r.data) || !r.stepsOk; }).map(function (r) { return r.id || '(번호 없음)'; });
    if (edited.length) throw new Error('고쳤거나 새로 추가한 테스트가 있습니다: ' + edited.slice(0, 5).join(', ') + (edited.length > 5 ? ' 외' : '') + ' → 먼저 "수정한 테스트 반영"을 누르세요.');
    var target = p.getProperty('TARGET_URL');
    if (!target) throw new Error('테스트할 화면 주소가 없습니다. 테스트 만들기를 다시 하세요.');

    var ss = ss_(), run = ss.getSheetByName(SHEETS.RUN);
    var done = run.getLastRow() > 1 ? run.getRange(2, 12, run.getLastRow() - 1, 1).getValues().filter(function (r) { return r[0] === '완료'; }).length : 0;
    var round = done + 1;
    var kind = only ? '재확인' : '차수';
    var label = only ? '재확인' : round + '차';
    var runId = 'R' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd-HHmmss');
    var nonce = Utilities.getUuid();
    p.setProperty('RUN_' + runId, JSON.stringify({ nonce: nonce, round: round, target: target, started: Date.now(), kind: kind, only: only }));
    run.appendRow([label, runId, now_(), '', target, '', '', '', '', '', '', '실행 중']);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }

  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + (p.getProperty('GITHUB_REPO') || DEFAULT_REPO) + '/actions/workflows/qa.yml/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + p.getProperty('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ ref: 'main', inputs: { callback_url: p.getProperty('WEBAPP_URL'), run_id: runId, nonce: nonce } })
  });
  var code = res.getResponseCode();
  if (code !== 204) {
    setRunStatus_(runId, '시작 실패');
    p.deleteProperty('RUN_' + runId);
    if (code === 401) throw new Error('GitHub 토큰이 만료됐거나 잘못됐습니다. 설정에서 토큰을 새로 넣어 주세요.');
    if (code === 403 || code === 404) throw new Error('GitHub 토큰에 이 저장소의 Actions 권한이 없거나 저장소 이름이 틀렸습니다.');
    throw new Error('GitHub Actions 실행 요청 실패 (' + code + ')');
  }
  log_(only ? '재확인 시작' : 'QA 실행 시작', label, only ? '대상 ' + only.join(', ') : '전체 테스트', '', '기획자');
  return { runId: runId, round: label };
}

function getRunStatus(runId) {
  var row = findRunRow_(runId);
  if (!row) return { status: '없음' };
  var sh = ss_().getSheetByName(SHEETS.RUN);
  var v = sh.getRange(row, 1, 1, 12).getValues()[0];
  if (v[11] === '실행 중') {
    var raw = props_().getProperty('RUN_' + runId);
    var started = raw ? JSON.parse(raw).started : 0;
    if (!raw || (started && Date.now() - started > RUN_TIMEOUT_MIN * 60000)) {
      sh.getRange(row, 12).setValue('시간 초과');
      props_().deleteProperty('RUN_' + runId);
      v[11] = '시간 초과';
    }
  }
  return { round: v[0], total: v[5], pass: v[6], fail: v[7], newDefects: v[8], verified: v[9], reopened: v[10], status: v[11] };
}

function findRunRow_(runId) {
  var sh = ss_().getSheetByName(SHEETS.RUN);
  if (sh.getLastRow() < 2) return 0;
  var ids = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (ids[i][0] === runId) return i + 2;
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
  if (!info) return json_({ error: '실행 정보가 맞지 않거나 시간이 초과됐습니다.' });
  var cases = tcRows_().filter(function (r) { return r.id && (!info.only || info.only.indexOf(r.id) > -1); }).map(function (r) {
    var steps = [];
    try { steps = JSON.parse(r.data[7] || '[]'); } catch (err) {}
    return { id: r.id, steps: steps };
  });
  return json_({ baseUrl: info.target, round: info.round, cases: cases });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: '형식 오류' }); }
  var info = checkRun_(body.run, body.nonce);
  if (!info) return json_({ error: '실행 정보가 맞지 않거나 시간이 초과됐습니다.' });
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (body.error) {
      setRunStatus_(body.run, '오류: ' + String(body.error).slice(0, 200));
    } else {
      applyResults_(body.run, info, body.results || []);
    }
    props_().deleteProperty('RUN_' + body.run);
  } catch (err) {
    setRunStatus_(body.run, '오류: 결과 기록 실패 ' + String(err.message).slice(0, 150));
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
  var tc = ss.getSheetByName(SHEETS.TC);
  var d = ss.getSheetByName(SHEETS.DEFECT);
  var recheck = info.kind === '재확인';
  var label = recheck ? '재확인 ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'M/d HH:mm') : info.round + '차';
  var who = 'AI';

  // 1) 테스트케이스 시트에 이번 실행 결과 열 (같은 이름 열이 있으면 재사용)
  var header = tc.getRange(1, 1, 1, Math.max(tc.getLastColumn(), TC_FIXED_COLS)).getValues()[0];
  var col = header.indexOf(label + ' 결과') + 1;
  if (!col) { col = Math.max(tc.getLastColumn(), TC_FIXED_COLS) + 1; tc.getRange(1, col).setValue(label + ' 결과').setFontWeight('bold').setBackground('#F2F4F6'); }
  var tcById = {};
  tcRows_().forEach(function (r) { if (r.id) tcById[r.id] = r; });

  // 2) 끝나지 않은 결함 (TC별 하나)
  var defects = d.getLastRow() > 1 ? d.getRange(2, 1, d.getLastRow() - 1, DCOLS).getValues() : [];
  var openByTc = {}, maxNo = 0;
  defects.forEach(function (r, i) {
    var m = String(r[0]).match(/(\d+)$/); if (m) maxNo = Math.max(maxNo, +m[1]);
    if (r[0] && OPEN_STATUS[r[14]]) openByTc[String(r[2]).trim()] = { row: i + 2, data: r };
  });

  var iaScreen = iaScreenMap_();
  var folder = shotFolder_();
  var stat = { total: 0, pass: 0, fail: 0, newDefects: 0, verified: 0, reopened: 0 };
  var logs = [];
  var L = function (kind, target, content, result) { logs.push([now_(), kind, target, String(content || '').slice(0, 300), result, who]); };

  results.forEach(function (r) {
    var t = tcById[r.id];
    if (!t) return;
    stat.total++;
    var cell = tc.getRange(t.row, col);
    var open = openByTc[r.id];
    var marked = open && open.data[12] === '수정완료';
    var manual = open && open.data[16] === '직접';   // 사람이 직접 확인하기로 한 결함은 AI가 상태를 바꾸지 않는다

    if (r.status === '실행 불가') { cell.setValue('실행 단계 없음').setBackground('#F2F4F6'); return; }

    if (r.status === '통과') {
      stat.pass++;
      cell.setValue(r.actual === '기대 결과와 같음' ? '통과' : '통과 (재실행)').setBackground('#E8F5E9');
      if (open && manual) {
        d.getRange(open.row, 16).setValue(appendLog_(open.data[15], label + ': AI 실행 결과 통과 (직접 확인 대기)'));
      } else if (open) {
        d.getRange(open.row, 14, 1, 3).setValues([[label + ' 재확인 통과', '종료',
          appendLog_(open.data[15], label + ': 다시 실행해 통과 확인 → 종료' + (marked ? '' : ' (개발자 표기 없이 통과)'))]]);
        d.getRange(open.row, 1, 1, DCOLS).setBackground('#F1F8E9');
        stat.verified++;
        L('재확인', open.data[0], open.data[5], '통과 → 종료');
      }
      return;
    }

    stat.fail++;
    var check = r.status === '확인 필요';   // 테스트 오류일 수 있음 → 기획자 판정
    var shot = r.screenshot ? saveShot_(folder, runId + '_' + r.id, r.screenshot) : null;

    if (open) {
      cell.setValue((check ? '확인 필요 → ' : '실패 → ') + open.data[0]).setBackground(check ? '#FFF8E1' : '#FDECEA');
      if (manual) {
        d.getRange(open.row, 16).setValue(appendLog_(open.data[15], label + ': AI 실행 결과 실패 (직접 확인 대기)'));
      } else if (check) {
        d.getRange(open.row, 14, 1, 3).setValues([[label + ' 재확인 불가 (테스트 오류 가능) · 기획자 확인', '확인 필요',
          appendLog_(open.data[15], label + ': 테스트가 요소를 찾지 못해 재확인 불가')]]);
        d.getRange(open.row, 1, 1, DCOLS).setBackground('#FFF8E1');
        L('재확인', open.data[0], open.data[5], '재확인 불가 → 확인 필요');
      } else if (marked) {
        d.getRange(open.row, 13, 1, 4).setValues([['', label + ' 재오픈 (수정완료 표기됐지만 재현됨)', '재오픈',
          appendLog_(open.data[15], label + ': 개발자 수정완료 표기 → 다시 실행해 재현 → 재오픈')]]);
        d.getRange(open.row, 1, 1, DCOLS).setBackground('#FFF3E0');
        stat.reopened++;
        L('재확인', open.data[0], open.data[5], '재현됨 → 재오픈');
      } else {
        d.getRange(open.row, 16).setValue(appendLog_(open.data[15], label + ': 계속 실패'));
      }
      if (shot && !manual) setShot_(d, open.row, shot);
      if (!manual) d.getRange(open.row, 9).setValue(r.actual);
    } else if (!recheck) {
      maxNo++;
      var id = 'D-' + ('00' + maxNo).slice(-3);
      var ia = String(t.data[3]);
      var screen = ia.split(/\s*,\s*/).map(function (x) { return iaScreen[x]; }).filter(String)[0] || '';
      var sev = check ? '-' : (/expectColor|expectText/.test(r.failedAction || '') ? '보통' : '높음');
      d.appendRow([id, label, r.id, ia, screen, (check ? '[테스트 확인 필요] ' : '') + t.data[2], t.data[5], t.data[6], r.actual, '', '', sev, '',
        check ? '테스트 오류 가능 · 기획자 확인' : '', check ? '확인 필요' : '열림', label + ': 발견 (' + now_() + ')', 'AI']);
      var row = d.getLastRow();
      if (check) d.getRange(row, 1, 1, DCOLS).setBackground('#FFF8E1');
      if (shot) setShot_(d, row, shot);
      cell.setValue((check ? '확인 필요 → ' : '실패 → ') + id).setBackground(check ? '#FFF8E1' : '#FDECEA');
      stat.newDefects++;
      L('결함 등록', id, t.data[2], check ? '확인 필요' : '열림');
    } else {
      cell.setValue('실패').setBackground('#FDECEA');
    }
  });

  var runRow = findRunRow_(runId);
  ss.getSheetByName(SHEETS.RUN).getRange(runRow, 4, 1, 9).setValues([[now_(), info.target, stat.total, stat.pass, stat.fail, stat.newDefects, stat.verified, stat.reopened, recheck ? '완료(재확인)' : '완료']]);
  logs.unshift([now_(), recheck ? '재확인 실행' : 'QA 실행', label, '테스트 ' + stat.total + '건', '통과 ' + stat.pass + ' · 문제 ' + stat.fail + ' · 새 결함 ' + stat.newDefects + ' · 종료 ' + stat.verified + ' · 재오픈 ' + stat.reopened, 'AI']);
  var h = ss.getSheetByName(SHEETS.HISTORY);
  h.getRange(h.getLastRow() + 1, 1, logs.length, 6).setValues(logs);
  if (!recheck) updateIaResults_(label, col);
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
  if (ia.getLastRow() < 2 || tc.getLastRow() < 2) return;
  var res = {};
  tc.getRange(2, 1, tc.getLastRow() - 1, col).getValues().forEach(function (r) {
    var v = String(r[col - 1]);
    String(r[3]).split(/\s*,\s*/).forEach(function (id) {
      if (!id) return;
      var m = v.match(/→ (D-\d+)/);
      if (m) (res[id] = res[id] || []).push(m[1]);
      else if (!res[id]) res[id] = [];
    });
  });
  var ids = ia.getRange(2, 1, ia.getLastRow() - 1, 1).getValues();
  var vals = ids.map(function (r) {
    var x = res[r[0]];
    if (!x) return ['테스트 없음'];
    return [x.length ? round + ' 문제 (' + x.join(', ') + ')' : round + ' 통과'];
  });
  var range = ia.getRange(2, 8, ids.length, 1);
  range.setValues(vals);
  range.setBackgrounds(vals.map(function (v) { return [v[0].indexOf('문제') > -1 ? '#FDECEA' : (v[0].indexOf('통과') > -1 ? '#E8F5E9' : null)]; }));
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
  try {
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', name + '.jpg');
    var file = folder.createFile(blob);
    return { url: file.getUrl(), b64: b64 };
  } catch (e) { return null; }
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
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear(); sh.clearFormats();
  var ia = ss.getSheetByName(SHEETS.IA), d = ss.getSheetByName(SHEETS.DEFECT), run = ss.getSheetByName(SHEETS.RUN);
  var iaRows = ia.getLastRow() > 1 ? ia.getRange(2, 1, ia.getLastRow() - 1, 8).getValues() : [];
  var dRows = d.getLastRow() > 1 ? d.getRange(2, 1, d.getLastRow() - 1, DCOLS).getValues() : [];
  var runRows = run.getLastRow() > 1 ? run.getRange(2, 1, run.getLastRow() - 1, 12).getValues().filter(function (r) { return r[11] === '완료'; }) : [];
  var open = 0, reopen = 0, check = 0, closed = 0;
  dRows.forEach(function (r) {
    if (!r[0]) return;
    if (r[14] === '종료') closed++;
    else if (r[14] === '재오픈') reopen++;
    else if (r[14] === '확인 필요') check++;
    else if (r[14] === '열림') open++;
  });
  var last = runRows.length ? runRows[runRows.length - 1] : null;

  sh.getRange('A1').setValue('QA 현황').setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setValue(last ? '최근 ' + last[0] + ' QA · ' + (last[3] instanceof Date ? Utilities.formatDate(last[3], 'Asia/Seoul', 'M월 d일 HH:mm') : last[3]) : '아직 QA를 실행하지 않았습니다. 메뉴 QA 자동화 → QA 실행').setFontColor('#8B95A1');
  var kpi = [['미해결 결함', open + reopen + check, '#FFF5F5', '#C2410C'], ['그중 재오픈', reopen, '#FFF3E0', '#C2410C'],
             ['기획자 확인 필요', check, '#FFF8E1', '#8A6D00'], ['종료', closed, '#E8F5E9', '#1B7F3B'],
             ['최근 통과', last ? last[6] + ' / ' + last[5] : '-', '#F2F4F6', '#191F28']];
  kpi.forEach(function (k, i) {
    var col = 1 + i * 2;
    sh.getRange(4, col, 1, 2).merge().setValue(k[0]).setFontColor('#4E5968').setBackground(k[2]).setHorizontalAlignment('center');
    sh.getRange(5, col, 1, 2).merge().setValue(k[1]).setFontSize(22).setFontWeight('bold').setFontColor(k[3]).setBackground(k[2]).setHorizontalAlignment('center');
  });
  sh.setRowHeight(5, 44);

  var screens = {};
  iaRows.forEach(function (r) { var s = screens[r[1]] = screens[r[1]] || { ia: 0, open: 0, closed: 0 }; s.ia++; });
  dRows.forEach(function (r) {
    if (!r[0] || r[14] === '제외') return;
    var s = screens[r[4]] = screens[r[4]] || { ia: 0, open: 0, closed: 0 };
    if (r[14] === '종료') s.closed++; else s.open++;
  });
  var t1 = [['화면별', '확인 항목', '미해결 결함', '종료']];
  Object.keys(screens).forEach(function (k) { if (k) t1.push([k, screens[k].ia, screens[k].open, screens[k].closed]); });
  sh.getRange(7, 1, t1.length, 4).setValues(t1);
  sh.getRange(7, 1, 1, 4).setFontWeight('bold').setBackground('#F2F4F6');

  var t2 = [['차수별', '통과', '실패', '재확인 통과', '재오픈']];
  runRows.forEach(function (r) { t2.push([r[0], r[6], r[7], r[9], r[10]]); });
  sh.getRange(7, 6, t2.length, 5).setValues(t2);
  sh.getRange(7, 6, 1, 5).setFontWeight('bold').setBackground('#F2F4F6');
  for (var c = 1; c <= 10; c++) sh.setColumnWidth(c, c === 1 || c === 6 ? 110 : 80);
  sh.setHiddenGridlines(true);
}

/* ───────────── 공통 ───────────── */

function progress_(msg) { props_().setProperty('PROGRESS', now_() + ' ' + msg); }
function getProgress() { return props_().getProperty('PROGRESS') || ''; }

function ss_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'); }
