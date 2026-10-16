/**
 * 牧草地マップ — 属性表の読み書きAPI(Google Apps Script)
 * 属性表のスプレッドシートに貼り付けて「ウェブアプリ」としてデプロイします(README参照)。
 *   GET  … 属性表の全行をJSONで返す(地図の表示用)
 *   POST … field_id の行を探して、編集可能な列だけ上書きする(地図の入力フォームから)
 *
 * 面積の列(投影面積_m2 など)はDEMから計算した値なので、地図からは書き換えられません。
 */
const SHEET_NAME = '';                               // 空なら先頭のシート。別シートなら名前を入れる
const ID_COL = 'field_id';
const EDITABLE = ['圃場名', '管理者', '草種', '備考'];  // 地図から書き換えてよい列(index.html の CONFIG.editable と合わせる)

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fmt_(v) {
  if (v instanceof Date) {
    const t = v.getHours() || v.getMinutes() || v.getSeconds();
    return Utilities.formatDate(v, Session.getScriptTimeZone(), t ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
  }
  return v;
}

function rowsOf_(values) {
  const head = values[0].map(String);
  return values.slice(1)
    .filter(r => r.some(c => c !== ''))
    .map(r => Object.fromEntries(head.map((h, i) => [h, fmt_(r[i])])));
}

function doGet() {
  return json_({ ok: true, rows: rowsOf_(sheet_().getDataRange().getValues()) });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const d = JSON.parse(e.postData.contents);
    const pass = PropertiesService.getScriptProperties().getProperty('PASSCODE');
    if (pass && String(d.passcode || '') !== pass) return json_({ ok: false, error: 'passcode' });
    if (d[ID_COL] === undefined || d[ID_COL] === '') return json_({ ok: false, error: 'field_id がありません' });

    const sh = sheet_();
    let head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    const idIdx = head.indexOf(ID_COL);
    if (idIdx < 0) return json_({ ok: false, error: '1行目に field_id の列がありません' });

    // 見出しに無い列があれば右端に追加
    EDITABLE.concat(['更新日時', '更新者']).filter(k => head.indexOf(k) < 0).forEach(k => {
      head.push(k);
      sh.getRange(1, head.length).setValue(k);
    });

    const ids = sh.getRange(2, idIdx + 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues().map(r => String(r[0]));
    const at = ids.indexOf(String(d[ID_COL]));
    if (at < 0) return json_({ ok: false, error: 'field_id ' + d[ID_COL] + ' の行がシートにありません' });
    const rowNo = at + 2;

    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    const upd = { '更新日時': now, '更新者': d['更新者'] || '' };
    EDITABLE.forEach(k => { if (k in d) upd[k] = String(d[k] ?? ''); });
    Object.keys(upd).forEach(k => sh.getRange(rowNo, head.indexOf(k) + 1).setValue(upd[k]));

    const row = sh.getRange(rowNo, 1, 1, head.length).getValues()[0];
    return json_({ ok: true, row: Object.fromEntries(head.map((h, i) => [h, fmt_(row[i])])) });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
