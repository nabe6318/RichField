/**
 * 牧草地マップ — 属性表の読み書きAPI(Google Apps Script)
 * 属性表のスプレッドシートに貼り付けて「ウェブアプリ」としてデプロイします(README参照)。
 *   GET  … 属性表の全行をJSONで返す(地図の表示用)
 *   POST … field_id の行を探して上書きする(地図から)
 *          mode: 'attr'  … 圃場名などの属性(EDITABLE の列)
 *          mode: 'shape' … 地図で直した形状(geometry 列)と、ブラウザでDEMから計算した面積
 */
const SHEET_NAME = '';                               // 空なら先頭のシート。別シートなら名前を入れる
const ID_COL = 'field_id';
const EDITABLE = ['圃場名', '管理者', '草種', '備考'];  // 地図から書き換えてよい列(index.html の CONFIG.editable と合わせる)
const SHAPE_COLS = ['geometry', '投影面積_m2', '表面積_m2', '面積比', '平均傾斜_度', 'DEM被覆率'];
const MAX_GEOM = 45000;                              // セルの上限は5万文字

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fmt_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
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

// 形状の簡単な検査(Polygon / MultiPolygon、座標が数値で北海道〜九州付近)
function checkGeom_(s) {
  if (s === '') return '';
  if (s.length > MAX_GEOM) throw new Error('形状の頂点が多すぎます');
  const g = JSON.parse(s);
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) throw new Error('形状が Polygon ではありません');
  const pts = JSON.stringify(g.coordinates).match(/-?\d+(\.\d+)?/g) || [];
  if (pts.length < 8) throw new Error('頂点が足りません');
  return JSON.stringify(g);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const d = JSON.parse(e.postData.contents);
    const pass = PropertiesService.getScriptProperties().getProperty('PASSCODE');
    if (pass && String(d.passcode || '') !== pass) return json_({ ok: false, error: 'passcode' });
    if (d[ID_COL] === undefined || d[ID_COL] === '') return json_({ ok: false, error: 'field_id がありません' });
    const mode = d.mode || 'attr';

    const sh = sheet_();
    const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    const idIdx = head.indexOf(ID_COL);
    if (idIdx < 0) return json_({ ok: false, error: '1行目に field_id の列がありません' });

    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    const upd = { '更新日時': now, '更新者': d['更新者'] || '' };
    if (mode === 'shape') {
      upd['geometry'] = checkGeom_(String(d.geometry ?? ''));
      SHAPE_COLS.slice(1).forEach(k => { if (k in d) upd[k] = d[k]; });
      upd['形状更新日時'] = upd['geometry'] ? now : '';
    } else {
      EDITABLE.forEach(k => { if (k in d) upd[k] = String(d[k] ?? ''); });
    }

    // 見出しに無い列があれば右端に追加
    Object.keys(upd).filter(k => head.indexOf(k) < 0).forEach(k => {
      head.push(k);
      sh.getRange(1, head.length).setValue(k);
    });

    const ids = sh.getRange(2, idIdx + 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues().map(r => String(r[0]));
    const at = ids.indexOf(String(d[ID_COL]));
    if (at < 0) return json_({ ok: false, error: 'field_id ' + d[ID_COL] + ' の行がシートにありません' });
    const rowNo = at + 2;

    Object.keys(upd).forEach(k => {
      const cell = sh.getRange(rowNo, head.indexOf(k) + 1);
      // 数値の列はそのまま、文字の列は「書式なしテキスト」で書く(日付などに自動変換されないように)
      if (typeof upd[k] === 'number') cell.setValue(upd[k]);
      else cell.setNumberFormat('@').setValue(upd[k]);
    });

    const row = sh.getRange(rowNo, 1, 1, head.length).getValues()[0];
    return json_({ ok: true, row: Object.fromEntries(head.map((h, i) => [h, fmt_(row[i])])) });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
