# Bun

This page records Bun behavior the bus and its development tools depend on. The installed versions and recheck register are in [platforms](README.md); the runtime binding is in [interfaces](../architecture/interfaces.md), and its procedures are in [install](../runbooks/install.md) and [deploy](../runbooks/deploy.md).

## Runtime and TOML

- **Verified in a development checkout, 2026-11-02:** Bun 1.4.4+38afee6c8 trims the opening newline of a TOML multiline literal string, unlike Bun 1.3.14. The native agent adapter renderer's literal oracle and parity tests passed with the newer parser. The eight existing generated Claude adapters lose one leading body blank line, not foundation text. Recheck the literal oracle and generated-body parity after changing Bun. This is development evidence, not live deployment evidence. See the [upgrade frame](../frames/agent-bus-toolchain-upgrade.md).
- **Verified in a development checkout, 2026-11-02:** invoking `bun run` through an absolute Bun 1.4.4 executable did not itself select that executable for a script's bare `bun` command: with Bun 1.3.14 first on `PATH`, the script printed 1.3.14. Set the child `PATH` to the selected executable as well, and check its identity; do not infer script runtime from the parent command. Recheck this behavior on a Bun upgrade.
- **Read in code:** the new installer writes a launcher invoking the selected executable with `--no-env-file`; `package.json` binds its accepted version. Changing a shell's `PATH` or a global Bun link does not change a launcher already written with an exact executable path. Runtime identity and launchd behavior still need the deployment rehearsal described in the frame.
