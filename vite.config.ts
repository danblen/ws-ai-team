import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const SERVER_PORT = process.env.SERVER_PORT || 5110;
const FE_PORT = process.env.FE_PORT || 5100;
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
let GIT_COMMIT = 'unknown';
let BUILD_NUM = '0';
try {
  GIT_COMMIT = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  // GITHUB_RUN_NUMBER 是 GHA 每次 workflow run 的唯一递增编号（per-push）；
  // BUILD_NUM 允许 Docker / 本地环境显式传入。优先使用这两个，保证每 push 一次 +1。
  BUILD_NUM = process.env.GITHUB_RUN_NUMBER || process.env.BUILD_NUM
    || execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {} // git may not be available (e.g. Docker build)

export default defineConfig({
  // Exclude the vendored prebuilt codeview bundle from the React plugin's
  // Babel pass: it's already compiled (no JSX) and ~2MB, so running Babel on
  // it only slows dev and trips the "deoptimised styling" note. React itself
  // stays external; only the transform is skipped.
  plugins: [react({ exclude: /\/src\/vendor\// })],
  base: '/aiteam/',
  define: {
    __COMMIT_HASH__: JSON.stringify(GIT_COMMIT),
    __BUILD_NUM__: JSON.stringify(BUILD_NUM),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: Number(FE_PORT),
    // 监听所有网卡（包含 IPv4 127.0.0.1），避免仅绑定 IPv6 [::1]
    // 导致浏览器用 127.0.0.1 解析 localhost 时连不上。
    host: true,
    // 后端会把预览/发布/工作区文件写入 server 下的这些目录，它们都在
    // Vite 的监听根内。若不忽略，构建预览时写入的大量文件会触发 Vite
    // HMR 整页刷新——表现为「自动跳回概览、会话被刷新」。忽略即可修复。
    watch: {
      ignored: [
        '**/server/.previews/**',
        '**/server/.published/**',
        '**/server/.workspaces/**',
        '**/server/.data/**',
        '**/server/.loop-data/**',
      ],
    },
    proxy: {
      // 前端在 base=/aiteam 下请求 /aiteam/api、/aiteam/preview，
      // 开发时去掉前缀再转发到后端（后端路由挂在根下）。
      '/aiteam/api': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/aiteam/, ''),
      },
      '/aiteam/preview': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/aiteam/, ''),
      },
      // 已发布站点公开访问路径，开发时同样转发到后端。
      '/aiteam/p': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/aiteam/, ''),
      },
    },
  },
});
