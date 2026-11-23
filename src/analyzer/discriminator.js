'use strict'
// Conservative recognition of the exact Balm 7.3.44 counter pattern.
// Does not execute JVM bytecode or assert that a registration has run in production.
const { instructions } = require('./classfile')
const OWNER = 'net/blay09/mods/balm/forge/network/ForgeBalmNetworking'
const API = 'net/blay09/mods/balm/api/network/BalmNetworking'
const SYNC = 'net/blay09/mods/balm/api/network/SyncConfigMessage'

function includesCall (code, owner, name) {
  return code.some(x => x.member?.owner === owner && x.member?.name === name)
}
function isBranched (code) {
  return code.some(x => (x.op >= 0x99 && x.op <= 0xa8) || [0xaa, 0xab, 0xc6, 0xc7, 0xc8, 0xc9].includes(x.op))
}
function proveBalmCounter (classes) {
  const cls = classes.get(OWNER)
  if (!cls) return { proven: false, reason: 'ForgeBalmNetworking class is missing' }
  const code = name => {
    const m = cls.methods.find(x => x.name === name && x.code)
    return m ? instructions(cls, m) : []
  }
  const next = code('nextDiscriminator')
  const lambda = code('lambda$nextDiscriminator$0')
  const clientbound = code('registerClientboundPacket')
  const serverbound = code('registerServerboundPacket')
  const nextUsed = c => includesCall(c, OWNER, 'nextDiscriminator') &&
    c.some(x => x.member?.owner?.includes('/SimpleChannel') && x.member.name === 'registerMessage')
  const structural = next.length > 0 && lambda.length > 0 &&
    next.some(x => x.member?.owner === 'java/util/Map' && x.member.name === 'compute') &&
    next.some(x => x.member?.name === 'intValue') &&
    // absent key -> iconst_0, present key -> iconst_1 + iadd
    lambda.some(x => x.op === 0x03) && lambda.some(x => x.op === 0x04) &&
    lambda.some(x => x.op === 0x60) &&
    nextUsed(clientbound) && nextUsed(serverbound)
  const channels = classes.get('net/blay09/mods/balm/forge/network/NetworkChannels')
  // Follow the standard channel factory and Supplier callback, not a compiler's
  // private lambda name. The recognized wrapper maps a namespace to namespace:network.
  const factories = (channels?.methods || []).filter(m => m.code && m.descriptor === '(Ljava/lang/String;Ljava/lang/String;)Lnet/minecraftforge/network/simple/SimpleChannel;')
    .map(method => ({ method, code: instructions(channels, method) }))
    .filter(({method,code}) => (method.flags & 8) !== 0 && code.map(i=>i.op===0x13?0x12:i.op).join(',') === '187,89,43,18,183,77,44,186,42,186,42,186,184,176' &&
      code[0].className === 'net/minecraft/resources/ResourceLocation' && code[3].literal === 'network' && code[4].member?.owner === 'net/minecraft/resources/ResourceLocation' &&
      code[4].member.name === '<init>' && code[4].member.descriptor === '(Ljava/lang/String;Ljava/lang/String;)V' &&
      code[12].member?.owner === 'net/minecraftforge/network/NetworkRegistry' && code[12].member.name === 'newSimpleChannel' &&
      code[12].member.descriptor === '(Lnet/minecraft/resources/ResourceLocation;Ljava/util/function/Supplier;Ljava/util/function/Predicate;Ljava/util/function/Predicate;)Lnet/minecraftforge/network/simple/SimpleChannel;' &&
      code[7].descriptor === '()Ljava/util/function/Supplier;')
  const factory = factories.length === 1 ? factories[0] : null
  const supplier = factory?.code[7].lambda
  const supplierClass = supplier && classes.get(supplier.owner)
  const supplierMethod = supplierClass?.methods.find(m => m.name === supplier.name && m.descriptor === supplier.descriptor && m.code)
  const supplierCode = supplierMethod ? instructions(supplierClass, supplierMethod) : []
  const literalVersion = supplierCode.length === 2 && [0x12,0x13].includes(supplierCode[0].op) && supplierCode[1].op === 0xb0 &&
    typeof supplierCode[0].literal === 'string' && supplierCode[0].literal.length > 0 && supplierCode[0].literal.length <= 64 ? supplierCode[0].literal : null
  const channelPattern = Boolean(factory)
  return structural
    ? { proven: true, channelPattern: channelPattern ? 'namespace:network' : null,
      channelVersionDeclaration: literalVersion ? {version:literalVersion,policy:'local-supplier-and-exact-peer-version',factory:{owner:channels.thisClass,name:factory.method.name,descriptor:factory.method.descriptor},supplier:{owner:supplier.owner,name:supplier.name,descriptor:supplier.descriptor},clientBehaviorImplemented:false} : null,
      pattern: 'per-key map counter: first=0, subsequent=previous+1', registration: 'SimpleChannel.registerMessage', bytecodeOwner: OWNER, runtimeVerified: false }
    : { proven: false, reason: 'Balm registration/counter bytecode differs from recognized pattern' }
}

function applyPredictions (artifacts) {
  const archives = []
  const walk = a => { archives.push(a); for (const nested of a.nestedJars || []) if (nested.archive) walk(nested.archive) }
  artifacts.forEach(walk)
  const proof = archives.map(a => a.network?.counterProof).find(p => p?.proven)
  if (!proof) return { proven: false, reason: 'No recognized Balm counter implementation found' }
  const all = archives.flatMap(a => a.network?.registrations || [])
  // Only a single straight-line registration method can be ordered statically.
  const groups = new Map()
  for (const reg of all) {
    const namespace = reg.id.split(':')[0]
    if (!groups.has(namespace)) groups.set(namespace, [])
    groups.get(namespace).push(reg)
  }
  for (const [namespace, regs] of groups) {
    const sameMethod = regs.every(r => r.registrationClass === regs[0].registrationClass && r.registrationMethod === regs[0].registrationMethod)
    const linear = sameMethod && regs.every(r => r.registrationMethodUnbranched === true)
    const stableOrder = regs.every((r,i) => i === 0 || r.offset > regs[i - 1].offset)
    if (!linear || !stableOrder) continue
    for (const [i, reg] of regs.entries()) {
      reg.predictedDiscriminator = i
      if (proof.channelPattern === 'namespace:network') reg.predictedChannel = `${namespace}:network`
      reg.discriminatorEvidence = {
        status: 'static-prediction', namespace,
        basis: 'recognized Balm per-namespace counter and unbranched registration sequence',
        assumptions: [
          'No earlier or additional runtime registration for this namespace',
          'Observed initialization method executes exactly once in the identified order'
        ],
        runtimeVerified: false
      }
    }
  }
  return { ...proof, predictedRegistrations: all.filter(r => r.predictedDiscriminator != null).length }
}
module.exports = { proveBalmCounter, applyPredictions, isBranched }
