'use strict'
const semver=require('semver')
function matchAdapter(matches,runtime){
  if(!matches)return {status:'matched',reasons:[]}
  const server=runtime.fml3?.getReport().server
  if(!runtime.fml3?.modList)return {status:'waiting',reasons:['server-declaration-not-observed']}
  const reasons=[]
  for(const [id,range]of Object.entries(matches.mods||{})){
    const mod=server.mods.find(m=>m.id===id)
    if(!mod)reasons.push('missing-mod:'+id)
    else if(mod.version!==range&&(!semver.valid(mod.version)||!semver.satisfies(mod.version,range)))reasons.push('mod-version-mismatch:'+id)
  }
  for(const [id,version]of Object.entries(matches.channels||{})){
    const channel=server.channels.find(c=>c.id===id)
    if(!channel)reasons.push('missing-channel:'+id)
    else if(channel.version!==version)reasons.push('channel-version-mismatch:'+id)
  }
  let pending=false
  for(const [registry,names]of Object.entries(matches.registries||{}))for(const name of names){
    if(runtime.registryMappings.getId(registry,name)==null){
      if(runtime.protocol.state!=='play')pending=true
      else reasons.push('missing-registry-entry:'+registry+':'+name)
    }
  }
  if(matches.jarSha256?.length){const hashes=runtime.compatibility.analysisHashes||[];if(!matches.jarSha256.every(hash=>hashes.includes(hash)))reasons.push('jar-fingerprint-mismatch')}
  return {status:reasons.length?'mismatch':pending?'waiting':'matched',reasons}
}
function validateMatches(matches){
  if(matches===undefined)return
  if(!matches||typeof matches!=='object'||Array.isArray(matches)||Object.keys(matches).some(k=>!['mods','channels','registries','jarSha256'].includes(k)))throw Error('invalid_adapter_matches')
  for(const key of ['mods','channels','registries'])if(matches[key]!==undefined&&(!matches[key]||typeof matches[key]!=='object'||Array.isArray(matches[key])))throw Error('invalid_adapter_matches:'+key)
  for(const [id,range]of Object.entries(matches.mods||{}))if(!/^[a-z0-9_.-]+$/.test(id)||typeof range!=='string'||!range)throw Error('invalid_adapter_mod_match')
  for(const [id,version]of Object.entries(matches.channels||{}))if(!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)||typeof version!=='string')throw Error('invalid_adapter_channel_match')
  for(const [id,names]of Object.entries(matches.registries||{}))if(!id.includes(':')||!Array.isArray(names)||names.some(n=>typeof n!=='string'||!n.includes(':')))throw Error('invalid_adapter_registry_match')
  if(matches.jarSha256!==undefined&&(!Array.isArray(matches.jarSha256)||matches.jarSha256.some(h=>!/^[a-f0-9]{64}$/.test(h))))throw Error('invalid_adapter_fingerprint')
}
module.exports={matchAdapter,validateMatches}
