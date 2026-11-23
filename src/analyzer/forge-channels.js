'use strict'
// Bounded symbolic analysis only. Never execute Java or infer support from discovery.
const { instructions } = require('./classfile')
const SIMPLE = 'net/minecraftforge/network/simple/SimpleChannel'
const BUILDER = 'net/minecraftforge/network/NetworkRegistry$ChannelBuilder'
const UNKNOWN = Object.freeze({ unresolved: true })
function signature (descriptor) {
  const end = descriptor.indexOf(')')
  return { args: descriptor.slice(1, end).match(/\[*L[^;]+;|\[*[ZBCSIJFD]/g) || [], result: descriptor.slice(end + 1) }
}
function discoverForgeChannels (classes, options = {}) {
  const methods = new Map(); const diagnostics = []; const registrations = []; const channels = []
  const initializing = new Set()
  const serviceBindings = new Map()
  const key = (owner, name, descriptor) => owner + '.' + name + descriptor
  for (const cls of classes.values()) for (const method of cls.methods) if (method.code) {
    methods.set(key(cls.thisClass, method.name, method.descriptor), { cls, method, code: instructions(cls, method) })
  }
  function resolve (owner, name, descriptor) {
    const service=owner
    const seen = new Set()
    while (owner && !seen.has(owner)) {
      seen.add(owner)
      const value = methods.get(key(owner, name, descriptor)); if (value) return value
      owner = classes.get(owner)?.superClass
    }
    const providers=options.serviceProviders?.[service]
    if(providers?.length===1 && providers[0]!==service && isSubtype(providers[0],service)) {
      const target=resolve(providers[0],name,descriptor)
      if(target)serviceBindings.set(service,{interface:service,provider:providers[0]})
      return target
    }
  }
  function isSubtype (owner, expected, seen = new Set()) {
    if (owner === expected) return true
    if (!owner || seen.has(owner)) return false
    seen.add(owner)
    const cls = classes.get(owner)
    return [cls?.superClass, ...(cls?.interfaces || [])].some(parent => isSubtype(parent, expected, seen))
  }
  const isRoot = m => m && ((m.owner === SIMPLE && ['registerMessage', 'messageBuilder'].includes(m.name)) ||
    (m.owner === BUILDER && ['named', 'simpleChannel'].includes(m.name)) ||
    (m.owner === 'net/minecraftforge/network/NetworkRegistry' && m.name === 'newSimpleChannel'))
  const apiSites = []
  for (const entry of methods.values()) for (const x of entry.code) if (x.member && [SIMPLE, BUILDER, SIMPLE + '$MessageBuilder'].includes(x.member.owner)) {
    apiSites.push({ owner: entry.cls.thisClass, method: entry.method.name, offset: x.offset, api: x.member })
  }
  const relevant = new Set()
  for (const [id, entry] of methods) if (entry.code.some(x => isRoot(x.member))) relevant.add(id)
  for (let changed = true; changed;) {
    changed = false
    for (const [id, entry] of methods) if (!relevant.has(id) && entry.code.some(x => {
      const m = x.member; const target = m && resolve(m.owner, m.name, m.descriptor)
      return target && relevant.has(key(target.cls.thisClass, target.method.name, target.method.descriptor))
    })) { relevant.add(id); changed = true }
  }
  function recordRegistration (callArgs, object, chain, builderProperties = null) {
    const [discriminator, packet, encoder, decoder, handler, direction] = callArgs
    const bind = callback => {
      const ref = callback?.callback
      const target = ref && resolve(isSubtype(packet?.className, ref.owner) ? packet.className : ref.owner, ref.name, ref.descriptor)
      return target ? { ...callback, resolvedCallback: { owner: target.cls.thisClass, name: target.method.name, descriptor: target.method.descriptor } } : callback
    }
    if (packet?.className) registrations.push({ className: packet.className, discriminator, numericDiscriminator: typeof discriminator === 'number' ? discriminator : null,
      channel: object, encoder: bind(encoder), decoder: bind(decoder), handler: bind(handler), direction: direction?.optional?.field?.name || direction?.field?.name || (callArgs.length===5 ? 'UNRESTRICTED' : null), trace: chain,
      status: 'discovered', codecStatus: 'not-analyzed', handlerStatus: 'not-implemented', runtimeVerified: false, canAdvertise: false,
      unresolved: [ ...(typeof discriminator === 'number' ? [] : ['discriminator-initialization-and-lifecycle-not-proven']), 'channel-identity-and-version-not-proven' ] })

    if (builderProperties && registrations.at(-1)?.trace === chain) registrations.at(-1).builderProperties = builderProperties
  }
  function evaluate (entry, receiver, args, trace, depth = 0, heap = new Map(), budget = { remaining: 30000 }, pure = false) {
    if (depth > 10) throw new Error('wrapper-depth-limit')
    const { cls, method, code } = entry
    const locals = []; const stack = []; const pop = () => { if (!stack.length) throw new Error('unsupported-stack-shape'); return stack.pop() }
    let slot = method.flags & 8 ? 0 : 1
    if (slot) locals[0] = receiver
    signature(method.descriptor).args.forEach((type, i) => { locals[slot] = args[i] ?? UNKNOWN; slot += ['J','D'].includes(type) ? 2 : 1 })
    for (let pc = 0; pc < code.length; pc++) {
      const x = code[pc]
      if (--budget.remaining < 0) throw new Error('symbolic-instruction-limit')
      const op = x.op
      if (!pure && ((op >= 0x99 && op <= 0xab) || [0xc8,0xc9].includes(op))) throw new Error('conditional-or-loop-registration')
      if (op === 0xc6 || op === 0xc7) {
        const value=pop()
        if(value!==null && !value?.objectClass && !value?.channel) throw new Error('unknown-null-branch')
        if((op===0xc6)===(value===null)) {
          const target=code.findIndex(i=>i.offset===x.target)
          if(target<=pc)throw new Error('registration-branch-loop')
          pc=target-1
        }
        continue
      }
      if (pure && op >= 0x99 && op <= 0x9e) {
        const value = pop(); if (typeof value !== 'number' && typeof value !== 'boolean') throw new Error('unknown-pure-branch')
        const n = Number(value); const take = [n === 0,n !== 0,n < 0,n >= 0,n > 0,n <= 0][op-0x99]
        if (take) { const target = code.findIndex(i => i.offset === x.target); if (target <= pc) throw new Error('pure-branch-loop'); pc = target-1 }
        continue
      }
      if (op === 0) continue
      if (op === 1) { stack.push(null); continue }
      if (op >= 2 && op <= 8) { stack.push(op - 3); continue }
      if ([0x10,0x11].includes(op)) { stack.push(x.number); continue }
      if ([0x12,0x13].includes(op)) { stack.push(x.literal ?? UNKNOWN); continue }
      if ([0x15,0x19].includes(op)) { stack.push(locals[x.localIndex] ?? UNKNOWN); continue }
      if ((op >= 0x1a && op <= 0x1d) || (op >= 0x2a && op <= 0x2d)) { stack.push(locals[op >= 0x2a ? op - 0x2a : op - 0x1a] ?? UNKNOWN); continue }
      if ([0x36,0x3a].includes(op)) { locals[x.localIndex] = pop(); continue }
      if ((op >= 0x3b && op <= 0x3e) || (op >= 0x4b && op <= 0x4e)) { locals[op >= 0x4b ? op - 0x4b : op - 0x3b] = pop(); continue }
      if (op === 0x57) { pop(); continue }
      if (op === 0x59) { const a = pop(); stack.push(a,a); continue }
      if (op === 0x5a) { const a = pop(); const b = pop(); stack.push(a,b,a); continue }
      if (op === 0x60) {
        const b = pop(); const a = pop()
        stack.push(typeof a === 'number' && typeof b === 'number' ? a+b
          : typeof b === 'number' ? { base: a?.base || a, increment: (a?.increment || 0)+b } : UNKNOWN)
        continue
      }
      if (op === 0x84) { const value=locals[x.localIndex]; locals[x.localIndex] = Number.isInteger(value) ? (value+x.increment)|0 : UNKNOWN; continue }
      if (op === 0xbb) { stack.push({ objectClass: x.className }); continue }
      if (op === 0xc0) continue
      if (op === 0xb2) {
        const fieldKey=JSON.stringify({field:x.member})
        if(!heap.has(fieldKey) && !initializing.has(x.member.owner) && method.name!=='<clinit>') {
          const initializer=resolve(x.member.owner,'<clinit>','()V')
          if(initializer) {
            initializing.add(x.member.owner)
            const copy=new Map(heap),nr=registrations.length,nc=channels.length
            try { evaluate(initializer,null,[],trace,depth+1,copy,budget); for(const [k,v] of copy)heap.set(k,v) } catch {} finally { initializing.delete(x.member.owner);registrations.length=nr;channels.length=nc }
          }
        }
        stack.push(heap.has(fieldKey)?heap.get(fieldKey):{field:x.member});continue
      }
      if (op === 0xb4) {
        const object = pop(); const field = { field: x.member, object }
        let value = heap.get(JSON.stringify(field))
        // Resolve a uniquely written external field through its self-contained
        // constructor assignment; never initialize the registration counter here.
        if (value === undefined && !object?.objectClass && depth < 8) {
          const writers = [...methods.values()].flatMap(e => e.code.filter(i => i.op === 0xb5 && i.member?.owner === x.member.owner && i.member.name === x.member.name).map(i => ({ e, i })))
          if (writers.length === 1) {
            const { e, i } = writers[0]; const end = e.code.indexOf(i)
            const begin = e.code.slice(0,end).findLastIndex(i => i.op === 0x2a)
            if (begin >= 0) {
              const owner = { objectClass: e.cls.thisClass }
              evaluate({ ...e, code: e.code.slice(begin,end+1) }, owner, [], trace, depth+1, heap, budget)
              value = heap.get(JSON.stringify({ field: x.member, object: owner }))
            }
          }
        }
        stack.push(value ?? field); continue
      }
      if (op === 0xb3) { const value = pop(); heap.set(JSON.stringify({ field: x.member }), value); continue }
      if (op === 0xb5) { const value = pop(); const object = pop(); heap.set(JSON.stringify({ field: x.member, object }), value); continue }
      if (op === 0xba) {
        if (!x.descriptor) throw new Error('unresolved-invokedynamic')
        const captures = signature(x.descriptor).args.map(() => pop()).reverse()
        if (x.stringConcat) {
          if (captures.some(v => !['string','number','boolean'].includes(typeof v))) throw new Error('unknown-string-concat')
          let arg = 0; let constant = 0
          stack.push(x.stringConcat.recipe.replace(/[\u0001\u0002]/g, marker => String(marker === '\u0001' ? captures[arg++] : x.stringConcat.constants[constant++])))
        } else stack.push({ callback: x.lambda || null, captures })
        continue
      }
      if ([0xac,0xb0].includes(op)) return pop()
      if (op === 0xb1) return UNKNOWN
      if (![0xb6,0xb7,0xb8,0xb9].includes(op)) throw new Error('unsupported-opcode-' + op.toString(16))
      const m = x.member; const sig = signature(m.descriptor)
      const callArgs = sig.args.map(() => pop()).reverse(); const object = op === 0xb8 ? null : pop()
      const location = { owner: cls.thisClass, method: method.name, descriptor: method.descriptor, offset: x.offset }
      const chain = [...trace, location]; let result = { call: m, args: callArgs, receiver: object }
      if (op === 0xb7 && m.name === '<init>' && m.owner === 'net/minecraft/resources/ResourceLocation') {
        if (callArgs.every(a => typeof a === 'string')) object.resourceLocation = callArgs.length === 2 ? callArgs.join(':') : callArgs[0]
      }
      if (m.owner === SIMPLE && m.name === 'registerMessage' && sig.args[0] === 'I' && sig.args[1] === 'Ljava/lang/Class;') {
        recordRegistration(callArgs, object, chain)
      } else if (m.owner === SIMPLE && m.name === 'messageBuilder' && sig.args[0] === 'Ljava/lang/Class;' && sig.args[1] === 'I') {
        result = { messageBuilder: true, channel: object, packet: callArgs[0], discriminator: callArgs[1], direction: callArgs[2], properties: {} }
      } else if (m.owner === SIMPLE + '$MessageBuilder' && object?.messageBuilder) {
        if (m.name === 'add') {
          recordRegistration([object.discriminator,object.packet,object.encoder,object.decoder,object.handler,object.direction],object.channel,chain,object.properties)
        } else if (['encoder','decoder'].includes(m.name)) { object[m.name] = callArgs[0]; result = object }
        else if (['consumerNetworkThread','consumerMainThread'].includes(m.name)) { object.handler = callArgs[0]; object.properties.consumerThread = m.name; result = object }
        else { object.properties[m.name] = callArgs; result = object }
      } else if (m.owner === BUILDER && m.name === 'named') result = { builder: true, name: callArgs[0] }
      else if (m.owner === BUILDER && m.name === 'simpleChannel') { result = { channel: object }; channels.push({ ...result, trace: chain, canAdvertise: false }) }
      else if (m.owner === BUILDER) result = { ...object, [m.name]: callArgs[0] }
      else if (m.owner === 'net/minecraftforge/network/NetworkRegistry' && m.name === 'newSimpleChannel') {
        result = { channel: { name: callArgs[0], networkProtocolVersion: callArgs[1], clientAcceptedVersions: callArgs[2], serverAcceptedVersions: callArgs[3] } }
        channels.push({ ...result, trace: chain, canAdvertise: false })
      } else if (m.owner === 'java/util/Optional' && ['of','ofNullable'].includes(m.name) && callArgs[0]!==null) result = { optional: callArgs[0] }
      else if (m.owner === 'java/lang/Integer' && m.name === 'toString' && m.descriptor === '(I)Ljava/lang/String;' && Number.isInteger(callArgs[0])) result=String(callArgs[0])
      else if (m.owner === 'java/util/ServiceLoader' && m.name === 'load' && m.descriptor==='(Ljava/lang/Class;)Ljava/util/ServiceLoader;' && callArgs[0]?.className) result={service:callArgs[0].className}
      else if (m.owner === 'java/util/ServiceLoader' && m.name === 'findFirst' && object?.service) {
        const providers=options.serviceProviders?.[object.service]
        if(providers?.length===1 && isSubtype(providers[0],object.service)) {
          serviceBindings.set(object.service,{interface:object.service,provider:providers[0]})
          result={optional:{objectClass:providers[0]}}
        }
      }
      else if (m.owner === 'java/util/Optional' && ['orElseThrow','get'].includes(m.name) && object?.optional) result=object.optional
      else if (m.owner === 'java/util/Objects' && m.name === 'requireNonNull') result = callArgs[0]
      else if (m.owner === 'net/minecraftforge/fml/ModLoadingContext' && m.name === 'get') result = {
        loadingContext: true, activeModId: method.name === '<init>' ? cls.annotations?.find(a => a.type === 'Lnet/minecraftforge/fml/common/Mod;')?.values.value : null }
      else if (m.owner === 'net/minecraftforge/fml/ModLoadingContext' && m.name === 'getActiveContainer' && object?.loadingContext && object.activeModId) {
        const mod = options.mods?.find(mod => mod.id === object.activeModId)
        if (mod) result = { modContainerVersion: mod.version }
      }
      else if (m.owner === 'net/minecraftforge/fml/ModContainer' && m.name === 'getModInfo' && object?.modContainerVersion) result = { modInfoVersion: object.modContainerVersion }
      else if (m.owner === 'net/minecraftforge/forgespi/language/IModInfo' && m.name === 'getVersion' && object?.modInfoVersion) result = { artifactVersion: object.modInfoVersion }
      else if (m.owner === 'org/apache/maven/artifact/versioning/ArtifactVersion' && object?.artifactVersion && ['getMajorVersion','getMinorVersion','getIncrementalVersion'].includes(m.name)) {
        const parts = /^(\d+)\.(\d+)\.(\d+)(?:[.-].*)?$/.exec(object.artifactVersion)
        if (parts) result = Number(parts[['getMajorVersion','getMinorVersion','getIncrementalVersion'].indexOf(m.name)+1])
      }
      else {
        // Resolve overrides on the concrete receiver before walking superclass methods.
        const target = resolve(op === 0xb7 ? m.owner : object?.objectClass || m.owner, m.name, m.descriptor)
        if (target && (relevant.has(key(target.cls.thisClass, target.method.name, target.method.descriptor)) ||
            target.code.some(i=>i.member?.owner==='java/util/ServiceLoader' && i.member.name==='load') ||
            ['Lnet/minecraftforge/network/simple/SimpleChannel;', 'Lnet/minecraft/resources/ResourceLocation;', 'Ljava/lang/String;'].includes(sig.result) ||
            (m.name === '<init>' && isSubtype(object?.objectClass, m.owner)))) result = evaluate(target, object, callArgs, chain, depth+1, heap, budget, sig.result === 'Ljava/lang/String;')
      }
      if (sig.result !== 'V') stack.push(result)
    }
    return UNKNOWN
  }
  // Collect each concrete registration sequence; symbolic wrappers alone cannot supply packet classes.
  for (const id of relevant) {
    const entry = methods.get(id)
    if (!entry.code.some(x => x.literal?.className) && !entry.code.some(x => isRoot(x.member) && x.member.owner !== SIMPLE)) continue
    const before = registrations.length; const channelBefore = channels.length
    try {
      const object = { objectClass: entry.cls.thisClass }; const heap = new Map()
      evaluate(entry, object, [], [], 0, heap)
    } catch (error) {
      registrations.length = before; channels.length = channelBefore
      diagnostics.push({ owner: entry.cls.thisClass, method: entry.method.name, descriptor: entry.method.descriptor, reason: error.message })
    }
  }
  const constructorContexts = []
  for (const owner of new Set(registrations.map(r => r.trace[0].owner))) {
    const entry = resolve(owner, '<init>', '()V')
    if (!entry) continue
    const heap = new Map(); const before = registrations.length; const channelBefore = channels.length
    try {
      evaluate(entry, { objectClass: owner }, [], [], 0, heap)
      constructorContexts.push({ owner, descriptor: '()V', fields: [...heap].map(([field,value]) => ({ field: JSON.parse(field), value })), runtimeVerified: false })
    } catch (error) { diagnostics.push({ owner, method: '<init>', reason: error.message }) }
    registrations.length = before; channels.length = channelBefore
  }
  for (const registration of registrations) {
    const context = constructorContexts.find(c => c.owner === registration.trace[0].owner)
    const lookup = field => context?.fields.find(f => JSON.stringify(f.field) === JSON.stringify(field))?.value
    registration.channelBinding = registration.channel?.channel ? registration.channel : lookup(registration.channel) || null
    const binding = registration.channelBinding?.channel
    if (binding) {
      const supplier = binding.networkProtocolVersion
      const callback = supplier?.callback
      const target = callback && resolve(callback.owner, callback.name, callback.descriptor)
      let version = null
      if (target) {
        try { version = evaluate(target, null, supplier.captures, [], 0, new Map(), { remaining: 1000 }, true) } catch {}
      }
      const equalsVersion = predicate => predicate?.callback?.owner === 'java/lang/String' && predicate.callback.name === 'equals' && predicate.captures?.[0] === version
      if (typeof version === 'string' && version.length > 0 && version.length <= 64 && equalsVersion(binding.clientAcceptedVersions) && equalsVersion(binding.serverAcceptedVersions)) {
        registration.channelIdentity = { id: binding.name?.resourceLocation, version, policy: 'exact-equality', evidence: 'constructor-supplier-and-both-version-predicates' }
      }
    }
    const initial = Number.isInteger(registration.discriminator) ? registration.discriminator : lookup(registration.discriminator?.base || registration.discriminator)
    registration.constructorScopedDiscriminator = Number.isInteger(initial) ? initial + (registration.discriminator?.increment || 0) : null
    registration.lifecycleStatus = 'entry-invocation-count-not-proven'
    const first = registration.trace[0]
    registration.entryCallSites = [...methods.values()].flatMap(entry => entry.code.filter(i => i.member &&
      i.member.owner === first.owner && i.member.name === first.method && i.member.descriptor === first.descriptor)
      .map(i => ({ owner: entry.cls.thisClass, method: entry.method.name, descriptor: entry.method.descriptor, offset: i.offset })))
    if (registration.entryCallSites.length === 1 && registration.entryCallSites[0].descriptor === '(Lnet/minecraftforge/fml/event/lifecycle/FMLCommonSetupEvent;)V') {
      registration.lifecycleStatus = 'single-static-call-in-forge-common-setup;reflection-not-analyzed'
    }
  }
  const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()]
  return { api: 'forge-1.20.1/SimpleChannel', registrations: unique(registrations), channels: unique(channels), constructorContexts, apiSites, diagnostics, serviceBindings:[...serviceBindings.values()], canAdvertise: false }
}
module.exports = { discoverForgeChannels, signature }
