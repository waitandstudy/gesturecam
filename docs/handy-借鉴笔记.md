# handy 源码借鉴笔记

> 对象：[Vin124/handy](https://github.com/Vin124/handy)（MIT）。
> 本次为了这份笔记把仓库 clone 到临时目录通读了核心模块，**没有复制任何代码**，
> 所有结论都在本项目的架构里重新实现。相关决策见 `DECISIONS.md`。

---

## 0. 先纠正一个前提：handy 教不了手机端

这一点必须先说清楚，否则容易对它的参考价值产生错误预期。handy 自己的 `docs/spec.md`
（其实是给 AI 用的 `CLAUDE.md`）里写得很明确：

| 它的实际情况 | 对我们的意义 |
| --- | --- |
| Python 3.11 + OpenCV + Tkinter，**Windows 笔记本摄像头** | 技术栈完全不同，代码无法移植 |
| 自称 "**not** the production app ... a debug harness" | 它是原型验证工具，不是工程范本 |
| "iPhone/iPad mirroring" 明确列为 **out of scope** | 一行移动端代码都没有 |
| 单个 Python 进程 + 三个线程 | 浏览器里没有对应物（见 §4） |

**结论：它能教的是"手势内核"——平滑、判定、状态机、交互手感；手机端的画幅、
性能预算、权限、UI、后台恢复它一个字都没有，那部分必须自己解决。**

---

## 1. 已经采纳并落进代码的

### 1.1 抓取宽容边距（手感提升最明显的一条）

```python
GRAB_HIT_MARGIN_FRAC = 0.06   # 输出画幅短边的 6%
```

它的注释解释了为什么必须放宽：手指中点要精确落在小素材上很别扭，
**精确命中会让"差一点点"的捏合被白白消费掉**（用户必须松手重捏一次）。

手机上这条比桌面上更重要：手指更粗、素材更小。已实现为
`hitTestObject(..., marginPx)`，由 `InteractionManager.grabHitMarginFrac`（默认 0.06）驱动。
边距在素材**局部空间**外扩，所以旋转后的素材同样正确。

### 1.2 手恢复时的重新锚定（消除"跳一下"）

它的 `update_grab` 里有一行关键逻辑：

```python
offset = _anchor_offset(transform, pinch_point) if grab.misses else grab.offset
```

含义：如果这一帧之前发生过"手丢失"（misses > 0），不要沿用旧的抓取偏移，
而是**按当前素材位置反算偏移**。否则手在丢失期间移动了，恢复的那一帧素材会瞬移过去。

我们原来的实现会在恢复时瞬移。已修正：`InteractionManager` 在 `sinceCursorLost > 0`
时重算 `grabOffset`，恢复帧的 `dragDelta` 归零。有专门的单测覆盖
（`手丢失期间素材被冻结；手回来时重新锚定，不跳`）。

### 1.3 宽限期内素材冻结 + 一次性标记只活一帧

它的 `GrabState.misses` 计数 + `GRAB_RELEASE_GRACE_FRAMES = 4`（约 0.13s @30fps）
用来扛住 MediaPipe 偶发的丢帧。我们已有等价机制（`releaseTimeoutSeconds`），
但**语义不同，见 §4**。另外它的 `was_pinching` 边沿记忆启发了我们确认
"`transition` 这类一次性标记必须只存活一帧"，否则行为层会重复触发。

### 1.4 验证了我们的分层是对的

它的分层是 `hand_tracker`（只出归一化关键点）→ `gestures`（判定 + 迟滞）→
`interaction`（抓取/缩放状态机，**改的是 Scene 里的 Layer**）→ `compositor`（纯绘制）。
和我们的 `hand / gesture / interaction / behavior / render` 是同一个思路，互相印证。

它有一条和我们完全一致的原则，值得记下来：

> 「Hand landmarks are passed around as **normalized coordinates (0–1)**;
> convert to pixels only at draw time.」

### 1.5 单一校验边界的写法

`tuning.py` 的 `clamp_tuning(enter, exit)` 是**唯一**一处保证 `exit > enter` 的地方，
控制面板滑块和配置文件加载两条路径都走它：

```python
if exit < enter + MIN_HYSTERESIS_GAP:
    exit = enter + MIN_HYSTERESIS_GAP
if exit > PINCH_THRESHOLD_MAX:      # 抬高 exit 会越界时，把两个一起往下拉
    exit = PINCH_THRESHOLD_MAX
    enter = PINCH_THRESHOLD_MAX - MIN_HYSTERESIS_GAP
```

这个"越界时成对下移而不是各自截断"的细节很值得抄思路。Phase 2 做实时阈值调节
（面板/滑杆 + localStorage 持久化）时会照这个形状写。

---

## 2. 记录备用、Phase 2 直接用得上的具体参数

这些是它调出来的经验值，省掉我们从零试参数的时间。
**注意它们的坐标系是"归一化帧坐标"，和我们的场景坐标口径一致，可以直接用。**

### 2.1 One-Euro 平滑参数（`src/smoothing.py`）

```python
DEFAULT_MIN_CUTOFF = 1.2   # 静止时的平滑强度（越小越稳但越滞后）
DEFAULT_BETA       = 0.03  # 快速移动时放松平滑的程度（越大越跟手）
DEFAULT_D_CUTOFF   = 1.0   # 速度估计本身的平滑
```

按它注释的说法，这组默认值"能明显消抖静止的手，同时拖动时感觉不到滞后"，
调参口径是 ~20–30fps 的归一化坐标 —— 与我们一致。

实现细节值得照做：
- 每只手一个滤波组（21 关键点 × 3 分量），**按 slot 分配**；
- **某一帧该 slot 没有手 → 整组 reset**，理由是"重新出现的手不应该从陈旧状态里渗出来"；
- `dt <= 0` 时用 `_MIN_DT = 1e-3` 兜底，避免重复时间戳导致的除零；
- 过滤 z：`_alpha(cutoff, dt) = 1 / (1 + tau/dt)`，`tau = 1/(2π·cutoff)`。

### 2.2 pinch 判定：用**尺度无关**的比例，而不是绝对距离（重要）

这是整份代码里最有价值的一个设计。它早期用"帧宽比例"当阈值，后来改成：

```
pinch_ratio = |拇指尖 − 食指尖| / 掌心长度
掌心长度 = |手腕 − 中指 MCP|      ← 一段不受手指姿态影响的刚性骨骼
```

好处是**与手离摄像头的远近无关**：同一组手指间距，手靠近和手伸直读数一致。
原来的帧比例指标没有这个性质 —— 手远时张开的手指会掉进阈值（幽灵 pinch），
手近时又必须用力捏。

它对参数的口径记录得非常清楚：
- 指尖相触 ≈ **0.05–0.20**；张开的手 **远大于 1.0**；
- 滑块范围 `PINCH_THRESHOLD_MIN = 0.10` ~ `PINCH_THRESHOLD_MAX = 0.90`；
- 默认 `ENTER = 0.40`、`EXIT = 0.58`，迟滞带宽 0.18；
- `MIN_HYSTERESIS_GAP = 0.03`；
- 它还特别记了一句：**ENTER 从 0.30 提到 0.40 是因为 0.30 要求指尖几乎贴合，
  导致抓取"很难触发"** —— 这种"改小数值换来手感"的经验正是我们要的。

另外：**z（深度）被明确忽略**，因为单目估计的深度太噪，会把距离算歪。

还有一个拳检测启发式（`detect_grab`）备用：指尖到手腕的距离 < 该指 PIP 到手腕的距离
即视为"弯曲"，四指中**多数（≥3）**弯曲就算握拳 —— 注释解释了为什么不用"全部"：
追踪噪声和部分张开的小指不该让抓取失败。

### 2.3 检测前先降采样（手机端性能关键）

```python
DETECTION_MAX_HEIGHT = 480   # 送进 MediaPipe 之前把帧缩到高 480
```

注释里的推理很到位：摄像头按原生分辨率采集（预览清晰），但
**MediaPipe 内部本来就会把输入缩到 ~200px**，直接喂全帧只会白白增加
BGR→RGB 转换和拷贝的开销；480 是它之前跑得动的分辨率，所以检测耗时和精度都不变。
关键点输出是归一化的，所以调用方看不出区别。

浏览器里的对应做法（Phase 2 实现）：`drawImage` 到一张 480p 的离屏 canvas
再喂 `HandLandmarker`，画面本身照旧全分辨率渲染。

### 2.4 其他可以直接照搬的工程约定

- `RunningMode.VIDEO` + `detect_for_video(image, timestampMs)`，且
  **时间戳必须严格递增**：`if now_ms <= last: now_ms = last + 1`。
  浏览器版 `detectForVideo` 同样要求单调时间戳，这个兜底必须要有。
- 三个 min-confidence 旋钮（detection / presence / tracking，默认 0.5）是
  **启动期参数**，改了要重建 landmarker —— 所以它们不进实时调参面板，只走配置/CLI。
- `DEFAULT_NUM_HANDS = 1`：MVP 单手足够。
- 模型地址：`https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`
- GPU delegate 失败时**打印一行提示再降级到 CPU**，不要静默。

---

## 3. 明确**不采纳**的

### 3.1 三线程模型照搬不了

它把采集 / 追踪 / 主循环拆成三个线程，靠"单个原子引用赋值"传递最新帧
（latest-frame-wins，无锁），并用 `seq` 去重避免对同一帧重复检测。
浏览器里没有这个选项。可用的替代手段（Phase 2 决定用哪些）：

| 它的做法 | 浏览器里的替代 |
| --- | --- |
| 追踪跑在独立线程 | MediaPipe 跑在 Web Worker（需 OffscreenCanvas 传帧） |
| 主循环固定 30fps | rAF 本来就跟屏幕刷新走；检测按自己的节奏跑，结果在两次检测之间沿用 |
| 按 seq 去重 | 同样按帧序号去重，避免 60fps 渲染时对同一帧检测两次 |
| 有 HUD 分阶段计时 | 我们的调试叠层已显示 fps，Phase 2 加"检测耗时"一行 |

**本阶段不引入 Worker**：先把功能跑通，性能问题等 Phase 2 有实测数据再决定
（需求文档第九节也要求"不要一开始把架构做复杂"）。

### 3.2 释放宽限的语义与它不同（刻意的）

| | handy | 本项目 |
| --- | --- | --- |
| 宽限覆盖什么 | "这一帧没有捏合" | **只覆盖"整只手丢了"** |
| 触发即时释放 | 无独立事件，靠 pinch 标志 | 有 `gesture-end` 离散事件，**即刻释放** |
| 宽限时长 | 4 帧 ≈ 0.13s @30fps | 0.25s（`releaseTimeoutSeconds`） |

原因：我们把离散事件和连续量分开之后，用户真实松开手会立刻产生 `gesture-end`，
不需要靠"连续 N 帧没捏合"来推断。所以宽限期只剩下"追踪抖动/手短暂丢帧"这一种用途，
可以给得更宽而不会让"主动松手"变迟钝。

### 3.3 虚拟摄像头

它的卖点之一是 `pyvirtualcam` 输出到 OBS 虚拟摄像头（给 Zoom/直播用）。
**浏览器不提供虚拟摄像头输出能力**，这条在 Web/PWA 栈上是天花板，做不到。
如果这是产品必需功能，技术栈必须换成桌面端或原生 —— 这条已记在 `DECISIONS.md`。

### 3.4 它没有的、也不该问它的

- 手机端画幅 / 9:16 成片 / letterbox —— 它只有"摄像头画面"一个概念，没有成片画幅
- 安全区、触控目标尺寸、下拉刷新、页面缩放
- 前后台切换与摄像头恢复
- 麦克风（口播必须要有声音）—— 它压根没有音频通路
- **双手手势**：它整套手势都是单手的（`pinch` / `open_palm` / `fist`），
  没有"两只手协同"的概念，也没有多手身份跟踪。
  我们的双手缩放（`DECISIONS.md` 第 18 节）**不是从 handy 借鉴的**，
  而是被真机反馈逼出来的自有设计；handy 在这里只提供了一个反面对照：
  它对单手 pinch 的定位就是"抓取/释放"，从来没用它做过尺度控制。

以上全部由我们自己在 Phase 1 解决，见 `DECISIONS.md` 的"手机端适配"一节。
