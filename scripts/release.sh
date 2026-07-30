#!/usr/bin/env bash
#
# Release gcoordinator-extension to the VS Code Marketplace.
#
#   scripts/release.sh patch            # 0.1.0 -> 0.1.1
#   scripts/release.sh minor            # 0.1.0 -> 0.2.0
#   scripts/release.sh major            # 0.1.0 -> 1.0.0
#   scripts/release.sh 0.4.2            # explicit version
#   scripts/release.sh patch --dry-run  # build + verify, stop before publishing
#
# The whole point of this script is the verification step: bin/spacemoused is a
# gitignored, macOS-only build artifact, so a vsix built without `npm run
# build:native` ships with macOS SpaceMouse support silently missing. Nothing
# errors out — it just doesn't work for half the users. Same for the Windows
# node-hid prebuilds. So we crack the vsix open and assert on its contents
# before anything reaches the Marketplace.

set -euo pipefail

PUBLISHER="tomohiron907"
KEYCHAIN_SERVICE="vsce-pat"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$BOLD" "$RESET" "$BOLD" "$*" "$RESET"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- arguments --

BUMP=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "unknown option: $arg" ;;
    *)         [ -n "$BUMP" ] && die "too many arguments"; BUMP="$arg" ;;
  esac
done
[ -n "$BUMP" ] || die "usage: scripts/release.sh <patch|minor|major|x.y.z> [--dry-run]"

CURRENT_VERSION="$(node -p "require('./package.json').version")"

case "$BUMP" in
  patch|minor|major)
    IFS=. read -r MAJ MIN PAT <<<"$CURRENT_VERSION"
    case "$BUMP" in
      patch) PAT=$((PAT + 1)) ;;
      minor) MIN=$((MIN + 1)); PAT=0 ;;
      major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
    esac
    NEW_VERSION="$MAJ.$MIN.$PAT"
    ;;
  [0-9]*.[0-9]*.[0-9]*)
    NEW_VERSION="$BUMP"
    ;;
  *)
    die "'$BUMP' is not a bump keyword or an x.y.z version"
    ;;
esac

TAG="v$NEW_VERSION"
VSIX="gcoordinator-extension-$NEW_VERSION.vsix"

printf '%sgcoordinator-extension%s  %s -> %s%s%s' "$BOLD" "$RESET" "$CURRENT_VERSION" "$BOLD" "$NEW_VERSION" "$RESET"
[ "$DRY_RUN" -eq 1 ] && printf '  %s(dry run)%s' "$DIM" "$RESET"
printf '\n'

# ---------------------------------------------------------------- preflight --

step "Preflight"

[ "$(uname -s)" = "Darwin" ] || die "releases must be cut on macOS: bin/spacemoused needs clang and the macOS SDK.
       Building elsewhere produces a vsix with macOS SpaceMouse support silently missing."
command -v clang >/dev/null || die "clang not found. Install the Xcode command line tools: xcode-select --install"
ok "macOS with clang"

command -v node >/dev/null || die "node not found"
[ -d node_modules ] || die "node_modules missing. Run: npm ci"
ok "node and node_modules present"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH'; releases are cut from main"
ok "on main"

git diff --quiet && git diff --cached --quiet \
  || die "working tree has uncommitted changes. Commit or stash them first:
$(git status --short | sed 's/^/         /')"
ok "working tree clean"

git fetch --quiet origin main --tags
LOCAL="$(git rev-parse main)"
REMOTE="$(git rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] || die "main and origin/main have diverged. Pull or push first."
ok "main in sync with origin/main"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "tag $TAG already exists locally. Pick a different version."
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists on origin. Pick a different version."
fi
ok "tag $TAG is free"

grep -q "^## \[$NEW_VERSION\]" CHANGELOG.md \
  || die "CHANGELOG.md has no '## [$NEW_VERSION]' section.
       Add one before releasing — it becomes the Marketplace changelog tab:

         ## [$NEW_VERSION] - $(date +%Y-%m-%d)

         ### Added
         - ..."
ok "CHANGELOG.md has a [$NEW_VERSION] section"

# The PAT is checked here, before any building, so an expired token fails in two
# seconds instead of after a full build. It is never written to disk by this
# script and never passed on a command line — only into vsce's environment.
if [ "$DRY_RUN" -eq 0 ]; then
  VSCE_PAT="${VSCE_PAT:-$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$PUBLISHER" -w 2>/dev/null || true)}"
  [ -n "$VSCE_PAT" ] || die "no Marketplace token found.

       Store one in the macOS Keychain (recommended, one time only):

         security add-generic-password -s $KEYCHAIN_SERVICE -a $PUBLISHER -w

       (it will prompt for the token without echoing it)

       Or export it for this run only:

         VSCE_PAT=... scripts/release.sh $BUMP

       Get a token at https://dev.azure.com -> User settings -> Personal access
       tokens, with Organization 'All accessible organizations' and the scope
       Marketplace: Manage."
  export VSCE_PAT
  npx vsce verify-pat "$PUBLISHER" >/dev/null 2>&1 \
    || die "the Marketplace token was rejected (expired, revoked, or wrong scope).
       Issue a new one and re-store it:
         security delete-generic-password -s $KEYCHAIN_SERVICE -a $PUBLISHER
         security add-generic-password -s $KEYCHAIN_SERVICE -a $PUBLISHER -w"
  ok "Marketplace token valid for publisher $PUBLISHER"
fi

# ------------------------------------------------------------------- version --

# From here on package.json is modified, so any failure has to put it back.
RELEASE_COMMITTED=0
restore_version() {
  if [ "$RELEASE_COMMITTED" -eq 0 ]; then
    git checkout -- package.json package-lock.json 2>/dev/null || true
  fi
}
trap restore_version EXIT

step "Bumping version to $NEW_VERSION"
npm version "$NEW_VERSION" --no-git-tag-version >/dev/null
ok "package.json and package-lock.json updated"

# --------------------------------------------------------------------- build --

step "Building"
npm run build:native >/dev/null
ARCHS="$(lipo -archs bin/spacemoused)"
case "$ARCHS" in
  *arm64*) : ;;
  *) die "bin/spacemoused is missing arm64 (got: $ARCHS)" ;;
esac
case "$ARCHS" in
  *x86_64*) : ;;
  *) die "bin/spacemoused is missing x86_64 (got: $ARCHS)" ;;
esac
ok "bin/spacemoused is universal ($ARCHS)"

npm run build >/dev/null
ok "extension host and webview bundles built"

step "Packaging"
rm -f "$VSIX"
npx vsce package --out "$VSIX" >/dev/null
ok "$VSIX ($(du -h "$VSIX" | cut -f1))"

# -------------------------------------------------------------- verification --

step "Verifying vsix contents"

MANIFEST="$(unzip -p "$VSIX" extension/package.json)"
PACKAGED_VERSION="$(node -p "JSON.parse(process.argv[1]).version" "$MANIFEST")"
[ "$PACKAGED_VERSION" = "$NEW_VERSION" ] \
  || die "packaged version is $PACKAGED_VERSION, expected $NEW_VERSION"
ok "packaged version is $NEW_VERSION"

ENTRIES="$(unzip -Z1 "$VSIX")"

require_entry() {
  printf '%s\n' "$ENTRIES" | grep -qxF "$1" || die "$2

       The vsix is missing: $1
       Nothing has been published. Fix the build and re-run."
  ok "$1"
}

require_entry "extension/bin/spacemoused" \
  "macOS SpaceMouse support would be silently missing from this release."
for arch in arm64 ia32 x64; do
  require_entry "extension/node_modules/node-hid/prebuilds/HID-win32-$arch/node-napi-v4.node" \
    "Windows SpaceMouse support would be broken on $arch."
done
require_entry "extension/out/extension.js" "The extension has no entry point."
require_entry "extension/media/preview.bundle.js" "The live preview webview would be blank."
require_entry "extension/media/gcodePreview.bundle.js" "The G-code preview webview would be blank."
require_entry "extension/readme.md" "The Marketplace listing would be empty."
require_entry "extension/changelog.md" "The Marketplace changelog tab would be empty."
require_entry "extension/LICENSE.txt" "The Marketplace license tab would be empty."

# 3DxMacWare SDK.pdf is 3Dconnexion reference material and must never ship.
# Everything else here is a build input that just bloats the package.
FORBIDDEN='\.pdf$|\.vsix$|^extension/src/|^extension/native/|^extension/scripts/|^extension/docs/'
if printf '%s\n' "$ENTRIES" | grep -qiE "$FORBIDDEN"; then
  die "the vsix contains files that should not ship:
$(printf '%s\n' "$ENTRIES" | grep -iE "$FORBIDDEN" | sed 's/^/         /')
       Check .vscodeignore. Nothing has been published."
fi
ok "no PDFs, no sources, no scripts or docs"

if [ "$DRY_RUN" -eq 1 ]; then
  step "Dry run complete"
  printf '  %s is built and verified but was not published.\n' "$VSIX"
  printf '  package.json has been restored to %s.\n' "$CURRENT_VERSION"
  printf '\n  Install it locally to test:\n    code --install-extension %s\n\n' "$VSIX"
  exit 0
fi

# ----------------------------------------------------------------- publishing --

step "Publishing to the Marketplace"
# --packagePath publishes the exact artifact that was just verified, rather than
# letting vsce rebuild and package a second time.
npx vsce publish --packagePath "$VSIX"
ok "published $PUBLISHER.gcoordinator-extension@$NEW_VERSION"

step "Committing and tagging"
git add package.json package-lock.json CHANGELOG.md
git commit --quiet -m "release v$NEW_VERSION"
RELEASE_COMMITTED=1
git tag -a "$TAG" -m "v$NEW_VERSION"
ok "commit and tag $TAG created"

if git push --quiet origin main "$TAG"; then
  ok "pushed main and $TAG to origin"
else
  warn "push failed, but $NEW_VERSION is already live on the Marketplace."
  warn "Resolve the push by hand — do not re-run this script:"
  warn "  git push origin main $TAG"
fi

step "Done"
cat <<EOF

  $PUBLISHER.gcoordinator-extension@$NEW_VERSION is live.

  Listing:  https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.gcoordinator-extension
  Manage:   https://marketplace.visualstudio.com/manage/publishers/$PUBLISHER

  It takes a few minutes for the Marketplace to finish processing before the
  new version is installable.

EOF
