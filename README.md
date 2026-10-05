# GPTIME

Windows向け **unok/myime** に、ChatGPTログインで利用する **GPT-6 Luna** のかな漢字変換を追加するソース実装です。

## 現在の状態

- ローカル設定画面、ChatGPTのOAuth登録・再ログイン・トークン更新・ログアウトを実装。
- `gpt-6-luna` / `reasoning.effort: none` / 候補1件 / HTTP接続再利用 / 60秒のメモリキャッシュ。
- MyIMEの明示的な変換時だけLuna候補を先頭に追加。打鍵ごとの予測・アイドル再サジェスト・シークレットモードではクラウドを呼びません。
- 通信失敗・利用上限・タイムアウト時は既存のMyIME候補を使用。部分応答は採用しません。
- **Windows向けビルド・インストール、実アカウントでのOAuthと推論は未検証です。MSIはまだ生成していません。**
- ここで動作確認できた範囲はNode側の自動テスト、ローカルHTTP画面、および固定したMyIMEソースへの変更適用です。

「最速」は速度保証ではありません。Lunaの推論を無効にし、短い出力に絞った構成です。Fast/Ultrafastのアカウント対応は未確認のため指定していません。待ち時間上限はクラウド要求あたり1.2秒、Swift側1.3秒です。辞書変換時間は別途加算され、複数文節では文節ごとに呼ばれます。

## 起動

Node.js 22以上をインストールしたWindowsで、このフォルダの `start-windows.cmd` を実行します。または:

```powershell
npm ci --ignore-scripts
npm start
```

1. ブラウザで <http://127.0.0.1:18765> を開く。
2. **Continue with ChatGPT** を押し、ブラウザでログイン・アプリの利用を許可する。
3. 「Lunaによるクラウド変換を有効にする」をオンにする。
4. 「変換を試す」で実際の候補と応答時間を確認する。

起動直後のクラウド変換は毎回オフです。アカウントの認証情報は保存されます。アプリを終了するとMyIMEは辞書候補に戻ります。標準のMyIMEをインストールしただけでは連携されません。次のビルドが必要です。

## MyIMEへ組み込む

対象を固定しています:

- MyIME: `a8486eca5312556ff88fed7f1850a28843b67977`
- Mozcサブモジュール: `2d993fd532c0df849ff3a5f6c7851b3757471ed6`

Windows上でこのプロジェクトのルートから実行します:

```powershell
git clone https://github.com/unok/myime.git upstream/myime
git -C upstream/myime checkout a8486eca5312556ff88fed7f1850a28843b67977
git -C upstream/myime submodule update --init --recursive
npm run patch-myime
cd upstream/myime
.\build-x64.bat
```

`upstream/myime` はこのリポジトリには含めていません。取得済みのコピーを使う場合はclone/checkoutを省き、必要なサブモジュールを取得してください。

ビルドにはVisual Studio 2022のC++環境、Swift 6.3.3以上、Bazelisk、Python、Windows SDK等、[MyIMEのビルドガイド](https://github.com/unok/myime/blob/master/docs/build.md)の環境が必要です。生成される `Mozc_x64.msi` をWindowsで実行し、必要なら再起動します。既存のIMEの置き換えが発生するため、普段使いの端末へ入れる前にテスト環境で確認してください。

別のMyIMEチェックアウトにも適用できます:

```powershell
node scripts/patch-myime.mjs C:\src\myime
```

スクリプトはSwiftの `ConvertTextWithLuna` エクスポートを追加し、Mozcが明示的な変換時のみそれを選ぶよう変更します。古いDLLの場合は既存関数に戻ります。変更箇所が一致しない版には適用を拒否します。

低遅延を重視する場合、MyIME側の設定でローカルZenzaiとタイポ補正のAI評価をオフにしてください。通常の辞書候補は残ります。

## データと認証

読みはクラウド変換を有効にした場合のみOpenAIへ送られます。前後の文章、辞書内容、アプリの画面は送りません。APIは `store: false`、入力履歴はディスクに保存せず、直近の成功候補だけ最大256件・60秒キャッシュします。無効化・ログアウト時に破棄します。

認証情報はWindowsでは `%LOCALAPPDATA%\GPTIME\account.json` に保存します。ディレクトリのACLを現在のユーザーに制限します。`bridge.json` はMyIMEと常駐アプリ間の接続情報です。これらを共有・コミットしないでください。Linuxでは `~/.config/GPTIME` に0600で保存し、ブラウザ変換部分のみ試せます。開発テスト用の `GPTIME_DATA_DIR` 上書きはMyIME連携では使わないでください。

このアプリ専用のOAuth動的登録を使い、Codexや他のアプリの認証ファイルは読みません。ログアウトは更新トークンの失効を試み、失敗しても端末のトークンを削除して画面で通知します。

## 検証

```powershell
npm test
```

テストではOAuthのstate/client照合、並行更新、SSEのUTF-8分割・失敗・中断、キャッシュ、タイムアウト、キャンセルを検証します。実機ではログイン→有効化→メモ帳で変換→辞書候補への切替→シークレット入力→アプリ停止後のフォールバックを確認してください。

## 参照仕様

- [Sign in with ChatGPT 登録仕様](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [アカウントとトークン更新](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [ChatGPTプランでの推論仕様](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [MyIME](https://github.com/unok/myime)

ChatGPTプランでの利用可否・モデルへのアクセスは実際のログインと推論結果によって確認します。
