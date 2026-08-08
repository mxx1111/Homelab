# 本地安全态势底图

`world.geojson` 与 `china-provinces.geojson` 来自 Natural Earth Vector
的 1:110m 国家边界和 1:50m 一级行政区数据。Natural Earth 数据属于公共领域，
可自由使用；本项目只保留地图渲染所需的几何与中文名称字段，并压缩为 GeoJSON。

- 项目主页：https://www.naturalearthdata.com/
- 数据仓库：https://github.com/nvkelso/natural-earth-vector
- 数据版本：2026-08-08 获取的 `master` 快照

这些文件由 Homelab 自己提供给浏览器，不会把攻击 IP、经纬度或访问者信息发送给
第三方地图服务。它们用于安全态势定位，不用于导航、测绘或精确边界判定。
