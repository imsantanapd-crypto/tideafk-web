'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const express = require('express')
const session = require('express-session')
const http = require('node:http')
const mineflayer = require('mineflayer')
const { Server: SocketServer } = require('socket.io')

const PORT = Number(process.env.PORT || 7860)
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'))
const HOST = process.env.MC_HOST || 'hightidepvp.net'
const MC_PORT = Number(process.env.MC_PORT || 25565)
const JOIN_COMMAND = process.env.JOIN_COMMAND || '/queue economy'
const SESSION_SECRET = process.env.SESSION_SECRET

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('Set SESSION_SECRET to a random secret with at least 32 characters.')
}

let users
try {
  users = JSON.parse(process.env.TIDEAFK_USERS || '{}')
} catch {
  throw new Error('TIDEAFK_USERS must be a JSON object of usernames to passwords.')
}
if (!users || Array.isArray(users) || typeof users !== 'object' || !Object.keys(users).length) {
  throw new Error('Set TIDEAFK_USERS to a JSON object containing at least one user.')
}
for (const [name, password] of Object.entries(users)) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name) || typeof password !== 'string' || password.length < 12) {
    throw new Error('Each TIDEAFK_USERS key must be a short username and each password at least 12 characters.')
  }
}

const app = express()
const server = http.createServer(app)
const io = new SocketServer(server)
const sessionMiddleware = session({
  name: 'tideafk.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: 'auto', maxAge: 12 * 60 * 60 * 1000 }
})
app.set('trust proxy', 1)
app.use(express.json({ limit: '8kb' }))
app.use(sessionMiddleware)
io.engine.use(sessionMiddleware)

const sessions = new Map()
const loginAttempts = new Map()
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
const roomFor = username => `user:${username}`
const publicState = state => ({ status: state.status, reconnects: state.reconnects, lastError: state.lastError })

function sendLog(username, message, level = 'info') {
  const item = { at: new Date().toISOString(), message: String(message).slice(0, 500), level }
  const state = sessions.get(username)
  if (state) {
    state.logs.push(item)
    if (state.logs.length > 200) state.logs.shift()
  }
  io.to(roomFor(username)).emit('log', item)
}

function emitState(username) {
  const state = sessions.get(username)
  if (state) io.to(roomFor(username)).emit('status', publicState(state))
}

function authRequired(req, res, next) {
  if (!req.session.username || !users[req.session.username]) return res.status(401).json({ error: 'Sign in first.' })
  next()
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown'
  const now = Date.now()
  const attempts = loginAttempts.get(ip) || { count: 0, until: now + 60_000 }
  if (now > attempts.until) { attempts.count = 0; attempts.until = now + 60_000 }
  if (attempts.count >= 10) return res.status(429).json({ error: 'Too many attempts. Wait one minute and try again.' })
  const { username, password } = req.body || {}
  const valid = typeof username === 'string' && typeof password === 'string' &&
    Object.hasOwn(users, username) && safeEqual(password, users[username])
  if (!valid) {
    attempts.count++
    loginAttempts.set(ip, attempts)
    return res.status(401).json({ error: 'Username or password is incorrect.' })
  }
  loginAttempts.delete(ip)
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not create a sign-in session.' })
    req.session.username = username
    req.session.save(saveErr => saveErr ? res.status(500).json({ error: 'Could not save sign-in session.' }) : res.json({ username }))
  })
})

app.post('/api/logout', authRequired, (req, res) => {
  const username = req.session.username
  stopUserBot(username, 'Stopped because you signed out.')
  req.session.destroy(() => res.json({ ok: true }))
})

app.get('/api/me', authRequired, (req, res) => res.json({ username: req.session.username, host: HOST, port: MC_PORT }))
app.get('/api/status', authRequired, (req, res) => {
  const state = sessions.get(req.session.username)
  res.json({ state: state ? publicState(state) : { status: 'stopped', reconnects: 0, lastError: '' }, logs: state?.logs || [] })
})

app.post('/api/start', authRequired, async (req, res) => {
  const username = req.session.username
  let state = sessions.get(username)
  if (state && ['connecting', 'online', 'reconnecting'].includes(state.status)) {
    return res.status(409).json({ error: 'Your bot is already running.' })
  }
  const profileDir = path.join(DATA_DIR, 'accounts', username)
  await fs.mkdir(profileDir, { recursive: true })
  state = { status: 'connecting', reconnects: 0, lastError: '', logs: [], stopped: false, bot: null, retryTimer: null, keepActiveTimer: null, revision: 0 }
  sessions.set(username, state)
  sendLog(username, `Connecting to ${HOST}:${MC_PORT} (Java Edition)…`)
  connectUserBot(username, state)
  res.json({ ok: true })
})

app.post('/api/stop', authRequired, (req, res) => {
  stopUserBot(req.session.username, 'Stopped by you.')
  res.json({ ok: true })
})

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }))
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})
app.use((err, req, res, next) => {
  console.error(err)
  if (!res.headersSent) res.status(500).json({ error: 'Unexpected server error.' })
})

io.use((socket, next) => {
  const username = socket.request.session?.username
  if (!username || !users[username]) return next(new Error('Sign in required.'))
  socket.data.username = username
  next()
})
io.on('connection', socket => {
  const username = socket.data.username
  socket.join(roomFor(username))
  const state = sessions.get(username)
  if (state) socket.emit('status', publicState(state))
})

function connectUserBot(username, state) {
  if (state.stopped || sessions.get(username) !== state) return
  const revision = ++state.revision
  state.status = state.reconnects ? 'reconnecting' : 'connecting'
  state.lastError = ''
  emitState(username)
  let bot
  try {
    bot = mineflayer.createBot({
      host: HOST,
      port: MC_PORT,
      username,
      auth: 'microsoft',
      profilesFolder: path.join(DATA_DIR, 'accounts', username),
      onMsaCode: code => {
        if (sessions.get(username) !== state || state.revision !== revision) return
        const url = code.verification_uri || code.verificationUri || 'https://microsoft.com/link'
        const value = code.user_code || code.userCode || ''
        io.to(roomFor(username)).emit('device-code', { url, code: value, message: code.message || '' })
        sendLog(username, value ? `Microsoft sign-in required. Enter code ${value} at ${url}.` : `Microsoft sign-in required at ${url}.`)
      }
    })
  } catch (err) {
    recordFailure(username, state, revision, err)
    scheduleReconnect(username, state, revision)
    return
  }
  state.bot = bot
  bot.on('login', () => sendLog(username, 'Microsoft authentication succeeded; joining server.'))
  bot.once('spawn', () => {
    if (sessions.get(username) !== state || state.stopped || revision !== state.revision) return
    state.status = 'online'
    state.reconnects = 0
    state.lastError = ''
    sendLog(username, `Online on ${HOST}:${MC_PORT}.`)
    emitState(username)
    if (JOIN_COMMAND) setTimeout(() => {
      if (sessions.get(username) === state && state.bot === bot && state.status === 'online') {
        bot.chat(JOIN_COMMAND)
        sendLog(username, `Sent configured join command: ${JOIN_COMMAND}`)
      }
    }, 1500)
    state.keepActiveTimer = setInterval(() => {
      if (state.bot !== bot || state.status !== 'online' || !bot.entity) return
      const yaw = bot.entity.yaw + (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 90)
      Promise.resolve(bot.look(yaw, bot.entity.pitch, true)).catch(() => {})
    }, 60_000)
  })
  bot.on('kicked', reason => {
    const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
    state.lastError = `Kicked: ${text}`
    sendLog(username, state.lastError, 'error')
  })
  bot.on('error', err => {
    if (sessions.get(username) !== state || revision !== state.revision) return
    recordFailure(username, state, revision, err)
  })
  bot.once('end', reason => {
    if (sessions.get(username) !== state || revision !== state.revision) return
    clearInterval(state.keepActiveTimer)
    state.keepActiveTimer = null
    state.bot = null
    if (state.stopped) {
      state.status = 'stopped'
      emitState(username)
      return
    }
    sendLog(username, `Disconnected${reason ? `: ${String(reason)}` : ''}.`, 'error')
    scheduleReconnect(username, state, revision)
  })
}

function recordFailure(username, state, revision, error) {
  if (sessions.get(username) !== state || revision !== state.revision) return
  state.lastError = String(error?.message || error || 'Unknown connection error').slice(0, 300)
  sendLog(username, state.lastError, 'error')
  state.status = 'reconnecting'
  emitState(username)
}

function scheduleReconnect(username, state, revision) {
  if (state.stopped || sessions.get(username) !== state || revision !== state.revision || state.retryTimer) return
  state.reconnects++
  const delay = Math.min(60, 5 * 2 ** Math.min(state.reconnects - 1, 4))
  state.status = 'reconnecting'
  sendLog(username, `Retry ${state.reconnects} in ${delay}s.`)
  emitState(username)
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null
    if (!state.stopped && sessions.get(username) === state) connectUserBot(username, state)
  }, delay * 1000)
}

function stopUserBot(username, message) {
  const state = sessions.get(username)
  if (!state) return
  state.stopped = true
  state.status = 'stopped'
  clearTimeout(state.retryTimer)
  clearInterval(state.keepActiveTimer)
  state.retryTimer = null
  state.keepActiveTimer = null
  const bot = state.bot
  state.bot = null
  if (bot) {
    try { bot.quit('Stopped by user') } catch { try { bot.end() } catch {} }
  }
  sendLog(username, message)
  emitState(username)
}

server.listen(PORT, '0.0.0.0', () => console.log(`TideAFK web listening on port ${PORT}`))

function shutdown() {
  for (const username of sessions.keys()) stopUserBot(username, 'Service is shutting down.')
  const forceExit = setTimeout(() => process.exit(1), 10_000)
  io.close(() => {
    clearTimeout(forceExit)
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
