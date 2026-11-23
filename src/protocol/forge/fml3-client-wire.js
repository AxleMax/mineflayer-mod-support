'use strict'

const { WireReader, WireWriter, MAX_COUNT } = require('./wire')

// Forge 1.20.1 HandshakeMessages.C2SModListReply, discriminator 2:
// Mod IDs; (channel identifier, version) pairs; (registry identifier, marker) pairs.
// The outer LoginWrapper envelope is separate and carries fml:handshake.
// This module NEVER generates Mod identities from static JAR metadata.
function validateReply (reply) {
  if (!reply || typeof reply !== 'object') throw new Error('invalid_client_mod_list_reply')
  const mods = reply.mods
  const channels = reply.channels
  const registries = reply.registries
  if (!Array.isArray(mods) || !Array.isArray(channels) || !Array.isArray(registries) ||
      mods.length > MAX_COUNT || channels.length > MAX_COUNT || registries.length > MAX_COUNT) throw new Error('invalid_client_mod_list_shape')
  const checkUnique = (values, kind) => {
    const unique = new Set(values)
    if (unique.size !== values.length) throw new Error('duplicate_client_' + kind)
  }
  checkUnique(mods, 'mod')
  checkUnique(channels.map(x => x?.id), 'channel')
  checkUnique(registries.map(x => x?.id), 'registry')
  return { mods, channels, registries }
}
function encodeC2SModListReply (input) {
  const { mods, channels, registries } = validateReply(input)
  const w = new WireWriter().byte(2).count(mods.length)
  for (const id of mods) w.modId(id)
  w.count(channels.length)
  for (const entry of channels) {
    w.identifier(entry.id).string(entry.version, 256)
  }
  w.count(registries.length)
  for (const entry of registries) {
    w.identifier(entry.id).string(entry.marker, 256)
  }
  return w.finish()
}
function decodeC2SModListReply (buffer) {
  const r = new WireReader(buffer)
  if (r.byte() !== 2) throw new Error('not_c2s_mod_list_reply')
  const mods = []; for (let n = r.count(); n > 0; n--) mods.push(r.modId())
  const channels = []; for (let n = r.count(); n > 0; n--) channels.push({ id: r.identifier(), version: r.string(256) })
  const registries = []; for (let n = r.count(); n > 0; n--) registries.push({ id: r.identifier(), marker: r.string(256) })
  r.end()
  return validateReply({ mods, channels, registries })
}
function wrapFml3Reply (inner) {
  if (!Buffer.isBuffer(inner) || inner.length === 0) throw new Error('invalid_fml3_inner_packet')
  return new WireWriter().identifier('fml:handshake').varInt(inner.length).bytes(inner).finish()
}
function unwrapFml3Reply (buffer) {
  const r = new WireReader(buffer)
  if (r.identifier() !== 'fml:handshake') throw new Error('invalid_fml3_reply_channel')
  const inner = r.bytes(r.varInt())
  r.end()
  return inner
}
function encodeFml3Acknowledge () { return wrapFml3Reply(Buffer.from([99])) }

module.exports = { encodeC2SModListReply, decodeC2SModListReply, wrapFml3Reply, unwrapFml3Reply, encodeFml3Acknowledge }
