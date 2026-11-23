'use strict'

// Narrow, non-invasive evidence collection. No raw payload bytes are retained.
const CHANNEL_RE = /^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/i

function textField (value, max = 96) {
  if (typeof value !== 'string') return null
  if (value.length > max || /[\x00-\x1F\x7F]/.test(value)) return null
  return value
}

function extractStatusEvidence (status) {
  if (!status || typeof status !== 'object') return { queried: true, error: 'unexpected_response' }
  const forgeData = status.forgeData || status.forge_data || null
  const modinfo = status.modinfo || status.modInfo || null
  const obj = forgeData && typeof forgeData === 'object' ? forgeData : modinfo && typeof modinfo === 'object' ? modinfo : null
  const mods = Array.isArray(obj?.mods) ? obj.mods : []
  const channels = Array.isArray(obj?.channels) ? obj.channels : []
  const version = status.version && typeof status.version === 'object' ? status.version : {}
  return {
    queried: true,
    reportsForgeData: Boolean(forgeData),
    reportsModInfo: Boolean(modinfo),
    fmlNetworkVersion: Number.isInteger(obj?.fmlNetworkVersion) ? obj.fmlNetworkVersion : Number.isInteger(obj?.fmlNetworkVer) ? obj.fmlNetworkVer : null,
    modsCount: mods.length,
    channelsCount: channels.length,
    minecraftProtocol: Number.isInteger(version.protocol) ? version.protocol : null,
    // Do not copy arbitrary server MOTD, player samples, icon, host or addresses.
    versionName: textField(version.name, 48)
  }
}

function varIntLength (buffer) {
  let value = 0
  for (let i = 0; i < Math.min(5, buffer.length); i++) {
    value |= (buffer[i] & 0x7f) << (i * 7)
    if ((buffer[i] & 0x80) === 0) return { length: value >>> 0, offset: i + 1 }
  }
  return null
}

function extractBrand (value) {
  if (typeof value === 'string') return textField(value, 96)
  if (!Buffer.isBuffer(value)) return null
  const prefix = varIntLength(value)
  if (!prefix || prefix.length > 96 || prefix.offset + prefix.length !== value.length) return null
  return textField(value.subarray(prefix.offset).toString('utf8'), 96)
}

function extractRegisterChannels (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 65536) return []
  return [...new Set(buffer.toString('utf8').split('\0').filter(x => x.length < 96 && CHANNEL_RE.test(x)))].slice(0, 64)
}

function extractLoginRequest (packet) {
  const name = String(packet?.name || '')
  if (packet?.phase !== 'login' || !/(plugin|custom_query|custom_payload)/i.test(name)) return null
  const d = packet.data || {}
  const channel = [d.channel, d.identifier, d.tag, d.channelName, d.name].find(v => typeof v === 'string' && CHANNEL_RE.test(v)) || null
  const body = [d.data, d.payload, d.contents].find(Buffer.isBuffer)
  const messageId = [d.messageId, d.message_id, d.transactionId, d.transaction_id].find(Number.isInteger)
  return {
    direction: packet.direction,
    packetName: name.slice(0, 64),
    channel,
    messageId: messageId ?? null,
    payloadBytes: body?.length ?? null
  }
}

function detectFmlHandshakeMarker (data) {
  const host = [data?.serverHost, data?.serverAddress, data?.server_address, data?.host].find(v => typeof v === 'string')
  if (!host) return null
  return /\u0000FML\d*(?:\u0000|$)/i.test(host)
}

module.exports = {
  extractStatusEvidence,
  extractBrand,
  extractRegisterChannels,
  extractLoginRequest,
  detectFmlHandshakeMarker
}
