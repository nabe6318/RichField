"""筆ポリゴン(field.gpkg)に独自IDを振り、1m DEMから投影面積・表面積を計算する。

使い方:
    python tools/calc_area.py field.gpkg 664351dem.tif

出力:
    out/field_area.gpkg      元の属性 + field_id + 面積(QGIS用、平面直角座標系のまま)
    out/fields_sheet.csv     スプレッドシートに貼り付ける属性表(初回の1回だけ)
    data/fields.geojson      地図表示用(緯度経度、field_id のみ)
    data/dem.tif             地図で範囲を囲ったときの計算用DEM(筆の範囲+余白で切り出したCOG)

計算方法(地図アプリの計算と同じ):
    投影面積 = ポリゴンの平面面積(DEMと同じ平面直角座標系で計算)
    表面積   = 投影面積 × 平均(1/cosθ)
               θ はHorn法(3×3)で求めた各セルの傾斜。セル中心がポリゴン内にあるセルで平均する。
必要なパッケージ:  pip install geopandas rasterio
"""
import os, sys
import numpy as np
import geopandas as gpd
import rasterio
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds, Window
from rasterio.enums import Resampling

BUFFER_M = 300          # Web用DEMの余白(筆の範囲の外側に何m残すか)
ROUND_CM = True         # 地図側のDEM(1cm丸め)と同じ値で計算する
ID_PREFIX = ""          # IDに接頭辞を付けたい場合(例 "OK-")。空なら 1, 2, 3 …


def sec_theta(z, dx, dy):
    """Horn法で傾斜を求め 1/cosθ を返す。端と欠測を含む3×3はNaN。"""
    p = np.pad(z, 1, constant_values=np.nan)
    a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
    d, f = p[1:-1, :-2], p[1:-1, 2:]
    g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
    gx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx)
    gy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * dy)
    return np.sqrt(1 + gx * gx + gy * gy)


def calc_one(src, geom):
    """1ポリゴンの投影面積・表面積・平均傾斜・DEM被覆率"""
    dx, dy = src.res
    minx, miny, maxx, maxy = geom.bounds
    win = from_bounds(minx, miny, maxx, maxy, src.transform).round_offsets().round_lengths()
    # Horn法の近傍用に1セル広げる
    win = Window(win.col_off - 1, win.row_off - 1, win.width + 3, win.height + 3)
    z = src.read(1, window=win, boundless=True, fill_value=src.nodata).astype("float64")
    if src.nodata is not None:
        z[z == src.nodata] = np.nan
    if ROUND_CM:
        ok_ = ~np.isnan(z); z[ok_] = np.round(z[ok_], 2)
    tr = src.window_transform(win)
    inside = ~geometry_mask([geom], out_shape=z.shape, transform=tr, all_touched=False)
    s = sec_theta(z, dx, dy)[inside]
    ok = s[~np.isnan(s)]
    proj = geom.area
    if ok.size == 0:
        return proj, np.nan, np.nan, 0.0
    m = ok.mean()
    slope = np.degrees(np.arccos(1 / ok)).mean()
    return proj, proj * m, slope, ok.size / max(inside.sum(), 1)


def main(gpkg, dem, out="out", data="data"):
    os.makedirs(out, exist_ok=True); os.makedirs(data, exist_ok=True)
    g = gpd.read_file(gpkg)
    with rasterio.open(dem) as src:
        if g.crs != src.crs:
            g = g.to_crs(src.crs)
        # 独自ID:北から南へ、同じ緯度帯(約100m)の中は西から東へ番号を振る
        c = g.geometry.representative_point()
        g = g.assign(_band=(-c.y // 100), _x=c.x).sort_values(["_band", "_x"]).drop(columns=["_band", "_x"])
        g.insert(0, "field_id", [f"{ID_PREFIX}{i}" if ID_PREFIX else i for i in range(1, len(g) + 1)])

        res = [calc_one(src, geom) for geom in g.geometry]
        g["proj_area_m2"] = [round(r[0], 1) for r in res]
        g["surf_area_m2"] = [round(r[1], 1) for r in res]
        g["area_ratio"] = [round(r[1] / r[0], 4) if r[0] else None for r in res]
        g["mean_slope_deg"] = [round(r[2], 2) for r in res]
        g["dem_coverage"] = [round(r[3], 3) for r in res]

        # Web用DEM:筆の範囲+余白で切り出し、圧縮したCOGにする
        minx, miny, maxx, maxy = g.total_bounds
        win = from_bounds(minx - BUFFER_M, miny - BUFFER_M, maxx + BUFFER_M, maxy + BUFFER_M, src.transform)
        win = win.round_offsets().round_lengths().intersection(Window(0, 0, src.width, src.height))
        arr = src.read(1, window=win)
        # 1cm単位に丸めて圧縮しやすくする(GitHubのブラウザ上アップロードは1ファイル25MBまで)
        valid = arr != src.nodata
        arr[valid] = np.round(arr[valid], 2)
        prof = src.profile.copy()
        prof.update(driver="COG", width=win.width, height=win.height, transform=src.window_transform(win),
                    compress="DEFLATE", predictor=3, zlevel=9, blocksize=256, overview_resampling="average")
        for k in ("blockxsize", "blockysize", "tiled", "interleave"):
            prof.pop(k, None)
        with rasterio.open(f"{data}/dem.tif", "w", **prof) as dst:
            dst.write(arr, 1)

    g.drop(columns=[c for c in ["history"] if c in g]).to_file(f"{out}/field_area.gpkg", layer="field_area", driver="GPKG")

    # スプレッドシート用の属性表
    sheet = g.drop(columns="geometry").copy()
    sheet["地目"] = sheet["land_type"].map({100: "田", 200: "畑"}).fillna("")
    cols = ["field_id", "圃場名", "管理者", "草種", "備考",
            "proj_area_m2", "surf_area_m2", "area_ratio", "mean_slope_deg", "dem_coverage",
            "地目", "polygon_uuid", "local_government_cd", "point_lng", "point_lat", "更新日時", "更新者"]
    for k in cols:
        if k not in sheet:
            sheet[k] = ""
    sheet[cols].rename(columns={
        "proj_area_m2": "投影面積_m2", "surf_area_m2": "表面積_m2", "area_ratio": "面積比",
        "mean_slope_deg": "平均傾斜_度", "dem_coverage": "DEM被覆率"}).to_csv(
        f"{out}/fields_sheet.csv", index=False, encoding="utf-8-sig")

    # 地図表示用(緯度経度・小数7桁)
    web = g[["field_id", "geometry"]].to_crs(6668)
    web.to_file(f"{data}/fields.geojson", driver="GeoJSON", COORDINATE_PRECISION=7)

    print(f"{len(g)} 筆:投影面積 計 {g.proj_area_m2.sum():,.0f} m2 / 表面積 計 {g.surf_area_m2.sum():,.0f} m2")
    print(f"出力: {out}/field_area.gpkg, {out}/fields_sheet.csv, {data}/fields.geojson, "
          f"{data}/dem.tif ({os.path.getsize(data + '/dem.tif') / 1e6:.1f} MB)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
