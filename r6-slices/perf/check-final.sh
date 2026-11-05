set -eu
pnpm exec turbo run @bb/server#generate:terminal-screen-worker @bb/app#typecheck --concurrency=1
pnpm exec turbo run test --filter=@bb/app -- plugin-frontend
