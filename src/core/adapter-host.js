'use strict'
const {matchAdapter,validateMatches}=require('./adapter-match')
const {compileMessageSchema}=require('../protocol/message-schema')

// One scoped installation point for data and protocol extensions. The context
// intentionally exposes no gameplay operation API or automatic Mod claim.
class AdapterHost {
  constructor (runtime) {
    this.runtime = runtime; this.entries = new Map(); this.closed = false; this.cleanupFailures = 0
    this.refresh=()=>{for(const entry of [...this.entries.values()]){
      if(!entry.active||!entry.matches)continue
      const match=matchAdapter(entry.matches,runtime);entry.reasons=match.reasons
      if(entry.status==='active'&&match.status!=='matched'){try{this._dispose(entry)}catch(error){runtime.emitWarning(error)}entry.status=match.status;this.entries.set(entry.id,entry)}
      else if(entry.status!=='active'&&match.status==='matched'){try{entry.activate()}catch(error){entry.status='failed';entry.reasons=[error.message];this.entries.set(entry.id,entry);runtime.emit('adapterActivationError',{id:entry.id,reason:error.message})}}
      else if(entry.status!=='active')entry.status=match.status
    }}
    for(const name of ['fml3Message','registryInstalled','protocolState'])runtime.on(name,this.refresh)
  }
  use (adapter) {
    const r = this.runtime
    if (this.closed || r.state === 'closed') throw new Error('adapter_host_closed')
    if (!adapter || adapter.apiVersion !== 1 || !/^[a-z0-9_.-]{1,128}$/.test(adapter.id || '') || typeof adapter.setup !== 'function') throw new Error('invalid_adapter_definition')
    if (this.entries.has(adapter.id)) throw new Error('duplicate_adapter:' + adapter.id)
    if (adapter.loaderProtocols && (!Array.isArray(adapter.loaderProtocols) || !adapter.loaderProtocols.includes(r.loaderProtocol.id))) throw new Error('adapter_loader_protocol_mismatch')
    if (adapter.minecraftVersions !== undefined && !Array.isArray(adapter.minecraftVersions)) throw new Error('invalid_adapter_minecraft_versions')
    validateMatches(adapter.matches)
    const entry = { id: adapter.id, versions: adapter.minecraftVersions && [...adapter.minecraftVersions], active: true, disposers: [],matches:adapter.matches&&structuredClone(adapter.matches),status:'waiting',reasons:[] }
    if (entry.versions && (!entry.versions.length || entry.versions.some(v => typeof v !== 'string'))) throw new Error('invalid_adapter_minecraft_versions')
    if (r.client?.version && entry.versions && !entry.versions.includes(r.client.version)) throw new Error('adapter_minecraft_version_mismatch')
    this.entries.set(entry.id, entry)
    const tracked = fn => (...args) => {
      if (!entry.active) throw new Error('adapter_scope_disposed')
      const dispose = fn(...args)
      let disposed = false
      const once = () => { if (disposed) return false; disposed = true; return dispose() }
      entry.disposers.push(once)
      return once
    }
    const context = Object.freeze({
      apiVersion: 1,
      loaderProtocol: r.loaderProtocol.id,
      defineItem: tracked((id, data) => r.contentDefinitions.register('item', id, data, 'adapter:' + entry.id)),
      defineEntity: tracked((id, data) => r.contentDefinitions.register('entity', id, data, 'adapter:' + entry.id)),
      defineBlock: tracked((id, data) => r.contentDefinitions.register('block', id, data, 'adapter:' + entry.id)),
      registerBlockCollision: tracked((id, provider) => r.blockCollisions.register(id, provider, 'adapter:' + entry.id)),
      defineMenu: tracked((id, data) => r.contentDefinitions.register('menu', id, data, 'adapter:' + entry.id)),
      registerMenuRules: tracked((id, configure) => r.menuRules.register(id, configure, 'adapter:' + entry.id)),
      registerProtocolCodec: tracked((...args) => r._loaderMethod('registerProtocolCodec', ...args)),
      registerExplicitCodec: tracked((...args) => r._loaderMethod('registerExplicitCodec', ...args)),
      registerNetwork: tracked(profile => r.registerModAdapter(profile)),
      registerChannel: tracked(profile => {
        const messages=profile.messages.map(message=>{
          const codec=message.schema?compileMessageSchema(message.schema,{version:r.client?.version||entry.versions?.[0]||'1.20.1'}):message.codec
          if(!codec)throw Error('message_schema_or_codec_required')
          return {...message,encode:codec.encode,decode:codec.decode,onMessage:message.onMessage||((data,context)=>r.emit('adapterMessage',{adapter:entry.id,name:message.name||null,data,...context}))}
        })
        return r._loaderMethod('registerChannel',{...profile,messages})
      }),
      registerCodecHandler: tracked(profile => r.registerModCodecHandler(profile)),
      onChannel: tracked((id, handler) => r.network.onChannel(id, handler)),
      on: tracked((event, handler) => { r.on(event, handler); return () => r.removeListener(event, handler) }),
      getRegistryId: (name, id) => r.registryMappings.getId(name, id),
      getRegistryName: (name, id) => r.registryMappings.getName(name, id),
      getConfig: id => r.configMirror?.get(id) || null,
      sendMessage: (...args) => { if (!entry.active) throw new Error('adapter_scope_disposed'); return r.sendModMessage(...args) },
      requestMessage: (...args) => { if (!entry.active) throw new Error('adapter_scope_disposed'); return r.requestModMessage(...args) }
    })
    entry.activate=()=>{try {
      const cleanup = adapter.setup(context)
      if (cleanup && typeof cleanup.then === 'function') cleanup.catch(error => r.emitWarning(error))
      if (cleanup !== undefined && typeof cleanup !== 'function') throw new Error('adapter_setup_must_be_synchronous_and_return_disposer')
      if (cleanup) entry.disposers.push(cleanup)
      entry.status='active'
    } catch (error) {
      try { this._dispose(entry) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'adapter_setup_and_cleanup_failed') }
      throw error
    }}
    const match=matchAdapter(entry.matches,r);entry.status=match.status==='matched'?'waiting':match.status;entry.reasons=match.reasons
    if(match.status==='matched')entry.activate()
    return () => this._dispose(entry)
  }
  _dispose (entry) {
    if (!entry.active) return this.entries.delete(entry.id)
    entry.active = false; this.entries.delete(entry.id)
    const errors = []
    for (const dispose of entry.disposers.reverse()) {
      try { dispose() } catch (error) { errors.push(error) }
    }
    entry.disposers.length = 0
    if (errors.length) {
      this.cleanupFailures += errors.length
      this.runtime.emit('adapterCleanupError', { id: entry.id, errorCount: errors.length })
      throw new AggregateError(errors, 'adapter_cleanup_failed:' + entry.id)
    }
    return true
  }
  validateVersion (version) {
    if (!version) return
    for (const entry of this.entries.values()) if (entry.versions && !entry.versions.includes(version)) throw new Error('adapter_minecraft_version_mismatch:' + entry.id)
  }
  destroy () {
    if (this.closed) return
    this.closed = true
    for(const name of ['fml3Message','registryInstalled','protocolState'])this.runtime.removeListener(name,this.refresh)
    for (const entry of [...this.entries.values()].reverse()) {
      try { this._dispose(entry) } catch (error) { this.runtime.emitWarning(error) }
    }
  }
  getReport () { return { apiVersion: 1, active: [...this.entries.values()].filter(e=>e.status==='active').map(e=>e.id),entries:[...this.entries.values()].map(e=>({id:e.id,status:e.status,reasons:[...e.reasons],matches:e.matches||null})), closed: this.closed, cleanupFailures: this.cleanupFailures } }
}
module.exports = { AdapterHost }
