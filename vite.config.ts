import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.SERVER_PORT || 5110;
const FE_PORT = process.env.FE_PORT || 5100;

export default defineConfig({
  plugins: [react()],
  base: '/ai-team/',
  server: {
    port: Number(FE_PORT),
    proxy: {
      // 前端在 base=/ai-team 下请求 /ai-team/api、/ai-team/preview，
      // 开发时去掉前缀再转发到后端（后端路由挂在根下）。
      '/ai-team/api': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ai-team/, ''),
      },
      '/ai-team/preview': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ai-team/, ''),
      },
      // 已发布站点公开访问路径，开发时同样转发到后端。
      '/ai-team/p': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ai-team/, ''),
      },
    },
  },
});
