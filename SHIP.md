# Shipping memory7 to npm

A step-by-step guide to publish `memory7`. Written 2026-11-09. npm's publishing rules have been changing quickly (tokens, 2FA, staged publishing), so the links at the bottom are the source of truth if a step here fails.

---

## 0. What gets published

`package.json` has `"files": ["dist", "README.md", "LICENSE"]`, so the tarball holds only the bundled build, the README and the license (plus `package.json`). Dependencies are bundled into `dist/`, so users install **zero** extra packages. Source, tests and this file are not published.

Users need Node >= 22.13 (`engines` in package.json). Older Node fails because `node:sqlite` does not exist there.

---

## 1. One-time setup

1. **npm account** at <https://www.npmjs.com/signup>. Verify your email.
2. **Turn on 2FA** (account settings → Two-Factor Authentication, "Authorization and publishing"). npm requires 2FA for manual publishes.
3. **Check the name is still free** right before publishing:
   ```bash
   npm view memory7
   ```
   An `E404 ... Not found` means it is free (it was on 2026-11-09). If someone took it, pick a new name (or a scope like `@yourname/memory7`; scoped public packages need `--access public` on first publish) and update `name` in `package.json`, plus every `memory7` in the README and in `src/ide/init.ts` where it says `npx -y memory7`.
4. **Fill in the package metadata** in `package.json`. npm does not require these, but users and provenance do:
   ```json
   "author": "Your Name <you@example.com>",
   "repository": { "type": "git", "url": "git+https://github.com/YOU/memory7.git" },
   "homepage": "https://github.com/YOU/memory7#readme",
   "bugs": { "url": "https://github.com/YOU/memory7/issues" }
   ```
   Then edit the copyright line in `LICENSE` ("memory7 contributors" → your name).
5. **Put the code in a git repo and push it to GitHub** (needed for the automated flow in section 6, and good practice anyway):
   ```bash
   git init && git add -A && git commit -m "memory7 0.1.0"
   git remote add origin git@github.com:YOU/memory7.git
   git push -u origin main
   ```

---

## 2. Pre-flight checks

Run all of these from the project root. Do not publish if any fails.

**Cross-platform check first.** The tests run on Linux in this workspace, but the package promises macOS and Windows too. After pushing to GitHub (step 1.5), open the **Actions** tab: the `ci` workflow (`.github/workflows/ci.yml`) runs typecheck, the full test suite, the build and a packed-tarball smoke test on Ubuntu, macOS and Windows with Node 22 and 24. Publish only when all six jobs are green. Any failure there is a real portability bug to fix first.

```bash
npm ci                    # clean install from package-lock.json
npm run typecheck
npm test                  # unit tests + real MCP client over stdio + CLI/hook tests
npm run build
npm run bench             # latency targets: search < 5 ms, digest < 10 ms, cold start < 150 ms
npm pack --dry-run        # lists exactly what would be published
```

`npm pack --dry-run` should list only: `LICENSE`, `README.md`, `package.json` and files under `dist/`. If you see `src/`, `test/`, `node_modules/` or `.env` files, stop and fix `files` in `package.json`.

### Install the real tarball in a sandbox

This is the closest thing to what users get. It never touches your real IDE configs because `HOME` and `MEMORY7_HOME` are pointed at a temp dir.

```bash
npm pack                                   # creates memory7-0.1.0.tgz
SANDBOX=$(mktemp -d)
export HOME=$SANDBOX MEMORY7_HOME=$SANDBOX/.memory7
npm install -g --prefix "$SANDBOX/prefix" ./memory7-0.1.0.tgz
export PATH="$SANDBOX/prefix/bin:$PATH"

memory7 --version                          # 0.1.0
memory7 doctor                             # all ✓ for Node, SQLite, database
memory7 add "I use Ubuntu" && memory7 search os
memory7 init --dry-run --ide all           # shows what init would change
```

Open a **new shell** afterwards so the exported variables are gone.

---

## 3. First publish (manual, from your machine)

```bash
npm login                  # opens a browser, completes with 2FA
npm whoami                 # confirm it is the right account
npm publish                # unscoped packages are public by default
```

npm asks for a 2FA code. When it finishes:

```bash
npm view memory7 version                   # 0.1.0
npx -y memory7@latest --version            # run from another directory, ideally another machine
npx -y memory7@latest doctor
```

Then tag the release in git so the published version maps to a commit:

```bash
git tag v0.1.0 && git push --tags
```

Create a GitHub Release from that tag with a short changelog.

> **Why manual first?** Trusted publishing (section 6) is configured on the package's settings page on npmjs.com, and that page only exists after the package has been published once. Staged publishing is also for new versions of an existing package, not the first publish.

---

## 4. Releasing later versions

Follow semver: `patch` for fixes, `minor` for new features, `major` for breaking changes (for example a database schema change that older versions cannot read).

```bash
# 1. update code, run the pre-flight checks from section 2
# 2. bump version, commit and tag in one step
npm version patch          # or minor / major  → edits package.json, commits, tags
# 3. publish
npm publish
git push --follow-tags
```

`tsup.config.ts` reads the version from `package.json`, so the `--version` output and the MCP `serverInfo.version` follow automatically after `npm run build`.

**Database changes:** if you change the schema, add a new numbered entry to `MIGRATIONS` and raise `SCHEMA_VERSION` in `src/core/db.ts`. Migrations run automatically and inside a transaction on the user's next start. Never edit an existing migration after release.

For a pre-release that should not become `latest`:

```bash
npm version 0.2.0-beta.0
npm publish --tag beta     # users opt in with: npx memory7@beta
```

---

## 5. If something goes wrong

- **Bad release:** a published version number can never be reused, even after unpublishing. Fix forward with a new patch version, and mark the bad one:
  ```bash
  npm deprecate memory7@0.1.1 "broken init on Windows, use 0.1.2"
  ```
  Unpublishing is restricted by npm policy and breaks anyone depending on the version, so avoid it. See the npm unpublish policy if you truly need it.
- **`E403 ... you do not have permission` / `package name too similar`:** the name is taken or blocked. Choose another or use a scope.
- **`E403 ... two-factor authentication ... required`:** enable 2FA on the account and run `npm login` again.
- **`E404` on `npm publish` for a scoped name:** add `--access public`.
- **`You cannot publish over the previously published versions`:** bump the version.
- **Users report `Cannot find module 'node:sqlite'`:** they are on Node < 22.13. Point them to <https://nodejs.org>.
- **A secret was published:** revoke it at the provider first, then publish a new version. Deleting from npm does not un-leak it.

---

## 6. Automating releases from GitHub Actions

Do this after the first manual publish. npm now recommends **trusted publishing (OIDC)**: GitHub proves to npm which workflow is publishing, so there is no long-lived token to leak or rotate.

Background so you are not surprised by older tutorials:

- npm **classic tokens were revoked** (late 2025). Do not follow guides that tell you to create one.
- **Granular tokens** are limited to 90 days and expire.
- npm has been **removing the ability of 2FA-bypass tokens to publish directly** (announced for January 2027). A long-lived `NPM_TOKEN` secret in CI is a path that is closing. Use OIDC.

### 6.1 Configure the trusted publisher on npm

On npmjs.com → your package `memory7` → **Settings → Trusted Publisher** → GitHub Actions, and enter:

- Organization or user: your GitHub name
- Repository: `memory7`
- Workflow filename: `publish.yml` (filename only, with extension; the file must live in `.github/workflows/`)
- Environment: optional (use one if you want a manual approval gate in GitHub)
- **Allowed actions:** npm always allows `npm stage publish` for a trusted publisher. Tick direct `npm publish` as well if you want the workflow below to publish without a human step. Leave it off if you prefer staged publishing (6.3).

### 6.2 Workflow

Create `.github/workflows/publish.yml`:

```yaml
name: publish
on:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write          # lets GitHub mint the OIDC token npm checks

jobs:
  publish:
    runs-on: ubuntu-latest   # trusted publishing needs GitHub-hosted runners
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm install -g npm@latest      # trusted publishing needs npm >= 11.5.1 and Node >= 22.14
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm publish --provenance --access public
```

Notes:
- Use the current major versions of `actions/checkout` and `actions/setup-node` (check their release pages).
- `--provenance` publishes a signed link from the npm package to the exact commit and workflow that built it. It requires `repository.url` in `package.json` to match the GitHub repo.
- `npm publish` here should fall back to no token at all. If it fails with a misleading 404 or auth error, the usual cause is a mismatch in the trusted-publisher form (repo name, workflow filename, or environment name), so re-check those first.
- Release flow becomes: `npm version patch && git push --follow-tags`. The tag triggers the workflow.

### 6.3 Staged publishing (optional human gate)

npm also offers `npm stage publish`: CI uploads the tarball, but it only goes live after a maintainer approves it with 2FA (CLI or npmjs.com). This protects you if CI or a token is ever compromised. To use it, replace the last workflow step with `npm stage publish --provenance` (requires a recent npm CLI; check `npm --version` and the docs below) and approve the staged version afterwards.

---

## 7. Final checklist

- [ ] `npm view memory7` was 404 when you started (name free)
- [ ] `author`, `repository`, `homepage`, `bugs` filled in; LICENSE name edited
- [ ] `npm ci && npm run typecheck && npm test && npm run build && npm run bench` all pass
- [ ] `npm pack --dry-run` lists only `dist/`, `README.md`, `LICENSE`, `package.json`
- [ ] Sandbox install of the tarball works (`memory7 doctor` all green)
- [ ] 2FA enabled on the npm account
- [ ] `npm publish` done, `npx -y memory7@latest --version` works from a clean directory
- [ ] `git tag vX.Y.Z && git push --tags`, GitHub Release written
- [ ] On a second machine: `npx -y memory7 init`, restart the IDE, confirm `memory_context` appears in the tool list (`memory7 doctor` shows which IDEs are configured)

---

## Links

- Creating and publishing unscoped public packages: <https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages>
- Trusted publishing: <https://docs.npmjs.com/trusted-publishers>
- Staged publishing: <https://docs.npmjs.com/staged-publishing>
- About access tokens: <https://docs.npmjs.com/about-access-tokens>
- Semantic versioning: <https://semver.org>
