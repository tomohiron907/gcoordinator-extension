# Windows での SpaceMouse 動作確認

開発は macOS、動作確認は Windows 実機、という往復を繰り返すための手順。
Windows 側にリポジトリのクローンは不要で、Mac で作った vsix を 1 つ持っていくだけ。

## 背景（なぜ確認が要るのか）

SpaceMouse の読み取り方はプラットフォームで別物になっている。

| | 読み取り方 | 実装 | フォーカス制御 |
|---|---|---|---|
| macOS | `3DconnexionClient.framework` を叩く C ヘルパー (`bin/spacemoused`) を spawn | `src/spacemouseHelper.ts` | ドライバ側の調停 + `SpaceMouseGate` |
| Windows | node-hid で raw HID を直接読む | `src/spacemouseHid.ts` | **`SpaceMouseGate` のみ** |

macOS の DriverKit dext はデバイスを `kIOHIDOptionsTypeSeizeDevice` で掴むため raw HID では開けない。
Windows の 3DxWare は掴まないので raw HID が通る（2026-07-30 に実機で確認済み）。

つまり **Mac で動いても Windows で動く保証はまったく無い**。両者は共通コードが
`src/spacemouseHost.ts` のファサードと `SpaceMouseGate` だけで、デバイスに触る部分は完全に別。
特に Windows にはドライバ側のフォーカス調停が無いので、`SpaceMouseGate` の挙動は
Windows でしか本当の意味で検証できない。

---

## 一度だけやる準備

### Mac 側

```bash
npm ci
```

`vsce` は `npx` で都度取ってくるのでインストール不要。

### Windows 側

- 3DxWare（3Dconnexion のドライバ）をインストールしておく。SpaceMouse ユーザーなら普通は入っている。
- VS Code をインストールし、`code` コマンドが PATH に通っていることを確認する。

```powershell
code --version
```

- Node.js は**通常の確認では不要**。「切り分け」セクションの `hid-probe.js` を使うときだけ要る。

---

## 毎回の手順

### 1. Mac: vsix をビルド

```bash
npm run build:native      # bin/spacemoused (universal binary) を生成
npm run build             # out/extension.js と media/*.bundle.js を生成
npx vsce package
```

`bin/` と `out/` は gitignore されていて、`build:native` は macOS の clang と SDK を要求する。
つまり **vsix は必ず Mac で作る**。Windows 側でビルドする方法は用意していない。

`npm run build:native` は macOS 用ヘルパーのビルドなので、Windows の挙動だけを見たいときは
省いてもよい（`bin/spacemoused` が既にあれば `vsce package` は通る）。ただし配布用の vsix を
作るときは必ず両方走らせること。

出来上がるのは `gcoordinator-extension-<version>.vsix`（約 900 KB / 24 ファイル）。
`repository` フィールドと LICENSE が無いという警告が 2 つ出るが、パッケージ自体は成功する。

中身の確認（任意）:

```bash
npx vsce ls
```

`node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4.node` が入っていれば
Windows でネイティブモジュールがロードできる。node-hid 3.4 は全プラットフォームの
prebuild を npm パッケージに同梱しているので、**1 つの vsix が Mac でも Windows でも動く**。
CI マトリクスもプラットフォーム別 vsix も要らない。

### 2. Windows: インストール

**同じバージョン番号で上書きインストールすると古い方が残ることがある。** 毎回この順で:

```powershell
code --uninstall-extension gcoordinator-extension
code --install-extension C:\path\to\gcoordinator-extension-0.0.1.vsix
```

その後 **VS Code を完全に終了して再起動**する（`onStartupFinished` で有効化されるため、
ウィンドウのリロードだけでは古いネイティブモジュールが掴まれたままになることがある）。

`package.json` の `version` を上げてからパッケージすると、インストール済みかどうかが
拡張機能ビューで一目で分かるので、確認を繰り返すときは上げておくと楽。

### 3. Windows: Output チャンネルを開く

`Ctrl+Shift+U` → 右上のドロップダウンで **`gcoordinator SpaceMouse`** を選ぶ。

ドロップダウンに出てこない場合は拡張機能が起動していない。`Ctrl+Shift+P` で
`gcoordinator` と打ってコマンドが 3 つ出るかを先に確認する。

### 4. Windows: プレビューを開く

`.gcode` ファイルを開いて `Ctrl+Shift+P` → **`gcoordinator: Preview G-code`**。

---

## チェックリスト

### 接続

- [ ] Output に `opening <製品名> @ \\?\hid#vid_256f...` が 1 行出る
- [ ] Output に `SpaceMouse unavailable:` が**出ない**
- [ ] 右下に警告トーストが**出ない**
- [ ] プレビュー左下のオーバーレイが**緑**で `SpaceMouse: <製品名>`

### 入力

- [ ] パックを倒すとオーバーレイの `tx/ty/tz/rx/ry/rz` が動く
- [ ] 手を離すと 250 ms 以内に全部 0 に戻る
- [ ] モデルが平行移動・回転する
- [ ] 手を離すとぴたっと止まる（ドリフトし続けない）
- [ ] 各軸の向きが Mac と一致している（反転・入れ替わりが無い）
- [ ] 感度が Mac と同程度

### 共存（この実装の本題）

- [ ] プレビューを開いたまま Fusion 360 を起動し、Fusion 側でパックが効く
- [ ] タスクトレイの 3Dconnexion アイコンが消えていない
- [ ] タスクマネージャで 3DxWare のプロセスが生きている

### フォーカスゲート（Windows 固有・重点確認）

Windows にはドライバ側の調停が無く `SpaceMouseGate` だけが誤動作を止めている。

- [ ] Fusion を最前面にしてパックを大きく動かす → VS Code に戻ったときビューが動いていない
- [ ] VS Code に戻すと再びプレビューが動く
- [ ] VS Code 内でコードエディタをクリックした状態でもプレビューは動く（仕様。パネルが `active` でなくても `visible` なら通す）
- [ ] プレビュータブを別タブで隠すと反応しない

### 後始末

- [ ] プレビューを閉じても Output に異常が出ない
- [ ] 閉じた直後に Fusion でパックが使える
- [ ] 開く / 閉じるを 3〜4 回繰り返しても毎回 `opening …` が出て接続できる
- [ ] VS Code を終了しても 3DxWare が生きている

---

## Output に出るメッセージ

成功時に出るのはこの 1 行だけ:

```
[12:34:56.789] opening SpaceMouse Wireless @ \\?\hid#vid_256f&pid_c62e&mi_00#...
```

失敗時は `SpaceMouse unavailable: <理由>` が出て、同時に右下に
`[gcoordinator] SpaceMouse: <理由>` のトーストが「Show log」ボタン付きで**1 回だけ**出る。
背後では 2 秒ごとに再試行し続けているので、後からデバイスを挿せば勝手に繋がる。

| 理由 | 意味 | 対処 |
|---|---|---|
| `could not load the HID module: …` | node-hid のネイティブモジュールがロードできない | vsix に win32 prebuild が入っているか `npx vsce ls` で確認。`.vscodeignore` の再include を疑う |
| `no SpaceMouse found — connect the device and reopen the preview` | 列挙に引っかからない | `hid-probe.js` で vendor ID を確認（`src/spacemouseHid.ts` の `VENDOR_IDS`） |
| `could not open <製品名> — …` | デバイスが占有されている | `hid-probe.js` で 3DxWare 停止時と比較。占有なら Windows 用ヘルパー方式の検討が必要 |
| `could not enumerate HID devices: …` | node-hid の列挙自体が失敗 | ネイティブモジュールの読み込みは成功しているので、権限かドライバ側の問題 |
| `SpaceMouse support is not available on …` | `process.platform` が `win32` でない | まず起きない |

オーバーレイ（プレビュー左下）は接続時が**緑**の `SpaceMouse: <製品名>`、
未接続時が**オレンジ**の `SpaceMouse: searching...`。

---

## 切り分け（動かなくなったとき）

拡張機能を疑う前に、生 HID そのものが通るかを確認する。`docs/hid-probe.js` を
Windows 機にコピーして:

```powershell
mkdir $HOME\hid-probe
cd $HOME\hid-probe
npm init -y
npm i node-hid@3
node hid-probe.js
```

`npm i node-hid@3` はプリビルドを展開するだけで、Visual Studio Build Tools も Python も要らない。
node-gyp のビルドログが流れ始めたらプリビルドの解決に失敗している。

3DxWare を動かしたまま実行し、パックを X → Y → Z → 各回転の順にゆっくり倒す。

- **数値が動く** → 生 HID は問題ない。拡張機能側（`spacemouseHid.ts` / `SpaceMouseGate` / webview）のバグ
- **`オープン失敗`** → 何かがデバイスを占有している。3DxWare のバージョン変更か、他の常駐ソフトを疑う
- **開けるがデータが来ない** → 3DxWare を一時終了して再実行。止めたら来るなら共存が壊れている

出力で見るべき点:

- `usagePage=1 usage=8` の行があるか（拡張機能はこれを優先して選ぶ）
- `report=` の番号（1 だけか、1 と 2 が交互か）と `len=`（13 か 7 か）
  → `src/spacemouseHid.ts` の `onReport()` がこの 3 パターンを分岐している
- パックを最大まで倒したときの値。**±350 前後**なら Mac と同スケール
  （macOS ヘルパーは `AXIS_SCALE = 350/512` で raw HID のレンジに正規化している）
- 軸の順番（X で 1 番目、Y で 2 番目、Z で 3 番目が動くか）

---

## 確認済みの構成

2026-07-30 に vsix インストールで動作確認済み。挙動が変わったらこの表と比較する。

- Windows + 3DxWare インストール済み、raw HID との共存 OK
- macOS: `bin/spacemoused` 経由、ドライバを一切停止せず Fusion 360 と共存 OK
- 1 つの vsix で両プラットフォームをカバー（node-hid 3.4 の全プラットフォーム prebuild 同梱による）
