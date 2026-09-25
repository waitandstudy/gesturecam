/**
 * ============================================================================
 * 录制结果的保存策略
 * ============================================================================
 *
 * 这个问题在真机上很具体：**"下载"和"存进相册"不是一件事**。
 *
 *   · iOS Safari 里点一个 `<a download="x.mp4">` **不会进相册**，
 *     只会落到"文件"App 里，用户翻不到就会认为"没保存"；
 *   · 想让视频进相册，网页唯一可行的路径是**系统分享面板**
 *     （`navigator.share({ files })`，里面有「存储到照片」）；
 *   · 桌面 Chrome / Edge 上，`showSaveFilePicker` 会弹出真正的"另存为"对话框，
 *     用户能自己选位置 —— 比静默下载到默认目录清楚得多；
 *   · 三者都没有时，退回最朴素的 `<a download>`。
 *
 * 所以按能力做优先级选择，而不是写死一种方式。
 * 这个模块的依赖全部可注入，所以策略选择与取消/失败处理都能在 Node 里单测。
 */

export type SaveMethod = 'share' | 'file-picker' | 'download';

export interface SaveRecordingOptions {
  blob: Blob;
  fileName: string;
  title?: string;
  text?: string;
}

export interface SaveRecordingDeps {
  createFile?: (blob: Blob, fileName: string) => File;
  canShareFiles?: (file: File) => boolean;
  share?: (data: ShareData) => Promise<void>;
  saveWithPicker?: (blob: Blob, fileName: string) => Promise<void>;
  download?: (blob: Blob, fileName: string) => void;
}

export interface SaveOutcome {
  method: SaveMethod;
  /** 用户在系统面板里主动取消了 —— 这不是错误，不该弹红字 */
  cancelled: boolean;
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/** 浏览器环境的默认实现。 */
export function createBrowserSaveDeps(): Required<SaveRecordingDeps> {
  return {
    createFile: (blob, fileName) => new File([blob], fileName, { type: blob.type }),

    canShareFiles: (file) =>
      typeof navigator !== 'undefined' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] }),

    share: async (data) => {
      await navigator.share(data);
    },

    saveWithPicker: async (blob, fileName) => {
      const picker = (
        window as unknown as {
          showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
            createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
          }>;
        }
      ).showSaveFilePicker;
      if (typeof picker !== 'function') throw new Error('showSaveFilePicker 不可用');
      const handle = await picker({ suggestedName: fileName });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    },

    download: (blob, fileName) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // 交给浏览器读完再释放，立刻 revoke 会让部分浏览器拿到空文件
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

/**
 * 选出这台设备上最合适的保存方式。
 *
 * 顺序的理由：**能不能落到用户找得到的地方**优先于实现简单。
 * 手机上分享面板能进相册；桌面上"另存为"能让用户选位置；
 * 两者都没有才静默下载。
 */
export function pickSaveMethod(deps: SaveRecordingDeps, file: File): SaveMethod {
  if (deps.canShareFiles?.(file) && typeof deps.share === 'function') return 'share';
  if (typeof deps.saveWithPicker === 'function') return 'file-picker';
  return 'download';
}

/**
 * 保存录制结果。
 * @throws 只有真正失败时才抛错；用户取消会以 `cancelled: true` 正常返回。
 */
export async function saveRecording(
  options: SaveRecordingOptions,
  deps: SaveRecordingDeps = createBrowserSaveDeps(),
): Promise<SaveOutcome> {
  const createFile = deps.createFile ?? ((blob: Blob, fileName: string) => new File([blob], fileName, { type: blob.type }));
  const file = createFile(options.blob, options.fileName);
  const method = pickSaveMethod(deps, file);

  try {
    if (method === 'share') {
      await deps.share?.({
        files: [file],
        title: options.title,
        text: options.text,
      } as ShareData);
      return { method, cancelled: false };
    }

    if (method === 'file-picker') {
      await deps.saveWithPicker?.(options.blob, options.fileName);
      return { method, cancelled: false };
    }

    deps.download?.(options.blob, options.fileName);
    return { method, cancelled: false };
  } catch (error) {
    if (isAbort(error)) {
      return { method, cancelled: true };
    }
    throw error;
  }
}

/** 保存方式对应的按钮文案。 */
export function saveButtonLabel(method: SaveMethod): string {
  switch (method) {
    case 'share':
      // iOS 的分享面板里才有"存储到照片"，所以这里必须说清楚
      return '保存到相册';
    case 'file-picker':
      return '另存为…';
    default:
      return '保存视频';
  }
}

/** 保存之后告诉用户"东西去哪了" —— 不说清楚，用户就会以为没保存。 */
export function saveOutcomeHint(method: SaveMethod): string {
  switch (method) {
    case 'share':
      return '已打开系统分享面板：选「存储到照片 / 保存到相册」即可进相册，选「存储到文件」则会存到「文件」App。';
    case 'file-picker':
      return '已保存到你选择的位置。';
    default:
      return '已开始下载：手机在「下载 / 文件」里，电脑在浏览器的下载目录里（不是相册）。';
  }
}
