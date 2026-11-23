'use strict'

// Purely observational coverage measurement. JAR metadata cannot prove that
// any mod's network handler or Java-side state transition was executed.
function evaluateChannelCoverage (messages, dispatcher) {
  const channels = new Map()
  for (const msg of messages || []) {
    if (typeof msg.predictedChannel !== 'string') continue
    const name = msg.predictedChannel
    if (!channels.has(name)) channels.set(name, { channel: name, total: 0, clientbound: 0, serverbound: 0,
      candidateDecoders: 0, structuralDecoders: 0, observedWireSamples: 0, unresolved: 0, predictedIndices: 0, runtimeVerifiedIndices: 0,
      handledClientbound: 0, blockers: [], canAdvertise: false })
    const entry = channels.get(name)
    entry.total++
    if (msg.direction === 'clientbound') entry.clientbound++
    if (msg.direction === 'serverbound') entry.serverbound++
    if (msg.predictedDiscriminator != null) entry.predictedIndices++
    if (!['candidate-codec', 'structural-candidate'].includes(msg.codecStatus)) entry.unresolved++
    if (msg.direction === 'clientbound' && msg.codecStatus === 'candidate-codec' &&
        dispatcher.candidates.has(name + '\u0000' + msg.predictedDiscriminator)) entry.candidateDecoders++
    if (msg.direction === 'clientbound' && msg.codecStatus === 'structural-candidate' &&
        dispatcher.candidates.has(name + '\u0000' + msg.predictedDiscriminator)) entry.structuralDecoders++
    const wire = dispatcher.wireMatches.get(name + '\u0000' + msg.predictedDiscriminator)
    if (wire) entry.observedWireSamples += wire.exact
    if (dispatcher.handlers.has(name + '\u0000' + msg.predictedDiscriminator)) entry.handledClientbound++
  }
  const report = []
  for (const entry of channels.values()) {
    // Stronger than "all byte layouts parsed": don't silently promote a
    // channel lacking business logic, registry application and server oracle.
    if (entry.unresolved) entry.blockers.push('unresolved_codec_or_handler')
    if (entry.predictedIndices !== entry.total || entry.runtimeVerifiedIndices !== entry.total) entry.blockers.push('discriminators_not_runtime_verified')
    if (entry.candidateDecoders || entry.structuralDecoders) entry.blockers.push('candidate_decoders_are_observation_only')
    entry.blockers.push('mod_client_behavior_not_implemented', 'registry_sync_not_applied', 'wire_oracle_not_verified')
    report.push(entry)
  }
  return report.sort((a, b) => a.channel.localeCompare(b.channel))
}
module.exports = { evaluateChannelCoverage }
