import { cpSync, createReadStream, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const mediapipeWasmDir = fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision/wasm', import.meta.url));

/**
 * 把 MediaPipe 的 wasm 目录挂到 `/wasm`：开发时用中间件实时读 node_modules，
 * 构建时拷进 dist。
 *
 * 为什么不直接复制进 public/：整个 wasm 目录有 34MB（SIMD / nosimd / ES module 三套），
 * 复制进仓库既没必要也难维护。为什么不直接用 CDN：需求文档要求
 * "拍摄时必须实时、低延迟、**尽量离线**"，同源加载才谈得上离线。
 */
function mediapipeWasm(): Plugin {
  return {
    name: 'gesturecam:mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/wasm', (request, response, next) => {
        const path = (request.url ?? '').split('?')[0] ?? '';
        const name = basename(decodeURIComponent(path));
        const file = join(mediapipeWasmDir, name);

        if (!name || !existsSync(file)) {
          next();
          return;
        }

        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        createReadStream(file).pipe(response);
      });
    },
    closeBundle() {
      cpSync(mediapipeWasmDir, 'dist/wasm', { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [mediapipeWasm()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // host: true 让同一局域网下的手机可以直接扫码打开，方便真机测手势手感
    host: true,
    port: 5173,
    /*
     * 手机测摄像头必须走 https（iOS Safari 与 Android Chrome 的 getUserMedia
     * 都要求安全上下文，http://192.168.x.x 拿不到摄像头），所以真机调试走
     * cloudflared 快速隧道。隧道域名每次随机，用前导点匹配整个域。
     * 这是**开发服务器**的 Host 白名单，只在本地开发时生效，不影响生产构建。
     */
    allowedHosts: ['.trycloudflare.com'],
    watch: {
      /*
       * 只监视"应用代码"，其余目录一律排除。原因是被监视到的文件只要有任何一个
       * 在写入过程中被锁住，dev server 就会以 EBUSY 直接崩掉 —— 已经踩过三次：
       *   1. public/models 下 7.8MB 的模型文件
       *   2. tools/bin 下 55MB 的隧道程序
       *   3. 编辑工具在 tools/ 下写的临时文件
       * 这些都不参与打包，监视它们没有任何收益。
       */
      ignored: [
        '**/public/models/**',
        '**/tools/**',
        '**/docs/**',
        '**/dist/**',
        '**/*.exe',
        '**/*.tmp',
        '**/.*.tmpdir/**',
      ],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
