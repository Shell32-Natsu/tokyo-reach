# Tokyo Reach · 東京 等時圏

选一个车站、出发时间和时间预算，在按真实比例绘制的东京圈铁路地图上，看看在这段时间里最远能坐到哪里。

- 覆盖 179 条线路：JR 东日本、东京 Metro、都营，以及东急、小田急、京王、西武、东武、京急、京成、相铁等全部主要私铁，还有单轨和新交通
- 按真实时刻表计算（约 9.3 万个车次），考虑候车、站内换乘步行、直通运行（不用下车的跨线车）
- 可以筛选车型（普通 / 快速·急行 / 付费特急）、运营商（全部 / 仅 JR / 仅地铁）、换乘节奏
- 显示每个车站的到达分钟数、最远的 10 个车站、具体乘车路线，以及前后一小时每分钟出发时的最远距离

## 本地运行

页面需要通过 HTTP 读取 `public/data/` 下的数据文件，直接双击打开不行：

```bash
cd public
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

也可以把 `public/` 整个目录放到任意静态托管。

## 部署到 GitHub Pages

仓库里的 `.github/workflows/pages.yml` 会在每次推送到 `main` 时自动部署：先用 `tools/bundle.py` 从 `src/` 重新生成 `public/index.html`，跑一遍算法测试，然后把 `public/` 发布出去。

第一次需要在仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。之后网址是 `https://<用户名>.github.io/tokyo-reach/`。

## 目录结构

```
src/
  engine.js      数据解码 + 可达性计算（Connection Scan Algorithm）
  app.js         地图（MapLibre GL）、站名标注、控件、结果列表
  style.css      样式（浅色/深色两套配色）
  body.html      页面结构
tools/
  build_mt3d_features.sh  构建 Mini Tokyo 3D 的线路几何
  build_data.py           生成 net.bin / tt.bin / geo13-16.bin
  build_basemap.py        生成 base.bin（海岸线、行政界、地名）
  bundle.py               把 src/ 合成 public/index.html
  common.py               变长整数 + 坐标差分编码
test/engine.test.js       命令行下的算法测试
public/                   可直接部署的成品（index.html + data/）
```

## 更新数据

时刻表来自 [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d) 仓库的 `data/`（作者会随各公司改点更新）。更新步骤：

```bash
# 1. 线路几何（需要 Node 18+）
tools/build_mt3d_features.sh /path/to/mini-tokyo-3d

# 2. 时刻表、车站、线路形状
python3 tools/build_data.py /path/to/mini-tokyo-3d

# 3. 底图（只在需要时重做；需要 shapely 和 mapshaper）
git clone --depth 1 https://github.com/niiyz/JapanCityGeoJson.git
python3 tools/build_basemap.py JapanCityGeoJson

# 4. 重新打包页面
python3 tools/bundle.py
node test/engine.test.js   # 可选：检查几条已知路线
```

## 算法说明

- 每一对相邻停站（某车次从 A 站开往 B 站）是一个"连接"，按发车时刻排序。从出发时刻开始顺序扫描，一个连接能被乘坐的条件是：已经在这趟车上，或者在发车前已经到达 A 站并完成换乘。
- 换乘时间：同一站同一线路换车 1 分钟；同一车站建筑内不同线路至少 2 分钟；需要出站走到另一个车站至少 4 分钟；再按站台间直线距离以每分钟 70 米加算，上限 20 分钟。“换乘节奏”选项会整体乘上 1.5 / 1 / 0.7。
- 直通运行（例如副都心线直通东急东横线）在数据里是首尾相接的两个车次，程序把它们当作同一次乘车处理，不计换乘。
- 时刻表只有分钟精度；时刻早于 03:00 的视为前一天的深夜。
- 节假日表内置了 2026–2027 年日本法定节假日和年末年始（12/30–1/3），用来自动选择“工作日 / 周六 / 周日·节假日”时刻表。

## 数据来源与授权

- 时刻表、车站、线路形状：Mini Tokyo 3D（MIT License，© Akihiko Kusanagi），其数据整理自公共交通开放数据中心（ODPT）等来源。ODPT 的部分数据（例如 JR 东日本、多数私铁）属于“挑战赛限定授权”，只适合个人、非商业用途；公开发布或商用前请先确认各数据的授权条款。
- 海岸线、行政区划、地名：国土交通省 国土数值信息 N03（经 niiyz/JapanCityGeoJson 转换）。
- 地图渲染：MapLibre GL JS（BSD-3-Clause）。
