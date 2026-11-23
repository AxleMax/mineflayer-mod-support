# Contributing

Use Node.js 22+, `npm ci`, `npm run check`, `npm test`, `npm run typecheck`.

For protocol work, identify the exact version's official API and implementation
before adding rules. Track wrappers, inheritance, callbacks and lifecycle. Keep
private names and sample-specific behavior out of generic core rules. A static
registration or a candidate schema is not proof of runtime compatibility.

Group related implementation and verification into one batch. Test different
structures and retain an unseen sample when evaluating generalization. Report
automatic, explicitly adapted and unsupported results separately.

Adapters should use public scoped extension points and stay versioned. Keep Java
execution, complete client emulation and gameplay automation outside the core.
Do not introduce a second equipment/use/container API alongside native Mineflayer.

Tests using optional real JAR/capture evidence skip when those artifacts are absent.
Portable tests use synthetic data and deterministic examples. Never commit private
JARs, tokens, `.env`, local paths, player NBT, server logs, captures or worlds.
Provide a redacted diagnosis and legally redistributable minimal synthetic fixture.

Live testing connects only to an existing user-controlled server. Do not add hidden
startup/restart helpers. Verify results on the server, clean uniquely owned test
fixtures, and distinguish intentional Bot quits from transport failures.

Open a focused issue or pull request with scope, exact versions, reproduced behavior,
validation and remaining limitations. Claims of Fabric/NeoForge support require an
implemented module and real evidence, not just an extension interface.
