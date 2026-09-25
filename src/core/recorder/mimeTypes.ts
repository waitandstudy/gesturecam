/**
 * 编码格式的选择。
 *
 * 为什么要有这个模块：录制格式的可用性在浏览器之间差别极大，而且**直接影响能不能交付**：
 *   · 抖音 / 剪映 / iOS 相册对 **webm 支持很差**，mp4(H.264) 才是能直接用的格式；
 *   · 桌面 Chrome 很早就只支持 webm，iOS Safari 反而优先给 mp4。
 * 所以不能写死一种格式，必须按优先级探测。
 *
 * 这个模块是纯函数，可以在 Node 里单测；真正的 `MediaRecorder.isTypeSupported`
 * 由调用方注入。
 */

/**
 * 按优先级排列的候选格式。
 *
 * 顺序的理由：**能不能被用户用起来** > 编码效率。
 * mp4/H.264 优先（手机相册、抖音、剪映通吃），
 * 拿不到才退到 webm（VP9 优于 VP8，后者兼容性更广但质量差一点）。
 */
export const PREFERRED_MIME_TYPES: readonly string[] = [
  'video/mp4;codecs=h264',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/**
 * 挑一个当前浏览器支持的录制格式。
 * @param isSupported 通常传 `(type) => MediaRecorder.isTypeSupported(type)`
 * @returns 支持的格式；都不支持时返回 null（调用方据此告诉用户"这台设备不支持录制"）
 */
export function pickSupportedMimeType(
  isSupported: (type: string) => boolean,
  candidates: readonly string[] = PREFERRED_MIME_TYPES,
): string | null {
  for (const type of candidates) {
    try {
      if (isSupported(type)) return type;
    } catch {
      // 某些实现对奇怪的 type 字符串会抛错，跳过继续试下一个
    }
  }
  return null;
}

/** 把 mimeType 归一化成"容器 + 编码"两个短标签，给用户看。 */
export function describeMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  const container = lower.includes('mp4') ? 'MP4' : lower.includes('webm') ? 'WebM' : '未知容器';
  const codec = lower.includes('h264') || lower.includes('avc1')
    ? 'H.264'
    : lower.includes('vp9')
      ? 'VP9'
      : lower.includes('vp8')
        ? 'VP8'
        : null;
  return codec ? `${container} / ${codec}` : container;
}
