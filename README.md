# PDF Sheet Music Editor

GitHub Pagesで動作するPDF楽譜エディターです。

## パート名の自動認識

- PaddleOCR.js（公式JavaScript SDK）を使用します。
- PP-OCRv6 small、日本語・英語対応モデルをブラウザ内で実行します。
- 各ページ上部28%をPDF.jsで画像化し、OCRで文字を抽出します。
- OCR結果から楽器名・パート名を判定し、ページを分類します。
- PDF画像はOCR処理のために外部サーバーへ送信しません。
- APIキー不要、OCR利用料不要です。
- 初回利用時にOCRモデル（約31 MB）と関連ライブラリをCDNからダウンロードします。2回目以降はブラウザキャッシュが利用される場合があります。

## 使用ライブラリ

- PDF.js 3.11.174
- pdf-lib 1.17.1
- PaddleOCR.js 0.4.2 / PP-OCRv6
- ONNX Runtime Web（PaddleOCR.js依存）

## 公開

GitHub Pagesの `main` ブランチを公開元に設定してください。

公開後：
https://tsuritetsu-eng.github.io/Ensemble-Score-Spliter/

## 注意

- OCRはヘッダー内の文字を読み取る機能です。楽譜の音符や演奏内容を解析するものではありません。
- 楽器名が認識されない場合や、OCRの読み違いがある場合は、ページのパート名を手動で修正してください。
- 認識速度は端末性能に左右されます。スマートフォンでは初回のモデル読み込みや認識に時間がかかることがあります。
- 現在のフロントエンドはNVIDIA APIやCloudflare WorkerをOCR処理に使用しません。旧Workerソースは互換性確認用にリポジトリに残っています。
