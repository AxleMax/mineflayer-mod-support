'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {parseToml,parseManifestMain,resolveMods}=require('../src/analyzer/mod-metadata')
test('standard TOML comments, quoted tables and hashes inside strings preserve Mod/dependency declarations',()=>{
  const result=parseToml('[[mods]] # legal comment\nmodId="blind"\nversion="2#not-comment"\n[[dependencies."blind"]] # legal\nmodId="forge"\nmandatory=true # legal\nversionRange="[47,)"')
  assert.equal(result.mods[0].modId,'blind');assert.equal(result.mods[0].version,'2#not-comment')
  assert.equal(result.deps[0].modId,'forge');assert.equal(result.deps[0].owner,'blind');assert.equal(result.deps[0].mandatory,true)
})
test('multiline descriptions cannot inject fake Mod tables or overwrite following metadata',()=>{
  const input='[[mods]]\nmodId="real"\ndescription=\'\'\'\n[[mods]]\nmodId="not-a-mod"\n\'\'\'\nversion="1"\n[[mods]]\nmodId="other"\nversion="2"'
  const result=parseToml(input)
  assert.deepEqual(result.mods.map(m=>m.modId),['real','other']);assert.equal(result.mods[0].version,'1')
  assert.throws(()=>parseToml('[[mods]]\nmodId="broken'),require('smol-toml').TomlError)
})
test('JAR main manifest handles continuation and ignores per-entry version overrides',()=>{
  const manifest=parseManifestMain('Manifest-Version: 1.0\r\nImplementation-Version: 1.20.1-\r\n 2.11\r\n\r\nName: fake.class\r\nImplementation-Version: WRONG\r\n')
  assert.equal(manifest['implementation-version'],'1.20.1-2.11')
  const result=resolveMods([{modId:'blind',version:'${file.jarVersion}'}],manifest)
  assert.equal(result.mods[0].version,'1.20.1-2.11');assert.equal(result.mods[0].versionSource,'jar-manifest/Implementation-Version')
})
test('unresolved substitutions remain explicitly unresolved; missing version uses the documented Forge default',()=>{
  const result=resolveMods([{modId:'unknown',version:'${file.jarVersion}'},{modId:'default'}],{})
  assert.equal(result.mods[0].versionResolved,false);assert.equal(result.warnings.length,1)
  assert.equal(result.mods[1].version,'1');assert.equal(result.mods[1].versionSource,'forge-default')
})
