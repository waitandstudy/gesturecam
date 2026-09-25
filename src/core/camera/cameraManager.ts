/**
 * 摄像头管理 —— 对应需求文档第十六节的 CameraManager。
 *
 * 只负责"拿到一路可用的视频流"这一件事：权限、前后摄、就绪等待、错误翻译。
 * 它不认识 Scene，也不认识素材，方便以后换平台的采集实现。
 */

export type FacingMode = 'user' | 'environment';

export type CameraErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'not-found'
  | 'in-use'
  | 'overconstrained'
  | 'not-ready'
  | 'unknown';

/** 把浏览器的 DOMException 翻译成给用户看的中文原因。 */
export class CameraError extends Error {
  readonly code: CameraErrorCode;

  constructor(code: CameraErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CameraError';
    this.code = code;
  }
}

export interface CameraManagerOptions {
  initialFacing?: FacingMode;
  idealWidth?: number;
  idealHeight?: number;
  idealFrameRate?: number;
  /** 等待视频就绪的超时时间（毫秒） */
  readyTimeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<CameraManagerOptions> = {
  initialFacing: 'user',
  idealWidth: 1280,
  idealHeight: 720,
  idealFrameRate: 30,
  readyTimeoutMs: 10_000,
};

function translateError(error: unknown): CameraError {
  if (error instanceof CameraError) return error;

  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('permission-denied', '摄像头权限被拒绝。请在浏览器地址栏的站点设置里允许「摄像头」，然后重新打开。', { cause: error });
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('not-found', '没有检测到可用的摄像头设备。', { cause: error });
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraError('in-use', '摄像头被其它应用占用（例如另一个浏览器标签、微信、钉钉或视频会议软件）。请关闭后重试。', { cause: error });
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraError('overconstrained', '当前设备不支持请求的分辨率，请降低分辨率后重试。', { cause: error });
    default:
      return new CameraError('unknown', `打开摄像头失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** 等待 video 的元数据就绪（此时 videoWidth / videoHeight 才可信）。 */
function waitForMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      window.clearTimeout(timer);
    };
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new CameraError('not-ready', '视频流加载失败。'));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new CameraError('not-ready', `等待摄像头画面超时（${timeoutMs}ms）。`));
    }, timeoutMs);

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

export class CameraManager {
  private readonly video: HTMLVideoElement;
  private readonly options: Required<CameraManagerOptions>;
  private _stream: MediaStream | null = null;
  private _facing: FacingMode;
  private _pending: Promise<void> | null = null;

  constructor(video: HTMLVideoElement, options: CameraManagerOptions = {}) {
    this.video = video;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this._facing = this.options.initialFacing;
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  }

  get facing(): FacingMode {
    return this._facing;
  }

  get stream(): MediaStream | null {
    return this._stream;
  }

  get isRunning(): boolean {
    return this._stream !== null;
  }

  get videoWidth(): number {
    return this.video.videoWidth || 0;
  }

  get videoHeight(): number {
    return this.video.videoHeight || 0;
  }

  /** 视频是否已经可以安全地被 drawImage 采样。 */
  get isReady(): boolean {
    return this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.videoWidth > 0;
  }

  /** 前置摄像头默认镜像显示（自拍习惯）；后置不镜像。 */
  get defaultMirrored(): boolean {
    return this._facing === 'user';
  }

  /** 打开摄像头。重复调用是安全的（并发调用会复用同一个 Promise）。 */
  async start(facing: FacingMode = this._facing): Promise<void> {
    if (this._pending) return this._pending;
    this._pending = this.open(facing).finally(() => {
      this._pending = null;
    });
    return this._pending;
  }

  async setFacing(facing: FacingMode): Promise<void> {
    if (this._facing === facing && this.isRunning) return;
    this.stop();
    await this.start(facing);
  }

  async switchFacing(): Promise<void> {
    await this.setFacing(this._facing === 'user' ? 'environment' : 'user');
  }

  stop(): void {
    if (!this._stream) return;
    for (const track of this._stream.getTracks()) track.stop();
    this._stream = null;
    this.video.srcObject = null;
  }

  private async open(facing: FacingMode): Promise<void> {
    if (!CameraManager.isSupported()) {
      throw new CameraError('unsupported', '当前浏览器不支持摄像头采集。请使用 Chrome / Edge / Safari 的较新版本，并确保页面运行在 https 或 localhost 下。');
    }

    // 先停掉旧流，避免手机上出现"摄像头被自己占用"。
    this.stop();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false, // 口播需要麦克风，但属于录制系统（Phase 9），此处不申请，避免一次性索要过多权限
        video: {
          facingMode: { ideal: facing },
          width: { ideal: this.options.idealWidth },
          height: { ideal: this.options.idealHeight },
          frameRate: { ideal: this.options.idealFrameRate, max: 60 },
        },
      });

      this._stream = stream;
      this._facing = facing;

      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await waitForMetadata(this.video, this.options.readyTimeoutMs);
      await this.video.play();
    } catch (error) {
      this.stop();
      throw translateError(error);
    }
  }
}
