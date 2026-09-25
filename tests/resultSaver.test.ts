import { describe, expect, it } from 'vitest';

import {
  pickSaveMethod,
  saveButtonLabel,
  saveOutcomeHint,
  saveRecording,
  type SaveRecordingDeps,
} from '@/ui/resultSaver';

function makeBlob(): Blob {
  return new Blob(['fake-video-bytes'], { type: 'video/mp4' });
}

interface Harness {
  deps: SaveRecordingDeps;
  calls: {
    share: ShareData[];
    wrote: { fileName: string; size: number }[];
    downloaded: string[];
  };
}

function createHarness(options: { canShare?: boolean; hasPicker?: boolean } = {}): Harness {
  const calls: Harness['calls'] = { share: [], wrote: [], downloaded: [] };

  const deps: SaveRecordingDeps = {
    createFile: (blob, fileName) => new File([blob], fileName, { type: blob.type }),
    canShareFiles: () => options.canShare === true,
    share: async (data) => {
      calls.share.push(data);
    },
    saveWithPicker: options.hasPicker
      ? async (blob, fileName) => {
          calls.wrote.push({ fileName, size: blob.size });
        }
      : undefined,
    download: () => {
      calls.downloaded.push('yes');
    },
  };

  return { deps, calls };
}

describe('保存方式的选择', () => {
  it('支持分享文件时优先走系统分享面板（手机进相册的唯一路径）', () => {
    const { deps } = createHarness({ canShare: true, hasPicker: true });
    const file = new File([], 'a.mp4', { type: 'video/mp4' });
    expect(pickSaveMethod(deps, file)).toBe('share');
  });

  it('不能分享但有另存为对话框时，用对话框（桌面能选位置）', () => {
    const { deps } = createHarness({ canShare: false, hasPicker: true });
    const file = new File([], 'a.mp4', { type: 'video/mp4' });
    expect(pickSaveMethod(deps, file)).toBe('file-picker');
  });

  it('都不支持时退回普通下载', () => {
    const { deps } = createHarness({ canShare: false, hasPicker: false });
    const file = new File([], 'a.mp4', { type: 'video/mp4' });
    expect(pickSaveMethod(deps, file)).toBe('download');
  });

  it('canShare 说可以但没有 share 函数时不会选出 share（避免点了没反应）', () => {
    const deps: SaveRecordingDeps = { canShareFiles: () => true };
    const file = new File([], 'a.mp4', { type: 'video/mp4' });
    expect(pickSaveMethod(deps, file)).toBe('download');
  });
});

describe('保存流程', () => {
  it('走分享面板时把文件带上去，并返回 share', async () => {
    const { deps, calls } = createHarness({ canShare: true });

    const outcome = await saveRecording({ blob: makeBlob(), fileName: 'clip.mp4', title: 'GestureCam' }, deps);

    expect(outcome).toEqual({ method: 'share', cancelled: false });
    expect(calls.share).toHaveLength(1);
    const files = (calls.share[0] as { files?: File[] }).files;
    expect(files?.[0]?.name).toBe('clip.mp4');
    expect(files?.[0]?.type).toBe('video/mp4');
  });

  it('用户在分享面板里取消 -> cancelled 为真且不抛错（不该弹红字）', async () => {
    const { deps } = createHarness({ canShare: true });
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    deps.share = async () => {
      throw abort;
    };

    const outcome = await saveRecording({ blob: makeBlob(), fileName: 'clip.mp4' }, deps);

    expect(outcome).toEqual({ method: 'share', cancelled: true });
  });

  it('另存为路径把 blob 完整写入', async () => {
    const { deps, calls } = createHarness({ canShare: false, hasPicker: true });
    const blob = makeBlob();

    const outcome = await saveRecording({ blob, fileName: 'clip.mp4' }, deps);

    expect(outcome.method).toBe('file-picker');
    expect(calls.wrote).toEqual([{ fileName: 'clip.mp4', size: blob.size }]);
  });

  it('下载路径被调用一次', async () => {
    const { deps, calls } = createHarness({ canShare: false, hasPicker: false });

    const outcome = await saveRecording({ blob: makeBlob(), fileName: 'clip.mp4' }, deps);

    expect(outcome.method).toBe('download');
    expect(calls.downloaded).toHaveLength(1);
  });

  it('真正失败时抛错（让调用方提示用户），而不是静默吞掉', async () => {
    const { deps } = createHarness({ canShare: true });
    deps.share = async () => {
      throw new Error('网络断了');
    };

    await expect(saveRecording({ blob: makeBlob(), fileName: 'clip.mp4' }, deps)).rejects.toThrow('网络断了');
  });
});

describe('保存方式的文案', () => {
  it('按钮文案区分"相册"与"下载"，别让用户以为下载会进相册', () => {
    expect(saveButtonLabel('share')).toBe('保存到相册');
    expect(saveButtonLabel('file-picker')).toBe('另存为…');
    expect(saveButtonLabel('download')).toBe('保存视频');
  });

  it('保存后的提示说清楚东西去了哪里', () => {
    expect(saveOutcomeHint('share')).toContain('存储到照片');
    expect(saveOutcomeHint('file-picker')).toContain('你选择的位置');
    expect(saveOutcomeHint('download')).toContain('不是相册');
  });
});
