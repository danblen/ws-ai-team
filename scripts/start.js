import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

async function portAvailable(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.on('error', () => resolve(false));
    srv.listen(port, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findPort(from) {
  while (!(await portAvailable(from))) from++;
  return from;
}

async function main() {
  const serverPort = await findPort(5025);
  const vitePort = await findPort(5020);

  console.log(`\n  后端 :${serverPort}  前端 :${vitePort}\n`);

  const server = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SERVER_PORT: String(serverPort) },
  });

  const vite = spawn('npx', ['vite', '--port', String(vitePort)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SERVER_PORT: String(serverPort) },
  });

  process.on('SIGINT', () => {
    server.kill();
    vite.kill();
    process.exit();
  });

  server.on('close', (code) => {
    console.log(`\n后端退出 (${code})`);
    vite.kill();
    process.exit();
  });
}

main();
