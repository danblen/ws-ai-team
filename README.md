
AI Agent 驱动的应用构建器。输入自然语言需求，AI 实时生成代码并预览。

服务器配置信息请参见 `../config/server/` 目录。

## 本地启动

保留已有项目运行，不要关闭。端口被占用时会自动递增。

```bash
npm start
```

脚本会从 `:5025`（后端）和 `:5020`（前端）开始检测，被占用就自动 +1，直到找到可用端口。

**单独启动后端或前端：**
```bash
npm run dev:server          # 后端（默认 :5025，可设 SERVER_PORT）
npm run dev:web             # 前端（默认 :5020，可设 --port）
npm run dev                 # 前后端同时启动（concurrently）
```

> 所有端口设置均通过环境变量/命令行参数，无需修改代码。
