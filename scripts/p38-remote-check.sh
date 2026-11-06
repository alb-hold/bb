set -eu
pnpm exec turbo run generate:terminal-screen-worker --filter=@bb/server
pnpm exec turbo run typecheck test --filter=@bb/app
pnpm exec turbo run build --filter=@bb/app
node apps/app/scripts/check-bundle-budget.mjs
