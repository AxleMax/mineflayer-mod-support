'use strict'

// The version-specific field meanings belong to this sample, outside the runtime.
const channel = 'waystones:network'
const known = 7
const cooldown = 9
const configId = 'waystones:common'

function installWaystonesScenario (runtime) {
  const evidence = { snapshotsHandled: 0, cooldownHandled: 0, configReads: 0,
    nonemptySnapshots: 0, indexedObjects: 0, added: 0, updated: 0, removed: 0 }
  runtime.registerModCodecHandler({
    channel, discriminator: known, id: 'waystones:known_waystones',
    onMessage (data, context) {
      if (typeof data.slot_0 !== 'string' || !Array.isArray(data.slot_1)) return false
      if (!data.slot_1.every(stone => typeof stone.slot_0 === 'string' &&
        typeof stone.slot_2 === 'string' && typeof stone.slot_5?.x === 'number')) return false
      if (context.getConfig(configId)?.propertyCount > 0) evidence.configReads++
      evidence.snapshotsHandled++
    }
  })
  runtime.registerModCodecHandler({
    channel, discriminator: cooldown, id: 'waystones:waystone_cooldown',
    onMessage (data, context) {
      if (typeof data.inventoryButtonCooldownUntil !== 'bigint' ||
          typeof data.warpStoneCooldownUntil !== 'bigint') return false
      if (context.getConfig(configId)?.propertyCount > 0) evidence.configReads++
      evidence.cooldownHandled++
    }
  })
  runtime.on('modDataObserved', event => {
    if (event.channel !== channel || event.discriminator !== known || !event.appliedToModRuntime) return
    const collection = runtime.modData.getCollection(channel, known, event.entityKey)
    if (collection.itemCount && collection.itemIds?.every(id =>
      runtime.modData.getCollectionItem(channel, known, event.entityKey, id)?.slot_0 === id)) {
      evidence.nonemptySnapshots++
      evidence.indexedObjects += collection.itemCount
    }
    for (const name of ['added', 'updated', 'removed']) evidence[name] += event.changes?.[name].length ?? 0
  })
  return evidence
}

function summarize (runtime, outcome, evidence, finished, stopReason, probe) {
  const config = runtime?.configMirror.getReport()
  const native = runtime?.nativeChannels.getReport()
  const fml3 = runtime?.fml3.getReport()
  const generic = native?.genericNetwork
  const checks = [
    ['fml3', fml3?.handshakeComplete === true],
    ['spawn', outcome.spawned],
    ['typed_config', config?.configs.some(entry => entry.id === configId && entry.roundTripExact)],
    ['node_handlers', evidence?.snapshotsHandled > 0 && evidence?.cooldownHandled > 0 &&
      evidence?.configReads > 0 && runtime?.modState.getApplied(channel, cooldown) !== null],
    ['nonempty_keyed_collection', evidence?.indexedObjects > 0]
  ]
  const errors = (generic?.counters.rejected ?? 0) + (generic?.codecHandlerErrors ?? 0) +
    (config?.counts.rejected ?? 0) + (runtime?.modState.getReport().counts.rejected ?? 0) +
    (runtime?.modData.getReport().counts.rejected ?? 0)
  const clean = !errors && !outcome.firstError && !outcome.kicked && stopReason !== 'connection_ended'
  checks.push(['clean_session', clean])
  if (probe) checks.push(['serverbound_request_response', probe.responseMatched])
  let failedStage = null
  const stages = checks.map(([stage, passed]) => {
    if (passed) return { stage, status: 'passed' }
    if (!finished || failedStage) return { stage, status: 'not_run' }
    failedStage = stage
    return { stage, status: 'failed' }
  })
  if (!probe) stages.push({ stage: 'serverbound_request_response', status: 'not_run', reason: 'no_read_only_endpoint_configured' })
  return {
    schema: 'mineflayer-mod-support/p32-e2e/v1',
    outcome: failedStage ? 'failed' : checks.every(([, passed]) => passed) ? 'passed' : 'pending',
    failedStage, stages, replies: fml3?.completionEvidence?.successfulReplies ?? 0,
    evidence: evidence || null, errors, serverboundActions: native?.transmit.messages ?? 0, probe: probe || null,
    serverEffectConfirmed: false
  }
}

module.exports = { installWaystonesScenario, summarize }
