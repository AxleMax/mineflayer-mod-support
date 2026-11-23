'use strict'

const FML3_SUFFIX = '\u0000FML3\u0000'
const MAX_HOST_BYTES = 255

/**
 * Experimental, *opt-in* client advertisement for Forge 1.20.1 (protocol 763).
 * This is not a Forge login implementation and deliberately never fabricates
 * the client mod list or sends a login-plugin response.
 */
function addFml3ToHandshake (name, data, version) {
  if (name !== 'set_protocol' || !data || typeof data !== 'object') return { applied: false, data }
  const isLogin = data.nextState === 2 || data.nextState === 'login'
  if (!isLogin) return { applied: false, data, reason: 'not_login' }
  if (version !== '1.20.1' || data.protocolVersion !== 763) {
    return { applied: false, data, reason: 'unsupported_version' }
  }
  if (typeof data.serverHost !== 'string') {
    return { applied: false, data, reason: 'missing_server_host' }
  }
  // A proxy/other modloader might have already added a handshake suffix.
  // Never remove or stack unidentified modifications.
  if (data.serverHost.includes('\u0000')) {
    return { applied: false, data, reason: data.serverHost.endsWith(FML3_SUFFIX) ? 'already_present' : 'existing_marker' }
  }
  const serverHost = data.serverHost + FML3_SUFFIX
  if (Buffer.byteLength(serverHost, 'utf8') > MAX_HOST_BYTES) {
    return { applied: false, data, reason: 'host_too_long' }
  }
  return { applied: true, data: { ...data, serverHost } }
}

module.exports = { addFml3ToHandshake, FML3_SUFFIX }
