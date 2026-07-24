import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---- Platform detection ----
const IS_LINUX = os.platform() === 'linux';
const IS_MAC = os.platform() === 'darwin';

// ---- State ----
const SANDBOX_UID_START = 10000;
const MAX_SANDBOX_USERS = 200;
const assignedUids = new Set/** @type {Set<number>} */();
const sessionToUid = new Map/** @type {Map<string, number>} */();

// ---- Logging ----
function log(...args) {
  console.log(`[user-isolate]`, ...args);
}

/**
 * Shared OpenCode config — generated once at first need, copied into each sandbox HOME.
 */
const SHARED_OPENCODE_CONFIG = '/tmp/aiteam-opencode.jsonc';

function ensureSharedOpenCodeConfig() {
  if (fs.existsSync(SHARED_OPENCODE_CONFIG)) return;
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !baseURL || !model) return;

  const providerName = 'opencode-deepseek';
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: `${providerName}/${model}`,
    provider: {
      [providerName]: {
        name: 'OpenCode DeepSeek',
        options: { apiKey, baseURL: baseURL.replace(/\/+$/, '') },
        models: { [model]: { id: model, name: 'DeepSeek Flash V4' } },
      },
    },
  };
  fs.writeFileSync(SHARED_OPENCODE_CONFIG, JSON.stringify(config, null, 2), 'utf8');
  log(`generated shared OpenCode config`);
}

/**
 * Write OpenCode config into the sandbox home directory.
 * OpenCode reads ~/.config/opencode/opencode.jsonc, not OPENAI_* env vars directly.
 */
function writeOpenCodeConfig(sandboxHome) {
  ensureSharedOpenCodeConfig();
  if (!fs.existsSync(SHARED_OPENCODE_CONFIG)) return;
  const dir = path.join(sandboxHome, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SHARED_OPENCODE_CONFIG, path.join(dir, 'opencode.jsonc'));
}

/**
 * Create a Linux system user for sandbox isolation.
 * @param {number} uid
 */
function createLinuxUser(uid) {
  const name = `sandbox-${uid}`;
  try {
    // 用户已存在（Docker 构建时预创建了所有沙箱用户），直接复用。
    execSync(`id -u ${name}`, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    // 不存在才创建
  }
  try {
    // --no-log-init: skip lastlog/wtmp updates (faster, less I/O)
    // -M: no home directory
    // -K UID_MIN=UID: allow creating user with specific UID below system range
    execSync(
      `useradd --no-log-init -M -K UID_MIN=${uid} -u ${uid} ${name}`,
      { stdio: 'pipe', timeout: 5000 },
    );
    log(`created system user ${name} (UID ${uid})`);
    return true;
  } catch (err) {
    log(`failed to create user ${name}: ${err.message}`);
    return false;
  }
}

/**
 * Remove a Linux system user.
 * @param {number} uid
 */
function removeLinuxUser(uid) {
  const name = `sandbox-${uid}`;
  try {
    execSync(`userdel -f ${name}`, { stdio: 'pipe', timeout: 5000 });
    log(`removed system user ${name} (UID ${uid})`);
  } catch (err) {
    log(`failed to remove user ${name}: ${err.message}`);
  }
}

/**
 * Get the next available sandbox UID.
 * @returns {number | null}
 */
function allocUid() {
  if (!IS_LINUX) return null; // macOS: no uid isolation needed

  for (let i = 0; i < MAX_SANDBOX_USERS; i++) {
    const uid = SANDBOX_UID_START + i;
    if (!assignedUids.has(uid)) {
      assignedUids.add(uid);
      return uid;
    }
  }
  log('no available sandbox UIDs (all in use)');
  return null;
}

/**
 * Release a sandbox UID back to the pool.
 * @param {number} uid
 */
function releaseUid(uid) {
  if (!IS_LINUX) return;
  assignedUids.delete(uid);
  sessionToUid.forEach((uid_, sid) => {
    if (uid_ === uid) sessionToUid.delete(sid);
  });
}

// ---- Public API ----

/**
 * Ensure a sandbox user exists for the given session ID.
 * Creates the system user on first call for this session.
 * Returns the numeric UID to use, or null if isolation is unavailable.
 *
 * @param {string} sid
 * @returns {{ uid: number | null, ok: boolean }}
 */
export function ensureIsolatedUser(sid) {
  if (!IS_LINUX) {
    // macOS dev: no isolation
    return { uid: null, ok: true };
  }

  // Already assigned
  if (sessionToUid.has(sid)) {
    return { uid: sessionToUid.get(sid), ok: true };
  }

  const uid = allocUid();
  if (uid === null) {
    return { uid: null, ok: false };
  }

  const created = createLinuxUser(uid);
  if (!created) {
    releaseUid(uid);
    return { uid: null, ok: false };
  }

  sessionToUid.set(sid, uid);
  return { uid, ok: true };
}

/**
 * Set the correct owner and permissions on a workspace directory.
 * Ensures only the sandbox user can read/write their own workspace.
 *
 * @param {string} dir - workspace directory path
 * @param {number | null} uid
 */
export function secureWorkspace(dir, uid) {
  if (!IS_LINUX || uid === null) return;
  try {
    execSync(`chown -R ${uid}:${uid} "${dir}"`, { stdio: 'pipe', timeout: 10000 });
    execSync(`chmod 0700 "${dir}"`, { stdio: 'pipe', timeout: 5000 });
    log(`secured workspace ${dir} for UID ${uid}`);
  } catch (err) {
    log(`failed to secure workspace ${dir}: ${err.message}`);
  }
}

/**
 * Set cgroup memory and CPU limits for the given UID.
 * Linux only, cgroups v2 required.
 * Silently no-ops if cgroups v2 is not available.
 *
 * @param {number} uid
 * @param {{ memoryMax?: string, cpuQuota?: string }} [limits]
 */
export function setCgroupLimits(uid, limits) {
  if (!IS_LINUX) return;

  const cgDir = `/sys/fs/cgroup/sandbox-${uid}`;
  try {
    fs.mkdirSync(cgDir, { recursive: true });

    if (limits?.memoryMax) {
      fs.writeFileSync(path.join(cgDir, 'memory.max'), limits.memoryMax, 'utf8');
      log(`cgroup memory limit: ${limits.memoryMax} for UID ${uid}`);
    }

    if (limits?.cpuQuota) {
      fs.writeFileSync(path.join(cgDir, 'cpu.max'), limits.cpuQuota, 'utf8');
      log(`cgroup cpu limit: ${limits.cpuQuota} for UID ${uid}`);
    }

    // Move the current PID (well, ideally all child processes) to this cgroup
    // PIDs are written per-process by the spawn wrapper, not here.
  } catch (err) {
    log(`cgroup setup failed for UID ${uid}: ${err.message} (cgroups v2 may not be available)`);
  }
}

/**
 * Clean up a sandbox user and its resources when a session is removed.
 * @param {string} sid
 */
export function removeIsolatedUser(sid) {
  if (!IS_LINUX) return;

  const uid = sessionToUid.get(sid);
  if (uid === undefined) return;

  removeLinuxUser(uid);
  releaseUid(uid);
  log(`cleaned up sandbox for session ${sid} (UID ${uid})`);
}

/**
 * Wrap spawn() to run as the sandbox user. On macOS, runs normally.
 * @param {string} binPath
 * @param {string[]} args
 * @param {object} opts - spawn options (cwd, stdio, etc.)
 * @param {number | null} uid
 * @returns {import('child_process').ChildProcess}
 */
export function spawnAsUser(binPath, args, opts, uid) {
  if (IS_LINUX && uid !== null) {
    // 每个沙箱用户使用独立的 HOME 目录，避免多用户竞争同一个 /tmp
    const sandboxHome = `/tmp/sandbox-${uid}`;
    try {
      fs.mkdirSync(`${sandboxHome}/.local/share`, { recursive: true });
      // 为 OpenCode 创建配置文件（OpenCode 不读 OPENAI_MODEL 等 env，用配置文件）
      writeOpenCodeConfig(sandboxHome);
      execSync(`chown -R ${uid}:${uid} "${sandboxHome}"`, { stdio: 'ignore', timeout: 5000 });
    } catch {}
    return spawn(binPath, args, {
      ...opts,
      uid,
      gid: uid,
      // Clean environment: don't leak secrets as the sandbox user
      // 但透传 AI 模型相关的环境变量，确保 CLI 能拿到 API Key 和模型配置
      env: {
        HOME: sandboxHome,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        TERM: 'dumb',
        npm_config_cache: `/tmp/.npm-${uid}`,
        // AI provider env vars needed by CLI tools
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
        OPENAI_MODEL: process.env.OPENAI_MODEL || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      },
    });
  }

  // macOS: run as current user
  return spawn(binPath, args, {
    ...opts,
    env: { ...process.env },
  });
}

/**
 * Generate a unique cache prefix for the sandbox user.
 * Claude Code caches things under ~/.claude — we isolate that too.
 * @param {number | null} uid
 * @returns {string}
 */
export function cacheDir(uid) {
  if (IS_LINUX && uid !== null) {
    return `/tmp/.cache-sandbox-${uid}`;
  }
  return os.homedir();
}
