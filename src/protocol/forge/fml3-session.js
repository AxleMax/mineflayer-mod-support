'use strict'

const { inspectFml3LoginWrapper } = require('./login-wrapper')
const { ForgeRegistryObserver } = require('./registry-observer')
const { unwrapFml3Reply, decodeC2SModListReply } = require('./fml3-client-wire')

/**
 * Passive FML3 login negotiation state machine. It never impersonates an
 * installed Java mod, sends packets, or mutates a network client.
 *
 * "advertised" is server-provided information, not client capabilities.
 */
class Fml3Session {
  constructor () {
    this.state = 'idle'
    this.modData = null
    this.modList = null
    this.requests = []
    this.responses = []
    this.events = []
    this.warnings = []
    this._pendingRequests = new Map()
    this._playReached = false
    this.clientProfile = null
    this._responseById = new Map()
    this._lastResponseType = null
    this.channelMismatch = null
    this.modListReplyStatus = 'not_sent'
    this.suppressedResponses = []
    this.configObservations = []
    this.registryObserver = new ForgeRegistryObserver()
  }

  inspectRequest (request) {
    if (!request || request.channel !== 'fml:loginwrapper') return null
    const id = request.messageId
    if (!Number.isInteger(id) || id < 0) throw new Error('invalid_login_message_id')
    const result = inspectFml3LoginWrapper(request.payload)
    const requiresReply = result.outerChannel === 'fml:handshake' &&
      !['S2CModData', 'S2CChannelMismatchData'].includes(result.type)
    this.requests.push({ id, channel: request.channel, outerChannel: result.outerChannel, type: result.type, parsed: result.parsed, error: result.error, packetId: result.packetId, requiresReply })
    // Minecraft transaction IDs may be reused after a request is resolved.
    // Only a second *outstanding* request with the same ID is suspicious.
    if (this._pendingRequests.has(id)) this.warnings.push('duplicate_request_id:' + id)
    if (requiresReply) this._pendingRequests.set(id, result.type || 'unknown')
    if (!result.parsed || result.error) {
      this.warnings.push('unparsed_fml_payload:' + id + ':' + (result.error || 'unknown'))
      this.state = 'inspection_error'
      return result
    }
    if (result.outerChannel !== 'fml:handshake') {
      this.events.push('other_channel:' + result.outerChannel)
      return result
    }
    if (result.type === 'S2CModData') {
      if (this.modData) this.warnings.push('duplicate_mod_data')
      this.modData = result.details.mods
      if (!this.modList) this.state = 'mod_data_received'
    } else if (result.type === 'S2CModList') {
      if (this.modList) this.warnings.push('duplicate_mod_list')
      if (!this.modData) this.warnings.push('mod_list_before_mod_data')
      this.modList = result.details
      this.state = 'mod_list_reply_required'
    } else if (result.type === 'S2CChannelMismatchData') {
      this.channelMismatch = result.details
      this.state = 'channel_mismatch_rejected'
      this.events.push('channel_mismatch_received:' + id)
      // This server-side terminal message does not require a C2S reply.
      this._pendingRequests.delete(id)
    } else if (result.type === 'S2CRegistry') {
      const receipt = this.registryObserver.observe(result.details, id)
      this.events.push(receipt ? 'registry_snapshot_received_opaque:' + receipt.name : 'registry_snapshot_unrecognized')
      if (this.state !== 'inspection_error') this.state = 'registry_sync_unimplemented'
    } else if (result.type === 'S2CConfigData') {
      this.configObservations.push({
        messageId: id,
        fileName: result.details.fileName,
        dataBytes: result.details.dataBytes,
        sha256: result.details.sha256
      })
      this.events.push('config_sync_received:' + id + ':' + result.details.fileName)
      if (this.state !== 'inspection_error') this.state = 'config_sync_received'
    } else {
      this.warnings.push('unsupported_fml_packet:' + result.packetId)
    }
    return result
  }

  inspectResponse (response) {
    const id = response?.messageId
    if (!Number.isInteger(id) || id < 0) throw new Error('invalid_login_response_id')
    const raw = response.payload
    const hasPayload = Buffer.isBuffer(raw) && raw.length > 0
    const requestType = this._pendingRequests.get(id) || null
    const successful = typeof response.successful === 'boolean' ? response.successful : hasPayload
    const item = { id, requestType, hasPayload, successful, size: hasPayload ? raw.length : 0, replyType: null, decoded: false }
    if (hasPayload && requestType) {
      try {
        const inner = unwrapFml3Reply(raw)
        if (inner[0] === 2) {
          const profile = decodeC2SModListReply(inner)
          item.replyType = 'C2SModListReply'
          item.decoded = requestType === 'S2CModList'
          if (requestType === 'S2CModList') {
            this.clientProfile = profile
            this.modListReplyStatus = successful ? 'wire_reply_sent_unverified' : 'wire_reply_rejected'
          }
        } else if (inner[0] === 99) {
          item.replyType = 'C2SAcknowledge'
          item.decoded = inner.length === 1 && ['S2CRegistry', 'S2CConfigData'].includes(requestType)
        } else {
          item.replyType = 'unknown'
        }
      } catch (error) {
        item.replyType = 'unrecognized'
        item.decodeError = String(error?.message || error).slice(0, 64)
      }
    }
    this.responses.push(item)
    this._responseById.set(id, item)
    // A response consumes the indexed transaction even when it is negative;
    // the final completion predicate separately requires a successful payload.
    this._pendingRequests.delete(id)
    if (!hasPayload) this.events.push('empty_login_response:' + id)
    if (!successful) this.events.push('negative_login_response:' + id)
    if (hasPayload && requestType && !item.decoded) this.warnings.push('unrecognized_fml3_client_reply:' + id)
    this._syncStateAfterPlay()
    return item
  }

  inspectSuppression (messageId, type, reason = 'suppressed_nmp_auto_reply') {
    if (!Number.isInteger(messageId) || messageId < 0) throw new Error('invalid_login_response_id')
    // Suppression means no reply was sent. Keep the request outstanding so
    // the report cannot mistake a deliberately withheld packet for an ACK.
    this.suppressedResponses.push({ id: messageId, type, reason })
    this.events.push('suppressed_login_response:' + messageId + ':' + type)
    this._syncStateAfterPlay()
  }

  markPlayReached () {
    this._playReached = true
    this.events.push('minecraft_play_state_reached')
    this._syncStateAfterPlay()
    return this.getReport().handshakeComplete
  }

  _syncStateAfterPlay () {
    if (!this._playReached) return
    this.state = this.getReport().handshakeComplete ? 'handshake_complete' : 'play_reached_with_unresolved_fml3'
  }

  getReport () {
    const serverMods = this.modData || []
    const serverList = this.modList || { modIds: [], channels: [], registries: [], dataPackRegistries: [] }
    const modDataIds = new Set(serverMods.map(m => m.id))
    const modListIds = new Set(serverList.modIds)
    const missingFromModData = serverList.modIds.filter(id => !modDataIds.has(id))
    const missingFromModList = serverMods.map(m => m.id).filter(id => !modListIds.has(id))
    const emptyResponses = this.responses.filter(r => !r.hasPayload).map(r => r.id)
    const requiredRequests = this.requests.filter(r => r.requiresReply === true)
    const completedReplies = requiredRequests.filter(r => { const reply = this._responseById.get(r.id); return Boolean(reply && reply.hasPayload && reply.successful && reply.decoded) })
    const failedReplies = requiredRequests.filter(r => { const reply = this._responseById.get(r.id); return Boolean(reply && (!reply.hasPayload || !reply.successful || !reply.decoded)) })
    const modListRequest = requiredRequests.find(r => r.type === 'S2CModList')
    const modListReply = modListRequest ? this._responseById.get(modListRequest.id) : null
    const modListReplyVerified = Boolean(modListReply && modListReply.replyType === 'C2SModListReply' && modListReply.successful && modListReply.decoded)
    const handshakeComplete = this._playReached && modListReplyVerified && requiredRequests.length > 0 && completedReplies.length === requiredRequests.length && this._pendingRequests.size === 0 && !this.channelMismatch
    const reportedState = handshakeComplete ? 'handshake_complete' : this._playReached ? 'play_reached_with_unresolved_fml3' : this.state
    return {
      state: reportedState,
      handshakeComplete,
      completionEvidence: { basis: handshakeComplete ? 'play_state_after_all_indexed_fml3_replies' : 'incomplete', playReached: this._playReached, modListReplyVerified, requiredRequests: requiredRequests.length, successfulReplies: completedReplies.length, failedReplies: failedReplies.length, pendingReplies: this._pendingRequests.size },
      clientProfile: this.clientProfile ? structuredClone(this.clientProfile) : null,
      forgeVersion: serverMods.find(m => m.id === 'forge')?.version || null,
      server: {
        mods: serverMods.map(m => ({ ...m })),
        modIds: [...serverList.modIds],
        channels: serverList.channels.map(c => ({ ...c })),
        registries: [...serverList.registries],
        dataPackRegistries: [...serverList.dataPackRegistries]
      },
      requests: this.requests.map(r => ({ ...r })),
      responses: this.responses.map(r => ({ ...r })),
      suppressedResponses: this.suppressedResponses.map(r => ({ ...r })),
      pendingRequests: [...this._pendingRequests.entries()].map(([id, type]) => ({ id, type })),
      configObservations: this.configObservations.map(r => ({ ...r })),
      channelMismatch: this.channelMismatch ? structuredClone(this.channelMismatch) : null,
      registryObservation: this.registryObserver.getReport(),
      diagnostics: {
        missingFromModData,
        missingFromModList,
        emptyResponses,
        // These are DISCOVERED server channels, NOT proof they are required.
        serverDeclaredChannels: serverList.channels.map(c => c.id),
        // Adapter and Registry capabilities are tracked by their dedicated runtime views.
        clientCodecCompatibility: 'see_native_channels_adapter_report',
        registrySync: 'see_runtime_registry_mappings_and_native_registry',
        modListReply: this.modListReplyStatus,
        clientProfile: this.clientProfile ? structuredClone(this.clientProfile) : null,
        warnings: [...this.warnings],
        events: [...this.events]
      }
    }
  }
}

/** Analyze an existing P0.4 JSON report offline. No server connection. */
function analyzeP04Report (report) {
  if (report?.schema !== 'mineflayer-mod-support/forge-p0-fml3-inspect/v1') {
    throw new Error('unsupported_report_schema')
  }
  const session = new Fml3Session()
  const handshake = report?.evidence?.fmlHandshake || []
  for (const m of handshake) {
    const id = m.messageId
    if (!Number.isInteger(id) || id < 0) throw new Error('invalid_message_id')
    const requiresReply = m.outerChannel === 'fml:handshake' && m.type !== 'S2CChannelMismatchData'
    session.requests.push({ id, channel: 'fml:loginwrapper', outerChannel: m.outerChannel || null, type: m.type || null, parsed: m.parsed === true, error: m.error || null, packetId: m.packetId ?? null, requiresReply })
    if (requiresReply) session._pendingRequests.set(id, m.type || 'unknown')
    if (m.parsed !== true || m.outerChannel !== 'fml:handshake' || m.trailingBytes !== 0) {
      session.warnings.push('invalid_or_partial_handshake_record:' + id)
      continue
    }
    if (m.type === 'S2CModData' && Array.isArray(m.details?.mods)) {
      session.modData = m.details.mods
      session.state = 'mod_data_received'
    } else if (m.type === 'S2CModList' && Array.isArray(m.details?.modIds) && Array.isArray(m.details?.channels) && Array.isArray(m.details?.registries)) {
      session.modList = { ...m.details, dataPackRegistries: m.details.dataPackRegistries || [] }
      session.state = 'mod_list_reply_required'
    } else {
      session.warnings.push('unsupported_handshake_record:' + id)
    }
  }
  for (const m of report?.evidence?.loginPluginMessages || []) {
    if (m.direction === 'outbound' && m.packetName === 'login_plugin_response' && Number.isInteger(m.messageId)) {
      session.inspectResponse({ messageId: m.messageId, payload: m.hasPayload === true ? Buffer.alloc(Math.max(1, Math.min(m.payloadBytes || 1, 64))) : null, successful: m.replySuccessful !== false })
    }
  }
  if (report.outcome?.reachedPlay === true) session.markPlayReached()
  return {
    schema: 'mineflayer-mod-support/fml3-negotiation-analysis/v1',
    sourceSchema: report.schema,
    environment: { minecraftVersion: report.settings?.minecraftVersion || null, serverVersion: report.evidence?.status?.versionName || null },
    outcome: { reachedPlay: report.outcome?.reachedPlay === true, kicked: report.outcome?.kicked || null },
    negotiation: session.getReport()
  }
}

module.exports = { Fml3Session, analyzeP04Report }
