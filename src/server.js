import express from 'express'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import pino from 'pino'
import { rmSync, existsSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT     = process.env.PORT     || 3002
const API_KEY  = process.env.API_KEY  || ''
const AUTH_DIR = process.env.AUTH_DIR || join(__dirname, '..', 'auth')

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })

const logger = pino({ level: 'silent' })

// ─── State ────────────────────────────────────────────────────────────────────

let sock             = null
let qrCodeData       = null
let connectionStatus = 'disconnected'   // disconnected | qr_pending | reconnecting | connected | logged_out
let phoneInfo        = null

// ─── WhatsApp connection ──────────────────────────────────────────────────────

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  let version
  try {
    const latest = await fetchLatestBaileysVersion()
    version = latest.version
  } catch {
    version = [2, 3000, 1015901307]
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    retryRequestDelayMs: 2_000,
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      try {
        qrCodeData       = await QRCode.toDataURL(qr)
        connectionStatus = 'qr_pending'
        console.log('[Baileys] QR code gerado — escaneie com o WhatsApp')
      } catch (err) {
        console.error('[Baileys] Erro ao gerar QR:', err.message)
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const reason     = lastDisconnect?.error?.output?.payload?.message || 'desconhecido'
      console.log(`[Baileys] Conexão encerrada: ${reason} (código ${statusCode})`)
      qrCodeData = null
      phoneInfo  = null

      if (statusCode === DisconnectReason.loggedOut) {
        connectionStatus = 'logged_out'
        console.log('[Baileys] Sessão encerrada. Limpe a pasta auth para reconectar.')
      } else {
        connectionStatus = 'reconnecting'
        console.log('[Baileys] Reconectando em 5s...')
        setTimeout(connectToWhatsApp, 5_000)
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected'
      qrCodeData       = null
      phoneInfo        = sock.user
      console.log(`[Baileys] Conectado como ${phoneInfo?.id}`)
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatJid(phone) {
  if (phone.includes('@')) return phone
  const clean = phone.replace(/\D/g, '')
  return `${clean}@s.whatsapp.net`
}

function formatE164(phone) {
  return phone.replace(/\D/g, '')
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '50mb' }))

// API Key middleware (apenas se API_KEY estiver definida)
function requireAuth(req, res, next) {
  if (!API_KEY) return next()
  const key = req.headers['x-api-key']
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: X-Api-Key inválida ou ausente' })
  }
  next()
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check público (sem auth) — útil para Docker healthcheck
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: connectionStatus })
})

// Status da conexão
app.get('/status', requireAuth, (req, res) => {
  res.json({
    status: connectionStatus,
    qrAvailable: !!qrCodeData,
    phone: phoneInfo?.id   || null,
    name:  phoneInfo?.name || null,
  })
})

// QR como imagem PNG
app.get('/qr', requireAuth, (req, res) => {
  if (!qrCodeData) {
    return res.status(404).json({ error: `QR não disponível. Status atual: ${connectionStatus}` })
  }
  const base64 = qrCodeData.replace(/^data:image\/png;base64,/, '')
  const img    = Buffer.from(base64, 'base64')
  res.set({ 'Content-Type': 'image/png', 'Content-Length': img.length })
  res.end(img)
})

// QR como JSON base64 (útil para integração com frontend)
app.get('/qr.json', requireAuth, (req, res) => {
  if (!qrCodeData) {
    return res.status(404).json({ error: `QR não disponível. Status atual: ${connectionStatus}` })
  }
  res.json({ qr: qrCodeData })
})

// Verificar se um número tem WhatsApp
app.post('/check', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp não conectado', status: connectionStatus })
  }
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'Campo obrigatório: phone' })

  try {
    const [result] = await sock.onWhatsApp(formatE164(phone))
    res.json({ phone, registered: !!result?.exists, jid: result?.jid || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar mensagem de texto
app.post('/send/text', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp não conectado', status: connectionStatus })
  }
  const { phone, message } = req.body
  if (!phone || !message) {
    return res.status(400).json({ error: 'Campos obrigatórios: phone, message' })
  }
  try {
    const jid    = formatJid(phone)
    const result = await sock.sendMessage(jid, { text: message })
    res.json({ success: true, messageId: result.key.id, to: jid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar imagem por URL
app.post('/send/image', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp não conectado', status: connectionStatus })
  }
  const { phone, url, caption } = req.body
  if (!phone || !url) {
    return res.status(400).json({ error: 'Campos obrigatórios: phone, url' })
  }
  try {
    const jid    = formatJid(phone)
    const result = await sock.sendMessage(jid, { image: { url }, caption: caption || '' })
    res.json({ success: true, messageId: result.key.id, to: jid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar arquivo/documento por URL
app.post('/send/file', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp não conectado', status: connectionStatus })
  }
  const { phone, url, filename, mimetype } = req.body
  if (!phone || !url || !filename) {
    return res.status(400).json({ error: 'Campos obrigatórios: phone, url, filename' })
  }
  try {
    const jid    = formatJid(phone)
    const result = await sock.sendMessage(jid, {
      document: { url },
      fileName: filename,
      mimetype: mimetype || 'application/octet-stream',
    })
    res.json({ success: true, messageId: result.key.id, to: jid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar áudio por URL (ptt=true = mensagem de voz)
app.post('/send/audio', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp não conectado', status: connectionStatus })
  }
  const { phone, url, ptt } = req.body
  if (!phone || !url) {
    return res.status(400).json({ error: 'Campos obrigatórios: phone, url' })
  }
  try {
    const jid    = formatJid(phone)
    const result = await sock.sendMessage(jid, {
      audio:    { url },
      mimetype: 'audio/mp4',
      ptt:      ptt === true,
    })
    res.json({ success: true, messageId: result.key.id, to: jid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Listar grupos
app.get('/groups', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp não conectado', status: connectionStatus })
  }
  try {
    const groups = await sock.groupFetchAllParticipating()
    const list   = Object.values(groups).map((g) => ({
      id:               g.id,
      subject:          g.subject,
      participantCount: g.participants?.length || 0,
      owner:            g.owner || null,
    }))
    res.json({ count: list.length, groups: list })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Logout / limpar sessão
app.post('/logout', requireAuth, async (req, res) => {
  try {
    if (sock) {
      try { await sock.logout() } catch { /* ignora erros ao deslogar */ }
      sock = null
    }
    rmSync(AUTH_DIR, { recursive: true, force: true })
    mkdirSync(AUTH_DIR, { recursive: true })
    connectionStatus = 'disconnected'
    qrCodeData       = null
    phoneInfo        = null
    res.json({ success: true, message: 'Sessão encerrada e auth limpa' })
    setTimeout(connectToWhatsApp, 2_000)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Newsletter helpers ───────────────────────────────────────────────────────

// Aceita: JID direto, código de convite ou URL completa do canal
async function resolveNewsletterJid(value) {
  if (!value) throw new Error('jid ou invite obrigatório')

  // Já é um JID → retorna direto
  if (value.endsWith('@newsletter')) return value

  // Extrai código de URL completa: https://whatsapp.com/channel/XXXX
  const urlMatch = value.match(/whatsapp\.com\/channel\/([^/?#]+)/)
  const code     = urlMatch ? urlMatch[1] : value

  const meta = await sock.newsletterMetadata('invite', code)
  if (!meta?.id) throw new Error(`Canal não encontrado para o código: ${code}`)
  return meta.id
}

function notConnected(res) {
  return res.status(503).json({ error: 'WhatsApp não conectado', status: connectionStatus })
}

// ─── Newsletter routes ────────────────────────────────────────────────────────

// Info do canal — por JID, código de convite ou URL
// Body: { jid } ou { invite } (código ou URL completa)
app.post('/newsletter/info', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, invite } = req.body
  if (!jid && !invite) {
    return res.status(400).json({ error: 'Informe jid ou invite (código ou URL do canal)' })
  }
  try {
    let meta
    if (jid) {
      meta = await sock.newsletterMetadata('jid', jid)
    } else {
      const urlMatch = invite.match(/whatsapp\.com\/channel\/([^/?#]+)/)
      const code     = urlMatch ? urlMatch[1] : invite
      meta           = await sock.newsletterMetadata('invite', code)
    }
    res.json(meta)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar texto no canal
// Body: { jid, message } — jid pode ser JID, código ou URL
app.post('/newsletter/send/text', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, message } = req.body
  if (!jid || !message) {
    return res.status(400).json({ error: 'Campos obrigatórios: jid, message' })
  }
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    const result        = await sock.sendMessage(newsletterJid, { text: message })
    res.json({ success: true, messageId: result.key.id, to: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar imagem no canal
// Body: { jid, url, caption? }
app.post('/newsletter/send/image', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, url, caption } = req.body
  if (!jid || !url) {
    return res.status(400).json({ error: 'Campos obrigatórios: jid, url' })
  }
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    const result        = await sock.sendMessage(newsletterJid, {
      image:   { url },
      caption: caption || '',
    })
    res.json({ success: true, messageId: result.key.id, to: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar vídeo no canal
// Body: { jid, url, caption? }
app.post('/newsletter/send/video', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, url, caption } = req.body
  if (!jid || !url) {
    return res.status(400).json({ error: 'Campos obrigatórios: jid, url' })
  }
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    const result        = await sock.sendMessage(newsletterJid, {
      video:   { url },
      caption: caption || '',
    })
    res.json({ success: true, messageId: result.key.id, to: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar arquivo/documento no canal
// Body: { jid, url, filename, mimetype? }
app.post('/newsletter/send/file', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, url, filename, mimetype } = req.body
  if (!jid || !url || !filename) {
    return res.status(400).json({ error: 'Campos obrigatórios: jid, url, filename' })
  }
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    const result        = await sock.sendMessage(newsletterJid, {
      document: { url },
      fileName: filename,
      mimetype: mimetype || 'application/octet-stream',
    })
    res.json({ success: true, messageId: result.key.id, to: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Buscar histórico de mensagens do canal
// Body: { jid, count?, since?, after? }
app.post('/newsletter/messages', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, count = 20, since = 0, after = 0 } = req.body
  if (!jid) return res.status(400).json({ error: 'Campo obrigatório: jid' })
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    const messages      = await sock.newsletterFetchMessages(newsletterJid, count, since, after)
    res.json({ jid: newsletterJid, count: messages?.length ?? 0, messages })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Seguir canal
// Body: { jid }
app.post('/newsletter/follow', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid } = req.body
  if (!jid) return res.status(400).json({ error: 'Campo obrigatório: jid' })
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    await sock.newsletterFollow(newsletterJid)
    res.json({ success: true, jid: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Deixar de seguir canal
// Body: { jid }
app.post('/newsletter/unfollow', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid } = req.body
  if (!jid) return res.status(400).json({ error: 'Campo obrigatório: jid' })
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    await sock.newsletterUnfollow(newsletterJid)
    res.json({ success: true, jid: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Silenciar canal
// Body: { jid }
app.post('/newsletter/mute', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid } = req.body
  if (!jid) return res.status(400).json({ error: 'Campo obrigatório: jid' })
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    await sock.newsletterMute(newsletterJid)
    res.json({ success: true, jid: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Reativar notificações do canal
// Body: { jid }
app.post('/newsletter/unmute', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid } = req.body
  if (!jid) return res.status(400).json({ error: 'Campo obrigatório: jid' })
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    await sock.newsletterUnmute(newsletterJid)
    res.json({ success: true, jid: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Número de inscritos
// Body: { jid }
app.post('/newsletter/subscribers', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid } = req.body
  if (!jid) return res.status(400).json({ error: 'Campo obrigatório: jid' })
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    const result        = await sock.newsletterSubscribers(newsletterJid)
    res.json({ jid: newsletterJid, subscribers: result?.subscribers ?? result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Reagir a uma mensagem do canal
// Body: { jid, serverId, reaction }  — reaction vazio remove a reação
app.post('/newsletter/react', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, serverId, reaction } = req.body
  if (!jid || !serverId) {
    return res.status(400).json({ error: 'Campos obrigatórios: jid, serverId' })
  }
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    await sock.newsletterReactMessage(newsletterJid, serverId, reaction || '')
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Criar canal
// Body: { name, description? }
app.post('/newsletter/create', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { name, description } = req.body
  if (!name) return res.status(400).json({ error: 'Campo obrigatório: name' })
  try {
    const meta = await sock.newsletterCreate(name, description)
    res.json({ success: true, newsletter: meta })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Atualizar nome do canal
// Body: { jid, name }
app.post('/newsletter/update/name', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, name } = req.body
  if (!jid || !name) return res.status(400).json({ error: 'Campos obrigatórios: jid, name' })
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    await sock.newsletterUpdateName(newsletterJid, name)
    res.json({ success: true, jid: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Atualizar descrição do canal
// Body: { jid, description }
app.post('/newsletter/update/description', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid, description } = req.body
  if (!jid || !description) {
    return res.status(400).json({ error: 'Campos obrigatórios: jid, description' })
  }
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    await sock.newsletterUpdateDescription(newsletterJid, description)
    res.json({ success: true, jid: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Deletar canal (irreversível)
// Body: { jid }
app.delete('/newsletter', requireAuth, async (req, res) => {
  if (connectionStatus !== 'connected') return notConnected(res)
  const { jid } = req.body
  if (!jid) return res.status(400).json({ error: 'Campo obrigatório: jid' })
  try {
    const newsletterJid = await resolveNewsletterJid(jid)
    await sock.newsletterDelete(newsletterJid)
    res.json({ success: true, deleted: newsletterJid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Baileys API] Porta ${PORT}`)
  if (API_KEY) {
    console.log(`[Baileys API] Proteção por API key ATIVA`)
  } else {
    console.log(`[Baileys API] AVISO: API_KEY não definida — endpoints públicos`)
  }
  connectToWhatsApp()
})
