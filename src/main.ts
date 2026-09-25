import './styles.css';

import { AssetError, AssetManager } from './core/assets/assetManager';
import type { SnapEvent } from './core/gesture/snap';
import { kindSpec, MaterialLibrary, plannedKinds } from './core/material/library';
import { attachBehaviorForMode, registerCoreBehaviors } from './core/behavior/behaviors/modes';
import { BehaviorManager } from './core/behavior/manager';
import { CameraError, CameraManager } from './core/camera/cameraManager';
import { ASPECT_PRESETS, Viewport, type OutputAspect } from './core/coords/viewport';
import { GestureManager } from './core/gesture/gestureManager';
import type { FlickEvent } from './core/gesture/flick';
import { createIdleGestureState, type GestureEvent, type GestureState } from './core/gesture/types';
import { type RawHand, type SceneHand } from './core/hand/handState';
import { HandTrackerError, MediaPipeHandTracker } from './core/hand/mediapipeHandTracker';
import { Scene } from './core/scene/scene';
import { DEFAULT_OBJECT_WIDTH, type ObjectState } from './core/scene/types';
import { RecorderError, RecorderManager, type RecordingLimits, type RecordingResult } from './core/recorder/recorderManager';
import { describeMimeType } from './core/recorder/mimeTypes';
import { Canvas2DRenderer } from './render/canvas2dRenderer';
import { drawHandOverlay } from './render/handOverlay';
import { ExportSurface } from './render/exportSurface';
import {
  createBrowserSaveDeps,
  pickSaveMethod,
  saveButtonLabel,
  saveOutcomeHint,
  saveRecording,
  type SaveMethod,
} from './ui/resultSaver';
import { drawDebugOverlay } from './render/debugOverlay';
import type { RenderFrame, RenderableObject } from './render/renderer';
import { Controls } from './ui/controls';

/**
 * ============================================================================
 * GestureCam 装配入口（composition root）
 * ============================================================================
 *
 * 这一层只做三件事：创建模块、把它们接起来、跑渲染循环。
 * **所有业务逻辑都不允许写在这里** —— 需求文档第二节明确禁止"为了完成 MVP
 * 把逻辑写死在页面代码里"。素材怎么动归 Behavior，坐标怎么换归 Viewport/geometry，
 * 摄像头怎么开归 CameraManager。
 *
 * 当前阶段：Phase 1（项目基础架构 + 摄像头预览 + Scene/Object 基础系统）。
 * 还没有接入的：手部追踪（Phase 2，`hand` 恒为 null）、跟随/缩放行为（Phase 4/5）、
 * 悬挂（Phase 7）、边界模式（Phase 8）、录制（Phase 9）。
 */

/** 新素材的基准宽度（占输出画幅宽度的比例） */
const DEFAULT_IMAGE_WIDTH_RATIO = DEFAULT_OBJECT_WIDTH;
/** 多个素材自动排布时的错开步长，避免完全重叠（真正的编排 UI 属于 Phase 14） */
const STACK_STEP = 0.05;

/**
 * 成片高度（像素）。宽度由画幅比例推出：9:16 → 720×1280。
 *
 * 先取 720p 而不是 1080p，是刻意的保守选择：录制时手机上要同时跑
 * "MediaPipe 检测 + 屏幕渲染 + 导出渲染 + H.264 编码"，1080p 的每帧像素是 720p 的
 * 2.25 倍，很容易掉帧。等真机实测有余量，把这里改成 1920 就是 1080×1920 ——
 * 素材状态和场景坐标都与分辨率无关，改一行即可（这也是需求文档"导出不同分辨率"的基础）。
 */
const EXPORT_HEIGHT = 1280;

/** 打开结果面板时的第一句提示：说清楚点下去会发生什么、东西会去哪。 */
const SAVE_FIRST_HINT: Record<SaveMethod, string> = {
  share: '点「保存到相册」会打开系统分享面板，选「存储到照片」即可进相册。',
  'file-picker': '点「另存为…」可以选择保存位置。',
  download: '点「保存视频」会下载到浏览器的下载目录（手机上不会进相册）。',
};

/**
 * 成片画幅预设。手机端口播默认 9:16，这是发布平台决定的，不是审美选择：
 * 抖音 / TikTok / 视频号 都是竖屏，横屏拍的素材发上去会被裁掉大半。
 */
const ASPECT_OPTIONS: readonly { label: string; value: OutputAspect }[] = [
  { label: '9:16', value: ASPECT_PRESETS.vertical },
  { label: '3:4', value: ASPECT_PRESETS.portrait },
  { label: '1:1', value: ASPECT_PRESETS.square },
  { label: '16:9', value: ASPECT_PRESETS.landscape },
  { label: '原相机', value: 'source' },
];

function staggerPosition(index: number): { x: number; y: number } {
  if (index === 0) return { x: 0.5, y: 0.5 };
  const slot = index - 1;
  return {
    x: 0.5 + STACK_STEP * ((slot % 5) - 2),
    y: 0.5 + STACK_STEP * ((Math.floor(slot / 5) % 5) - 2),
  };
}

interface GestureCamDebugApi {
  scene: Scene;
  assets: AssetManager;
  camera: CameraManager;
  viewport: Viewport;
  handTracker: MediaPipeHandTracker;
  gestures: GestureManager;
  /** 仅开发用：临时接管手势输入（没有真手时验证交互与行为链路） */
  injectRawHands(hands: readonly RawHand[]): GestureState;
  setGestureOverride(state: GestureState | null, hands?: readonly SceneHand[]): void;
  /**
   * 验证用：直接"翻到下一张"，绕过手势。
   *
   * 为什么要有它：合成手造不出"拇指贴中指"这个姿势（`makeHand` 的拇指位置是相对**食指**摆的），
   * 所以浏览器验收没法用手势驱动响指。手势本身由 `tests/snap.test.ts` 单测钉住，
   * 这里验的是**翻页这条流程**（出来的是哪张、位置在哪、上一张有没有收起来）。
   */
  revealNext(): void;
  recorder: RecorderManager;
  /** 仅开发用：把录制上限改小，便于验收"到上限自动停止"这条路径 */
  setRecordingLimits(limits: Partial<RecordingLimits>): void;
  /**
   * 仅开发用：用已经加载的素材再摆一个对象（和 UI 添加走同一条装配逻辑）。
   * 验收脚本里"破坏性"的用例（指弹删除）用它造一个自己的素材，
   * 免得把别的用例要用的素材删掉。返回新对象 id；没有素材时返回 null。
   */
  createDemoObject(patch?: { position?: { x: number; y: number } }): string | null;
  /** 仅开发用：改状态栏文字（验收脚本扰动过状态之后要还原，否则截图里会留着上一条消息） */
  setStatus(text: string): void;
  /** 仅开发用：把状态栏刷成产品自己的那条提示（验收脚本收尾时用，截图里就不会有残留消息） */
  refreshStatus(): void;
  /**
   * 仅开发用：调试叠层是否开着。
   * 叠层是画在画布上的，DOM 里没有可查的元素，验收脚本只能问这个。
   */
  isDebugOverlayOn(): boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  readonly lastResult: RecordingResult | null;
  readonly lastSaveMethod: SaveMethod;
  saveResult: () => Promise<void>;
}

declare global {
  interface Window {
    gesturecam?: GestureCamDebugApi;
  }
}

function main(): void {
  const controls = new Controls(document);

  const renderer = new Canvas2DRenderer(controls.canvas);
  const viewport = new Viewport(
    { width: 1, height: 1 },
    { width: 1, height: 1 },
    { mirrored: true, outputAspect: ASPECT_PRESETS.vertical },
  );
  const assets = new AssetManager();
  const camera = new CameraManager(controls.video, {
    initialFacing: 'user',
    idealWidth: 1280,
    idealHeight: 720,
    idealFrameRate: 30,
  });
  const behaviors = new BehaviorManager();
  registerCoreBehaviors(behaviors);

  const scene = new Scene({
    viewport,
    behaviors,
    name: '未命名场景',
    // 命中测试需要素材真实形状；Scene 不依赖 AssetManager，所以在这里注入
    aspectOf: (state) => assets.aspectOf(state.source),
  });

  // 双手：一只手拿住素材、两只手一起开合改大小。
  // 追踪和手势层都要开到 2，任何一层只留 1 手，双手缩放就永远不成立。
  const handTracker = new MediaPipeHandTracker({ numHands: 2, preferGpu: true });
  const gestures = new GestureManager({ maxHands: 2 });
  const recorder = new RecorderManager();

  /** 录制时真正被录的那块离屏画布（固定成片分辨率、不含黑边与调试叠层） */
  let exportSurface: ExportSurface | null = null;
  /** 麦克风流由 main 持有并负责停止（RecorderManager 只停自己采集的画布轨） */
  let micStream: MediaStream | null = null;
  let resultUrl: string | null = null;
  let lastResult: RecordingResult | null = null;
  let lastFileName = 'gesturecam.mp4';
  let lastSaveMethod: SaveMethod = 'download';
  let busyRecording = false;

  /** 最近一次检测得到的手势状态；两次检测之间沿用它的连续量 */
  let latestGestures: GestureState = createIdleGestureState();
  /** 本帧待投递的离散事件（只投递一次，避免 60fps 渲染重复触发抓取） */
  let pendingEvents: readonly GestureEvent[] = [];
  /** 指弹事件同样只投递一次（它也是"只活一帧"的） */
  let pendingFlicks: readonly FlickEvent[] = [];
  let pendingSnaps: readonly SnapEvent[] = [];
  /** 平滑后的手（调试叠层画它，能直观看出滤波效果） */
  let latestHands: readonly SceneHand[] = [];
  let lastDetectAt = 0;
  let trackerInitState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  /**
   * 仅开发用的手势覆盖：设上之后渲染循环不再读取追踪结果，直接用这份状态驱动场景。
   * 用途：无头浏览器/没有真手时验证"交互 → 行为"整条链路（后续调跟随手感的 Phase 4 也要用）。
   */
  let gestureOverride: GestureState | null = null;
  /** 覆盖模式下待投递的事件（与真实路径一样：只投递一次） */
  let overridePendingEvents: readonly GestureEvent[] = [];
  let overridePendingFlicks: readonly FlickEvent[] = [];
  let overridePendingSnaps: readonly SnapEvent[] = [];
  /**
   * 检测节奏与渲染节奏解耦：渲染跑满 60fps，检测按自己的节奏（~30fps）。
   * 手机上一次检测要 10–30ms，如果每帧都检测，渲染会被拖垮；
   * 而检测之间沿用上一次的手势结果，视觉上完全看不出来。
   */
  const DETECT_INTERVAL_MS = 33;

  /*
   * 调试叠层默认**关**。
   *
   * 它画的是骨架、fps、每个门槛的原始读数 —— 那是**标定**用的，不是给人看的：
   * 默认开着时左上角一大块读数压着画面，日常拍摄很碍事。
   * 注意别把 `handOverlay`（准星 + 手势提示横幅）一起关掉：
   * 那个是**操作反馈**，用户靠它知道"捏下去会抓到谁"（见下面渲染循环里的注释）。
   */
  let showDebug = false;
  /** null = 跟随摄像头默认（前置镜像）；true/false = 用户手动指定 */
  let mirrorOverride: boolean | null = null;
  /** 成片画幅预设的下标 */
  let aspectIndex = 0;
  let placedCount = 0;

  /**
   * 素材箱：这次拍摄要用到的素材清单（§25 里"工具箱式"的核心）。
   *
   * 它和 `assets` / `scene.objects` 是三层：资源（解码出来的）→ 素材（用户挑的）
   * → 对象（摆在画面上、被手势操控的那一份）。见 `core/material/library.ts` 顶部。
   */
  const materials = new MaterialLibrary();

  /**
   * 响指翻页的状态：**当前显示着哪一件**。
   *
   * 同一时刻只会有一件显示着 —— 响指是"下一张替换上一张"（§28：
   * 用户要的是按顺序出图、图出现在左上角，不是堆在一起）。`null` = 一张都没显示。
   */
  let revealedMaterialId: string | null = null;

  /**
   * 已经被"放出来过"的素材。
   *
   * ⚠️ 不能拿"当前是否显示"来判断要不要摆到左上角 —— 那样**拖过的图翻回来会被重置**
   * （翻下一页时上一张被收起来，再翻回来它就"看起来是第一次"）。
   * 用户明确要的是"**拖过就记住位置**"，所以必须记"放过没有"这件事本身。
   */
  const revealPlaced = new Set<string>();
  let fps = 0;
  let lastFrameTime = performance.now();

  // ---------------------------------------------------------------- 录制

  /** 申请麦克风。口播没有声音等于废片，所以录制是必须带的；失败则录无声视频并明确提示。 */
  async function ensureMic(): Promise<MediaStreamTrack | null> {
    const existing = micStream?.getAudioTracks()[0];
    if (existing && existing.readyState === 'live') return existing;
    if (!navigator.mediaDevices?.getUserMedia) return null;

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      return micStream.getAudioTracks()[0] ?? null;
    } catch (error) {
      controls.setStatus(
        `麦克风不可用（${error instanceof Error ? error.message : String(error)}），将录制无声视频。`,
        'warn',
      );
      return null;
    }
  }

  function stopMic(): void {
    if (!micStream) return;
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }

  async function startRecording(): Promise<void> {
    // 已经在录 / 正在收尾时直接忽略重复点击
    if (recorder.state !== 'idle' || busyRecording) return;
    if (!recorder.supported) {
      controls.showError(
        '当前浏览器不支持录制：mp4 / webm 编码都不可用。请更新浏览器，或在手机上用最新版 Chrome / Safari。',
      );
      return;
    }
    if (!camera.isReady) {
      controls.showError('摄像头还没就绪，等一下再录。');
      return;
    }

    // 导出画布固定成片分辨率，并在录制期间跟随屏幕视口的源尺寸/镜像/画幅
    exportSurface = new ExportSurface({
      source: { width: camera.videoWidth, height: camera.videoHeight },
      outputAspect: viewport.outputAspectSetting,
      mirrored: viewport.mirrored,
      height: EXPORT_HEIGHT,
    });

    const audioTrack = await ensureMic();

    try {
      recorder.start({ canvas: exportSurface.canvas, audioTrack, fps: 30 });
    } catch (error) {
      controls.showError(
        error instanceof RecorderError ? error.message : `开始录制失败：${error instanceof Error ? error.message : String(error)}`,
      );
      exportSurface = null;
      return;
    }

    controls.showError(null);
    controls.setRecording(true);
    controls.setStatus(
      `录制中：${exportSurface.width}×${exportSurface.height} · ${describeMimeType(recorder.supportedMimeType ?? '')}${audioTrack ? ' · 带音频' : ' · 无音频'}。请保持在本页面，切到后台会丢帧。`,
    );
  }

  async function stopRecording(): Promise<void> {
    // 注意判断的是"有没有在录"，而不是 busyRecording：
    // 后者只在收尾过程中为真，用它当入口条件会导致刚开录就点停止时直接 return。
    if (!recorder.isRecording || busyRecording) return;
    busyRecording = true;
    controls.setStatus('正在生成视频…');

    try {
      const result = await recorder.stop();
      showResult(result);
    } catch (error) {
      controls.showError(`生成视频失败：${error instanceof Error ? error.message : String(error)}`);
      controls.setStatus('录制失败。');
    } finally {
      busyRecording = false;
      exportSurface = null;
      controls.setRecording(false);
    }
  }

  function showResult(result: RecordingResult): void {
    lastResult = result;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(result.blob);

    const extension = result.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const seconds = (result.durationMs / 1000).toFixed(1);
    const megabytes = (result.blob.size / 1048576).toFixed(2);
    lastFileName = `gesturecam-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${extension}`;

    // 保存方式按设备能力选：手机走分享面板（才能进相册）、桌面走另存为、否则普通下载
    const probeFile = new File([result.blob], lastFileName, { type: result.mimeType });
    lastSaveMethod = pickSaveMethod(createBrowserSaveDeps(), probeFile);

    controls.showResult({
      url: resultUrl,
      downloadName: lastFileName,
      saveLabel: saveButtonLabel(lastSaveMethod),
      hint: SAVE_FIRST_HINT[lastSaveMethod],
      meta: `${seconds} 秒 · ${result.width}×${result.height} · ${megabytes} MB · ${describeMimeType(result.mimeType)} · ${result.hasAudio ? '含音频' : '无音频'}`,
    });
    controls.setStatus(`录制完成：${seconds} 秒，${megabytes} MB。点「${saveButtonLabel(lastSaveMethod)}」保存。`);
  }

  async function saveResult(): Promise<void> {
    if (!lastResult) return;
    controls.setResultHint('正在保存…');

    try {
      const outcome = await saveRecording({
        blob: lastResult.blob,
        fileName: lastFileName,
        title: 'GestureCam 录制',
        text: '用手势拍摄的口播素材',
      });

      if (outcome.cancelled) {
        controls.setResultHint('已取消保存。可以再点一次，或点「下载」。');
        return;
      }
      controls.setResultHint(saveOutcomeHint(outcome.method));
    } catch (error) {
      controls.setResultHint(
        `保存失败：${error instanceof Error ? error.message : String(error)}。可以点「下载」作为备选。`,
        'error',
      );
    }
  }

  function toggleRecording(): void {
    if (recorder.isRecording) {
      void stopRecording();
    } else {
      void startRecording();
    }
  }

  // ---------------------------------------------------------------- 手部识别

  async function startTracker(): Promise<void> {
    if (trackerInitState === 'loading' || trackerInitState === 'ready') return;
    trackerInitState = 'loading';
    controls.setStatus('正在加载手部识别模型（首次约 8MB，之后走本地缓存）…');

    try {
      await handTracker.init();
      trackerInitState = 'ready';
      controls.setStatus(`手部识别就绪（${handTracker.delegate}，支持双手）。${gestureHint()}`);
    } catch (error) {
      trackerInitState = 'failed';
      const message =
        error instanceof HandTrackerError
          ? error.message
          : `手部识别初始化失败：${error instanceof Error ? error.message : String(error)}`;
      controls.showError(message);
      controls.setStatus('手部识别不可用：素材仍可添加，但手势控制用不了。', 'warn');
    }
  }

  // ---------------------------------------------------------------- 尺寸与坐标

  function syncSourceSize(): void {
    if (camera.isReady) viewport.setSourceSize(camera.videoWidth, camera.videoHeight);
  }

  function applyLayout(): void {
    const rect = controls.canvas.getBoundingClientRect();
    renderer.resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), window.devicePixelRatio || 1);
    viewport.setCanvasSize(renderer.cssWidth, renderer.cssHeight);
    syncSourceSize();
  }

  function currentMirrored(): boolean {
    return mirrorOverride ?? camera.defaultMirrored;
  }

  function syncMirror(): void {
    const mirrored = currentMirrored();
    viewport.setMirrored(mirrored);
    controls.setMirrorPressed(mirrored);
  }

  function currentAspectOption(): { label: string; value: OutputAspect } {
    return ASPECT_OPTIONS[aspectIndex] ?? { label: '9:16', value: ASPECT_PRESETS.vertical };
  }

  /** 应用成片画幅。只影响布局与裁切，不改任何素材的场景坐标。 */
  function syncAspect(): void {
    const option = currentAspectOption();
    viewport.setOutputAspect(option.value);
    controls.setAspectLabel(option.label);
  }

  // ---------------------------------------------------------------- 摄像头

  async function startCamera(): Promise<void> {
    controls.setStatus('正在请求摄像头权限…');
    try {
      await camera.start();
      syncMirror();
      applyLayout();
      controls.setCameraReady(true);
      controls.showError(null);
      controls.setStatus(
        `摄像头就绪：${camera.videoWidth}×${camera.videoHeight}（${camera.facing === 'user' ? '前置' : '后置'}）。点「＋ 图片」添加素材。`,
      );
    } catch (error) {
      const message =
        error instanceof CameraError ? error.message : `打开摄像头失败：${error instanceof Error ? error.message : String(error)}`;
      controls.setCameraReady(false);
      controls.showError(message);
      controls.setStatus('摄像头不可用，素材仍可添加（但看不到画面）。', 'warn');
    }
  }

  async function switchCamera(): Promise<void> {
    if (!camera.isRunning) {
      await startCamera();
      return;
    }
    controls.setStatus('正在切换摄像头…');
    try {
      await camera.switchFacing();
      mirrorOverride = null;
      syncMirror();
      applyLayout();
      controls.setStatus(
        `已切换到${camera.facing === 'user' ? '前置' : '后置'}摄像头：${camera.videoWidth}×${camera.videoHeight}。`,
      );
    } catch (error) {
      controls.showError(error instanceof CameraError ? error.message : '切换摄像头失败。');
    }
  }

  // ---------------------------------------------------------------- 素材

  function describeScene(): string {
    const count = scene.objects.count;
    return count === 0 ? '场景里还没有素材。' : `场景里有 ${count} 个素材。`;
  }

  /** 秒 -> "1 分 05 秒" / "42 秒"，用在录制上限的提示上。 */
  function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes > 0 ? `${minutes} 分 ${String(rest).padStart(2, '0')} 秒` : `${rest} 秒`;
  }

  /**
   * 状态栏里那段"怎么用手势"。
   *
   * 只写一处：它原来在"识别就绪"和"添加素材"两处各写了一遍，很快就走偏了 ——
   * 加了指弹之后两边都还是旧文案（**指弹等于没有可发现性**）。
   * 集中一个函数之后，加手势只改这里一行。
   */
  function gestureHint(): string {
    return (
      '拇指+食指捏合＝选中（像鼠标左键）：移动手拖动，另一只手也捏上、两手开合就是缩放，' +
      '食指勾住再快速弹出＝删掉指尖下的图，握着素材的那只手握拳＝立即停止。'
    );
  }

  async function addImages(files: readonly File[]): Promise<void> {
    const problems: string[] = [];

    for (const file of files) {
      try {
        const asset = await assets.addImage(file);
        const object = scene.objects.create({
          source: asset.id,
          size: { width: DEFAULT_IMAGE_WIDTH_RATIO },
          // 新加入的素材默认"跟随手"：这是这个产品的核心承诺
          // （添加图片 -> 捏合抓住 -> 拖到想要的位置），FIXED 留给场景编排时显式指定。
          mode: 'FOLLOW_HAND',
          // 位置就是"响指把它放出来时它出现在哪"——画面左上角。用户拖过就一直在那。
          position: { ...REVEAL_POSITION },
          boundaryMode: 'CENTER_CLAMP',
          /*
           * §28 的流程：**挑进来的素材默认藏着**，打响指才一张张放出来。
           * 以前是加进来就显示 —— 那样"拍摄时放出来"就没意义了。
           */
          visible: false,
        });
        placedCount += 1;
        attachBehaviorForMode(behaviors, object);
        // 登记进素材箱，并记下"这件素材对应画面上哪一份"——
        // 将来"手势让素材出现/隐藏"要靠这条关系找回它
        const material = materials.add({ kind: 'image', label: asset.name, assetId: asset.id });
        materials.link(material.id, object.id);
      } catch (error) {
        problems.push(error instanceof AssetError ? error.message : `${file.name} 添加失败。`);
      }
    }

    if (problems.length > 0) controls.showError(problems.join('\n'));
    else controls.showError(null);

    renderMaterials();
    controls.setStatus(`${describeScene()}${gestureHint()}点「●拍摄」录制成片。`);
  }

  /** 把素材箱里的东西画进面板（UI 层只认扁平的 `MaterialRow`，不认核心层的 Material）。 */
  function renderMaterials(): void {
    controls.renderMaterials(
      materials.list().map((material) => {
        const spec = kindSpec(material.kind);
        const asset = material.assetId ? assets.get(material.assetId) : undefined;
        return {
          id: material.id,
          label: material.label,
          badge: spec.badge,
          // 只有位图类（图片/GIF/贴纸）才有缩略图；文字这类将来自己画一张
          thumbUrl: asset?.objectUrl ?? null,
          kindHint: `${spec.label} · ${spec.hint}`,
        };
      }),
    );
  }

  /**
   * 素材**第一次**被放出来时落在画面左上角（大致的构图位）。
   * 之后你把它拖到哪，它就一直在哪 —— 位置存在画面对象自己身上，不另记一份。
   */
  const REVEAL_POSITION = { x: 0.22, y: 0.2 };

  function setRevealed(id: string, visible: boolean): void {
    const material = materials.get(id);
    const object = material?.objectId ? scene.objects.get(material.objectId) : undefined;
    if (!object) return;
    object.setVisible(visible);
  }

  /**
   * 响指 = 出下一张（§28）。
   *
   * 后一张出来时**把前一张收起来**（替换，不是叠加）：
   * 用户要的是"按顺序出图、图出现在左上角"，几张堆在同一处会互相压住、也没法收。
   * 打到最后一张再打就从头循环 —— 用户明确说"不要回退"。
   */
  function advanceReveal(): void {
    const items = materials.list();
    if (items.length === 0) {
      controls.setStatus('素材箱是空的 —— 先点底栏「＋」加几张，再打响指翻页。', 'warn');
      return;
    }

    const currentIndex = revealedMaterialId
      ? items.findIndex((material) => material.id === revealedMaterialId)
      : -1;
    const nextIndex = (currentIndex + 1) % items.length;
    const next = items[nextIndex];
    if (!next) return;

    if (revealedMaterialId && revealedMaterialId !== next.id) setRevealed(revealedMaterialId, false);
    // 只有"从没被放出来过"的才摆到左上角；放出来过（可能被你拖走了）就保持原地
    const material = materials.get(next.id);
    const object = material?.objectId ? scene.objects.get(material.objectId) : undefined;
    if (object && !revealPlaced.has(next.id)) {
      object.setPosition({ ...REVEAL_POSITION });
      revealPlaced.add(next.id);
    }
    setRevealed(next.id, true);

    revealedMaterialId = next.id;
    renderMaterials();
    controls.setStatus(`${describeScene()}（第 ${nextIndex + 1}/${items.length} 张）`);
  }

  /**
   * 挪一件素材的顺序。
   *
   * **顺序就是响指翻页的顺序**（§28），所以这个操作是有语义的，不只是"排好看"。
   * 已经在头/尾时 `materials.move` 返回 false —— 界面那颗按钮本来就是禁掉的，这里不用报错。
   */
  function moveMaterial(id: string, delta: number): void {
    if (!materials.move(id, delta)) return;
    renderMaterials();
    // 正在显示的那一张**不变**（`revealedMaterialId` 存的是 id，不受顺序影响），
    // 只是它"第几张"变了；下一次响指从它的新位置往后走。
  }

  /**
   * 删掉一件素材。
   *
   * 画面上的那一份要一起收掉 —— 否则会出现"箱子里没有、画面上还在"的鬼影，
   * 而且那一份还会继续响应手势。
   */
  function removeMaterial(id: string): void {
    const objectId = materials.remove(id);
    if (objectId) scene.objects.remove(objectId);
    // 删掉的正好是"现在显示着的那张" -> 当前指针要清掉，
    // 否则下一次响指会从"一个不存在的 id"往后找，行为不好预测
    if (revealedMaterialId === id) revealedMaterialId = null;
    renderMaterials();
    controls.setStatus(`${describeScene()}${gestureHint()}点「●拍摄」录制成片。`);
  }

  function clearScene(): void {
    scene.objects.clear();
    assets.clear();
    materials.clear();
    revealedMaterialId = null;
    revealPlaced.clear();
    placedCount = 0;
    renderMaterials();
    controls.showError(null);
    controls.setStatus('已清空场景与素材。');
  }

  // ---------------------------------------------------------------- 渲染循环

  function buildFrame(): RenderFrame {
    const objects: RenderableObject[] = scene.objects.listByZ().map((object) => {
      const state: Readonly<ObjectState> = object.state;
      const asset = assets.get(state.source);
      return {
        state,
        aspect: assets.aspectOf(state.source),
        image: asset ? asset.image : null,
      };
    });

    return {
      camera: camera.isReady
        ? { source: controls.video, width: camera.videoWidth, height: camera.videoHeight }
        : null,
      objects,
    };
  }

  function loop(now: number): void {
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    const instantFps = dt > 0 ? 1 / dt : 0;
    fps = fps > 0 ? fps * 0.9 + instantFps * 0.1 : instantFps;

    syncSourceSize();

    // ---- 手势输入 ----
    let frameGestures: GestureState;

    if (gestureOverride) {
      // 与真实路径保持同样的语义：连续量沿用，事件只投递一次
      frameGestures = {
        time: now / 1000,
        controls: gestureOverride.controls,
        events: overridePendingEvents,
        flicks: overridePendingFlicks,
        snaps: overridePendingSnaps,
      };
      overridePendingEvents = [];
      overridePendingFlicks = [];
      overridePendingSnaps = [];
      latestGestures = frameGestures;
    } else {
      // 检测与渲染解耦：渲染跑满 60fps，检测按自己的节奏（~30fps）。
      // 手机上一次检测要 10–30ms，每帧都检测会把渲染拖垮；
      // 检测之间沿用上一次的手势连续量，视觉上完全看不出来。
      if (now - lastDetectAt >= DETECT_INTERVAL_MS) {
        lastDetectAt = now;
        const timeSeconds = now / 1000;
        const raw =
          handTracker.isReady && camera.isReady
            ? handTracker.detect(
                controls.video,
                { width: camera.videoWidth, height: camera.videoHeight },
                now,
              )
            : [];
        latestGestures = gestures.update(raw, timeSeconds, viewport);
        // 事件只投递一次：检测帧之间沿用连续量，但事件队列必须清空，
        // 否则 60fps 渲染会把同一次 pinch-start 触发好几遍。
        pendingEvents = latestGestures.events;
        pendingFlicks = latestGestures.flicks;
        pendingSnaps = latestGestures.snaps;
        latestHands = gestures.smoothedHands;
      }

      frameGestures = {
        time: now / 1000,
        controls: latestGestures.controls,
        events: pendingEvents,
        flicks: pendingFlicks,
        snaps: pendingSnaps,
      };
      pendingEvents = [];
      pendingFlicks = [];
      pendingSnaps = [];
    }

    /*
     * 响指 = 出下一张。它是"只活一帧"的一次性事件，所以这一帧响几下就翻几页。
     * 放在场景更新**之前**：翻出来的图当帧就参与后续的抓取与渲染判断。
     */
    for (let i = 0; i < frameGestures.snaps.length; i += 1) advanceReveal();

    scene.update(dt, frameGestures);

    const frame = buildFrame();
    renderer.render(frame, viewport);

    // ---- 录制：把同一帧渲染到离屏导出画布，并采样素材轨迹 ----
    if (recorder.isRecording && exportSurface) {
      exportSurface.syncFrom(viewport);
      exportSurface.render(frame);
      // 每帧把素材状态写进 timeline：实时合成保证"所见即所得"，
      // timeline 保证"拍完还能重编辑 / 换分辨率重导出"（需求文档第十三节）。
      scene.captureTimelineFrame();

      /*
       * 录制上限：MediaRecorder 把整段视频攒在内存里，手机上录几分钟就是几百 MB。
       * 到上限**不是错误** —— 自动停止、照常出片，然后明确告诉用户为什么停了。
       * 接近上限（80%）时先在状态栏提醒，让用户有机会主动收尾。
       */
      const usage = recorder.usage;
      controls.setRecordingTimer(recorder.elapsedSeconds, usage.ratio);
      const limit = recorder.checkLimits();
      if (limit) {
        // 提示要在 stopRecording **之后**写：它自己会写一条"录制完成"的状态，
        // 先写会被覆盖掉（验收脚本当场抓到了这一点）。
        const message =
          limit === 'duration'
            ? `已到录制时长上限（${formatDuration(recorder.recordingLimits.maxDurationSeconds)}），已自动停止并保存。`
            : '已到录制体积上限，已自动停止并保存（再录下去会把内存撑爆）。';
        void stopRecording().then(() => controls.setStatus(message, 'warn'));
      } else if (usage.ratio >= 0.8) {
        controls.setStatus(
          `快录满了：还剩约 ${formatDuration(usage.remainingSeconds)}，到时会自动停止并保存。`,
          'warn',
        );
      }
    }

    // ---- 手部准星（屏幕专用，永不进成片）----
    // 素材盖住手时，这是用户唯一能判断"捏下去会抓到谁"的依据，所以始终开着。
    // 手离开画面之后也要继续画：那时屏幕上还留着"已取消 · 请先张开手掌"的提示。
    if (
      latestHands.length > 0 ||
      latestGestures.controls.pinchPoint ||
      gestures.fistHands.length > 0 ||
      scene.interactions.rearmRequired ||
      scene.interactions.deletingCount > 0
    ) {
      const overlayCtx = controls.canvas.getContext('2d');
      if (overlayCtx) {
        drawHandOverlay(overlayCtx, renderer.dpr, viewport, frame.objects, {
          hands: latestHands,
          pinches: latestGestures.controls.pinches,
          twoHand: latestGestures.controls.twoHand,
          twoHandRatio: scene.interactions.twoHandDebug.distanceRatio,
          fistHands: gestures.fistHands,
          rearmRequired: scene.interactions.rearmRequired,
          deletingCount: scene.interactions.deletingCount,
          pinchPoint: latestGestures.controls.pinchPoint,
          pinchActive: gestures.pinchActive,
          previewTargetId: scene.interactions.previewTargetId,
          pinchRatio: gestures.debug.pinchRatio,
          flickArmed: gestures.debug.flickArmed,
          flickSpeed: gestures.debug.flickSpeed,
        });
      }
    }

    if (showDebug) {
      const ctx = controls.canvas.getContext('2d');
      if (ctx) {
        const trackerDebug = gestures.debug;
        const inputSize = handTracker.detectionInputSize;
        drawDebugOverlay(
          ctx,
          renderer.dpr,
          viewport,
          frame.objects,
          latestHands,
          {
            fps,
            objectCount: scene.objects.count,
            sourceWidth: camera.videoWidth,
            sourceHeight: camera.videoHeight,
            mirrored: viewport.mirrored,
            cameraFacing: camera.facing,
            gestureActive: latestHands.length > 0,
            detectMs: handTracker.lastDetectMs,
            detectInputWidth: inputSize.width,
            detectInputHeight: inputSize.height,
            trackerDelegate: handTracker.delegate ?? '未就绪',
            pinchRatio: trackerDebug.pinchRatio,
            pinchActive: gestures.pinchActive,
            handCount: trackerDebug.handCount,
            activePinches: trackerDebug.activePinches,
            twoHandActive: trackerDebug.twoHandActive,
            twoHandDistance: trackerDebug.twoHandDistance,
            twoHandRatio: scene.interactions.twoHandDebug.distanceRatio,
            flick: trackerDebug.flick,
            snap: trackerDebug.snap,
            perHand: trackerDebug.perHand,
            fistHands: trackerDebug.fistHands,
            rearmRequired: scene.interactions.rearmRequired,
            inHandLossGrace: trackerDebug.inHandLossGrace,
            grabbedIds: scene.interactions.grabbedIds(),
            timelineFrames: scene.timeline.frameCount,
            note: trackerNote(),
          },
          { showGrid: true, showBounds: true, showInfo: true, showHands: true },
        );
      }
    }

    requestAnimationFrame(loop);
  }

  function trackerNote(): string | undefined {
    if (trackerInitState === 'failed') return '手部识别不可用';
    if (trackerInitState === 'loading') return '正在加载手部识别模型…';
    if (handTracker.delegate === 'CPU') return 'GPU 不可用，已降级 CPU';
    return undefined;
  }

  // ---------------------------------------------------------------- 事件绑定

  controls.onPickImages((files) => {
    void addImages(files);
  });

  controls.switchCameraButton.addEventListener('click', () => {
    void switchCamera();
  });

  // 清空是"破坏性 + 想立刻看到结果"的操作：点完把设置面板收起来，让用户看见画面空了
  controls.clearButton.addEventListener('click', () => {
    clearScene();
    controls.setSettingsOpen(false);
  });

  controls.aspectButton.addEventListener('click', () => {
    aspectIndex = (aspectIndex + 1) % ASPECT_OPTIONS.length;
    syncAspect();
    controls.setStatus(
      `成片画幅已切到 ${currentAspectOption().label}（素材的场景坐标不变，画面按新画幅重新裁切）。`,
    );
  });

  controls.mirrorButton.addEventListener('click', () => {
    mirrorOverride = !currentMirrored();
    syncMirror();
    controls.setStatus(
      `镜像已${viewport.mirrored ? '打开' : '关闭'}（只翻转摄像头画面与手部位置，素材内容不会被翻转）。`,
    );
  });

  controls.debugButton.addEventListener('click', () => {
    showDebug = !showDebug;
    controls.setDebugPressed(showDebug);
  });

  /*
   * 设置面板。打开它时顺手收起调试叠层 —— 两块浮层叠在一起谁也看不清，
   * 而且"要看设置"和"要标定"是两种完全不同的场景，本来就不该同时出现。
   */
  controls.onSettingsToggle((open) => {
    if (open && showDebug) {
      showDebug = false;
      controls.setDebugPressed(false);
    }
    // 两个抽屉互斥：同时开着会互相压住，而且谁在上面取决于 DOM 顺序，很难解释
    if (open) controls.setMaterialsOpen(false);
  });

  /*
   * 素材箱：底栏「＋」打开它；加素材本身走 `onPickImages`
   * （绑在素材箱里的「添加图片」上，见 `ui/controls.ts`）。
   */
  controls.onMaterialsToggle((open) => {
    if (open) {
      if (showDebug) {
        showDebug = false;
        controls.setDebugPressed(false);
      }
      controls.setSettingsOpen(false);
      // 每次打开都重画：素材可能在别处被清掉过
      renderMaterials();
    }
  });

  controls.onMaterialAction((action, id) => {
    if (action === 'remove') removeMaterial(id);
    else moveMaterial(id, action === 'up' ? -1 : 1);
  });

  controls.onMaterialClear(() => {
    clearScene();
    controls.setMaterialsOpen(false);
  });

  // "以后支持"那行由**种类表**生成 —— 别在 UI 里手写死列表，那正是"写死"的起点
  const planned = plannedKinds();
  controls.setPlannedMaterials(
    planned.length > 0
      ? `以后支持：${planned.map((spec) => `${spec.label}（${spec.hint}）`).join(' · ')}`
      : '',
  );
  /*
   * 打开 App 先看到**素材箱**（§25 的流程）：先把这次要用的东西挑好、排好顺序，
   * 再点「开始拍摄」进相机。挑好之前不该先看到相机，否则"拍摄前先选"就是句空话。
   */
  renderMaterials();
  controls.setMaterialsOpen(true);

  controls.onToggleRecord(toggleRecording);
  controls.onCloseResult(() => controls.hideResult());
  controls.onSaveResult(() => {
    void saveResult();
  });

  // 不支持录制就禁用按钮，并把原因写在 title 里（不要给一个点了没反应的按钮）
  if (!recorder.supported) {
    controls.setRecordingSupported(false, '当前浏览器不支持 mp4 / webm 录制');
  }

  // 尺寸变化用 ResizeObserver 感知，避免每帧都读一次布局
  new ResizeObserver(() => applyLayout()).observe(controls.canvas);

  window.addEventListener('beforeunload', () => {
    camera.stop();
    assets.clear();
    stopMic();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  });

  /*
   * 手机端特有：切到后台（接电话、切 App、锁屏）后浏览器会暂停 video，
   * 有时直接把摄像头轨道解绑。回到前台必须显式恢复，否则用户看到的是
   * 一张卡住的最后一帧 —— 而拍摄类 App 最忌讳"以为在录其实没画面"。
   */
  document.addEventListener('visibilitychange', () => {
    /*
     * 切到后台时：**正在录制就立刻停并保存**。
     *
     * 为什么必须停，而不是"继续录"：
     *   · 后台时 rAF 停止，导出画布不再重绘，录下去只会得到一段**冻结的画面**；
     *   · 音轨可能还在走，于是画面与声音越差越远；
     *   · 内存还在继续涨（MediaRecorder 把整段攒在内存里），上限反而更容易被撞到。
     * 停下来至少把**已经录到的部分**完整交到用户手里 —— 这是"录一条完整口播"最要紧的一条。
     */
    if (document.visibilityState !== 'visible') {
      if (recorder.isRecording) {
        void stopRecording().then(() =>
          controls.setStatus(
            '页面切到后台，已自动停止录制并保存（后台时画面不再更新，继续录只会得到冻结的画面）。',
            'warn',
          ),
        );
      }
      return;
    }

    const track = camera.stream?.getVideoTracks()[0];
    if (!camera.isRunning || !track || track.readyState === 'ended') {
      void startCamera();
    } else if (controls.video.paused) {
      void controls.video.play().catch(() => startCamera());
    }

    // 后台期间 rAF 停止，dt 会是一个很大的值；重置基准避免一次巨大的时间跳变
    lastFrameTime = performance.now();
    applyLayout();
  });

  if (import.meta.env.DEV) {
    window.gesturecam = {
      scene,
      assets,
      camera,
      viewport,
      handTracker,
      gestures,
      /**
       * 开发用后门：没有真手时验证整条链路（MediaPipe 在无头浏览器里识别不到手）。
       * 走的是真实的 GestureManager，所以判定/迟滞/平滑逻辑都是真的。
       */
      injectRawHands: (hands) => {
        const state = gestures.update(hands, performance.now() / 1000, viewport);
        return state;
      },
      revealNext: () => advanceReveal(),
      setGestureOverride: (state, hands) => {
        gestureOverride = state;
        overridePendingEvents = state?.events ?? [];
        overridePendingFlicks = state?.flicks ?? [];
        overridePendingSnaps = state?.snaps ?? [];
        if (hands) latestHands = hands;
        if (state) latestGestures = state;
      },
      recorder,
      /**
       * 开发用后门：把录制上限调小，好在验收里几秒钟内跑到"自动停止"那条路径。
       * 走的是真实的上限逻辑，只是把阈值换掉。
       */
      setRecordingLimits: (limits) => {
        Object.assign(recorder.recordingLimits as { maxDurationSeconds: number; maxBytes: number }, limits);
      },
      createDemoObject: (patch) => {
        const asset = assets.list()[0];
        if (!asset) return null;
        const object = scene.objects.create({
          source: asset.id,
          size: { width: DEFAULT_IMAGE_WIDTH_RATIO },
          mode: 'FOLLOW_HAND',
          position: patch?.position ?? staggerPosition(placedCount),
        });
        placedCount += 1;
        attachBehaviorForMode(behaviors, object);
        return object.id;
      },
      setStatus: (text) => controls.setStatus(text),
      refreshStatus: () => controls.setStatus(`${describeScene()}${gestureHint()}点「●拍摄」录制成片。`),
      isDebugOverlayOn: () => showDebug,
      startRecording,
      stopRecording,
      saveResult,
      get lastResult() {
        return lastResult;
      },
      get lastSaveMethod() {
        return lastSaveMethod;
      },
    };
  }

  // ---------------------------------------------------------------- 启动

  applyLayout();
  syncMirror();
  syncAspect();
  requestAnimationFrame(loop);
  void startCamera().then(() => startTracker());
}

main();
