'use strict'
const { MAX_COUNT } = require('./wire')
const ID = /^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/

// Forge's peer channel table is authoritative for the login reply. This only
// negotiates channel presence/version; it never installs a message codec/handler.
function negotiateChannels (local, server) {
  function table (values, source) {
    if (!Array.isArray(values) || values.length > MAX_COUNT) throw Error('invalid_' + source + '_channel_table')
    const result = new Map()
    for (const entry of values) {
      if (!entry || !ID.test(entry.id || '') || typeof entry.version !== 'string' || Buffer.byteLength(entry.version, 'utf8') > 256 || result.has(entry.id)) throw Error('invalid_' + source + '_channel_declaration')
      result.set(entry.id, { id: entry.id, version: entry.version })
    }
    return result
  }
  const locals = table(local, 'local'), peers = server == null ? null : table(server, 'server')
  const entries = []
  for (const channel of peers?.values() || []) {
    const found = locals.get(channel.id)
    entries.push({ ...channel, source: 'server-declaration', localDiscovery: !found ? 'absent' : found.version === channel.version ? 'matched' : 'version-mismatch', localVersion: found?.version ?? null })
  }
  for (const channel of locals.values()) if (!peers?.has(channel.id)) entries.push({ ...channel, source: 'local-supplement', localDiscovery: 'local-only', localVersion: channel.version })
  if (entries.length > MAX_COUNT) throw Error('negotiated_channel_count_limit')
  entries.sort((a,b) => a.id.localeCompare(b.id))
  return {
    policy: peers ? 'server-primary' : 'awaiting-server-declaration',
    channels: entries.map(({id,version}) => ({id,version})), entries,
    serverChannelCount: peers?.size ?? 0,
    serverCompletedCount: entries.filter(e => e.source === 'server-declaration' && e.localDiscovery === 'absent').length,
    versionConflicts: entries.filter(e => e.localDiscovery === 'version-mismatch'),
    scope: 'channel negotiation only; codecs, Mod identities and behavior are separate'
  }
}
module.exports = { negotiateChannels }
