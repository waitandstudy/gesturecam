import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

import type { FrameSize, HandTrackingFrame, HandTrackingInterface, Handedness, NormalizedLandmark, RawHand } from './handState';

/**
 * MediaPipe Tasks Vision `HandLandmarker` 的浏览器实现 —— 对应需求文档第十六节原则 3
 * 与参考文档第四节的 `HandTrackingManager`。
 *
 * 三条关键做法（都来自 handy 的实测经验，见 docs/handy-借鉴笔记.md §2）：
 *
 * 1. **检测前把输入降到 480p**（`DETECTION_MAX_HEIGHT`）。
 *    摄像头按原生分辨率采集以保证预览清晰，但 MediaPipe 内部本来就会把输入缩到
 *    ~200px，喂全帧只会白白增加像素转换与拷贝开销。关键点输出是归一化的，
 *    所以调用方完全看不出区别。**注意必须等比缩放、不能裁切** ——
 *    一裁切，归一化坐标就不再对应原始帧，场景坐标换算全错。
 *
 * 2. **VIDEO 模式 + 严格递增时间戳**。`detectForVideo` 要求时间戳单调递增，
 *    同一毫秒内调两次会直接抛错，所以要有 `if (ts <= last) ts = last + 1` 的兜底。
 *
 * 3. **GPU 失败要降级到 CPU 并打一行提示**，不要静默、也不要让整个应用起不来。
 *
 * 这个类是**唯一**允许 import `@mediapipe/*` 的地方。想在别处用它的时候，
 * 说明你正在破坏"换识别方案不用重写程序"这条约束。
 */

export class HandTrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandTrackerError';
  }
}

export interface MediaPipeHandTrackerOptions {
  /** wasm 目录（由 vite 插件把 node_modules 里的 wasm 挂到这个路径上） */
  wasmBasePath?: string;
  /** 模型文件路径 */
  modelAssetPath?: string;
  numHands?: number;
  /** 检测输入的最大高度，超过就等比降采样 */
  detectionMaxHeight?: number;
  /** 是否请求 GPU delegate（失败会自动降级 CPU） */
  preferGpu?: boolean;
  minHandDetectionConfidence?: number;
  minHandPresenceConfidence?: number;
  minTrackingConfidence?: number;
  /** 以 ES Module 方式加载 wasm（个别打包环境下需要） */
  useModule?: boolean;
}

const DEFAULT_WASM_BASE_PATH = '/wasm';
const DEFAULT_MODEL_PATH = '/models/hand_landmarker.task';
const DEFAULT_DETECTION_MAX_HEIGHT = 480;

export class MediaPipeHandTracker implements HandTrackingInterface {
  readonly name = 'mediapipe-tasks-hand-landmarker';

  private readonly options: Required<MediaPipeHandTrackerOptions>;
  private landmarker: HandLandmarker | null = null;
  private _delegate: 'GPU' | 'CPU' | null = null;
  private _lastTimestampMs = -1;
  private _lastDetectMs = 0;
  private _detectFailures = 0;
  private _inputSize: FrameSize = { width: 0, height: 0 };
  private detectCanvas: HTMLCanvasElement | null = null;

  constructor(options: MediaPipeHandTrackerOptions = {}) {
    this.options = {
      wasmBasePath: options.wasmBasePath ?? DEFAULT_WASM_BASE_PATH,
      modelAssetPath: options.modelAssetPath ?? DEFAULT_MODEL_PATH,
      numHands: options.numHands ?? 1,
      detectionMaxHeight: options.detectionMaxHeight ?? DEFAULT_DETECTION_MAX_HEIGHT,
      preferGpu: options.preferGpu ?? true,
      minHandDetectionConfidence: options.minHandDetectionConfidence ?? 0.5,
      minHandPresenceConfidence: options.minHandPresenceConfidence ?? 0.5,
      minTrackingConfidence: options.minTrackingConfidence ?? 0.5,
      useModule: options.useModule ?? false,
    };
  }

  get delegate(): 'GPU' | 'CPU' | null {
    return this._delegate;
  }

  get isReady(): boolean {
    return this.landmarker !== null;
  }

  /** 上一次 detect 的耗时（毫秒）。手机端性能就是靠这个数字被看见的。 */
  get lastDetectMs(): number {
    return this._lastDetectMs;
  }

  /** 实际送进模型的尺寸（用于确认降采样是否生效）。 */
  get detectionInputSize(): FrameSize {
    return { ...this._inputSize };
  }

  get detectFailures(): number {
    return this._detectFailures;
  }

  async init(): Promise<void> {
    if (this.landmarker) return;

    let vision;
    try {
      vision = await FilesetResolver.forVisionTasks(this.options.wasmBasePath, this.options.useModule);
    } catch (error) {
      throw new HandTrackerError(
        `手部识别运行时（wasm）加载失败：${describe(error)}。` +
          `请确认 ${this.options.wasmBasePath} 可访问（开发服务器由 vite 插件挂载）。`,
      );
    }

    const options = {
      baseOptions: {
        modelAssetPath: this.options.modelAssetPath,
        delegate: 'GPU' as const,
      },
      runningMode: 'VIDEO' as const,
      numHands: this.options.numHands,
      minHandDetectionConfidence: this.options.minHandDetectionConfidence,
      minHandPresenceConfidence: this.options.minHandPresenceConfidence,
      minTrackingConfidence: this.options.minTrackingConfidence,
    };

    if (this.options.preferGpu) {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(vision, options);
        this._delegate = 'GPU';
        return;
      } catch (error) {
        // 手机上 GPU delegate 失败很常见（驱动/上下文限制），必须能退回去
        console.warn(`[GestureCam] GPU delegate 不可用（${describe(error)}），改用 CPU。`);
      }
    }

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: this.options.modelAssetPath, delegate: 'CPU' },
      });
      this._delegate = 'CPU';
    } catch (error) {
      throw new HandTrackerError(
        `手部识别模型初始化失败：${describe(error)}。` +
          `请确认模型文件存在：${this.options.modelAssetPath}。`,
      );
    }
  }

  detect(source: HandTrackingFrame, frame: FrameSize, timestampMs: number): readonly RawHand[] {
    const landmarker = this.landmarker;
    if (!landmarker) return [];

    const input = this.prepareInput(source, frame);
    const timestamp = this.nextTimestamp(timestampMs);

    const started = performance.now();
    let result;
    try {
      result = landmarker.detectForVideo(input, timestamp);
    } catch (error) {
      // 单帧检测失败不该让渲染循环挂掉（VIDEO 模式下偶发的时间戳/尺寸问题）
      this._detectFailures += 1;
      if (this._detectFailures <= 3) {
        console.warn(`[GestureCam] 手部检测失败（第 ${this._detectFailures} 次）：${describe(error)}`);
      }
      return [];
    }
    this._lastDetectMs = performance.now() - started;

    return this.toRawHands(result.landmarks, result.handedness);
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this._delegate = null;
    this.detectCanvas = null;
  }

  // ---------------------------------------------------------------- 内部

  private nextTimestamp(timestampMs: number): number {
    let ts = Math.round(timestampMs);
    if (!Number.isFinite(ts)) ts = 0;
    if (ts <= this._lastTimestampMs) ts = this._lastTimestampMs + 1;
    this._lastTimestampMs = ts;
    return ts;
  }

  /**
   * 需要时把帧等比缩到 `detectionMaxHeight` 以内。
   * 不缩放时直接返回原对象，省掉一次全帧拷贝（原生 1080p 下这一下很值钱）。
   */
  private prepareInput(source: HandTrackingFrame, frame: FrameSize): HandTrackingFrame {
    const maxHeight = this.options.detectionMaxHeight;

    // 尺寸必须是有效的正数：摄像头还没出图时 videoWidth 为 0，
    // 万一调用方算错了尺寸（NaN），降采样会静默产出一张 0×0 的画布并把 NaN 传下去。
    // 宁可原样透传并在调试信息里显示 0×0，也不要制造一个看不懂的失败。
    const usable =
      Number.isFinite(frame.width) &&
      Number.isFinite(frame.height) &&
      frame.width > 0 &&
      frame.height > 0;

    if (!usable || frame.height <= maxHeight) {
      this._inputSize = usable ? { width: frame.width, height: frame.height } : { width: 0, height: 0 };
      return source;
    }

    const scale = maxHeight / frame.height;
    const width = Math.max(1, Math.round(frame.width * scale));
    const height = Math.max(1, Math.round(frame.height * scale));

    if (!this.detectCanvas) this.detectCanvas = document.createElement('canvas');
    const canvas = this.detectCanvas;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) {
      this._inputSize = { width: frame.width, height: frame.height };
      return source;
    }

    context.drawImage(source, 0, 0, width, height);
    this._inputSize = { width, height };
    return canvas;
  }

  private toRawHands(
    landmarks: readonly (readonly { x: number; y: number; z: number; visibility?: number }[])[],
    handedness: readonly (readonly { categoryName?: string; displayName?: string; score?: number }[])[],
  ): RawHand[] {
    const hands: RawHand[] = [];

    landmarks.forEach((handLandmarks, index) => {
      const category = handedness[index]?.[0];
      const points: NormalizedLandmark[] = handLandmarks.map((landmark) => ({
        position: { x: landmark.x, y: landmark.y },
        z: landmark.z,
        visibility: landmark.visibility ?? 1,
      }));

      hands.push({
        landmarks: points,
        handedness: toHandedness(category?.categoryName ?? category?.displayName),
        confidence: category?.score ?? 1,
      });
    });

    return hands;
  }
}

function toHandedness(name: string | undefined): Handedness {
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  if (lower.startsWith('left')) return 'left';
  if (lower.startsWith('right')) return 'right';
  return 'unknown';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
