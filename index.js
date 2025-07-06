import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys'
import axios from 'axios'
import * as dotenv from 'dotenv'
import qrcode from 'qrcode-terminal'
import fs from 'fs-extra'

dotenv.config()

const openaiKey = process.env.OPENAI_API_KEY
const openaiProjectId = process.env.OPENAI_PROJECT_ID

const memoryFile = 'threads.json'

// Load saved memory or start fresh
let threads = new Map()
if (fs.existsSync(memoryFile)) {
  const loaded = fs.readJsonSync(memoryFile)
  threads = new Map(Object.entries(loaded))
  console.log('📂 Memory loaded.')
}

// Save memory every 5 seconds
setInterval(() => {
  fs.writeJsonSync(memoryFile, Object.fromEntries(threads))
}, 5000)

// Helper: sleep for ms milliseconds
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Calculate dynamic delay based on message lengths
function calculateDelay(incomingText, replyText) {
  const baseDelay = 10000 // minimum 10 seconds
  const charsPerSecond = 15 // estimated reading speed (characters per sec)

  // Time to read incoming message
  const incomingDelay = (incomingText.length / charsPerSecond) * 1000
  // Time to type/send reply (approx)
  const replyDelay = (replyText.length / charsPerSecond) * 1000

  // Total delay = base + incoming read + reply type, capped max 60 seconds
  return Math.min(baseDelay + incomingDelay + replyDelay, 60000)
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const sock = makeWASocket({ auth: state })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      qrcode.generate(qr, { small: true })
      console.log('📱 Scan QR to login')
    }
    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp')
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401
      console.log('⚠️ Disconnected. Reconnecting?', shouldReconnect)
      if (shouldReconnect) startSock()
    }
  })

  // Message queue stuff
  const messageQueue = []
  let isProcessingQueue = false

  async function processQueue() {
    if (isProcessingQueue) return
    isProcessingQueue = true

    while (messageQueue.length > 0) {
      const { jid, reply, incomingText } = messageQueue.shift()

      await sock.sendMessage(jid, { text: reply })
      console.log(`🤖 To ${jid}: ${reply}`)

      const delay = calculateDelay(incomingText, reply)
      console.log(`⏳ Waiting ${delay / 1000}s before next message...`)
      await sleep(delay)
    }

    isProcessingQueue = false
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const jid  = msg.key.remoteJid
    const text = msg.message.conversation 
              || msg.message.extendedTextMessage?.text
    if (!text) return

    console.log(`📩 From ${jid}: ${text}`)

    if (!threads.has(jid)) {
      threads.set(jid, [
         { role: 'system', content: `You are SB — a regular person chatting on WhatsApp. You sound casual, laid-back, and talk like a real human being. You're mildly agreeable, but you're not afraid to playfully disagree or tease if it makes sense. You let conversations flow naturally, like how people chat with friends.

Keep your messages short to medium-length, avoid sounding robotic or overly formal. Use natural slang, and casual phrasing when it fits. You never say you're an AI or ChatGPT — if anyone asks, just say "It's me, SB."

Don't overexplain. Be spontaneous, natural, and react like someone genuinely reading and replying on their phone. You're texting, not writing essays.` }
      ])
    }

    const thread = threads.get(jid)

    const lower = text.toLowerCase()
    if (lower.includes('are you ai') || lower.includes('are you chatgpt')) {
      const replyText = "It's me, SB."
      messageQueue.push({ jid, reply: replyText, incomingText: text })
      processQueue()
      return
    }

    thread.push({ role: 'user', content: text })

    if (thread.length > 11) {
      thread.splice(1, thread.length - 10)
    }

    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          messages: thread,
          max_tokens: 150,
          temperature: 0.7
        },
        {
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
            'OpenAI-Project': openaiProjectId,
            'Content-Type': 'application/json'
          }
        }
      )

      const reply = res.data.choices[0].message.content.trim()
      thread.push({ role: 'assistant', content: reply })

      // Enqueue reply with dynamic delay
      messageQueue.push({ jid, reply, incomingText: text })
      processQueue()

    } catch (err) {
      console.error('⚠️ OpenAI error:', err.response?.data || err.message)
    }
  })
}

startSock()
