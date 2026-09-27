// 비행 전 점검 화면.
//
// 🔴 **판정을 여기서 하지 않는다.** 서버가 준 level/verdict 를 그대로 그린다.
//    임계값은 tools/preflight/preflight.py 의 EXPECT 한 곳에만 있다.
//
// 🔴 **점검은 병렬이다.** 묶음이 끝나는 순서는 정해져 있지 않다 — 자기 데이터가
//    먼저 온 것이 먼저 끝난다. 목록 번호는 자리 번호지 실행 순서가 아니다.
'use strict';

const $ = (id) => document.getElementById(id);

// 🔴 텔레메트리 수집 시간(초). **고르게 두지 않는다.**
//    FC 가 알아서 뿌리는 값 중 가장 느린 것이 HOME_POSITION·VIBRATION 으로
//    2초 주기다 (2026-09-20 실측). 짧게 잡으면 그 항목이 통째로 빠져
//    「데이터 없음」 이 되는데, 고를 수 있으면 현장에서 짧은 쪽을 고른다.
//
//    실제 소요는 이보다 짧다 — 필요한 것이 다 오면 gather 가 조기 종료한다
//    (실측 2~3초). 끝까지 듣는 것은 FC 경고뿐이다: 언제 올지 모른다.
const SECS = 10;

// 등급 → 화면 말. preflight.py 의 GROUP_VERDICT 와 같은 짝이다.
// 🔴 색만으로 말하지 않는다 — 글자로도 같은 것을 적는다 (색각 이상·인쇄).
const LEVEL = {
  blk:  { cls: 'blk',  mark: '✖' },
  warn: { cls: 'warn', mark: '▲' },
  ok:   { cls: 'ok',   mark: '✔' },
  info: { cls: 'info', mark: '·' },
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** preflight.py 의 설명문은 터미널에서 읽히려고 쓰였고 `**강조**` 가 섞여 있다.
 *  🔴 textContent 로 넣은 뒤 그 조각만 감싼다 — 서버 문자열을 innerHTML 에
 *     넣지 않는다. FC 가 보낸 STATUSTEXT 도 이 길로 오기 때문이다. */
function withEmphasis(node, text) {
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  parts.forEach((part, i) => {
    if (!part) return;
    node.appendChild(i % 2 ? el('b', null, part) : document.createTextNode(part));
  });
  return node;
}

function setNote(text, cls) {
  const n = $('note');
  n.textContent = text || '';
  n.className = 'pf-note' + (cls ? ' ' + cls : '');
}

// ── 점검 목록 ────────────────────────────────────────────────────────
// 시작할 때 전부 깔아 두고 (전부 회색), 끝나는 자리부터 색이 들어온다.
const rows = new Map();      // 묶음 이름 -> {li, pct, verdict}

function buildList(groups) {
  const ol = $('list');
  ol.textContent = '';
  rows.clear();
  groups.forEach((g, i) => {
    const li = el('li', 'pf-row waiting');

    // 줄 전체가 버튼이다 — 눌러야 하는 곳을 따로 찾게 하지 않는다.
    // 🔴 <button> 을 쓴다: 키보드 Tab·Enter 가 저절로 되고, 스크린리더가
    //    "눌러서 펼침" 을 읽어 준다. div 에 onclick 을 걸면 둘 다 잃는다.
    const head = el('button', 'pf-rhead');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    // 번호는 **자리 번호**다. 점검은 병렬이라 실행 순서가 아니다.
    head.appendChild(el('span', 'pf-rnum', String(i + 1).padStart(2, '0')));
    head.appendChild(el('span', 'pf-rlabel', g.label));
    // 진행률과 판정이 같은 자리에 온다 — 끝나면 퍼센트가 판정으로 바뀐다.
    const right = el('span', 'pf-rright', '대기');
    head.appendChild(right);
    li.appendChild(head);

    // 근거. 그 줄 바로 아래에서 열린다 — 판정과 이유가 떨어져 있으면
    // 무엇 때문에 NO GO 인지를 목록 밖에서 찾아야 한다.
    const body = el('div', 'pf-rbody');
    body.hidden = true;
    li.appendChild(body);

    head.addEventListener('click', () => toggleRow(g.name));
    ol.appendChild(li);
    rows.set(g.name, { li, head, right, body, done: false, group: null });
  });
}

/** 줄 하나를 펼치거나 접는다. 아직 안 끝난 줄은 보여 줄 것이 없다. */
function toggleRow(name, want) {
  const row = rows.get(name);
  if (!row || !row.group) return;
  const open = want == null ? row.body.hidden : want;
  if (open && !row.body.dataset.filled) {
    fillRowBody(row.body, row.group);
    row.body.dataset.filled = '1';
  }
  row.body.hidden = !open;
  row.head.setAttribute('aria-expanded', String(open));
  row.li.classList.toggle('open', open);
}

/** 그 묶음이 무엇을 읽었는지. 판정과 같은 자리에 둔다. */
function fillRowBody(body, g) {
  body.textContent = '';
  for (const it of g.items) {
    const lv = LEVEL[it.level] || LEVEL.info;
    const item = el('div', 'pf-item ' + lv.cls);
    item.appendChild(el('span', 'pf-mark', lv.mark));
    item.appendChild(el('span', 'pf-iname', it.name));
    item.appendChild(el('span', 'pf-idetail', it.detail));
    // 왜 막혔는지가 다음 행동을 정한다. 접지 않는다 (터미널도 안 접는다).
    if (it.why) item.appendChild(withEmphasis(el('div', 'pf-why'), it.why));
    body.appendChild(item);
  }
  if (!g.items.length) {
    body.appendChild(el('div', 'pf-empty', '읽은 것이 없다'));
  }
}

function setProgress(prog) {
  for (const [name, v] of Object.entries(prog)) {
    const row = rows.get(name);
    if (!row || row.done) continue;
    const pct = Math.round(v * 100);
    // 아직 아무것도 안 온 것은 대기 그대로 둔다. 0% 를 띄우면 「읽는 중」
    // 과 「아직 시작도 안 함」 이 같아 보인다.
    if (pct <= 0) continue;
    row.li.className = 'pf-row running';
    row.right.textContent = pct + '%';
    row.li.style.setProperty('--pct', pct + '%');
  }
}

/** 임무 머리. 사진 한 장으로도 언제 점검한 것인지가 남아야 한다. */
function setBrief(d) {
  if (d.at) $('bAt').textContent = d.at.replace('T', ' ').slice(0, 19);
}

function setGroupDone(g) {
  const row = rows.get(g.name);
  if (!row) return;
  row.done = true;
  row.group = g;
  // 이미 펼쳐 둔 줄이면 내용도 갱신한다 — 마지막 한 벌이 판정을 바꿨을 수 있다.
  if (row.body.dataset.filled) fillRowBody(row.body, g);
  const lv = LEVEL[g.level] || LEVEL.info;
  const open = row.li.classList.contains('open');
  row.li.className = 'pf-row done ' + lv.cls + (open ? ' open' : '');
  row.li.style.setProperty('--pct', '100%');
  row.right.textContent = g.verdict;
}

// ── 종합 ───────────────────────────────────────────────────────────
/** 종합. 🔴 두 가지로만 답한다 — GOOD TO GO 아니면 NO GO.
 *  preflight.py 는 「확인 후 판단」 을 따로 내지만, 이 화면에서는 GO 가 아닌
 *  것을 전부 NO GO 로 묶는다 (2026-09-20 사용자 지정). 무엇 때문인지는
 *  바로 아래 줄과 항목별 상세가 말한다. */
function renderTotal(d) {
  const go = d.verdict === 'GO';
  const sec = $('total');
  sec.hidden = false;
  sec.className = 'pf-total ' + (go ? 'ok' : 'blk');
  $('tverdict').textContent = go ? 'GOOD TO GO' : 'NO GO';

}

/** 붙지 못했거나 서버가 막힌 경우. 🔴 이때 GOOD TO GO 를 그리지 않는다. */
function renderFail(d) {
  const box = $('fail');
  box.hidden = false;
  box.textContent = '';
  box.appendChild(el('div', 'pf-failtitle', d.error || '점검하지 못했다'));
  for (const n of d.notes || []) box.appendChild(el('div', 'pf-failnote', '· ' + n));
  if (d.hints && d.hints.length) {
    box.appendChild(el('div', 'pf-failhead', '확인할 것'));
    for (const h of d.hints) box.appendChild(el('div', 'pf-failnote', '· ' + h));
  }
}

// ── 암호 ────────────────────────────────────────────────────────────
let pw = '';
try { pw = sessionStorage.getItem('pf_pw') || ''; } catch { /* 사설 모드 */ }

function askPassword(err) {
  $('pwErr').hidden = !err;
  $('pwErr').textContent = err || '';
  $('modal').hidden = false;
  $('pw').value = '';
  $('pw').focus();
}
const closeModal = () => { $('modal').hidden = true; };

// ── 점검 ────────────────────────────────────────────────────────────
let busy = false;

function reset() {
  $('total').hidden = true;
  $('fail').hidden = true;
  $('again').hidden = true;
  $('list').textContent = '';
  rows.clear();
}

/** 한 줄이 왔다. 종류대로 처리한다. */
function onLine(d) {
  switch (d.t) {
    case 'agent':
      setBrief(d);
      break;
    case 'start':
      buildList(d.groups);
      setBrief(d);
      setNote('FC 를 읽는 중', 'dim');
      break;
    case 'prog':
      setProgress(d.progress || {});
      break;
    case 'group':
      // 🔴 먼저 끝난 것이 먼저 온다. 자리는 목록에서 이름으로 찾는다.
      setGroupDone(d.group);
      break;
    case 'done':
      setBrief(d);
      // 마지막 한 벌로 목록을 맞춘다 — 늦게 온 값이 중간 판정을 바꿨을 수 있다.
      for (const g of d.groups || []) setGroupDone(g);
      if (d.error) renderFail(d);
      else renderTotal(d);
      // 점검이 끝났다. 이제 다시 돌리거나 근거를 펼칠 수 있다.
      $('again').hidden = false;
      setNote('', '');
      break;
    default:
      break;
  }
}

async function run() {
  if (busy) return;
  if (!pw) { askPassword(); return; }

  busy = true;
  $('go').disabled = true;
  $('hero').hidden = true;
  $('run').hidden = false;
  reset();
  setNote('FC 에 붙는 중…', 'dim');

  try {
    const res = await fetch('/api/preflight/stream?t=' + SECS, {
      method: 'POST',
      headers: { 'X-Preflight-Password': pw },
    });

    if (res.status === 401) {
      // 저장해 둔 암호가 더는 안 맞는다. 버리고 다시 묻는다.
      pw = '';
      try { sessionStorage.removeItem('pf_pw'); } catch { /* 사설 모드 */ }
      $('hero').hidden = false;
      $('run').hidden = true;
      setNote('', '');
      askPassword('암호가 틀렸다');
      return;
    }
    try { sessionStorage.setItem('pf_pw', pw); } catch { /* 사설 모드 */ }

    // 스트림이 아니면 (503·409 등) 한 벌짜리 JSON 이다.
    const type = res.headers.get('content-type') || '';
    if (!type.includes('ndjson')) {
      const d = await res.json().catch(() => ({ error: '응답을 읽지 못했다' }));
      renderFail(d);
      setNote(d.error || '점검하지 못했다', 'bad');
      return;
    }

    // NDJSON 을 줄 단위로 읽는다. 한 덩이에 여러 줄이 올 수도, 줄이 잘려
    // 올 수도 있으므로 개행에서만 자른다.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); }
        catch { /* 반쪽 줄은 버린다 — 다음 덩이에서 온전히 온다 */ }
      }
    }
  } catch (e) {
    setNote('서버에 닿지 못했다: ' + e.message, 'bad');
    $('again').hidden = false;
  } finally {
    busy = false;
    $('go').disabled = false;
  }
}

$('go').addEventListener('click', () => run());
$('again').addEventListener('click', () => run());

$('cancel').addEventListener('click', closeModal);
$('pwForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('pw').value;
  if (!v) { $('pw').focus(); return; }
  pw = v;
  closeModal();
  run();
});
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal();
});
