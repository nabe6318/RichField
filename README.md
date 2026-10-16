# 牧草地 面積マップ(Leaflet + GitHub Pages + 1m DEM)

川島地区農地調査マップと同じ仕組みのWebGISです。筆ポリゴンの属性はGoogleスプレッドシートで管理し、
地図から範囲を囲うと、1m DEMから求めた**投影面積と表面積**をポップアップで表示します。

## フォルダ構成

```
index.html               地図本体(冒頭の CONFIG だけ編集すればOK)
data/fields.geojson      筆ポリゴン(field_id のみ。属性はシート側)
data/fields_sheet.csv    属性表(API未設定時の表示用。シートの初期データでもある)
data/dem.tif             範囲計算用の1m DEM(筆の範囲+300mで切り出し、1cm丸め、COG形式)
tools/calc_area.py       上の3ファイルと out/ を作るスクリプト
tools/serve.py           ローカル確認用サーバー
gas/Code.gs              属性表の読み書きAPI(スプレッドシートに貼るApps Script)
out/field_area.gpkg      元の属性 + field_id + 面積(QGIS用、GitHubには不要)
out/fields_sheet.csv     スプレッドシート初期データ(data/ と同じもの)
```

## 地図でできること

- 筆ポリゴンを平均傾斜で色分け、ID・圃場名を表示(ズーム15以上)
- 筆をクリック → 表面積・投影面積(m²・a・ha)、面積比、平均傾斜、シートの属性を右パネルに表示
- **左上の五角形(または四角)ボタンで範囲を囲む → その範囲の投影面積・表面積をポップアップ表示**
  - 囲った範囲は鉛筆ボタンで頂点を動かして修正(自動で再計算)、ゴミ箱で削除
  - 「計測を保存」で、囲った範囲と面積をGeoJSONで書き出し(QGISで開けます)
- 書き込みAPIを設定すると、筆の属性(圃場名・管理者・草種・備考)を地図から編集してシートに保存

## 面積の計算方法

| 項目 | 計算 |
|---|---|
| 投影面積 | ポリゴンの水平面積(JGD2011 平面直角座標 XII系 = DEMと同じ座標系) |
| 表面積 | 投影面積 × 平均(1/cosθ) |
| θ | 各セルの傾斜(Horn法、3×3近傍) |
| 平均の対象 | セル中心がポリゴン内にある1mセル |

`tools/calc_area.py`(シートの面積)と地図上の計算は同じ方法・同じDEMで、33筆すべてで差は0.01%未満です。
1m DEMは草丈や計測ノイズの凹凸も拾うため、平坦な場所でも面積比がわずかに1を超えます。

## 1. スプレッドシートに属性表を入れる(初回のみ)

1. 属性表のスプレッドシートを開く
2. 「ファイル → インポート → アップロード」で `data/fields_sheet.csv` を選ぶ
3. インポート場所「**現在のシートを置換する**」、区切り文字「自動」→「データをインポート」

列の意味:

| 列 | 内容 | 地図から編集 |
|---|---|---|
| field_id | 独自ID(北→南、同じ帯の中は西→東に1から) | × |
| 圃場名・管理者・草種・備考 | 自由に入力 | ○ |
| 投影面積_m2・表面積_m2・面積比・平均傾斜_度・DEM被覆率 | DEMから計算 | × |
| 地目・polygon_uuid・local_government_cd・point_lng・point_lat | 筆ポリゴン(農水省)の元の属性 | × |
| 更新日時・更新者 | 地図から保存したときに自動記入 | — |

列は右に自由に追加できます(地図の「その他の属性」に表示されます)。
地図から編集できる列を増やすときは、`index.html` の `CONFIG.editable` と `gas/Code.gs` の `EDITABLE` の両方に列名を足してください。
field_id と面積の列は、地図の表示に使うので名前を変えないでください。

## 2. 書き込みAPIの設定(初回のみ・約10分)

川島地区マップと同じ手順です。

1. スプレッドシートの「拡張機能」→「Apps Script」
2. 最初のコードをすべて消し、`gas/Code.gs` を貼り付けて保存
3. 歯車「プロジェクトの設定」で、タイムゾーンが日本標準時か確認し、スクリプト プロパティ `PASSCODE` に合言葉を設定
4. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」、実行:**自分**、アクセス:**全員** →「デプロイ」→ アクセスを承認
5. 表示された `https://script.google.com/macros/s/…/exec` を `index.html` の `CONFIG.api: ''` に貼り付け

設定前でも、地図・面積表示・範囲計測は `data/fields_sheet.csv` で動きます(編集フォームは出ません)。
**公開範囲**:属性表はAPIのURLを知っていれば誰でも読めます。管理者欄などに個人情報を入れる場合は注意してください。

## 3. GitHub Pagesで公開

1. GitHubで新しいリポジトリを作成(Public)
2. 「Add file」→「Upload files」で `index.html`・`data/`・`gas/`・`tools/`・`README.md` をアップロード(`out/` は不要)
   - `data/dem.tif` は約21MBです(ブラウザからのアップロード上限25MB以内)
3. 「Settings」→「Pages」→ Branch: `main` / `/(root)` →「Save」
4. 1〜2分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で閲覧

地図はDEMの必要な部分だけを読み込むので、スマホでも軽く動きます。

## ローカルで確認する場合

```
python tools/serve.py
```
で `http://localhost:8000` を開きます(`python -m http.server` はDEMの部分読み込みに対応していないため、範囲計算が動きません)。

## 筆ポリゴンやDEMを差し替えるとき

```
pip install geopandas rasterio
python tools/calc_area.py field.gpkg 664351dem.tif
```
で `out/` と `data/` が作り直されます。
**注意**:field_id は位置の順で振り直されるため、筆が増減するとIDがずれます。シートに入力を始めた後で作り直す場合は、
`out/field_area.gpkg` の polygon_uuid で照合してから、面積の列だけをシートに貼り替えてください。

- DEMの範囲を広げたい:`calc_area.py` の `BUFFER_M`(既定300m)を変更
- IDに接頭辞を付けたい(例 `OK-1`):`calc_area.py` の `ID_PREFIX`
- 他地域のDEM:`index.html` の `CONFIG.demCrs` をそのDEMの座標系に合わせる
