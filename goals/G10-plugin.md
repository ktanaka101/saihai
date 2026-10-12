---
id: G10
parent: G0
status: 達成
version: 0.1
updated: 2026-10-12
---

# G10 使い始めの手間をなくす

> saihai を Claude Code のプラグインとして1回入れれば、どのプロジェクトでも一言で使い始められ、答えも会話の中で済むようにする。

## 意図

- 目的：使い始めを「プラグインを1回入れる」と「一言伝える」だけにし、人がコマンドを打たずに会話の中で答えられるようにする
- 理由：利用者が試そうとして「使い始めるのが面倒」と感じた。clone・ブランチ・init・新しいセッション・長いコマンド・main へのコミットの禁止が重なっていた。使い始めでつまずくと、ボトルネックを減らす前に使われない（J5、J83 の経緯）
- 望ましい最終状態：プラグインを入れたプロジェクトで「〇〇をゴールにして」と言えば、参謀がゴール文書の置き場を作って草案を書き、「受信箱」と言えば判断待ちを質問の形で出す。saihai を使っていないプロジェクトでは何も起きない

## 仮説と判定

- 仮説：なし（理由：G9 の手段。効果は導入先での G0 の仮説と、利用者の判定（Q46）で測る）

## 具体例

- E1 `[機械]` saihai のリポジトリがプラグインと配布元（マーケットプレイス）を兼ね、`claude plugin validate` を通る
- E2 `[機械]` プラグインのフックは、saihai を使っていないプロジェクト（goals/ も saihai.config.json もない）では何もせず、エラーも出さない
- E3 `[機械]` guard は、設定で `"guard": true` にしたプロジェクトだけで main への直接のコミットを止める
- E4 `[機械]` セッション開始のフックが、saihai を使うプロジェクトでだけ、委任の約束を文脈に入れる（CLAUDE.md を書き換えない）
- E5 `[機械]` goal-draft スキルは、ゴール文書の置き場がなければ `saihai init --minimal` で作る（CLAUDE.md・設定・スキルには触れない）
- E6 `[機械]` 受信箱のスキルが、判断待ちと事後確認を質問の形で出し、答えを `saihai answer`・`saihai confirm` で記録する
- E7 `[機械]` 新しいセッションでプラグインを読み込ませ、一言から草案、受信箱での回答までを、人がコマンドを打たずに通す

## 不変条件

- saihai を使っていないプロジェクトでは、プラグインは何も変えず、何も止めない — 理由：入れたすべてのプロジェクトでフックが動くため（G10.E2、G9 の不変条件）

## 推奨

- プラグインで使うスキルと、init で入れるスキルは同じ雛形から作る — 理由：2つがずれないようにする（G9.E5）

## 非ゴール

- Anthropic の公式ディレクトリへの登録（自分の配布元で足りるかを先に確かめる）

---

## AI 層

> ここから下は AI 向けの記録と根拠。人は根拠を確かめたいときだけ読めばよい。

### 設計

- リポジトリの根を、プラグイン（`.claude-plugin/plugin.json`）と配布元（`.claude-plugin/marketplace.json`、plugins の source は `"./"`）の両方にする
- `skills/`：goal-draft・interpret・inbox。templates から `{{saihai}}` を `saihai` にして作る（プラグインの `bin/` はセッションの PATH に入るので、短い名前で呼べる）
- `bin/saihai`：`saihai.mjs` を呼ぶシェルの入口（拡張子なしの名前で PATH から呼ぶため）
- `hooks/hooks.json`：SessionStart（`saihai context`）、PostToolUse（`check --hook`）、Stop（`check --stop`）、PreToolUse（`guard`）。どれも `--root "$CLAUDE_PROJECT_DIR"` を渡し、saihai を使っていないプロジェクトでは何もしない
- guard は設定の `"guard": true` のときだけ止める。saihai 自身と、init（全部入り）で入れたプロジェクトは true にする
- 利用者の手順：`/plugin marketplace add ktanaka101/saihai` → `/plugin install saihai@saihai`。あとは一言

### 調べたこと

- プラグインは `.claude-plugin/plugin.json`（name だけが必須）と、根の `skills/`・`hooks/hooks.json`・`bin/` からなる。スキルはプラグインの名前で区切られ（例：`saihai:goal-draft`）、`bin/` の中身はプラグインが有効な間、Bash の PATH に入る。フックの command では `${CLAUDE_PLUGIN_ROOT}`・`${CLAUDE_PROJECT_DIR}` が使える（[プラグインの参考資料](https://code.claude.com/docs/en/plugins-reference)）
- 配布元は `.claude-plugin/marketplace.json`（name・owner・plugins）。利用者は `claude plugin marketplace add <owner>/<repo>` と `claude plugin install <plugin>@<marketplace>` で入れる。`claude plugin validate` で確かめられる（[配布元の作り方](https://code.claude.com/docs/en/plugin-marketplaces)）
- プラグインのフックは、プラグインが有効なすべてのプロジェクトで動く。プラグインの根の CLAUDE.md は読み込まれない（同じ参考資料）

### 既知の落とし穴（プレモーテム）

「半年後にこのゴールが失敗していたら、原因は何か」

| 落とし穴 | 根拠 | 対策 |
|---|---|---|
| saihai を使っていないプロジェクトで、フックがエラーを出したりコミットを止めたりする | プラグインのフックはすべてのプロジェクトで動く | 使っていなければ何もしない（E2）。guard は設定で有効にしたときだけ（E3） |
| init で入れたフックと、プラグインのフックが二重に動く | investment-research には init で入れた | 二重でも結果は同じ（検査は冪等）。プラグインに移るなら、init で足した設定を外す手順を示す |
| スキルの名前が変わり（saihai:goal-draft）、利用者が呼び方に迷う | プラグインのスキルは名前で区切られる | 「ゴールにして」「受信箱」の言葉で呼ばれるよう、スキルの説明に書く |

### 判例

| ID | 日付 | 判断 | 強さ | 上申 | 置き換え |
|---|---|---|---|---|---|
| J84 | 2026-10-12 | 使い始めの手間をなくすため、saihai を Claude Code のプラグインとして配る（G10 を新設する。J77 の「プラグインは後で検討」を見直す）。具体例は E1〜E7 のとおりとする。推奨を採用（J37） | 仮置き | Q51 | ― |
| J85 | 2026-10-12 | guard は、設定で `"guard": true` にしたプロジェクトだけで効かせる。推奨を採用（J37） | 仮置き | Q52 | ― |
| J86 | 2026-10-13 | G10 を達成とする。E1〜E6 はテストと `claude plugin validate` で、E7 は新しいセッションにプラグインを読み込ませた実践で確かめた。推奨を採用（J37） | 仮置き | ― | ― |

### 経緯

- 2026-10-12：利用者が investment-research で試そうとして「使い始めるのが面倒じゃないか」と指摘した。参謀が手間を数えると、clone・ブランチ・init・コミット・新しいセッション・長いコマンド・main へのコミットの禁止が重なっていた。J37 に基づき推奨を採用した。採らなかった自明な案は次のとおり。Q51（手間の減らし方）は「init のコマンドを短くし、手順書を整える」（手順の数は減らない）。Q52（guard の扱い）は「プラグインでも常に有効にする」（saihai を使っていないプロジェクトのコミットまで止める）
- 2026-10-13：実装した（D32）。`.claude-plugin/`（plugin.json・marketplace.json）、`hooks/hooks.json`、`bin/saihai`、`skills/`（goal-draft・interpret・inbox）。saihai を使っていないプロジェクトでは、フックは何もしない。guard は設定で有効にしたときだけ効く
- 2026-10-13：E7 として、真っさらなプロジェクト（家計の支出の集計）で、新しいセッションに `--plugin-dir` でプラグインを読み込ませた
  - 一言（「毎月の支出の集計に手間がかかっていて、使いすぎに気づくのが月末になってしまう。早く気づけるようにしたい。ゴールにして。」）だけで、参謀が `saihai init --minimal` で置き場を作り、G0 の草案（判断待ち4件、出典4件）を書いて作業ブランチにコミットした。約1分。CLAUDE.md は変わらず、`.claude/` もできなかった
  - 2つ目のセッションで「受信箱」と言うと、inbox スキルが質問の案を示し、渡した答え（3件は推奨、1件は自由記述）を `saihai answer` で判例に移した。判断待ちが0件になり、G0 は進行中に進んだ。人はコマンドを打っていない
  - 使い始めの手間：G9 では clone・ブランチ・init・コミット・新しいセッション・長いコマンドが要った。G10 ではプラグインを1回入れて、一言伝えるだけになった
  - 確かめていないこと：`claude -p` では質問の画面を出せないので、AskUserQuestion で実際に人が選ぶ流れは、まだ人の手で確かめていない
- 2026-10-13：利用者から「これだとプロジェクトだけじゃなく全体に影響する」と指摘された。プラグインの既定の入れ方（user）は、すべてのプロジェクトで有効になる。入れる範囲は user・project・local から選べるので、README の手順を `--scope local`（自分の、そのプロジェクトだけ。`.claude/settings.local.json`）に改めた。`marketplace add` だけはユーザーの設定に入るが、一覧を登録するだけで、プラグインは動かない（[プラグインの入れ方](https://code.claude.com/docs/en/plugins/install)）
