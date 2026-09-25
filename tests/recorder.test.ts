import { describe, expect, it } from 'vitest';

import { describeMimeType, pickSupportedMimeType, PREFERRED_MIME_TYPES } from '@/core/recorder/mimeTypes';
import { RecorderError, RecorderManager, type RecorderLike } from '@/core/recorder/recorderManager';

describe('录制格式探测', () => {
  it('优先选 mp4/H.264（手机相册、抖音、剪映通吃）', () => {
    const picked = pickSupportedMimeType(() => true);
    expect(picked).toBe('video/mp4;codecs=h264');
  });

  it('只支持 webm 的桌面浏览器退到 VP9', () => {
    const picked = pickSupportedMimeType((type) => type.startsWith('video/webm'));
    expect(picked).toBe('video/webm;codecs=vp9');
  });

  it('只支持裸 webm 时也能拿到可用格式', () => {
    const picked = pickSupportedMimeType((type) => type === 'video/webm');
    expect(picked).toBe('video/webm');
  });

  it('都不支持时返回 null（调用方据此明确报错，而不是录出打不开的文件）', () => {
    expect(pickSupportedMimeType(() => false)).toBeNull();
  });

  it('探测过程中抛错的格式被跳过，不影响后面的候选', () => {
    const picked = pickSupportedMimeType((type) => {
      if (type.includes('h264')) throw new Error('奇怪的 type');
      return type.startsWith('video/webm');
    });
    expect(picked).toBe('video/webm;codecs=vp9');
  });

  it('候选顺序是"可用性优先"：mp4 全部排在 webm 前面', () => {
    const firstWebm = PREFERRED_MIME_TYPES.findIndex((type) => type.includes('webm'));
    const lastMp4 = PREFERRED_MIME_TYPES.map((type, index) => (type.includes('mp4') ? index : -1)).reduce(
      (max, index) => Math.max(max, index),
      -1,
    );
    expect(lastMp4).toBeLessThan(firstWebm);
  });

  it('describeMimeType 给出人能读的标签', () => {
    expect(describeMimeType('video/mp4;codecs=h264')).toBe('MP4 / H.264');
    expect(describeMimeType('video/webm;codecs=vp9')).toBe('WebM / VP9');
    expect(describeMimeType('video/webm')).toBe('WebM');
  });
});

/** 假的 MediaRecorder：像真的一样在 start/stop 时回调。 */
class FakeRecorder implements RecorderLike {
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  startCalls: number[] = [];
  stopCalls = 0;
  /** 每次 stop 前先吐出的分片 */
  chunksToEmit: string[] = ['chunk-1'];
  fireStopOnStop = true;
  throwOnStop = false;

  constructor(readonly options: MediaRecorderOptions) {}

  start(timeslice?: number): void {
    this.state = 'recording';
    this.startCalls.push(timeslice ?? 0);
  }

  stop(): void {
    this.stopCalls += 1;
    if (this.throwOnStop) throw new Error('stop 失败');
    for (const chunk of this.chunksToEmit) {
      this.ondataavailable?.({ data: new Blob([chunk]) });
    }
    this.state = 'inactive';
    if (this.fireStopOnStop) this.onstop?.({});
  }
}

interface Harness {
  manager: RecorderManager;
  recorders: FakeRecorder[];
  /** 推进假时钟（毫秒） */
  advance: (ms: number) => void;
}

function createHarness(options: { supported?: string[]; limits?: { maxDurationSeconds?: number; maxBytes?: number } } = {}): Harness {
  const recorders: FakeRecorder[] = [];
  let clock = 0;
  const supported = options.supported ?? ['video/mp4;codecs=h264', 'video/webm;codecs=vp9'];

  const manager = new RecorderManager({
    createRecorder: (_stream, recorderOptions) => {
      const recorder = new FakeRecorder(recorderOptions);
      recorders.push(recorder);
      return recorder;
    },
    // Node 里没有 MediaStream，这里只需要一个占位对象
    createStream: () => ({}) as unknown as MediaStream,
    now: () => clock,
    isTypeSupported: (type) => supported.includes(type),
    limits: options.limits,
  });

  return {
    manager,
    recorders,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** 造一个能被 captureStream 的假画布；轨道 stop() 会调用 onStopTrack */
function fakeCanvas(width: number, height: number, onStopTrack: () => void): HTMLCanvasElement {
  const makeTrack = () => ({
    kind: 'video',
    readyState: 'live',
    stop: onStopTrack,
  });

  return {
    width,
    height,
    captureStream: () => ({
      getVideoTracks: () => [makeTrack()],
      getTracks: () => [makeTrack()],
    }),
  } as unknown as HTMLCanvasElement;
}

describe('RecorderManager', () => {
  it('不支持任何格式时 getSupported 为假、start 抛出可读的错误', () => {
    const { manager } = createHarness({ supported: [] });
    expect(manager.supported).toBe(false);
    expect(() => manager.start({ canvas: fakeCanvas(720, 1280, () => {}) })).toThrow(RecorderError);
  });

  it('开始录制会带上选好的格式与分片间隔', () => {
    const harness = createHarness();
    let stopped = 0;

    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => (stopped += 1)) });

    expect(harness.manager.isRecording).toBe(true);
    expect(harness.recorders).toHaveLength(1);
    expect(harness.recorders[0]?.options.mimeType).toBe('video/mp4;codecs=h264');
    // 分片间隔是 1 秒，避免整段视频都堆在最后
    expect(harness.recorders[0]?.startCalls).toEqual([1000]);
  });

  it('停止后返回 Blob、时长与成片尺寸', async () => {
    const harness = createHarness();
    const canvas = fakeCanvas(720, 1280, () => {});

    harness.manager.start({ canvas });
    harness.advance(2500);
    const result = await harness.manager.stop();

    expect(result.mimeType).toBe('video/mp4;codecs=h264');
    expect(result.durationMs).toBe(2500);
    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
    expect(result.hasAudio).toBe(false);
    expect(result.blob.size).toBeGreaterThan(0);
    expect(harness.manager.state).toBe('idle');
  });

  it('带麦克风音轨时 hasAudio 为真', async () => {
    const harness = createHarness();
    const audioTrack = { kind: 'audio', readyState: 'live', stop: () => {} } as unknown as MediaStreamTrack;

    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}), audioTrack });
    const result = await harness.manager.stop();

    expect(result.hasAudio).toBe(true);
  });

  it('停止时把采集到的画布轨停掉（否则摄像头指示灯一直亮）', async () => {
    const harness = createHarness();
    let stoppedTracks = 0;

    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => (stoppedTracks += 1)) });
    await harness.manager.stop();

    expect(stoppedTracks).toBe(1);
  });

  it('重复调用 stop 返回同一个结果、不会重复触发 recorder.stop', async () => {
    const harness = createHarness();
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });

    const first = harness.manager.stop();
    const second = harness.manager.stop();
    await Promise.all([first, second]);

    expect(harness.recorders[0]?.stopCalls).toBe(1);
  });

  it('没有在录制时 stop 会被拒绝', async () => {
    const harness = createHarness();
    await expect(harness.manager.stop()).rejects.toThrow(RecorderError);
  });

  it('重复 start 会被拒绝（状态机不允许并发录制）', () => {
    const harness = createHarness();
    const canvas = fakeCanvas(720, 1280, () => {});

    harness.manager.start({ canvas });
    expect(() => harness.manager.start({ canvas })).toThrow(/不能开始新的录制/);
  });

  it('onstop 迟迟不来时用超时兜底交出已收到的数据，而不是永远卡住', async () => {
    const harness = createHarness();
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    // 让假 recorder 不触发 onstop，模拟浏览器异常
    const recorder = harness.recorders[0];
    if (recorder) recorder.fireStopOnStop = false;

    const pending = harness.manager.stop();
    // 快进到超时之后：用真实的定时器，所以这里等一小会儿
    const result = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000)),
    ]);

    expect(result).not.toBeNull();
    if (result) {
      expect(result.blob.size).toBeGreaterThan(0);
      expect(harness.manager.lastErrorMessage).toContain('超时');
    }
  }, 12_000);

  it('recorder.stop() 抛错时 stop() 的 Promise 会被拒绝，状态回到 idle', async () => {
    const harness = createHarness();
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    const recorder = harness.recorders[0];
    if (recorder) recorder.throwOnStop = true;

    await expect(harness.manager.stop()).rejects.toThrow();
    expect(harness.manager.state).toBe('idle');
  });

  it('cancel 清理状态且不产出结果', () => {
    const harness = createHarness();
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });

    harness.manager.cancel();

    expect(harness.manager.state).toBe('idle');
    expect(harness.manager.isRecording).toBe(false);
    expect(harness.manager.elapsedSeconds).toBe(0);
  });
});

/**
 * 录制上限（护栏）。
 *
 * 为什么必须有：MediaRecorder 把整段视频攒在内存里，手机上录几分钟就是几百 MB；
 * 没有上限也没有预警，最坏是录到一半崩掉、**前面全丢**。
 */
describe('RecorderManager 录制上限', () => {
  /** 录制中手动投递一个指定字节数的分片（只用到 Blob 的 size） */
  function emitBytes(harness: Harness, bytes: number): void {
    harness.recorders[0]?.ondataavailable?.({ data: { size: bytes } as Blob });
  }

  it('时长到上限时 checkLimits 返回 duration；没到就是 null', () => {
    const harness = createHarness({ limits: { maxDurationSeconds: 10, maxBytes: 1_000_000 } });
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    expect(harness.manager.checkLimits()).toBeNull();

    harness.advance(9_000);
    expect(harness.manager.checkLimits()).toBeNull();

    harness.advance(1_500);
    expect(harness.manager.checkLimits()).toBe('duration');
  });

  it('体积到上限时返回 bytes（时长还差得远）', () => {
    const harness = createHarness({ limits: { maxDurationSeconds: 600, maxBytes: 1000 } });
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });

    emitBytes(harness, 400);
    expect(harness.manager.recordedByteCount).toBe(400);
    expect(harness.manager.checkLimits()).toBeNull();

    emitBytes(harness, 700);
    expect(harness.manager.recordedByteCount).toBe(1100);
    expect(harness.manager.checkLimits()).toBe('bytes');
  });

  it('usage 给出进度与剩余秒数（UI 靠它显示"还剩多少"并变色）', () => {
    const harness = createHarness({ limits: { maxDurationSeconds: 100, maxBytes: 1_000_000 } });
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    harness.advance(25_000);
    emitBytes(harness, 100_000);

    const usage = harness.manager.usage;
    expect(usage.durationSeconds).toBeCloseTo(25, 6);
    expect(usage.bytes).toBe(100_000);
    expect(usage.ratio).toBeCloseTo(0.25, 6);
    expect(usage.binding).toBe('duration');
    expect(usage.remainingSeconds).toBeCloseTo(75, 6);
  });

  it('体积更紧时 binding 是 bytes，剩余时间按体积速率估算', () => {
    const harness = createHarness({ limits: { maxDurationSeconds: 600, maxBytes: 1000 } });
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    // 10 秒录了 500 字节 -> 速率 50 B/s -> 还剩 500 字节 = 10 秒
    harness.advance(10_000);
    emitBytes(harness, 500);

    const usage = harness.manager.usage;
    expect(usage.binding).toBe('bytes');
    expect(usage.ratio).toBeCloseTo(0.5, 6);
    expect(usage.remainingSeconds).toBeCloseTo(10, 3);
  });

  it('停止之后不再报上限（避免重复触发停止）', async () => {
    const harness = createHarness({ limits: { maxDurationSeconds: 5, maxBytes: 1000 } });
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    emitBytes(harness, 2000);
    expect(harness.manager.checkLimits()).toBe('bytes');

    const stopping = harness.manager.stop();
    expect(harness.manager.checkLimits()).toBeNull();
    await stopping;
    expect(harness.manager.checkLimits()).toBeNull();
  });

  it('到上限不是错误：停止之后照常拿到文件', async () => {
    const harness = createHarness({ limits: { maxDurationSeconds: 3, maxBytes: 1_000_000 } });
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    harness.advance(3_100);
    emitBytes(harness, 1234);
    expect(harness.manager.checkLimits()).toBe('duration');

    const result = await harness.manager.stop();
    // 关键：到上限也能正常出片（不是报错、更不是丢文件）
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
  });

  it('默认上限是 5 分钟 / 400MB（够一条口播，又不至于把内存撑爆）', () => {
    const manager = new RecorderManager();
    expect(manager.recordingLimits.maxDurationSeconds).toBe(300);
    expect(manager.recordingLimits.maxBytes).toBe(400 * 1024 * 1024);
  });

  it('分片字节数累计，新一次录制归零', () => {
    const harness = createHarness({ limits: { maxDurationSeconds: 600, maxBytes: 10 ** 9 } });
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    emitBytes(harness, 100);
    emitBytes(harness, 200);
    expect(harness.manager.recordedByteCount).toBe(300);

    harness.manager.cancel();
    harness.manager.start({ canvas: fakeCanvas(720, 1280, () => {}) });
    expect(harness.manager.recordedByteCount).toBe(0);
  });
});
