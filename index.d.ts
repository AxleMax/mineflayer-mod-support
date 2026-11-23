import { EventEmitter } from 'node:events'

declare namespace modSupportPlugin {

export interface ItemDefinition { displayName?: string; stackSize?: number; maxDurability?: number }
export interface EntityDefinition { displayName?: string; width?: number; height?: number }
export type MenuDefinition = ({ containerSlots: number; playerInventory: 'appended-36' } | { slots: number; inventoryStart: number; inventoryEnd: number }) & { standardClick: true; craftingResultSlot?: number; requiresConfirmation?: boolean }
export interface BlockDefinition {
  minStateId: number
  defaultStateId: number
  /** Actual ordered StateDefinition domains; last property varies fastest. */
  properties: Array<{name: string; values: Array<string | number | boolean>}>
  collisionShapes: Array<Array<[number, number, number, number, number, number]>>
  displayName?: string
  hardness?: number
  diggable?: boolean
  transparent?: boolean
  boundingBox?: 'block' | 'empty'
}
export type ProtocolCodecKind = 'recipe' | 'ingredient' | 'argument' | 'metadata'
export interface ExplicitCodecContext {
  getRegistryId(registry: string, id: string): number | null
  getRegistryName(registry: string, id: number): string | null
  read(type: unknown, offset: number): {value: any; size: number}
  write(type: unknown, value: any, offset: number): number
  sizeOf(type: unknown, value: any): number
}
export interface ExplicitProtocolCodec {
  read(buffer: Buffer, offset: number, context: ExplicitCodecContext): {value: any; size: number}
  write(value: any, buffer: Buffer, offset: number, context: ExplicitCodecContext): number
  sizeOf(value: any, context: ExplicitCodecContext): number
}
export interface NativeMenuWindow {
  id: number; type: string; slots: any[]; selectedItem: any
  inventoryStart: number; inventoryEnd: number; hotbarStart: number; craftingResultSlot: number
  [key: string]: any
}
export interface MenuRuleContext { menu?: string; windowId?: number; additionalData?: Uint8Array; source: string }
export interface BlockCollisionContext {
  getBlock(position: any, extraInfo?: boolean): any
  player: {position: Record<string, number> | null; onGround?: boolean; metadata: any} | null
  source: string
}
export interface ModAdapterContext {
  readonly apiVersion: 1
  readonly loaderProtocol: string
  defineItem(id: string, data: ItemDefinition): () => boolean
  defineEntity(id: string, data: EntityDefinition): () => boolean
  defineBlock(id: string, data: BlockDefinition): () => boolean
  registerBlockCollision(id: string, provider: (block: any, context: BlockCollisionContext) => Array<[number, number, number, number, number, number]>): () => boolean
  defineMenu(id: string, data: MenuDefinition): () => boolean
  registerMenuRules(id: string, configure: (window: NativeMenuWindow, context: MenuRuleContext) => void | (() => void)): () => boolean
  registerProtocolCodec(kind: ProtocolCodecKind, id: string, schema: unknown, version?: '1.20.1'): () => void
  registerExplicitCodec(kind: ProtocolCodecKind, id: string, codec: ExplicitProtocolCodec, version?: '1.20.1'): () => void
  registerNetwork(profile: NativeModAdapter): () => void
  /** Register explicit message codecs without advertising a Java Mod identity. */
  registerChannel(profile: ChannelDefinition): () => void
  registerCodecHandler(profile: {channel: string; discriminator: number; id: string; onMessage(data: any, context: ModCodecHandlerContext): unknown}): () => void
  onChannel(channel: string, handler: (event: PayloadEvent) => void): () => void
  on(event: string, handler: (...args: any[]) => void): () => void
  getRegistryId(registry: string, id: string): number | null
  getRegistryName(registry: string, id: number): string | null
  getConfig(id: string): unknown
  sendMessage(channel: string, discriminator: number | null, value: unknown): NativeModSendReceipt
  requestMessage(channel: string, discriminator: number | null, value: unknown, options: NativeModRequestOptions): Promise<NativeModResponse>
}
export interface ModAdapter {
  id: string
  apiVersion: 1
  loaderProtocols?: string[]
  minecraftVersions?: string[]
  matches?: { mods?: Record<string,string>; channels?: Record<string,string>; registries?: Record<string,string[]>; jarSha256?: string[] }
  /** Synchronous setup. All context registrations are scoped and disposed automatically. */
  setup(context: ModAdapterContext): void | (() => void)
}
export interface LoaderProtocolDefinition {
  id: string
  apiVersion: 1
  create(runtime: ModSupportRuntime): LoaderProtocolInstance
}
export interface LoaderProtocolInstance {
  id: string
  apiVersion: 1
  registerChannel?(profile: ChannelDefinition): () => void
  attachClient?(client: any): void
  onState?(state: string): void
  observeInbound?(packet: PacketEvent): void
  observeOutbound?(packet: PacketEvent): void
  observePayload?(event: PayloadEvent): {status: string}
  captureNamedLoginPluginRequest?(data: unknown): void
  transformOutgoing?(name: string, data: any): {action: 'passthrough' | 'suppress'} | {action: 'replace'; data: any}
  decodePacket?(buffer: Buffer, version: string, phase: string): any | null
  registerProtocolCodec?(kind: ProtocolCodecKind, id: string, schema: unknown, version?: '1.20.1'): () => void
  registerExplicitCodec?(kind: ProtocolCodecKind, id: string, codec: ExplicitProtocolCodec, version?: '1.20.1'): () => void
  getMenuContext?(windowId: number): Record<string, any> | null
  registerModAdapter?(profile: NativeModAdapter): () => void
  registerModCodecHandler?(profile: {channel: string; discriminator: number; id: string; onMessage(data: any, context: ModCodecHandlerContext): unknown}): () => void
  sendModMessage?(channel: string, discriminator: number | null, value: unknown): NativeModSendReceipt
  requestModMessage?(channel: string, discriminator: number | null, value: unknown, options: NativeModRequestOptions): Promise<NativeModResponse>
  snapshot?(): Record<string, unknown>
  syncEvidence?(): Record<string, unknown> | null
  destroy(): void
}

export interface ModSupportOptions {
  trace?: {
    packets?: boolean
    raw?: boolean
    log?: boolean
  }
  maxPayloadBytes?: number
  /** P2.6 per-bot native Registry integration. Does not modify global minecraft-data. */
  nativeRegistry?: {
    /** Default true. Injects a per-bot item index into bot.registry before Mineflayer plugins initialize. */
    itemOverlay?: boolean
    /** Default true. Projects server entity type IDs and names; custom dimensions/metadata remain unknown. */
    entityOverlay?: boolean
    /** Default true. Isolated block data and explicit state/collision definitions; no inferred Mod state IDs. */
    blockOverlay?: boolean
  }
  /** P2.7 bounded, NBT-free real inventory observation; disabled by default. */
  nativeInventory?: {
    observe?: boolean
    expectedItem?: string | null
  }
  /** Default Forge. Other loaders require an explicit versioned module; no bundled Fabric/NeoForge implementation. */
  loaderProtocol?: 'forge' | LoaderProtocolDefinition
  adapters?: ModAdapter[]
  /** Path or object generated by analyze:jars. Read-only; never grants wire compatibility. */
  compatibilityManifest?: string | Record<string, unknown>
  /** Analyze all top-level JARs and Jar-in-Jar dependencies in this directory before connecting. */
  modsDir?: string
  experimental?: {
    /** Forge 1.20.1 FML3 hostname marker probe only; not a full handshake. */
    forgeFml3Marker?: boolean
    /** Wire-only probe: replace NMP's empty response to S2CModList with a truthful empty client list. Expect kick; this does NOT join Forge servers. */
    fml3ProbeEmptyReply?: boolean
    /** P1.6 controlled FML3 diagnostic: suppress unsupported NMP replies, send truthful empty ModList, never claim Java mods. */
    fml3ProbeControlled?: boolean
    /** P3.0 opt-in FML3 runtime: ACK decoded registry/config data and advertise only explicitly registered Node Mod adapters. */
    fml3Runtime?: boolean
    /** P1.7 opt-in experimental Forge tier_sorting 1.0 network capability; does NOT claim Waystones or JARs. */
    nativeTierChannel?: boolean
    /** Test-server only: observe JAR callback codecs using constructor-scoped indices. No advertisement or sends. */
    forgeJarCodecObservation?: boolean
    /** Test-server only: negotiate JAR-proven exact-version channels for data observation. Implies codec observation; no Mod behavior or serverbound actions. */
    forgeJarChannelObservation?: boolean
    /** Opt-in diagnostic only: attempts to ACK ModData and a fully decoded internal Registry mapping. Does NOT apply Registry to Mineflayer. */
    fml3RegistryProgression?: boolean
    /** Unsafe, explicit *test-server-only* channel claims; not derived automatically from JARs and not evidence of compatibility. */
    trialChannels?: Array<{ id: string; version: string }>
    /** Explicit test-server-only collection of bounded real Play custom payload bytes. Disabled by default. */
    playWireCapture?: boolean
    /** 'modded' for all non-core namespaces, or comma-separated exact channel names. */
    playWireCaptureChannels?: string
  }
}

export interface ModCodecHandlerContext {
  channel: string
  discriminator: number
  id: string
  entityKey: string | null
  codecStatus: 'structural-only' | 'candidate-only'
  roundTripExact: true
  getConfig: ModSupportRuntime['configMirror']['get']
}

export interface NativeModSendReceipt {
  status: 'sent'
  channel: string
  discriminator: number | null
  bytes: number
  serverConfirmed: false
}

export interface NativeModRequestOptions {
  responseDiscriminator: number | null
  match(data: unknown): boolean
  timeoutMs?: number
  signal?: AbortSignal
}
export interface ChannelDefinition {
  id: string
  version: string
  framing?: 'forge-simple-channel' | 'raw'
  messages: Array<{name?:string;discriminator?:number|null;direction:'clientbound'|'serverbound'|'bidirectional';schema?:Record<string,any>;codec?:{encode(value:unknown):Buffer;decode(bytes:Buffer):any};onMessage?:(value:any,context:{channel:string;discriminator:number|null})=>void}>
}

export interface NativeModResponse {
  request: NativeModSendReceipt
  response: { channel: string; discriminator: number | null; status: 'handled'; data: unknown }
  serverEffectConfirmed: false
}

export interface ModCollectionChanges {
  added: string[]
  updated: string[]
  removed: string[]
}

export interface NativeModAdapter {
  id: string
  version: string
  /** Required explicit opt-in: only real Node handlers/encoders are advertised to FML3. */
  advertise: true
  channels: Array<{
    id: string
    version: string
    /** Defaults to Forge SimpleChannel's one-byte discriminator framing; raw handles the full custom-payload bytes. */
    framing?: 'forge-simple-channel' | 'raw'
    messages: Array<{
      discriminator?: number | null
      direction: 'clientbound' | 'serverbound' | 'bidirectional'
      decode?: (payload: Buffer) => unknown
      encode?: (value: unknown) => Buffer
      onMessage?: (value: unknown, context: {channel:string;discriminator:number}) => void
    }>
  }>
}

export interface PacketEvent {
  direction: 'inbound' | 'outbound'
  name: string
  phase: string | null
  metadata?: Record<string, unknown>
  data?: unknown
  buffer?: Buffer
  fullBuffer?: Buffer
  timestamp: number
}

export interface PayloadEvent {
  channel: string
  data: Buffer | null
  phase: string | null
  direction: 'inbound' | 'outbound'
  packetName: string
  size?: number
  observedAt: number
}

export class CompatibilityRuntime {
  constructor(options?: ModSupportOptions)
  source: string
  listLocalMods(): Array<{ id: string; version: string; source: string | null }>
  getMessage(id: string): Record<string, unknown> | null
  setRuntimeEvidence(evidence: Record<string, unknown>): Record<string, any>
  getReport(): Record<string, any>
}

export class ModSupportRuntime extends EventEmitter {
  constructor(options?: ModSupportOptions)
  loaderProtocol: LoaderProtocolInstance
  use(adapter: ModAdapter): () => boolean
  getCapabilities(): {schema:string;connection:{handshake:boolean};channels:Array<Record<string,any>>;adapters:Record<string,any>;content:Record<string,any>;registries:Record<string,any>;synchronization:Record<string,any>|null;limitations:string[]}
  installRegistry(input: {name: string; entries: Array<{id: number; name: string}>; source?: string}): Record<string, unknown>
  adapters: { getReport(): {apiVersion: 1; active: string[]; entries:Array<{id:string;status:string;reasons:string[];matches:ModAdapter['matches']|null}>; closed: boolean; cleanupFailures: number} }
  contentDefinitions: { getReport(): Record<string, unknown> }
  nativeWindows: { getReport(): {perBot: true; projectedWindows: number; operationsOwner: string} }
  /** Forge module diagnostics/codec extensions; absent on unrelated custom loader modules. */
  protocolCodecs: {
    register(kind: ProtocolCodecKind, id: string, schema: unknown, version?: '1.20.1'): () => void
    registerExplicit(kind: ProtocolCodecKind, id: string, codec: ExplicitProtocolCodec, version?: '1.20.1'): () => void
    getReport(): {
      recipeSerializers: string[]
      ingredientSerializers: string[]
      commandArguments: string[]
      synchronization: { recipes: {status: string; recipes?: number; resource?: string | null; reason?: string}; entityMetadata: {status: string; entityId?: number; resource?: string | null; reason?: string} }
      entityMetadataSerializers: Array<{id: number; name: string; codecRegistered: boolean}>
      inferredRecipes: Array<{ id: string; kind: 'recipe' | 'ingredient'; serializer: string | null; source: string; status: 'candidate' | 'unresolved'; reason: string | null; wireVerified: boolean; derivation?: 'normal-read-control-flow' | 'paired-read-write' | null; pairedWriterProven?: boolean; definitionCount?: number; inferenceFailure?: string | null; bindingEvidence?: unknown[]; wireEvidence?: unknown }>
      decoded: number
      rejected: number
    }
  }
  state: string
  client: unknown
  bot: unknown
  loader: { name: string; version: string | null; confidence: string }
  protocol: {
    minecraftVersion: string | null
    protocolVersion: number | null
    state: string | null
    packetsIn: number
    packetsOut: number
    rawPacketsIn: number
    rawPacketsOut: number
  }
  network: {
    channels(): Array<Record<string, unknown>>
    get(id: string): Record<string, unknown> | undefined
    onRaw(listener: (event: PayloadEvent) => void): () => void
    onChannel(id: string, listener: (event: PayloadEvent) => void): () => void
  }
  fml3: { state: string; getReport(): Record<string, unknown> }
  fml3Controller: { getReport(): Record<string, unknown> }
  registryMappings: {
    getId(registry: string, identifier: string): number | null
    getName(registry: string, id: number): string | null
    getEntries(registry: string): Array<{id:number;name:string}> | null
    getReport(): Record<string, unknown>
  }
  nativeRegistry: {
    ensureOverlay(): boolean
    syncRegistry(registry: string): { registry:string; entries:number; lookupAvailable:boolean; itemOverlayInstalled:boolean; entityOverlayInstalled:boolean; blockStateIdsAvailable:boolean; entityAttributesAvailable:false }
    resolve(kind:'item'|'block'|'entity', resourceOrId: string | number): {kind:string;registry:string;id:number;name:string;nativeItemIndexInstalled:boolean;metadataComplete:boolean;stateIdsKnown:boolean;clientBehaviorImplemented:false}|null
    describeItemStack(stack:{type:number;count?:number}):Record<string,unknown>|null
    describeInventory():Array<Record<string,unknown>>
    describeEntity(entity:{entityType?:number}):Record<string,unknown>|null
    getReport():Record<string,unknown>
    getRegistryId(registry:string, identifier:string):number|null
    getRegistryName(registry:string, id:number):string|null
    getRegistryEntries(registry:string):Array<{id:number;name:string}>|null
  }
  forgeSplit: { getReport(): Record<string, unknown> }
  forgeContainers: {
    getCurrent(): {menuId:number;menu:string;windowId:number;title:string;additionalData:Uint8Array;slotLayoutKnown:boolean;readOnly:boolean;items:Array<{type:number;name:string|null;count:number;metadata:number;nbt:any}|null>}|null
    getReport(): Record<string, unknown>
  }
  nativeInventory: {
    attachInventory(): boolean
    observeSnapshot(): void
    getReport(): Record<string, unknown>
  }
  modState: {
    /** Live decoded observations; structural/candidate values are NOT applied Mod logic. */
    getLatest(channel:string, discriminator:number, entityKey?:string|null): {status:string;data:any;appliedToModRuntime:boolean}|null
    getApplied(channel:string, discriminator:number, entityKey?:string|null): {status:string;data:any}|null
    getByMessageId(id:string): Array<Record<string,any>>
    getKeys(channel:string, discriminator:number): Array<string|null>
    getReport(options?:{includeValues?:boolean}):Record<string,any>
  }
  modData: {
    /** Read-only observed collection snapshot inferred from a JAR Codec IR; not authoritative Mod client behavior. */
    getCollection(channel: string, discriminator: number, entityKey?: string | null): (Record<string, any> & { changes: ModCollectionChanges | null }) | null
    getObject(channel: string, discriminator: number, entityKey?: string | null): Record<string, any> | null
    getCollectionItem(channel: string, discriminator: number, entityKey: string | null, itemIdOrIndex: string | number): any | null
    listProjections(): Array<Record<string, unknown>>
    getRegistryId(registry: string, identifier: string): number | null
    getRegistryName(registry: string, id: number): string | null
    resolveRegistry(registry: string, resourceOrId: string | number): {registry:string;name:string;id:number;source:string;appliedToMineflayer:false} | null
    getReport(options?: {includeValues?:boolean}): Record<string, unknown>
  }
  configMirror: { get(identifier:string): {id:string;roots:Record<string,any>;categories:Record<string,Record<string,any>>;categoryCount:number;propertyCount:number;roundTripExact:true;appliedToJava:false}|null; getReport():Record<string,unknown> }
  playWire: { getReport(): Record<string, unknown> }
  serverConfigs: {
    get(fileName: string): Buffer | null
    getReport(): Record<string, unknown>
  }
  nativeChannels: { tier: { order: string[]; synced: boolean }; getAdvertisedChannels(): Array<{id:string;version:string}>; getAdvertisedMods():string[]; getReport(): Record<string, any>; registerModAdapter(adapter: NativeModAdapter): () => void; send(channel:string, discriminator:number|null, value:unknown):NativeModSendReceipt; request(channel:string, discriminator:number|null, value:unknown, options:NativeModRequestOptions):Promise<NativeModResponse>; registerHandler(profile: {channel:string;discriminator:number;decode:(payload:Buffer)=>unknown;onMessage:(data:unknown, context:Record<string,unknown>)=>void;direction?:'clientbound'}): () => void }
  compatibility: {
    source: string
    listLocalMods(): Array<{ id: string; version: string; source: string | null }>
    getMessage(id: string): Record<string, unknown> | null
    getReport(): Record<string, any>
  }
  diagnostics: { snapshot(): Record<string, unknown> }
  ready: Promise<this>
  registerModAdapter(adapter: NativeModAdapter): () => void
  /** Local synchronous callback for one exact JAR decoder. Return false to observe only. */
  registerModCodecHandler(profile: { channel: string; discriminator: number; id: string; onMessage(data: any, context: ModCodecHandlerContext): void | boolean }): () => void
  sendModMessage(channel:string, discriminator:number|null, value:unknown):NativeModSendReceipt
  requestModMessage(channel:string, discriminator:number|null, value:unknown, options:NativeModRequestOptions):Promise<NativeModResponse>
  onPacket(listener: (packet: PacketEvent) => void): () => void
  destroy(): void
}



  const plugin: typeof modSupportPlugin
  const Fml3Session: { new(): { state: string; getReport(): Record<string, unknown> } }
  function analyzeP04Report(report: Record<string, unknown>): Record<string, unknown>
  function analyzeJars(filePaths: string[], options?: Record<string, unknown>): Record<string, any>
  function createCompatibilityManifest(report: Record<string, any>): Record<string, any>
  function validateManifest(input: Record<string, any>): Record<string, any>
  function evaluateCompatibility(manifest: Record<string, any> | null, server?: Record<string, any>, runtimeEvidence?: Record<string, unknown>): Record<string, any>
  function encodeC2SModListReply(reply: { mods: string[]; channels: Array<{ id: string; version: string }>; registries: Array<{ id: string; marker: string }> }): Buffer
  function decodeC2SModListReply(data: Buffer): { mods: string[]; channels: Array<{ id: string; version: string }>; registries: Array<{ id: string; marker: string }> }
  function wrapFml3Reply(data: Buffer): Buffer
  function inspectFml3LoginWrapper(data: Buffer): Record<string, any>
  const Fml3ControlledProbe: { new(enabled?: boolean): { getReport(): Record<string, unknown> } }
  function decodeTierSync(data: Buffer): { tiers: string[] }
  function encodeTierSync(tiers: string[]): Buffer
  function decodeSimpleChannel(data: Buffer): { discriminator: number; payload: Buffer }
  function decodeForgeRegistrySnapshot(data: Buffer): { ids: Array<{ name: string; id: number }>; aliases: Array<{ from: string; to: string }>; overrides: Array<{ name: string; owner: string }>; blocked: number[]; entriesDecoded: true }
  function compileCodecPlan(plan: Record<string, any>): { encode(value:unknown):Buffer;decode(buffer:Buffer):any; description:Record<string,unknown> }
  function compileMessageSchema(schema: Record<string,any>, options?:{version?:'1.20.1'}): {encode(value:unknown):Buffer;decode(buffer:Buffer):any;description:Record<string,unknown>}
  function flatSchemaToPlan(fields: Array<{field:string;type:string}>): Record<string,any>
  function inferCallGraphPlan(graph: Record<string,any>): Record<string,any>
  function replayCapturedPlayWire(reportPath: string, modsDir: string): Record<string, any>
  const ModStateStore: { new(options?: {maxEntries?: number; maxBytes?:number}): ModSupportRuntime["modState"] }
  const NativeRegistryBridge: { new(options:{mappings:any;definitions?:unknown;itemOverlay?:boolean;entityOverlay?:boolean;blockOverlay?:boolean}): ModSupportRuntime['nativeRegistry'] }
  const NativeInventoryObserver: { new(options:{bridge:any;enabled?:boolean;expectedItem?:string|null}): ModSupportRuntime['nativeInventory'] }
  const NativeChannelRuntime: { new(runtime:any, options?:ModSupportOptions, compatibility?:any): ModSupportRuntime['nativeChannels'] }
  const ServerRegistryMappings: {new(): ModSupportRuntime['registryMappings']}
  const GenericModDataRuntime: { new(options?: {manifest?:Record<string,any>;registryMappings?:unknown;maxProjections?:number;maxBytes?:number}): ModSupportRuntime["modData"] }
  const PlayWireRecorder: {new(options?:{enabled?:boolean;channels?:string;maxPerChannel?:number;maxSamples?:number;maxSampleBytes?:number;maxTotalBytes?:number}): {observe(event:PayloadEvent, result?:Record<string,unknown>):boolean;getReport():Record<string,unknown>}}
  const GenericPacketDispatcher: {new(runtime?:any,options?:ModSupportOptions): {registerCandidate(message:Record<string,any>):boolean;observe(event:PayloadEvent):Record<string,any>;report():Record<string,any>} }
  function makeCodec(schema: Array<{ field: string; type: string }>): { encode(value: Record<string, unknown>): Buffer; decode(buffer: Buffer): Record<string, unknown> }
  function createBot(mineflayer: { createBot(options: Record<string, unknown>): any }, options?: Record<string, any> & { modSupport?: ModSupportOptions }): any
}

declare function modSupportPlugin(bot: any, botOptions?: { modSupport?: modSupportPlugin.ModSupportOptions }): modSupportPlugin.ModSupportRuntime

export = modSupportPlugin
