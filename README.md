# saihai（采配）

人は采配を振るだけ。

ソフトウェアづくりは「ゴール設定 → 実装 → 現実からの観測 → 解釈と次の判断」のループです。実装は AI で速くなりましたが、残りの3つは人の注意力が要り、ループの速さを決めています。saihai は、この実装以外の3つを支え、人の注意力を判断にだけ使えるようにするフレームワークです。

- **ゴール設定**：一言の意図から、AI（参謀）が下調べ・仮説・理由つきの制約を添えたゴール文書の草案を作る。人は判断待ちに答えるだけ
- **実装（AI に任せる）**：実装する AI は委任指示に従い、報告条件に当たらない判断は自分で決めて判断ログに残す。main への反映は門番が行う
- **現実からの観測**：ゴールの仮説に書いた観測の式から、当たり・外れを自動で判定する
- **解釈と次の判断**：人が開くのは受信箱だけ。いま判断すべきことが5件まで並ぶ。仮説が判定されたゴールは、参謀が事後検証（AAR）して次の判断を上申する

考え方の土台は、委任型指揮（Auftragstaktik）です。人が書くのは、意図（目的・理由・望ましい最終状態）と、不変条件と、報告条件だけです。制約には理由と強さ（不変条件・推奨・仮置き）を付けるので、AI は理由に照らして逸脱を報告できます。

## 必要なもの

- Node.js 22.8 以上（依存パッケージはありません）
- git
- [Claude Code](https://code.claude.com/)（スキルとフックを使います）

## 導入する

```bash
git clone https://github.com/ktanaka101/saihai.git ~/codes/saihai
```

導入したいプロジェクト（git のフォルダ）で:

```bash
node ~/codes/saihai/bin/saihai.mjs init
```

次のものが入ります。既にある CLAUDE.md と `.claude/settings.json` は上書きせず、saihai の節とフックを足すだけです。2回動かしても重複しません。

| 入るもの | 役割 |
|---|---|
| `goals/G0-project.md` | ゴールの木の根。最初は雛形 |
| `decisions/log.jsonl` | 判断ログ（実装する AI の判断・逸脱・報告） |
| `saihai.config.json` | 門番の検査と観測のコマンドの設定 |
| `CLAUDE.md` の saihai の節 | 実装する AI への約束（委任指示・判断ログ・門番） |
| `.claude/skills/goal-draft`・`interpret` | 参謀の手順（草案づくり、解釈と事後検証） |
| `.claude/settings.json` のフック | ゴール文書の検査、main への直接のコミットの防止 |

フックとスキルからは、PATH 上に `saihai` があればそれを、なければ init した saihai の絶対パスを呼びます。saihai のフォルダを動かしたら、もう一度 init してください。

## 使う

Claude Code で、やりたいことを一言で伝えます（例：「CSV の取り込みを速くしたい。ゴールにして」）。参謀が goal-draft スキルで草案を作り、判断待ちを聞いてきます。

| コマンド | すること |
|---|---|
| `saihai inbox` | 受信箱：いま人が判断すべきこと（5件まで）と、ゴールごとの段階 |
| `saihai new --parent G0 --slug name --title "題名" --summary "要約"` | ゴール文書の雛形を作る |
| `saihai check` | ゴール文書と判断ログを検査する |
| `saihai brief G1` | 実装する AI への委任指示（祖先のゴールの不変条件・報告条件を含む） |
| `saihai log --goal G1 --kind 判断 ...` | 判断ログに1件足す |
| `saihai observe` | 観測と仮説の判定。`--save` で履歴に残す。`--record 指標=値` で人の観測を記録する |
| `saihai aar G1` | 事後検証の材料（起きるはずだったこと・起きたこと） |
| `saihai gate` | 門番：最新の main とマージした結果を検査し、通れば main に反映して push する |

`saihai` は `node ~/codes/saihai/bin/saihai.mjs` のことです。対象のプロジェクトは `--root`、環境変数 `SAIHAI_ROOT`、今のフォルダから上へたどる、の順で決まります。

## ゴール文書

1つのゴールを1つの Markdown にします。人が読む人間層（40行まで）と、AI 向けの記録の AI 層に分かれます。

```markdown
## 意図
- 目的：…
- 理由：…
- 望ましい最終状態：…

## 仮説と判定
- 仮説：これを作れば、誰の何がどう良くなるはずか
- 当たりの判定：…（観測：`取り込み時間の中央値 <= 3`）
- 外れの判定：…（観測：`取り込みの失敗 >= 1`）

## 具体例
- E1 `[機械]` 自動で確かめる受け入れの例

## 不変条件
- 必ず守ること — 理由：なぜ（関わる ID）

## 報告条件
- 実装を止めて人に聞く条件
```

書式の詳細は [G1](goals/G1-goal-format.md) と [G1.2](goals/G1.2-format-v2.md) にあります。

## 設定（saihai.config.json）

```json
{
  "gate": {
    "checks": [{ "name": "テスト", "cmd": ["npm", "test"] }],
    "push": true
  },
  "probes": {
    "取り込み時間の中央値": { "command": "node scripts/measure.mjs", "examples": ["G1（仮説）"] }
  }
}
```

- `gate.checks`：門番の検査。既定のゴール文書の検査の後ろに足される。`push: false` にすると、リモートに push せず手元の main だけを更新する
- `probes`：観測のコマンド。標準出力の1つ目の数値が値、2つ目が件数。名前を仮説の観測の式に書くと、当たり・外れの判定に使われる

## saihai 自身

このリポジトリは saihai を saihai で作っています。ゴールは [goals/](goals/)、判断ログは [decisions/log.jsonl](decisions/log.jsonl) にあります。評価の導出（実装を見ない評価 AI と隠しシナリオ）は、今は saihai 自身にだけあります。

開発：`npm test`（Node.js のテスト、行のカバレッジ80%以上）。
