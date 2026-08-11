# 骑行 · 旅游 · 导航 · 地图 一体应用（全 TypeScript 骨架）

地图渲染用 **MapLibre GL JS**（可离线、无 Token），国内骑行路线 / POI / 地理编码通过 **GeoProvider 抽象**混合调用 **高德地图 API**；支持 GPS 定位、地址搜索、POI 附近搜索与智能推荐，全程 TypeScript，端云共享 `@bike-travel/shared`。

## 目录
```
packages/
  shared/   纯 TS：领域类型 + 坐标系转换(BD09/GCJ02/WGS84) + 几何 + GPX
  server/   Node + Fastify：/api/route /api/poi /api/geocode，GeoProvider 路由（Valhalla/高德/OSM/Demo）
  web/      React + Vite + MapLibre：地图(高德底图/定位/搜索/POI/推荐) / 骑行记录 / 旅游行程 / 离线 pmtiles / 持久化存储
```

## 运行
```bash
npm install

# 终端 1：后端
npm run dev:server          # http://localhost:3000  (demo 路线，无需任何 key)

# 终端 2：前端
npm run dev:web             # http://localhost:5173  (Vite 已代理 /api -> :3000)
```
打开页面：地图 Tab 点「规划骑行路线（上海示例）」看画线；或用「附近搜索」搜 POI、「推荐」Tab 一键直达热门目的地；骑行 Tab 开始记录；行程 Tab 搜地点组行程。**所有行程与轨迹自动持久化到浏览器 localStorage，刷新不丢失。**

## 路由 Provider（已接 Valhalla / 高德 / OSM / Demo）
优先级：`VALHALLA_URL`(自托管) > 高德(国内+在线+有 key) > `OSM_ROUTING_URL`(OSRM/Valhalla) > Demo。
- 真实路由已验证：设 `OSM_ROUTING_URL=https://router.project-osrm.org/route/v1/cycling/` 返回 155 点真实几何（11.28km）。
- Valhalla：`POST /route` + bicycle profile，Valhalla 的 encoded polyline 解码在 `shared/geo/geometry.ts`。
- 高德：`v4/direction/bicycling` + `v3/place/around`，GCJ-02 在 `shared/geo/coord` 转回 WGS-84（高德输入也必须是 GCJ-02，故先 `wgs84ToGcj02` 再发请求）。

后端环境变量（`.env`，参考 `.env.example`）：
```
AMAP_KEY=                 # 高德地图 key
AMAP_REST_HOST=https://restapi.amap.com
VALHALLA_URL=             # 自托管 Valhalla base，如 http://localhost:8002
OSM_ROUTING_URL=          # OSRM 骑行路由 base，末尾带斜杠
```
端口请在 **`config/ports.env`** 统一配置（`SERVER_PORT` / `WEB_PORT`）；`start`/`stop`/`restart` 脚本与 `vite.config.ts` 都读它，改端口无需动代码。本地临时覆盖可建 `config/ports.env.local`（已 gitignore）。

## 一键启停（npm 脚本）
```bash
npm run start     # 启动 server + web（后台，日志 /tmp/bike_*.log）
npm run stop      # 按配置端口终止
npm run restart   # 重启
npm run ports     # 打印当前端口配置
npm run logs      # 实时 tail 前后端日志（Ctrl+C 退出）
```

## 离线 pmtiles（已接）
- 前端 `web/.env` 设 `VITE_PMTILES_URL` 指向一个 `.pmtiles` 文件（如 Protomaps 产物）。
- `offline/source.ts`：带 **IndexedDB 缓存的 PMTiles Source**，联网写入、离线命中。
- 地图 Tab「下载当前区域离线包」会按当前视野 bbox 在 z10–14 预取瓦片存入 IndexedDB；飞行模式下仍可出图。
- 顶栏可切底图：高德 / 在线(OpenFreeMap) / 离线(pmtiles)。

## 实时轨迹录制（已接 · 增强版）
- `ride/RideRecorder.ts`：`navigator.geolocation.watchPosition` 实时采样 → 距离/速度/爬升/心率；可选 **Web Bluetooth** 连心率带（heart_rate service）。
- **状态机**：开始 → 暂停 / 继续 → 停止。暂停时停止 GPS 监听并**冻结时长**（不计入总时长），恢复时自动补偿暂停区间（`pausedTotalMs`）。
- **GPS 漂移过滤**：低精度点（accuracy > 35m）与小位移点（相邻 < 3m）自动跳过，轨迹线更干净；精度值写入 `TrackPoint.acc` 供质量评估。
- **地图实时反馈**：绿色轨迹线随采样实时绘制；录制中当前位置以**绿色脉冲点**标记（区别于导航蓝色箭头）；默认**镜头跟随**当前位置（正北向上、可一键关闭）。
- **底部录制 HUD**：实时显示距离(km) / 时长 / 速度(km/h) / 心率(bpm) / 采样点，并提供暂停 / 继续 / 停止 / 镜头跟随开关。
- **停止与保存**：停止时命名并入库「我的骑行」档案库（不再强制下载）；GPX 导出改为按需按钮（通过 `shared/gpx.ts` 的 `trackToGpx` 导出 `.gpx`，含心率）。

## 旅游行程（已接）
- 行程 Tab：搜索 POI（走 `/api/poi`）或地址（`/api/geocode`）→ 加为途经点并标注第几天 → 「规划行程路线」逐段调用 `/api/route` → 在地图按天色绘制多段路线 + POI 标记。
- **按天分组**：途经点按「第几天」自动分组展示；规划时组内相邻点连成当天路线、**跨天不连**，每天合并为一条 Route 并以不同颜色绘制（卡片色块与地图路线同色，颜色取自 `MapView.ROUTE_COLORS`）。
- **沿途 POI 推荐**：每个途经点行有「附近」按钮，调用 `/api/poi` 搜索该点周边（景点/美食/咖啡/休息站，半径 1.5km）返回候选，一键「插入」为同天的下一个途经点。
- **分享 / 导出**：可编辑行程标题；「分享 / 导出」弹层生成纯文本行程单（标题 + 每天途经点 + 距离/时长/爬升汇总 + 全程合计），支持复制到剪贴板、下载 `.txt`、下载完整 `.json`（含 waypoints 与每日汇总）。
- **途经点编辑**：每个途经点行支持「↑/↓」调整顺序、直接编辑所属「第几天」数字；改动即时落盘并在重新规划时生效。

## 定位与搜索（已接）
- 定位：地图 Tab「📍 定位我的位置」调用 `navigator.geolocation.getCurrentPosition`（高精度，10s 超时），成功后飞行到用户位置并打蓝色圆点标记。
- 搜索：搜索框走 `/api/geocode`（高德 v3 地理编码）→ 返回 WGS-84 坐标 → 飞行到目标并打红色标记。
- 定位 / 搜索状态分行显示，互不覆盖。

## POI 附近搜索（已接）
- 地图 Tab「附近搜索」：输入关键词（默认"美食"）+ 选半径（1/2/5km）+ 搜周边 → 调 `/api/poi`（高德 `place/around`，真实数据）→ 地图上粉色圆点标记 + 左侧 POI 列表。
- 点击列表项或地图标记 → 飞行到该 POI 并**选中高亮**（金色大圆点 + 光晕），地图与列表双向联动。
- 接口 `GeoProvider.searchPOI(q, near, radiusM?)` 支持半径透传。

## 推荐功能（已接）
- 新增「推荐」Tab：
  - 🔥 上海热门目的地：外滩 / 豫园 / 陆家嘴 / 人民公园 / 徐家汇 / 田子坊 卡片，点击一键飞行直达。
  - 🚴 智能骑行推荐（一键）：自动搜附近「公园」→ 取最近一处 → 调 `/api/route` 规划骑行路线 → 显示距离/时长并画蓝色路线。
  - 🧠 **智能路线推荐（多候选打分）**：在「推荐」Tab 选「目标里程（5/10/15/20km）+ 风格（休闲/景观/美食/探索）」，算法自动生成多条候选环线——按风格搜 POI 作候选终点（不足补环形采样点），逐候选「去程+回程」合并为环线，沿途挑停靠 POI，再按 **距离匹配 / POI 丰富度 / 新颖度（探索风格，远离历史轨迹）/ 爬升惩罚** 综合打分，排序取前 3 条。选中路线在地图置顶（蓝）其余多色叠加，一键「用此路线导航」。
  - 🏷️ 分类一键搜：美食 / 咖啡 / 景点 / 单车租赁 / 充电桩，复用 POI 搜索。

## 天气 / 环境图层（已接）
- 地图 Tab「🌤️ 环境图层」开关：一键加载**当前地图视野**内的天气网格，覆盖整片区域（温度 / 空气质量 / 降水三种指标可切换）。
- **数据源**：Open-Meteo 免费 API（天气 + 空气），**免 API key、支持 CORS**；网格用「一次请求多坐标」只发 2 个请求即可拉满整屏，服务端按 0.05° 单元格缓存 10 分钟。
- **渲染**：网格点喂给 MapLibre `circle` 图层，按指标分级着色（温度 蓝→红 / AQI 绿→紫 / 降水 透明→蓝），圆形重叠形成连续「场」感，并附颜色图例。
- **中心天气卡片**：展示当前中心点的实时温度 / 湿度 / 风 / 降水 / AQI / PM2.5，骑行前快速评估天气与空气质量。
- 后端路由：`GET /api/weather?lng=&lat=`（单点）、`GET /api/weather/field?minLng=&minLat=&maxLng=&maxLat=&n=7`（bbox 网格）。

## 高德底图（已接）
- **默认底图 = 高德**（Autonavi 公开栅格瓦片 CDN `wprd0{1-4}.is.autonavi.com`，免 key）。
- **坐标对齐**：高德瓦片是 GCJ-02，业务数据统一存 WGS-84；渲染时按当前底图投影——高德底图上实时把路线 / POI / 标记转 GCJ-02 再画，保证叠加层与瓦片像素级对齐。
- 顶栏切换循环：高德 → 在线(OpenFreeMap 矢量街道) → 离线(pmtiles) → 高德。

## 实时导航（已接）
- **进入方式**：地图 Tab 规划路线后点「🧭 开始导航」（支持真实 GPS / 模拟预览两种模式）。
- **实时 GPS 跟踪**：`watchPosition` 高精度持续定位，地图跟随当前位置，蓝色箭头 `▲` 指示行进方向。
- **进度追踪**：纯几何投影算法 `projectOnRoute` 把 GPS 点映射到路线上 → 计算已走/剩余距离/时间/比例。
  - 地图上**自动分段渲染**：已走路段灰色 + 未走路段蓝色，直观展示行进位置。
  - 底部 **NavHUD** 显示剩余距离/时间 + 下一步转向（图标+文字+距离）+ 退出按钮。
- **中文语音播报**：Web Speech API (`zh-CN`) 自动播报：
  - 进入导航：「开始导航，全程约 X 公里，预计 Y 分钟」
  - 接近路口（≤200m）：「前方约 X 米，右转进入XX路」
  - 到达目的地：「您已到达目的地」
  - 偏航重算：「已偏航，正在重新规划路线」
- **偏航自动重算**：GPS 偏离路线超过 40m → 自动以当前位置为起点、原终点为目标重新调 `/api/route` 规划新路线（**5s 节流**，避免每个 GPS tick 都打高德造成镜头抖动与请求风暴；仅真实 GPS 模式触发）。
- **镜头跟随行进方向**：勾选「镜头跟随行进方向」后，导航中地图 `bearing` 随 GPS 朝向 (`heading`) 旋转、`pitch` 抬到 50° 进入 3D 视角，前进方向始终朝上（关闭则仅居中）。
- **多路线对比（A/B 方案）**：地图 Tab「路线对比」区块可输入 A/B 两套起终点，分别「规划 A / 规划 B」后**双色叠加**渲染到地图，并并排显示距离/时长与差值，便于选路。
- **模拟导航**：勾选「模拟导航（无 GPS 室内预览）」后沿路线几何逐点推进，无需 GPS 即可室内预览完整导航体验（适合调试与演示）。
- **高德 maneuver 解析**：从高德 v4 骑行接口的 instruction 文本正则推断转向类型（左转/右转/环岛/靠左/靠右…），替代原先写死的 `straight`，使转向提示和图标正确。

## 途径点骑行导航（已接）
- **多途经点规划**：骑行 Tab「🚩 途径点骑行导航」区块可依次添加多个途经点（起点 / 途经点1 / 途经点2 / … / 终点）。每个途经点支持：搜索框地理编码（Enter 添加下一站）、「用当前位置」一键设为、↑↓ 调整顺序、删除、清空。
- **逐段规划 + 合并**：点「🧭 规划途径点路线」后，按相邻点对**逐段**调用 `getRouteSmart`（走 `/api/route`，并享受离线路由缓存回退），再用 `mergeRoutes` 把各段几何 / 步骤 / 里程 / 爬升累加合并为**一条完整 Route**。原先的 `computeNavState` / `isOffRoute` / `projectOnRoute` 全程复用、**零改动**。
- **导航进度显示**：导航中底部 NavHUD 显示「🚩 途经点 idx/总数 · 名称」，逐站推进（起点→途经点1→…→终点）；每抵达一站自动语音播报并切到下一站目标，末站到达即整体结束。
- **到站判定**：用 `distM(pos, 目标途经点) < 40m` 独立判定到站（不依赖路线投影，避免绕路误差）。
- **偏航重路由（保留后续途经点）**：偏航时以当前位置为起点、**下一站途经点**为目标重算该段，再 `mergeRoutes([新段, ...剩余段])` 重建完整路线——绝不跳过中间途经点（比直接重算到终点更正确）。仅真实 GPS 模式触发 5s 节流。
- **地图标记**：起点蓝色 🚩、各途经点用 `WP_COLORS` 彩色 🚩（带「途经点N 名称」气泡）、终点橙色 🏁；与导航蓝箭头 / 录制绿脉冲 / 回放橙点 / 队友色点 / 海拔红环互不冲突。
- **核心纯函数**（`web/src/nav/waypoints.ts`，无副作用易测）：`mergeRoutes(legs)` / `planWaypointRoute(stops, planOne)` / `singleNavContext(route)`；`App.tsx` 通过 `seedNav` 把单点路线 / AB 对比 / 智能推荐 / 行程规划结果统一接入同一套导航上下文。
- **端到端验证**：`verify-waypoint.cjs` 设 3 个途经点（上海人民公园 / 南京东路步行街 / 外滩）→ 断言标记≥3、路线距离>0、navStops=3、🚩/途经点1/🏁 标签出现、起始 NavHUD 1/3、模拟导航 idx 推进到 2 并最终到达、HUD 含「途经点」。**11/11 PASS**（无头 swiftshader WebGL）。

## 轨迹闭环（已接）
- **GPX 导入**：骑行 Tab「导入 GPX」按钮支持上传 `.gpx` 文件（兼容本应用导出格式与各厂商命名空间），通过 `shared/gpx.ts` 的 `gpxToTrack` 解析为 `Track` 对象（含坐标/海拔/时间/**心率**）。
- **GPX 导出**：停止骑行记录后自动下载 `.gpx` 文件（含心率数据，通过 `<extensions><hr>` 标签），可分享到 Strava / Garmin / 两步路等平台。
- **轨迹回放**：导入或记录完成后自动加载到回放视图：
  - **地图联动**：绿色轨迹线绘制到地图 + 橙色回放位置标记随进度移动（复用 liveTrack 通道，无需改 MapView 接口）。
  - **回放控制条**：播放 / 暂停、进度拖拽（range input）、倍速档位（1x / 2x / 4x / 8x）、时间显示。
  - **状态机在 App 层**：定时器驱动游标推进 → 联动地图 marker + 图表游标竖线；到达末尾自动暂停。
- **数据分析图表**（纯 SVG 手绘，零依赖）：
  - **海拔剖面**：绿色折线，显示全程爬升趋势与当前点海拔值。
  - **心率曲线**：红色折线（仅当 GPX 含心率数据时显示），展示心率波动。
  - **速度曲线**：蓝色折线，由相邻 GPS 点距离/时间差计算瞬时速度 (km/h)。
  - 三张图均支持**回放游标竖线**（虚线 + 圆点），随回放进度同步移动。

## 数据持久化（已接）
- **零依赖 localStorage 封装**：`web/src/storage.ts` 提供 `loadJSON<T>` / `saveJSON`，带 try-catch + SSR 守卫，配额超限/隐私模式静默失败。
- **行程自动恢复**：
  - 行程 Tab 的行程（标题 + 按天途经点）每次变更即时写入 `localStorage`（结构升级为 `SavedTrip { title, waypoints }`）。
  - 刷新页面后**自动恢复途经点**；若存在 ≥2 个途经点则**自动重新规划路线**并渲染到地图（不强制切换 Tab）。
- **骑行轨迹档案库（我的骑行）**：
  - 骑行记录停止 / GPX 导入后自动存入档案库（上限 50 条），含名称（日期+时间）、距离、采样点数。
  - 骑行 Tab 底部显示「我的骑行」列表：点击任意条目即可加载到回放+图表视图，支持单条删除。
  - 刷新页面后档案库完整保留。

## 骑行成就与年度报告（已接）
- **入口**：新增「🏆 成就」Tab。基于档案库全部轨迹做纯前端聚合（零外部依赖）。
- **年度报告**：年份下拉切换 / 全部时间；顶部四大数字（总里程/时长/爬升/次数）；**GitHub 风格热力日历**（按每日里程 5 档着色，含月份标签与周几行头）；月度里程柱状图；个人纪录卡（最长单次/最大爬升/最长时长/最高均速/**最快 5·10·20km** 滑动窗口计算）。
- **连续打卡**：按本地日历日去重，自动算出当前连续天数 + 历史最长连续天数。
- **徽章体系**（12 枚，含进度条）：里程里程碑（100/500/1000km）、单次距离（50/100km）、累计爬升（1000/5000m）、连续打卡（7/30天）、早起鸟(5-8点出发)、夜骑侠(20点后)、出行次数。每枚徽章显示 `当前值 / 目标值` + 进度百分比。
- **可分享年度报告卡**：「生成年度报告卡」弹层渲染 SVG 卡片（深蓝渐变背景 + 四大数字 + 月度柱 + 纪录摘要），支持一键下载 PNG（复用 RideShareCard 的 SVG→Canvas→PNG 导出模式）。
- **核心算法在 shared 层**（`shared/src/achievements.ts`）：`aggregate` / `personalRecords` / `bestEffortInTrack`(滑动窗口) / `streaks` / `dayCalendar` / `computeBadges` / `buildAnnualReport`。**前后端共用同一份纯函数**，Server 未来可直接复用做服务端聚合。
- **端到端验证**：`verify-achievements.cjs` 注入构造轨迹（9 条、多天连续、含 ele/hr/t、经度递增产生真实距离），切成就 Tab → 断言总里程精确匹配、个人纪录正确、连续打卡=7、徽章 earned≥4 且特定徽章状态符合预期、热力日历>300 格子、报告卡弹层+SVG 出现、「全部时间」年份一致。**20/20 PASS**。

## 云同步与账户（已接）
- **入口**：新增「☁️ 云端」Tab。未登录显示注册 / 登录表单（用户名 + 密码，可切换模式）；登录后显示账号、上次同步时间、本地 / 云端轨迹数、「立即同步」「退出登录」。
- **服务端接口**（`server/src/routes/sync.ts`）：
  - `POST /api/auth/register`、`POST /api/auth/login` → `{ token, user }`
  - `POST /api/auth/logout`（Bearer）→ 服务端**真实吊销 token**
  - `GET /api/auth/me`（Bearer）、`GET /api/sync`（拉取全量）、`POST /api/sync`（推送 + 服务端合并后回传权威版本）
- **存储**（`server/src/store/db.ts`）：零依赖 JSON 文件持久化（`data/cloud.json`，tmp + rename 原子写）。密码用 `node:crypto` **scrypt 加盐哈希**（不存明文），校验走 `timingSafeEqual` 防时序攻击；token 为 32 字节随机 hex。`data/` 已加入 `.gitignore`。
- **合并策略**（`shared/src/sync.ts`，**前后端共用同一份纯函数**，避免两端策略不一致）：
  - 轨迹：按 `savedAt` 取**并集**去重 → 应用**删除墓碑**过滤 → 时间降序 → 上限截断。
  - 行程：LWW（last-write-wins），按 `updatedAt` 取较新的一份。
  - 墓碑：本地删除的轨迹记入 `deletedTracks` 一并上行，避免被其它设备的并集「复活」。
- **自动同步**：登录成功后自动 pull 合并到本地；`library` / `trip` 变更后**防抖 3s 自动 push**，用数据签名判断「是否真有新变更」避免空推。
- **端到端验证**：`verify-cloud.cjs` 同时起 server(3000) + vite(5173)，**不 mock 认证与同步**（仅拦截 `/sw.js` 与地图瓦片）。设备 A 注册 → 造轨迹 → 同步；设备 B 用独立 incognito context（空 localStorage）登录同账号 → 拉取 → 断言轨迹恢复；并断言删除墓碑不被回灌、退出后旧 token 立即失效。**19/19 PASS**。

## 移动端 PWA（已接）
- **可安装**：`public/manifest.webmanifest` + `index.html` 的 `manifest` / `apple-touch-icon` / `theme-color` 等元信息，浏览器/手机支持「安装到主屏」；捕获 `beforeinstallprompt` 后在顶栏显示「＋ 安装到主屏」按钮。
- **离线可用**：`public/sw.js` Service Worker（生产构建 `import.meta.env.PROD` 时注册）采用分级缓存策略：
  - 同源资源（JS/CSS/HTML）：stale-while-revalidate，离线也能秒开；
  - 跨域瓦片（高德/OpenFreeMap/PMTiles）：cache-first，弱网/飞行模式仍可出图；
  - `/api` 请求：network-first，失败回退缓存。
- **移动适配**：`viewport-fit=cover` + 状态栏沉浸 + 按钮 `touch-action: manipulation` 去除 300ms 点击延迟，适合手机触控。

## 离线路由缓存（已接）
- **路线级离线**：与离线瓦片（管底图）互补，`web/src/offline/routeCache.ts` 把每段规划结果按「起终点签名」缓存到 `localStorage`（`routes-cache`）。
- **弱网/无网回退**：`getRouteSmart()` 优先联网取最新路线并写缓存；请求失败时回退到缓存几何（路线标记 `cached: true`，界面提示「离线缓存路线」），导航/行程在飞行模式下仍可继续。
- **行程预下载**：行程 Tab「💾 下载离线路线」按钮，一次性把全部相邻途经点段落规划并缓存，出门前预载、途中无网也能导航。

## 骑行成绩分享卡片（已接）
- 骑行 Tab 选中某条轨迹（回放/分析视图）后点「🖼️ 生成成绩卡片」，弹出一张 SVG 成绩卡：标题 + 里程/时长/均速/心率/爬升指标 + 心率或速度剖面。
- 「下载 PNG」把 SVG 经 Canvas 栅格化导出为图片，可直接分享到社交平台（纯前端、零图片依赖）。

## 骑行数据可视化（已接）
- **数据概览仪表盘**：骑行 Tab 内「骑行数据概览」卡片展示总里程 / 总爬升 / 总时长 / 骑行次数 / 平均里程 / 平均爬升（基于 `shared/trackStats.ts` 的 `summarizeTrack` 统一口径，时长由轨迹首末时间戳推算）。
- **按月里程柱状图**：纯 SVG 柱状图，按 `YYYY-MM` 聚合每条轨迹距离，一眼看出各月骑行量。
- **运动热力图**：点击「显示运动热力图」把所有轨迹采样点作为点要素喂给 MapLibre `heatmap` 图层（重叠点自动累加密度），在地图上呈现「常去/常骑路段」热力分布，自动框选到全部轨迹范围。
- **历史对比**：在档案库勾选 2 条轨迹 → 点「在地图对比」即以双色折线叠加渲染到地图（`compareTracks` 通道），同时下方给出并排指标表（里程/爬升/时长/均速/心率），直观看出两次骑行的差异。

## 海拔剖面与爬坡分析（已接）
- **入口**：加载轨迹回放（点击档案库条目 / 导入 GPX / 停止录制）后，底部自动出现「📈 海拔剖面 · 爬坡分析」面板（录制/导航时自动让位）。
- **纯函数核心**（`shared/src/climb.ts`，**端云共用**）：
  - `buildProfile(points, stepM, smoothWin)`：等距重采样（默认 25m 步长）+ **移动平均平滑**（消除 GPS 高程噪声）+ 逐点坡度%（含插值坐标供地图联动）。
  - `detectClimbs(profile)`：「峰值 + 回落容差」算法识别爬坡段（允许途中小幅回落视为同一段），按 minGain/minLen/minAvgGrade 过滤噪声小坡。
  - `climbCategory(score)`：Strava 风格定级（score = 长度m × 平均坡度% → HC/C1–C4；城市骑行多为 C3–C4 或未定级小坡）。
  - `analyzeProfile`：总爬升/下降、最陡上坡/下坡、最高最低海拔、爬坡段数与爬坡总里程、最陡爬坡段。
- **SVG 剖面图**（Strava 风格渐变面积图）：
  - X 轴 = 距离（km），Y 轴 = 海拔（m），含网格线与刻度。
  - **按坡度分档着色竖条**：平缓(灰) → 缓坡3%(绿) → 中坡6%(黄) → 陡坡9%(橙) → 峻坡12%(红) → 极陡≥15%(深红)，形成连续渐变视觉。
  - 爬坡段在图上用橙色半透明背景带 + ▲编号标注。
  - **悬停联动地图**：鼠标在剖面上移动 → 显示该点距离/海拔/坡度读数 + 地图对应位置出现**红色圆环高亮标记**（区别于导航蓝箭头/录制绿脉冲/回放橙点）；移出后标记消失。
  - 爬坡段列表：每段显示定级徽章（C1–C4/HC 或坡度档标签）、长度、爬升、均坡、最大坡；悬停条目也联动到该段中点。
- **顶部摘要 chips**：距离、爬升(m)、下降(m)、最陡坡%、最高海拔(m)、爬坡段数。
- **收起 / 重开**：面板可关闭（录制/导航时自动隐藏），关闭后底部显示「📈 海拔剖面」pill 一键重开。
- **端到端验证**：`verify-elevation.cjs` 注入构造轨迹（5km、先平→爬200m→下200m→平），加载回放 → 断言面板/SVG/爬坡段渲染、精确数值（距离≈5000m/爬升≈200m/最陡≈10%/C3 定级）、悬停联动地图高亮标记、收起/重开。**21/21 PASS**。

## 结伴骑行 · 位置共享（WebSocket 多人）（已接）
- **入口**：新增「👥 结伴」Tab。未登录引导去「云端」登录；登录后输入房间号（字母/数字/连字符，1–24 位）→「加入」建立 WebSocket 长连接。
- **协议**（`shared/src/live.ts`，**端云共用同一份判别联合**）：
  - 客户端 → 服务端：`{type:'pos',pos:{lng,lat,spd?,hdg?,t}}` / `{type:'ping',t}`
  - 服务端 → 客户端：`welcome`(含本人身份+房间全体快照) / `join` / `leave` / `pos` / `pong` / `error`
  - 安全解析 `parseClientMsg` / `parseServerMsg`：网络消息逐字段校验，非法返回 null。
  - `groupSpread(members)` 纯函数：haversine 质心 + 最大两两间距 + 掉队者判定（距质心 >300m）。
  - `colorForId(id)` 哈希稳定色：同 id 永远同色。
- **服务端**（`server/src/ws/liveShare.ts`）：
  - `ws` 库 `noServer` 模式挂到 Fastify http.Server 的 `'upgrade'` 事件上，仅接管 `/ws/ride` 路径（其余返回 404），复用 **同一端口(3000) 与 Bearer-token 账户体系**。
  - 房间模型：`Map<room, Map<userId, Client>>`。一用户一房间内只保留一条连接（多设备顶掉旧连接）。
  - 心跳两层：① ws 协议层 ping/pong 帧 + alive 标志（30s 巡检清理僵死连接）；② 应用层 `{type:'ping'}`→`{type:'pong'}` 测 RTT（20s 间隔）。
  - 鉴权：浏览器 WebSocket 无法自定义请求头，token 通过查询参数 `?token=` 传入，用与 REST 相同的 `userByToken` 解析；非法 token 返回 HTTP 401 并销毁 socket。
- **前端客户端**（`web/src/live/liveClient.ts`）：
  - `LiveClient` 类：封装 connect/sendPos/close + 断线自动重连（指数退避 1s→10s 上限）+ 应用层 ping 保活。
  - URL 构造：`ws://host/ws/ride?room=xxx&token=yyy`（开发时 Vite 代理 `/ws` 到 `:3000` ws:true）。
- **结伴面板**（`web/src/live/GroupPanel.tsx`）：
  - 房间号输入 + 加入/离开按钮、连接状态指示灯（已连接/连接中/已断开）、成员列表（颜色圆点 + 名字 + 距离 + 时间戳 + 掉队标记）。
  - 队伍聚散摘要：显示队伍跨度距离 + 掉队人数警告。
  - 点击队友条目 → 地图飞行到该人位置并切回地图 Tab。
- **地图队友标记**（MapView `mates` prop）：
  - 每位有位置的队友渲染为「名字气泡 + 彩色圆点」自定义 div marker（anchor=bottom，锚点在圆心底部），本人不画为队友（避免与 livePos 绿脉冲重叠）。
  - 标记随位置更新全量重建（队伍规模小，开销可忽略）。
- **App 集成**：
  - Tab 类型新增 `'group'`，标签动态显示在线队友数（如 `👥 结伴·2`）。
  - 登录态复用已有 `auth` state；加入时启动 `watchPosition` 自动上报 GPS 位置（高精度）；离开时停止监听并关闭 WebSocket。
  - 组件卸载时自动离开（cleanup effect），防止泄漏。
  - `window.__group` 调试接口：`join(room)` / `sendPos(lng,lat)` / `leave()` / `members()` / `status` / `selfId()`。
- **Vite 开发代理**：`vite.config.ts` 新增 `'/ws': { target: 'ws://localhost:3000', ws: true }`，开发环境无需额外配置即可走 WebSocket 代理。
- **端到端验证**：`verify-group.cjs` 同时起 server(3000) + vite(5173)，**不 mock 认证/WebSocket**。设备 A/B 各自注册登录（独立 incognito context）→ 加入同一房间 → 断言双方互相看到成员列表（2 人）→ 双方上报位置 → 断言跨设备实时可见（WebSocket 广播）→ 断言地图出现队友标记（各 1 个，且不含自己）→ 断言队伍聚散分析显示跨度距离 → 设备 B 离开 → 断言 A 实时感知（成员回落 1、标记清除）→ 非法 token 握手被拒（401）。**19/19 PASS**。

## 关键点
- **坐标系**：内部一律 WGS-84；进高德前 `wgs84ToGcj02`，回来自高德 `gcj02ToWgs84`（高德用 GCJ-02，比百度 BD-09 少一层转换）。
- **渲染与数据解耦**：MapLibre 只管画，高德/OSRM/Valhalla 只当数据源，离线能力不受影响。
- **类型贯穿**：`Route` / `POI` / `Coordinate` 在 shared 定义，端云 import 同一份。
- shared 的 `package.json` 把 `exports` 直接指向 `src/index.ts`，web 用 vite alias 也指同一份 TS，无需先 build shared。
# bike-travel
# bike-travel
# bike-travel
