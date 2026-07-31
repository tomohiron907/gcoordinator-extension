# リリース手順

Marketplace への公開は `scripts/release.sh` に集約されている。
人間が手で叩いてもいいし、AI エージェントにこのファイルを読ませてそのまま実行させてもいい。

```bash
./scripts/release.sh patch     # 0.1.0 -> 0.1.1
./scripts/release.sh minor     # 0.1.0 -> 0.2.0
./scripts/release.sh major     # 0.1.0 -> 1.0.0
./scripts/release.sh 0.4.2     # バージョン直指定
./scripts/release.sh patch --dry-run   # ビルドと検証だけして公開しない
```

スクリプトが失敗したら、そこで止まって何も公開されない。
`--dry-run` は `package.json` のバージョンも元に戻すので、安全に何度でも試せる。

---

## 初回だけ必要な準備

### Marketplace トークンを Keychain に入れる

```bash
security add-generic-password -s vsce-pat -a tomohiron907 -w
```

プロンプトが出るのでトークンを貼り付ける（画面には表示されない）。
以降 `release.sh` はここから自動で読む。

トークンの発行元は https://dev.azure.com → 右上のユーザー設定 → Personal access tokens。

| 項目 | 値 |
| --- | --- |
| Organization | **All accessible organizations**（ここを間違えると必ず落ちる） |
| Scopes | Custom defined → **Marketplace: Manage** |
| Expiration | 最長 1 年 |

トークンは平文でどこにも保存しないこと。`release.sh` はファイルにも git にも書かない。

**トークンを差し替えるとき:**

```bash
security delete-generic-password -s vsce-pat -a tomohiron907
security add-generic-password -s vsce-pat -a tomohiron907 -w
```

Keychain を使いたくない場合はその場限りの環境変数でもいい。

```bash
VSCE_PAT=xxxxx ./scripts/release.sh patch
```

---

## リリースの流れ

### 1. 変更を main にマージして push しておく

`release.sh` は作業ツリーが汚れていたり、`main` と `origin/main` がずれていると
止まる。バージョン番号は**触らない** — スクリプトが上げる。

### 2. CHANGELOG.md に新バージョンの節を足す

これは手作業。スクリプトは節が無ければ公開を拒否する。

```markdown
## [0.1.1] - 2026-08-15

### Fixed

- ...
```

見出しは `## [x.y.z]` の形（角括弧つき）でないと検出されない。
ここに書いた内容がそのまま Marketplace の Changelog タブになる。

### 3. dry-run で確かめる

```bash
./scripts/release.sh patch --dry-run
```

生成された vsix はそのまま手元の VS Code に入れて動作確認できる。

```bash
code --install-extension gcoordinator-extension-0.1.1.vsix
```

Windows 側の確認が必要な変更なら、この vsix を持っていって
[docs/windows-testing.md](windows-testing.md) の手順を回す。

### 4. 本番リリース

```bash
./scripts/release.sh patch
```

成功すると以下がまとめて行われる。

1. Marketplace へ publish
2. `release vX.Y.Z` コミット（`package.json` / `package-lock.json` / `CHANGELOG.md`）
3. 注釈つきタグ `vX.Y.Z`
4. `origin` へ main とタグを push

Marketplace 側の処理に数分かかるので、すぐには新バージョンが入らない。

---

## スクリプトが何を検証しているか

ここが自動化の本体。**このプロジェクトの失敗は静かに起きる**ので、
ビルドが通ったことは何の保証にもならない。

### なぜ macOS でしか切れないのか

`bin/spacemoused` は macOS の SpaceMouse 対応の実体で、`native/spacemoused.c` を
clang で universal binary にビルドしたもの。`bin/` は gitignore されているため
**リポジトリには存在しない**。

つまり:

- clean checkout でそのまま `vsce package` すると `bin/spacemoused` の無い vsix ができる
- macOS 以外ではそもそもビルドできない
- どちらの場合も**エラーは出ない**。macOS ユーザーの SpaceMouse だけが黙って動かない

`release.sh` は `uname` で macOS を確認し、`build:native` を必ず走らせ、
`lipo -archs` で arm64 と x86_64 の両方が入っていることまで見る。

### vsix の中身をこじ開けて確認する項目

publish の直前に、実際に固まった vsix を `unzip` して以下を assert している。
一つでも欠けたらそこで止まり、何も公開されない。

| 項目 | 欠けると何が起きるか |
| --- | --- |
| `extension/bin/spacemoused` | macOS の SpaceMouse が無反応 |
| `extension/node_modules/node-hid/prebuilds/HID-win32-{arm64,ia32,x64}/node-napi-v4.node` | Windows の SpaceMouse が無反応 |
| `extension/out/extension.js` | 拡張機能が起動しない |
| `extension/media/preview.bundle.js` | Live Preview が真っ白 |
| `extension/media/gcodePreview.bundle.js` | G-code プレビューが真っ白 |
| `extension/readme.md` / `changelog.md` / `LICENSE.txt` | Marketplace のページが空 |
| `package.json` のバージョン一致 | 意図しないバージョンが出る |

加えて、`.pdf` / `src/` / `native/` / `scripts/` / `docs/` が
**入っていないこと**も確認する。
`3DxMacWare SDK.pdf` は 3Dconnexion の資料で再配布できないため、
git 履歴からも削除済み。二度とコミットしないこと（`.gitignore` 済み）。

Windows の HID prebuild は `node-hid` の npm パッケージに同梱されているものを
`.vscodeignore` の再include で拾っている。単一の vsix で mac と Windows の
両方をカバーする構成なので、プラットフォーム別ビルドは不要。

---

## トラブルシューティング

| メッセージ | 対処 |
| --- | --- |
| `releases must be cut on macOS` | Windows/Linux では切れない。Mac でやる |
| `clang not found` | `xcode-select --install` |
| `working tree has uncommitted changes` | コミットするか stash する |
| `main and origin/main have diverged` | `git pull` / `git push` してから再実行 |
| `CHANGELOG.md has no '## [x.y.z]' section` | 上記の手順 2 を先にやる |
| `no Marketplace token found` | 上記の「初回だけ必要な準備」 |
| `the Marketplace token was rejected` | トークンの期限切れか scope 間違い。Organization が **All accessible organizations** かを確認して再発行 |
| `tag vX.Y.Z already exists` | そのバージョンは公開済み。バージョンを上げる |
| `the vsix is missing: ...` | ビルド不全。`npm ci` してから再実行 |

### publish は通ったが push で落ちた場合

Marketplace には既に出てしまっているので、**スクリプトを再実行してはいけない**
（同じバージョンを二度 publish できない）。手で push だけ済ませる。

```bash
git push origin main vX.Y.Z
```

### 公開したバージョンを取り消したい

Marketplace はバージョンの削除ができない。次のパッチを出して上書きするか、
どうしても不可なら管理画面から拡張機能ごと unpublish する。

https://marketplace.visualstudio.com/manage/publishers/tomohiron907

---

## 画像の扱い（0.1.1 で対応済み）

| ファイル | 用途 | vsix に入るか |
| --- | --- | --- |
| `media/icon.png` | `package.json` の `"icon"`。Marketplace のアイコン | **入る**（必須） |
| `media/gcoordinator-extension.png` | README のスクリーンショット | 入らない |

Marketplace の README は**相対パスを解決しない**ので、スクリーンショットは
`https://raw.githubusercontent.com/tomohiron907/gcoordinator-extension/main/media/...`
の絶対 URL で貼る。GitHub から配信されるため vsix に同梱する必要がなく、
2MB の原寸画像がパッケージを膨らませないよう `.vscodeignore` で除外している。
アイコンだけは vsix に入っていないと表示されないので除外しないこと。

## まだ手付かずのこと

- **GitHub Release** — 今はタグを push するだけ。`gh` を入れれば
  `gh release create` で vsix を添付できる
