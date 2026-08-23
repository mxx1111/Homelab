# vendor

第三方前端资源，随仓库分发，不走 CDN。

面板的定位是"外网出问题时才去看的东西"，从 unpkg 拉 Leaflet 意味着它在最需要
它的时候最脆弱：断网时 `L` 未定义，安全中心的地图那块直接抛异常。所以这里改成
本地分发。

## leaflet 1.9.4

- 来源：<https://unpkg.com/leaflet@1.9.4/dist/>
- 许可：BSD-2-Clause，见 `leaflet/LICENSE`
- 校验（与原 index.html 里的 SRI 值一致）：
  - `leaflet.css` `sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=`
  - `leaflet.js` `sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=`

`images/` 是 `leaflet.css` 里 `url()` 引用的资源。面板只用 `L.circleMarker`
（SVG，不需要图片），带上是为了 css 不 404，也为了将来真用到 marker 时不用回头补。

升级时重新下载并核对上游发布的 SRI 值，别只看文件能跑。
