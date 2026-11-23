'use strict'
// Offline-only artifact. This is deliberately NOT an injectable Forge client
// identity: no client Mod presence, channel compatibility or codec compliance
// is advertised based on static analysis alone.
function createCompatibilityManifest (report) {
  if (report?.schema !== 'mineflayer-mod-support/jar-analysis/v1' || !Array.isArray(report.artifacts)) throw new Error('Expected JAR analysis report')
  const items = []
  function visit (artifact) {
    for (const r of artifact.network?.registrations || []) {
      items.push({
        id: r.id,
        source: artifact.source,
        direction: r.direction,
        messageClass: r.className,
        predictedDiscriminator: r.predictedDiscriminator ?? null,
        predictedChannel: r.predictedChannel || null,
        numericDiscriminator: null,
        discriminatorEvidence: r.discriminatorEvidence || null,
        codec: {
          status: r.codec.status,
          candidateSchema: r.codec.status === 'candidate-codec' ? r.codec.schema : null,
          crossClassEvidence: r.codec.callGraph || null,
          structuralInference: r.codec.inference || null,
          verifiedAgainstServer: false
        },
        runtimeReady: false
      })
    }
    for (const nested of artifact.nestedJars || []) if (nested.archive) visit(nested.archive)
  }
  report.artifacts.forEach(visit)
  return {
    schema: 'mineflayer-mod-support/compatibility-manifest/v1',
    toolVersion: '0.0.9',
    execution: 'node-only',
    generatedFrom: report.artifacts.map(a => ({ file: a.source, sha256: a.sha256 })),
    dependencies: report.discoveredMods,
    messages: items,
    verifiedAgainstServer: false,
    runtime: { enabled: false, canAdvertiseMods: false, canSendModPayloads: false, canJoinForgeAsModded: false },
    caveats: [
      'Predicted discriminators are not confirmed runtime IDs',
      'Static candidate schemas require trusted wire-format oracle tests',
      'Mod initialization, registry sync, and client-side Java behavior are not executed',
      'This manifest is diagnostic metadata only, not an FML handshake reply'
    ]
  }
}
module.exports = { createCompatibilityManifest }
