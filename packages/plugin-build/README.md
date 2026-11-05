# Shared frontend runtime

Frontend builds replace the specifiers in `src/runtime-shims.mjs` with the existing host runtime slots. Radix checkbox, slot and compose-refs load together through an awaited lazy runtime group before plugin evaluation. Their namespace objects are assembled in a separate chunk using the host's installed modules. No SDK surface is added.

For these three specifiers, the builder resolves each import from its importer, reads that installed package's version, and shares only when the host has the same major and an equal or newer stable version. Prereleases require an exact match. An unresolved version, newer plugin version or incompatible major keeps the installed plugin copy bundled and emits a build warning. The generated export manifest records the host's actual installed versions.

The complete Radix package namespace is shared, including Checkbox Root and Indicator, to preserve context identity. Existing plugin artifacts keep their bundled dependencies until rebuilt. Rebuilt artifacts declare the new slots in `app.meta.json`; the loader awaits them before evaluation. If loaded by an older host without a required slot, the shim throws a specific `Cannot load "<specifier>"` error and the loader contains the failure to that plugin. New artifacts require the updated host.

Zod continues to bundle per plugin. Exposing its full namespace through a lazy import expands the static boot closure because the host already imports Zod. A shared subset needs separate conservative import-use analysis and a generated host usage contract before admission.
