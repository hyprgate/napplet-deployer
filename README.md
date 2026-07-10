<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `napplet-deployer` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# Napplet Deployer

Sandboxed NIP-5D napplet for deploying another napplet's built `index.html`.

The deployer:

- reads the selected HTML file and detects `napplet-type`, `napplet-requires`,
  `napplet-config-schema`, title, and description metadata;
- computes the NIP-5A single-file `/index.html` `path` hash and aggregate `x`
  hash;
- uploads the HTML through NAP-UPLOAD with a Blossom rail hint;
- publishes a kind `35129` named-napplet event through the runtime relay API.

The UI intentionally shows the current NAP-UPLOAD limitation: before upload, a
napplet cannot know which Blossom server the runtime will target, and it cannot
request a specific Blossom destination. After upload it can only infer server
tags from returned URLs.

## Develop

```bash
pnpm --filter @hyprgate/napp-napplet-deployer dev
pnpm --filter @hyprgate/napp-napplet-deployer test
pnpm --filter @hyprgate/napp-napplet-deployer type-check
pnpm --filter @hyprgate/napp-napplet-deployer build
```
