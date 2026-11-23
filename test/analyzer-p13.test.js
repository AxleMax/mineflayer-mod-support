'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { analyzeJars } = require('../src/analyzer/mod-jar')
const { createCompatibilityManifest } = require('../src/analyzer/compatibility-manifest')
const { applyPredictions } = require('../src/analyzer/discriminator')

const jars = [process.env.MMR_BALM_JAR, process.env.MMR_WAYSTONES_JAR]
const runFixture = jars.every(Boolean)

test('manifest refuses an invalid analysis report', () => {
  assert.throws(() => createCompatibilityManifest({}), /JAR analysis report/)
})
test('manifest never advertises mod compatibility from static guesses', () => {
  const report = {
    schema: 'mineflayer-mod-support/jar-analysis/v1',
    discoveredMods: [{ id: 'a' }],
    artifacts: [{ source: 'a.jar', sha256: 'abcd', network: { registrations: [
      { id: 'a:test', direction: 'clientbound', className: 'Example', predictedDiscriminator: 0, codec: { status: 'candidate-codec', schema: [] } }
    ] }, nestedJars: [] }]
  }
  const manifest = createCompatibilityManifest(report)
  assert.equal(manifest.runtime.enabled, false)
  assert.equal(manifest.runtime.canSendModPayloads, false)
  assert.equal(manifest.messages[0].numericDiscriminator, null)
  assert.equal(manifest.messages[0].predictedDiscriminator, 0)
  assert.equal(manifest.messages[0].runtimeReady, false)
  assert.equal(manifest.messages[0].codec.verifiedAgainstServer, false)
})
test('counter proof is absent when Balm code is not available', () => {
  const a = { network: { registrations: [{ id: 'a:foo', registrationMethodUnbranched: true, registrationClass: 'A', registrationMethod: 'init', offset: 12 }] }, nestedJars: [] }
  const result = applyPredictions([a])
  assert.equal(result.proven, false)
  assert.equal(a.network.registrations[0].predictedDiscriminator, undefined)
})
test('cross-class register groups refuse non-linear registrations', () => {
  const a = { network: { counterProof: { proven: true }, registrations: [
    { id:'x:a', registrationClass:'A', registrationMethod:'init', registrationMethodUnbranched:true, offset:5 },
    { id:'x:b', registrationClass:'A', registrationMethod:'different', registrationMethodUnbranched:true, offset:10 }
  ] }, nestedJars: [] }
  applyPredictions([a])
  assert.equal(a.network.registrations[0].predictedDiscriminator, undefined)
})

test('Balm / Waystones JAR: numeric prediction and cross-class evidence', { skip: !runFixture }, () => {
  const report = analyzeJars(jars)
  assert.equal(report.discriminatorProof.proven, true)
  assert.equal(report.summary.predictedDiscriminators, 12)
  assert.equal(report.summary.crossClassCodecs, 3)
  const regs = report.artifacts[1].network.registrations
  assert.deepEqual(regs.map(r => r.predictedDiscriminator), Array.from({ length:11 }, (_, i) => i))
  assert.ok(regs.every(r => r.predictedChannel === 'waystones:network'))
  assert.ok(regs.every(r => r.numericDiscriminator === null && r.discriminatorEvidence.runtimeVerified === false))
  const update = regs.find(r => r.id === 'waystones:waystone_update')
  const known = regs.find(r => r.id === 'waystones:known_waystones')
  assert.equal(update.codec.status, 'unresolved')
  assert.equal(known.codec.status, 'unresolved')
  assert.equal(update.codec.callGraph.encode.steps[0].target.method, 'write')
  assert.equal(update.codec.callGraph.decode.steps[0].target.method, 'read')
  assert.ok(update.codec.callGraph.encode.steps[0].target.steps.some(s => s.type === 'blockpos'))
  assert.equal(known.codec.callGraph.encode.hasBranch, true)
  assert.ok(known.codec.callGraph.encode.steps.some(s => s.kind === 'static-call' && s.target.method === 'write'))
  const manifest = createCompatibilityManifest(report)
  assert.equal(manifest.messages.length,12)
  assert.equal(manifest.runtime.canJoinForgeAsModded,false)
})
