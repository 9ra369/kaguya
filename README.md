# Kaguya

プロジェクト対応 マルチ DCC ランチャー(現状のスコープは Houdini のみ)。

- **動的な環境変数**(ショットコンテキスト、`HOUDINI_PACKAGE_DIR` の向き先)→ プロジェクトごとの `env.bat`
- **静的な環境変数**(`JOB` / `PRJ` / OTL パス / `PYTHONPATH` など)→ Houdini packages(JSON)

という二層構造を UI 化したランチャー。右側の「Environment Stack」パネルで、起動前にどの変数がどの層から来るかを確認できる。v0.2 から**プロジェクト環境変数ビルダー**を搭載し、UI からプロジェクト名を入力するだけで packages JSON・ディレクトリ構成・起動設定が自動生成される。

---

## フォルダ構成(この 1 フォルダで完結)

```
Kaguya/
├── Kaguya.exe             ← ビルド後にここへ置く(開発中は npm start)
├── main.js / preload.js   ← Electron メインプロセス
├── builder.js             ← 環境変数ビルダー(DCC アダプタ方式)
├── renderer/              ← UI (HTML / CSS / JS)
├── config/
│   ├── projects.json      ← プロジェクトレジストリ(ビルダーが自動登録)
│   ├── apps.json          ← アプリ定義(名前・アイコン・exe パス)
│   ├── settings.json      ← 既定ルート・HOUDINI_AUTHOR 等のランチャー設定
│   └── templates/*.json   ← ディレクトリ構成テンプレート(追加・編集可)
├── projects/<ID>/env.bat  ← 動的層。手書きプロジェクト用 packages/ もここに置ける
├── packages_common/       ← 全プロジェクト共通の packages JSON
└── icons/                 ← apps/*.png, projects/*.png
```

## 起動フロー

```
[UI でアプリをクリック / シーンをダブルクリック]
        ↓
main.js が cmd.exe /c "projects/<ID>/env.bat" "<exe>" ["<scene>"] を spawn
(LAUNCHER_ROOT とショット選択由来の LAUNCHER_* を export して渡す)
        ↓
env.bat が HOUDINI_PACKAGE_DIR / HOUDINI_NO_ENV_FILE / ショット変数を set
        ↓
start "" <exe> → 環境変数は子プロセスへそのまま継承
        ↓
Houdini が HOUDINI_PACKAGE_DIR を走査し、各 *.json をアルファベット順にマージ
(JOB / PRJ はここで確定。$SEQ / $SHOT_ROOT など bat 確定値も参照可能)
```

システム環境変数には一切書き込まない。Kaguya 経由の起動時のみ有効なサンドボックス的挙動。

---

## プロジェクト環境変数ビルダー

Applications パネルの「＋ 新規プロジェクト」から起動。プロジェクト名を打つと JSON プレビューと出力先パスがリアルタイム更新される。

**入力**: プロジェクト名(英数字・`_`・`-` のみ) / ルート(既定値は `config/settings.json` の `defaultProjectRoot`) / テンプレート / DCC / 追加変数(key=value)

**生成されるもの**:

1. `<root>/<name>/packages/<name>.json` — Houdini packages 形式(UTF-8 BOM なし)

```json
{
    "load_package_once": true,
    "env": [
        { "JOB": "D:/projects/PRJ_cityDemo" },
        { "PRJ": "PRJ_cityDemo" },
        { "HOUDINI_OTLSCAN_PATH": { "value": "$JOB/otls", "method": "prepend" } }
    ],
    "path": "$JOB/houdini",
    "_launcher_meta": { "created": "...", "template": "default", "launcher_version": "0.2.0" }
}
```

   `HOUDINI_PATH` は直接触らず `path` キー経由、OTL パスは `method: "prepend"` で既定パスを保持する(`&` の二重展開問題を回避)。`_launcher_meta` は Houdini が無視するメタデータで、手書き編集しても壊れない。

2. `<root>/<name>/` 配下のディレクトリ群(チェック ON 時。テンプレートは `config/templates/*.json` で定義、`extra_env` プリセットも書ける)
3. `projects/<name>/env.bat` — 最小の動的層(packages の向き先 + ショット変数の受け口)
4. `config/projects.json` への自動登録(即座にプロジェクトセレクタに出現、`hipDir: "$JOB/hip"` 設定済み)

**バリデーション**: 名前の形式違反・ルート不存在・書き込み権限なしはエラー(作成不可)。パスのマルチバイト文字・スペース・260字超過は黄色警告(続行可、Houdini のマルチバイトパス起動失敗問題への注意喚起)。同名プロジェクトは上書き確認ダイアログ。

**設定** (`config/settings.json`): `defaultProjectRoot` のほか、`author`(→ `HOUDINI_AUTHOR`)、`tempDir`(→ `HOUDINI_TEMP_DIR`、マルチバイトパス回避用)、`anonymousStatistics`(`false` で `HOUDINI_ANONYMOUS_STATISTICS=0` を出力)。空なら出力しない。

**生成後の管理**: ビルダー製プロジェクトを選択中、Environment Stack ヘッダに「JSONを開く」「フォルダで表示」ボタンが出る。

### 設計メモ: JOB はどの層にあるか

手書きプロジェクト(bat に直接 JOB を書く流儀)は従来通り **bat で `JOB` を確定**してよい。ビルダー生成プロジェクトは仕様書に従い **package JSON 側に `JOB` を置く**。ランチャーは hipDir / ショット走査の解決時に「bat 変数 → packages の単純代入変数」の順でマージするため、どちらの流儀でも `$JOB/hip` が解決できる(bat が優先。`prepend`/`append` 形式はマージ対象外)。

また `HOUDINI_PACKAGE_DIR` は SideFX 公式ドキュメント通り**複数ディレクトリを `;` 連結可能**として扱っている(プロジェクト packages + `packages_common` の二層)。

---

## ショットセレクタ

`projects.json` のプロジェクトに `shots` キーを付けると、トップバーにショット選択が現れる。

**A. フォルダ走査**

```json
"shots": {
  "dir": "$JOB/shots",
  "pattern": "^KDM_(?<seq>[^_]+)_(?<subscene>[^_]+)_(?<cut>[^_]+)$"
},
"hipDirShot": "$SHOT_ROOT/houdini/hip"
```

**B. JSON ファイル**(Shot Tracker 連携の接続口): `"shots": { "file": "projects/KDM/shots.json" }`。`shots.example.json` の形式で書き出せばランチャー側は無変更で繋がる。`file` が `dir` より優先。

ショット選択時、ランチャーは `LAUNCHER_SHOTCODE / LAUNCHER_SEQ / LAUNCHER_SUBSCENE / LAUNCHER_CUT / LAUNCHER_SHOT_ROOT` を export して bat を起動し、bat 側で `set SEQ=%LAUNCHER_SEQ%` と受ける(bat 内の未定義 `%VAR%` は空展開なので未選択でも安全)。Scenes パネルは `hipDirShot` に切り替わり、Environment Stack もショット文脈で再解釈される。

---

## セットアップ

Node.js(v20 以降)を入れた上で:

```bat
cd Kaguya
npm install
npm start
```

初期状態はプロジェクト空(レジストリは `[]`)。「+ New Project」から作成を始める。UI 表示言語は英語。

最初に確認する場所:

1. **`config/apps.json`** — `exe` が実際の Houdini インストールパスか確認(**パスは必ず `/` 区切りで書く**。`C:\Program Files\...` のようにバックスラッシュで書くと JSON として不正になり、画面上部に Config error が表示される)
2. **`config/settings.json`** — `defaultProjectRoot` を自分のプロジェクト置き場に(New Project モーダルの Browse… ボタンで File Explorer からも選択可)

## exe 化(ポータブルビルド)

```bat
npm run dist
```

`dist/Kaguya.exe` をこのフォルダ直下(config と同階層)へコピーすれば、フォルダごと持ち運べる。ポータブル exe は `PORTABLE_EXECUTABLE_DIR` から自分の場所を検出して隣の `config/` を読む。

## マルチ DCC 拡張(将来)

変数構築は `builder.js` 内の DCC アダプタに分離済み(`adapters.houdini`)。Maya / Blender 対応は `buildEnv` / `packageExtras` / `batchTemplate` を持つアダプタを追加し、`apps.json` の DCC 種別と紐付ける。共通変数(`JOB` / `PRJ`)はコア側で構築される。起動系(bat の `%1 %2` 形式)は DCC 非依存なのでそのまま使える。

## 動作確認のヒント

- 生成 JSON 経由で起動した Houdini の HScript Textport で `echo $JOB` / `echo $PRJ` が期待値を返すこと
- `hconfig -p` でプロジェクト packages が読み込まれていること(パッケージのロード状況一覧)
- `hconfig HOUDINI_OTLSCAN_PATH` で `$JOB/otls` が先頭付加され、既定パスも残っていること
- Kaguya を経由せず起動した Houdini にプロジェクト環境が漏れていないこと(システム env 非汚染)

## 既知の制限

- 起動処理は Windows 専用(bat 前提)。UI・プレビュー・ビルダーは他 OS でも動く
- Environment Stack の bat 層プレビューは `set VAR=value` の静的解析(if 分岐は追わない)
- packages JSON の `enable` 条件・`append`/`prepend` の実マージ結果はプレビューでは評価しない(表記のみ)
- 再生成時の diff 表示(仕様書 §5.2)は未実装 — 現状は上書き確認のみ。`_launcher_meta.created` で世代は追える
- 456.py による `$JOB` 固定(§6.3)・起動プロファイル(§6.4)は未実装の将来拡張
