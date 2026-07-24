import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '.data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret');

fs.mkdirSync(DATA_DIR, { recursive: true });

// 令牌有效期：7 天。
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- 密钥 ----------
// 优先使用 AUTH_SECRET；否则生成一个并持久化，保证重启后已签发的令牌仍有效。
function loadSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const generated = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    } catch {
      /* ignore write failures; fall back to in-memory secret */
    }
    return generated;
  }
}

const SECRET = loadSecret();

// ---------- 用户存储 ----------
function readUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function findUser(email) {
  const target = normalizeEmail(email);
  return readUsers().find((u) => u.email === target) || null;
}

// ---------- 密码哈希（scrypt + 盐） ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---------- 令牌（HMAC-SHA256 签名的紧凑令牌，类 JWT） ----------
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signToken(email) {
  const payload = { email: normalizeEmail(email), exp: Date.now() + TOKEN_TTL_MS };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload; // { email, exp }
  } catch {
    return null;
  }
}

// ---------- 是否强制登录 ----------
// 已注册用户存在，或显式配置了 API_TOKEN / AUTH_REQUIRED，则要求鉴权。
export function authRequired() {
  if (process.env.AUTH_REQUIRED === '1' || process.env.AUTH_REQUIRED === 'true') return true;
  if (process.env.API_TOKEN) return true;
  return readUsers().length > 0;
}

/** 从请求头解析 Bearer 令牌并校验，返回 payload 或 null。 */
export function authFromRequest(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1]);
}

// ---------- 管理员鉴权 ----------
// 高危操作（浏览服务器任意目录、对任意目录建/合并工作树、在任意目录跑 CLI）
// 可直接改动服务器上的代码，仅限管理员账号。默认管理员邮箱可用 ADMIN_EMAIL 覆盖。
export const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || 'siplgo@siplgo.xyz');

/** 当前请求是否为管理员（邮箱匹配 ADMIN_EMAIL，大小写不敏感）。 */
export function isAdmin(req) {
  return normalizeEmail(req.user?.email) === ADMIN_EMAIL;
}

/**
 * 高危操作的鉴权闸门：
 * - 未启用鉴权（本地无注册用户）→ 完全放行，保证本地模式在自己电脑上照常使用；
 * - 启用鉴权（云端有注册用户）→ 仅管理员放行，其余账号写出 403 并返回 false。
 * 返回 true 表示放行；返回 false 时已写出响应，调用方应立即 return。
 */
export function ensureAdminForSensitive(req, res) {
  if (!authRequired()) return true;
  if (isAdmin(req)) return true;
  res.status(403).json({ error: '无权限：该操作仅限管理员账号' });
  return false;
}

// ---------- 对话次数限制 ----------
// 每个邮箱只能发 N 次对话，超管不限制。
// 可通过环境变量 MAX_CONVERSATIONS_PER_USER 覆盖（默认 5）。
export const MAX_CONVERSATIONS_PER_USER = Math.max(1, parseInt(process.env.MAX_CONVERSATIONS_PER_USER || '5', 10) || 5);

/** 读取用户的已用对话次数。 */
export function getConversationCount(email) {
  const user = findUser(email);
  if (!user) return 0;
  return user.conversationCount || 0;
}

/** 递增用户的已用对话次数 +1，立即持久化到 users.json。 */
export function incrementConversationCount(email) {
  const users = readUsers();
  const target = normalizeEmail(email);
  const user = users.find((u) => u.email === target);
  if (!user) return;
  user.conversationCount = (user.conversationCount || 0) + 1;
  writeUsers(users);
}

/**
 * 对话次数限制闸门：
 * - 未启用鉴权 → 放行（本地模式无限制）；
 * - 管理员 → 放行（超管不限制）；
 * - API_TOKEN 持有者 → 放行（服务间调用不限制）；
 * - 已用次数 >= MAX_CONVERSATIONS_PER_USER → 写出 403 并返回 false；
 * - 否则放行并返回 true。
 *
 * 调用方在拿到 true 后应立即调用 incrementConversationCount 扣减次数，
 * 确保「先扣后执行」，杜绝并发绕过。
 */
export function checkConversationLimit(req, res) {
  if (!authRequired()) return true;

  // API_TOKEN 持有者视为服务间调用，不限制。
  const header = req.headers.authorization || '';
  if (process.env.API_TOKEN && header === `Bearer ${process.env.API_TOKEN}`) return true;

  // 超管不限制。
  if (isAdmin(req)) return true;

  const email = req.user?.email;
  if (!email) {
    // 没有用户上下文（理论上不会走到这里，因为有鉴权中间件），安全放行。
    return true;
  }

  const used = getConversationCount(email);
  if (used >= MAX_CONVERSATIONS_PER_USER) {
    res.status(403).json({
      error: `对话次数已达上限（${MAX_CONVERSATIONS_PER_USER} 次），请联系管理员`,
      limitExceeded: true,
      used,
      max: MAX_CONVERSATIONS_PER_USER,
    });
    return false;
  }
  return true;
}

// ---------- 路由 ----------
export function mountAuth(app) {
  // 注册：邮箱唯一，密码至少 6 位。
  app.post('/api/auth/register', (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '邮箱格式无效' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' });
    }
    if (findUser(email)) {
      return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
    }
    const { salt, hash } = hashPassword(password);
    const users = readUsers();
    users.push({ email, salt, hash, createdAt: Date.now() });
    writeUsers(users);
    res.json({ ok: true, email, token: signToken(email) });
  });

  // 登录。
  app.post('/api/auth/login', (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const user = findUser(email);
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }
    res.json({ ok: true, email, token: signToken(email) });
  });

  // 当前登录用户。
  app.get('/api/auth/me', (req, res) => {
    const payload = authFromRequest(req);
    if (!payload) return res.status(401).json({ error: '未登录或令牌已过期' });
    res.json({ ok: true, email: payload.email });
  });
}
