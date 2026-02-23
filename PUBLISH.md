# Dispatch — Publishing & Distribution Guide

Reference guide for publishing `dispatch-ai` across all major package managers.

---

## 1. Automated Publishing (with GitHub Actions)

We've set up a GitHub Action to automatically publish `dispatch-ai` to npm whenever a new version tag is pushed.

### One-time Setup:
1.  **Add npm token to GitHub**:
    *   Generate a "Classic" or "Granular" access token (Automation scope) on [npmjs.com](https://www.npmjs.com/settings/mehul/tokens).
    *   Add it to your GitHub repository: `Settings` → `Secrets and variables` → `Actions` → `New repository secret`.
    *   Name it `NPM_TOKEN`.

### To Publish a New Version:
Simply run:

```bash
# Bump version and create a commit/tag (e.g. 0.1.0 -> 0.1.1)
npm version patch

# Push the tag to GitHub
git push origin main --follow-tags
```

---

## 2. Manual npm / npx (Backup)

### Prerequisites
- npm account at [npmjs.com](https://www.npmjs.com)
- Check name availability: `npm search dispatch-ai`
- Fallback names: `@mehul/dispatch`, `dispatch-ai`, `dispatch-issues`

### Publish

```bash
# One-time login
npm login

# Build and publish
cd dispatch
npm run build
npm publish

# If using scoped package (@mehul/dispatch), make it public:
npm publish --access public
```

### Users install with:

```bash
# Run without installing
npx dispatch-ai run

# Or install globally
npm install -g dispatch-ai
dispatch run
```

### Updating

```bash
# Bump version
npm version patch   # 0.1.0 → 0.1.1
npm version minor   # 0.1.1 → 0.2.0
npm version major   # 0.2.0 → 1.0.0

# Publish update
npm run build
npm publish
```

### Pro Tips
- Add `postinstall` script to check for Claude Code
- Add `engines` field to enforce Node >= 20
- Use `np` package for safer publishes: `npx np`

---

## 2. GitHub Releases

### Create a release with tarball

```bash
# Build
npm run build

# Create tarball
npm pack
# Produces: dispatch-ai-0.1.0.tgz

# Create GitHub release (requires gh CLI)
gh release create v0.1.0 dispatch-ai-0.1.0.tgz \
  --title "Dispatch v0.1.0" \
  --notes "Initial release — AI-powered batch issue solver"
```

### Users install with:

```bash
# Download and install from release
npm install -g https://github.com/mehulpatel/dispatch/releases/download/v0.1.0/dispatch-ai-0.1.0.tgz
```

---

## 3. Homebrew (macOS / Linux)

### Option A: Homebrew Tap (No approval needed)

**Step 1:** Create a GitHub repo named `homebrew-tap`

**Step 2:** Add formula file `Formula/dispatch.rb`:

```ruby
class Dispatch < Formula
  desc "AI-powered batch GitHub issue solver — dispatch issues, receive PRs"
  homepage "https://github.com/mehulpatel/dispatch"
  url "https://registry.npmjs.org/dispatch-ai/-/dispatch-ai-0.1.0.tgz"
  sha256 "REPLACE_WITH_ACTUAL_SHA256"
  license "MIT"

  depends_on "node@20"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "dispatch", shell_output("#{bin}/dispatch --version")
  end
end
```

**Step 3:** Generate SHA256:

```bash
shasum -a 256 dispatch-ai-0.1.0.tgz
```

### Users install with:

```bash
brew tap mehulpatel/tap
brew install dispatch
```

### Option B: Homebrew Core (When popular)

Submit PR to [homebrew-core](https://github.com/Homebrew/homebrew-core) once the project has:
- Meaningful GitHub stars (100+)
- Active usage and issues
- Stable release history

---

## 4. Scoop (Windows)

### Create a Scoop bucket

**Step 1:** Create a GitHub repo named `scoop-dispatch`

**Step 2:** Add manifest `bucket/dispatch.json`:

```json
{
  "version": "0.1.0",
  "description": "AI-powered batch GitHub issue solver",
  "homepage": "https://github.com/mehulpatel/dispatch",
  "license": "MIT",
  "depends": "nodejs",
  "url": "https://registry.npmjs.org/dispatch-ai/-/dispatch-ai-0.1.0.tgz",
  "hash": "REPLACE_WITH_SHA256",
  "installer": {
    "script": "npm install -g $dir/package"
  },
  "bin": "dispatch.cmd"
}
```

### Users install with:

```powershell
scoop bucket add dispatch https://github.com/mehulpatel/scoop-dispatch
scoop install dispatch
```

---

## 5. AUR (Arch Linux)

### Create PKGBUILD

```bash
# Maintainer: Mehul Patel <mehul.patel@buildingminds.com>
pkgname=dispatch-ai
pkgver=0.1.0
pkgrel=1
pkgdesc="AI-powered batch GitHub issue solver"
arch=('any')
url="https://github.com/mehulpatel/dispatch"
license=('MIT')
depends=('nodejs>=20')
source=("https://registry.npmjs.org/dispatch-ai/-/dispatch-ai-${pkgver}.tgz")
sha256sums=('REPLACE_WITH_SHA256')

package() {
    npm install -g --prefix "$pkgdir/usr" "$srcdir/package"
}
```

Submit to [AUR](https://aur.archlinux.org/).

### Users install with:

```bash
yay -S dispatch-ai
# or
paru -S dispatch-ai
```

---

## 6. Nix / NixOS

### Add `flake.nix` to the repo:

```nix
{
  description = "AI-powered batch GitHub issue solver";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
      in {
        packages.default = pkgs.buildNpmPackage {
          pname = "dispatch-ai";
          version = "0.1.0";
          src = ./.;
          npmDepsHash = "REPLACE_WITH_HASH";
        };
      });
}
```

### Users install with:

```bash
nix run github:mehulpatel/dispatch
# or
nix profile install github:mehulpatel/dispatch
```

---

## 7. Docker (For CI/CD and scheduled runs)

### Add `Dockerfile`:

```dockerfile
FROM node:20-alpine

RUN npm install -g dispatch-ai

# Ensure claude CLI is available
# Users mount their Claude Code config
VOLUME ["/root/.claude"]

WORKDIR /repo
ENTRYPOINT ["dispatch"]
```

### Users run with:

```bash
docker run -v $(pwd):/repo -v ~/.claude:/root/.claude \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  dispatch-ai run
```

---

## 8. GitHub Action (For scheduled nightly runs)

### Create `action.yml` in the repo:

```yaml
name: 'Dispatch — AI Issue Solver'
description: 'Solve GitHub issues with AI and create pull requests'
inputs:
  github-token:
    description: 'GitHub token'
    required: true
  labels:
    description: 'Issue labels to filter (comma-separated)'
    required: false
  max-issues:
    description: 'Max issues to process'
    required: false
    default: '5'
  model:
    description: 'AI model to use'
    required: false
    default: 'sonnet'
runs:
  using: 'node20'
  main: 'dist/action.js'
```

### Users add to their repo `.github/workflows/dispatch.yml`:

```yaml
name: Dispatch Nightly
on:
  schedule:
    - cron: '0 2 * * *'  # Run at 2 AM UTC every night
  workflow_dispatch:       # Allow manual trigger

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mehulpatel/dispatch@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          max-issues: 10
          model: sonnet
```

---

## Recommended Rollout Order

| Phase | Channel | Effort | Audience |
|-------|---------|--------|----------|
| **Phase 1 (Day 1)** | npm / npx | 5 min | JS/TS devs |
| **Phase 1 (Day 1)** | GitHub Release | 15 min | Direct downloads |
| **Phase 2 (Week 1)** | Homebrew Tap | 1 hour | macOS/Linux devs |
| **Phase 2 (Week 1)** | GitHub Action | 2 hours | CI/CD users |
| **Phase 3 (Week 2)** | Docker | 30 min | Containers |
| **Phase 3 (Week 2)** | Scoop | 1 hour | Windows devs |
| **Phase 4 (Month 1)** | AUR | 1 hour | Arch users |
| **Phase 4 (Month 1)** | Nix Flake | 1 hour | Nix users |
| **Phase 5 (When popular)** | Homebrew Core | PR submission | Mainstream |

---

## If Rewriting in Go (v2)

Use [GoReleaser](https://goreleaser.com) to automate everything:

```bash
# One command builds for all platforms and publishes everywhere
goreleaser release
```

GoReleaser auto-generates:
- Platform binaries (linux/mac/windows × amd64/arm64)
- Homebrew formula
- Scoop manifest
- Docker images
- GitHub Release with checksums
- Snapcraft package

This is the approach used by `gh` CLI, `lazygit`, `act`, and `age`.

---

## Checklist Before First Publish

- [ ] Verify `dispatch-ai` name is available on npmjs.com
- [ ] Update `package.json` with correct GitHub repo URL
- [ ] Add `repository`, `bugs`, and `homepage` fields to `package.json`
- [ ] Ensure `README.md` has badges (npm version, license, downloads)
- [ ] Test `npm pack` and install from tarball locally
- [ ] Tag release: `git tag v0.1.0 && git push --tags`
- [ ] Set up npm 2FA for publish security
