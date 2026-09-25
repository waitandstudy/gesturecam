import { pickSupportedMimeType } from './mimeTypes';

/**
 * ============================================================================
 * RecorderManager —— 实时合成录制（需求文档第十三节）
 * ============================================================================
 *
 * 已确认的路线：**实时合成（所见即所得）+ 每帧把素材状态写入 timeline**。
 * 所以这里只负责"把一张画布 + 一路麦克风录成视频文件"；
 * "画布上该有什么"由 ExportSurface 负责，"素材轨迹"由 Timeline 负责。
 *
 * 四个刻意的设计：
 *
 * 1. **录的是离屏导出画布，不是屏幕上那块画布。**
 *    屏幕上画布带着 letterbox 黑边、尺寸还随手机型号变；直接录会得到
 *    "带黑边的、分辨率不确定的"视频。导出画布固定成片分辨率（默认 720×1280），
 *    顺带满足需求文档"导出不同分辨率"的要求。
 *
 * 2. **格式按优先级探测、拿不到就如实报错**（见 mimeTypes.ts）。
 *    不写死 mp4 也不写死 webm，都不支持时明确告诉用户，
 *    而不是录出一个他打不开的文件。
 *
 * 3. **可以注入 MediaRecorder 工厂。** 这样状态机（开始/分片/停止/出错/清理）
 *    能在 Node 里单测，不需要真的跑浏览器编码器。
 *
 * 4. **谁创建的轨道谁负责停。** RecorderManager 只停自己用 `captureStream()`
 *    采集到的画布视频轨；麦克风轨道由调用方（main.ts）持有并负责停止 ——
 *    否则要么录制结束麦克风灯还亮着，要么越权停掉别人的轨道。
 */

export type RecorderState = 'idle' | 'recording' | 'stopping';

/** MediaRecorder 的最小结构，便于测试替身。 */
export interface RecorderLike {
  readonly state: string;
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type RecorderFactory = (stream: MediaStream, options: MediaRecorderOptions) => RecorderLike;

export interface RecordingStartOptions {
  /** 要录制的画布（离屏导出画布） */
  canvas: HTMLCanvasElement;
  /** 可选麦克风音轨；口播必须要有声音 */
  audioTrack?: MediaStreamTrack | null;
  fps?: number;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  /** 成片像素尺寸 */
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface RecorderManagerDeps {
  /** 注入点：默认用浏览器的 MediaRecorder */
  createRecorder?: RecorderFactory;
  /** 注入点：默认 `new MediaStream(tracks)`；Node 里没有 MediaStream，所以留出接缝 */
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
  /** 注入点：默认 performance.now */
  now?: () => number;
  /** 探测格式支持；默认用 MediaRecorder.isTypeSupported */
  isTypeSupported?: (type: string) => boolean;
  /** 录制上限（时长 / 体积）。缺省用 `DEFAULT_RECORDING_LIMITS` */
  limits?: Partial<RecordingLimits>;
}

/** 分片间隔：定期拿到数据，避免整段视频都堆在最后一刻。 */
const TIMESLICE_MS = 1000;
const DEFAULT_FPS = 30;
/** 720p 竖屏的合理码率：再高对手机是负担，再低画面会糊。 */
const DEFAULT_VIDEO_BITRATE = 6_000_000;
const DEFAULT_AUDIO_BITRATE = 128_000;
/** onstop 迟迟不来时的兜底，避免用户对着"停止中"卡死。 */
const STOP_TIMEOUT_MS = 8000;

/**
 * 录制上限。
 *
 * 为什么必须有：MediaRecorder 是把整段视频**攒在内存里**的（分片也是 Blob），
 * 手机上录几分钟 720p 就是几百 MB。没有上限、也没有预警，最坏情况是录到一半页面崩掉、
 * **前面全丢** —— 这对"录一条完整口播"是致命的。
 *
 * 两个阈值哪个先到算哪个：
 *   · 时长（默认 5 分钟）：正常情况先到的是它；
 *   · 体积（默认 400MB）：码率异常/压缩比差时的兜底（400MB ≈ 9 分钟 @6Mbps）。
 *
 * 到上限不是错误：**正常出片 + 一句提示**，用户已经录到的内容一定拿得到。
 */
export interface RecordingLimits {
  maxDurationSeconds: number;
  maxBytes: number;
}

export const DEFAULT_RECORDING_LIMITS: Readonly<RecordingLimits> = Object.freeze({
  maxDurationSeconds: 5 * 60,
  maxBytes: 400 * 1024 * 1024,
});

/** 达到上限的原因。 */
export type RecordingLimitReason = 'duration' | 'bytes';

/** 用到什么程度：给 UI 显示"还剩多少"以及变色提醒。 */
export interface RecordingUsage {
  durationSeconds: number;
  bytes: number;
  /** 0..1，取时长与体积里更紧的那个 */
  ratio: number;
  /** 先到的那一项 */
  binding: RecordingLimitReason;
  /** 按当前进度估算还能录多少秒 */
  remainingSeconds: number;
}

export class RecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderError';
  }
}

function defaultFactory(stream: MediaStream, options: MediaRecorderOptions): RecorderLike {
  if (typeof MediaRecorder === 'undefined') {
    throw new RecorderError('当前浏览器不支持录制（没有 MediaRecorder）。');
  }
  return new MediaRecorder(stream, options) as unknown as RecorderLike;
}

export class RecorderManager {
  private readonly createRecorder: RecorderFactory;
  private readonly createStream: (tracks: MediaStreamTrack[]) => MediaStream;
  private readonly now: () => number;
  private readonly isTypeSupported: (type: string) => boolean;

  private recorder: RecorderLike | null = null;
  private chunks: Blob[] = [];
  private canvasStream: MediaStream | null = null;
  private startedAt = 0;
  private size = { width: 0, height: 0 };
  private hasAudio = false;
  private _state: RecorderState = 'idle';
  private pendingStop: Promise<RecordingResult> | null = null;
  private stopResolve: ((result: RecordingResult) => void) | null = null;
  private stopReject: ((error: unknown) => void) | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private readonly limits: RecordingLimits;
  /** 已经收到的分片总字节数（体积上限靠它，而不是靠 blob 拼完再量） */
  private recordedBytes = 0;

  constructor(deps: RecorderManagerDeps = {}) {
    this.createRecorder = deps.createRecorder ?? defaultFactory;
    this.createStream = deps.createStream ?? ((tracks) => new MediaStream(tracks));
    this.now = deps.now ?? (() => performance.now());
    this.isTypeSupported =
      deps.isTypeSupported ??
      ((type: string) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
    this.limits = { ...DEFAULT_RECORDING_LIMITS, ...deps.limits };
  }

  get recordingLimits(): Readonly<RecordingLimits> {
    return this.limits;
  }

  get recordedByteCount(): number {
    return this.recordedBytes;
  }

  /**
   * 当前用量（进度 + 还剩多少秒）。
   * 用在 UI 上：接近上限时状态栏变色并显示剩余时间。
   */
  get usage(): RecordingUsage {
    const durationSeconds = this.elapsedSeconds;
    const durationRatio = this.limits.maxDurationSeconds > 0 ? durationSeconds / this.limits.maxDurationSeconds : 0;
    const bytesRatio = this.limits.maxBytes > 0 ? this.recordedBytes / this.limits.maxBytes : 0;
    const binding: RecordingLimitReason = durationRatio >= bytesRatio ? 'duration' : 'bytes';
    const ratio = Math.max(durationRatio, bytesRatio);
    // 按"更紧的那一项"估算剩余秒数；已经超了就 0
    const remainingSeconds =
      binding === 'duration'
        ? Math.max(0, this.limits.maxDurationSeconds - durationSeconds)
        : Math.max(0, (this.recordedBytes > 0 ? durationSeconds / bytesRatio : durationSeconds) - durationSeconds);
    return { durationSeconds, bytes: this.recordedBytes, ratio, binding, remainingSeconds };
  }

  /**
   * 是否已经到上限。**达到后会持续返回同一个原因** ——
   * 调用方用它触发一次停止（重复调用 stop() 是安全的，会复用同一个 Promise）。
   */
  checkLimits(): RecordingLimitReason | null {
    if (this._state !== 'recording') return null;
    const usage = this.usage;
    if (usage.durationSeconds >= this.limits.maxDurationSeconds) return 'duration';
    if (this.recordedBytes >= this.limits.maxBytes) return 'bytes';
    return null;
  }

  get state(): RecorderState {
    return this._state;
  }

  get isRecording(): boolean {
    return this._state === 'recording';
  }

  /** 当前环境下能用的录制格式（null = 不支持录制）。 */
  get supportedMimeType(): string | null {
    return pickSupportedMimeType(this.isTypeSupported);
  }

  get supported(): boolean {
    return this.supportedMimeType !== null;
  }

  /** 已经录了多久（秒），给 UI 显示计时用。 */
  get elapsedSeconds(): number {
    return this._state === 'idle' ? 0 : (this.now() - this.startedAt) / 1000;
  }

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  start(options: RecordingStartOptions): void {
    if (this._state !== 'idle') {
      throw new RecorderError(`当前状态是 ${this._state}，不能开始新的录制。`);
    }

    const mimeType = this.supportedMimeType;
    if (!mimeType) {
      throw new RecorderError(
        '当前浏览器不支持任何可用的录制格式（mp4 / webm 都不可用）。请更新浏览器，或改用 Chrome / Edge / Safari 的较新版本。',
      );
    }

    if (typeof options.canvas.captureStream !== 'function') {
      throw new RecorderError('当前浏览器不支持从画布采集视频流（canvas.captureStream 不可用）。');
    }

    const fps = options.fps ?? DEFAULT_FPS;
    const canvasStream = options.canvas.captureStream(fps);

    // 单独组一条流，而不是往 canvasStream 上挂音轨：这样谁拥有什么很清楚
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
    if (options.audioTrack) tracks.push(options.audioTrack);

    const recorder = this.createRecorder(this.createStream(tracks), {
      mimeType,
      videoBitsPerSecond: options.videoBitsPerSecond ?? DEFAULT_VIDEO_BITRATE,
      audioBitsPerSecond: options.audioBitsPerSecond ?? DEFAULT_AUDIO_BITRATE,
    });

    this.chunks = [];
    this.recordedBytes = 0;
    this.canvasStream = canvasStream;
    this.recorder = recorder;
    this.startedAt = this.now();
    this.size = { width: options.canvas.width, height: options.canvas.height };
    this.hasAudio = Boolean(options.audioTrack);
    this.lastError = null;
    this._state = 'recording';

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
        // 累计字节数：体积上限要在分片到来时就能算出来，而不是等 blob 拼完
        this.recordedBytes += event.data.size;
      }
    };
    recorder.onerror = (event) => {
      this.lastError = describeRecorderError(event);
      this.finishWithError(new RecorderError(this.lastError));
    };
    recorder.onstop = () => {
      this.finishSuccess(mimeType);
    };

    recorder.start(TIMESLICE_MS);
  }

  /**
   * 停止录制并拿到结果。
   * 重复调用返回同一个 Promise（不会重复触发 stop）。
   */
  stop(): Promise<RecordingResult> {
    if (this.pendingStop) return this.pendingStop;
    if (this._state !== 'recording') {
      return Promise.reject(new RecorderError('当前没有在录制。'));
    }

    this._state = 'stopping';

    this.pendingStop = new Promise<RecordingResult>((resolve, reject) => {
      this.stopResolve = resolve;
      this.stopReject = reject;

      // 兜底：某些浏览器 onstop 偶尔不来。超时后把已经收到的分片交出去，
      // 而不是让用户对着一个卡住的"停止中"界面。
      this.stopTimer = setTimeout(() => {
        if (this._state === 'stopping') {
          this.lastError = '停止录制超时，已用收到的数据生成文件。';
          this.finishSuccess(this.supportedMimeType ?? 'video/webm');
        }
      }, STOP_TIMEOUT_MS);

      try {
        this.recorder?.stop();
      } catch (error) {
        this.finishWithError(error);
      }
    });

    return this.pendingStop;
  }

  /** 放弃本次录制（例如用户中途关闭页面）。 */
  cancel(): void {
    this.clearStopTimer();
    this.chunks = [];
    this.releaseCanvasStream();
    this.recorder = null;
    this._state = 'idle';
    this.stopResolve = null;
    this.stopReject = null;
    this.pendingStop = null;
  }

  // ---------------------------------------------------------------- 内部

  private finishSuccess(mimeType: string): void {
    const durationMs = this.now() - this.startedAt;
    const blob = new Blob(this.chunks, { type: mimeType });
    const result: RecordingResult = {
      blob,
      mimeType,
      durationMs,
      width: this.size.width,
      height: this.size.height,
      hasAudio: this.hasAudio,
    };

    this.clearStopTimer();
    this.releaseCanvasStream();
    this.recorder = null;
    this.chunks = [];
    this._state = 'idle';

    const resolve = this.stopResolve;
    this.stopResolve = null;
    this.stopReject = null;
    this.pendingStop = null;
    resolve?.(result);
  }

  private finishWithError(error: unknown): void {
    this.clearStopTimer();
    this.releaseCanvasStream();
    this.recorder = null;
    this.chunks = [];
    this._state = 'idle';

    const reject = this.stopReject;
    this.stopResolve = null;
    this.stopReject = null;
    this.pendingStop = null;
    reject?.(error instanceof Error ? error : new RecorderError(String(error)));
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  /**
   * 只停我们自己用 captureStream() 采集的画布视频轨。
   * 麦克风轨道由调用方持有，越权停掉它会让调用方陷入"轨道莫名其妙失效"的困惑。
   */
  private releaseCanvasStream(): void {
    if (!this.canvasStream) return;
    for (const track of this.canvasStream.getTracks()) {
      if (track.readyState === 'live') track.stop();
    }
    this.canvasStream = null;
  }
}

function describeRecorderError(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (typeof event === 'object' && event !== null && 'error' in event) {
    const inner = (event as { error?: unknown }).error;
    if (inner instanceof Error) return inner.message;
  }
  return '录制过程中出现未知错误。';
}
