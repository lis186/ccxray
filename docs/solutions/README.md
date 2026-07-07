# solutions/ — 沉澱過的解法與教訓

每批 pipeline / 每次非 trivial 修復收尾時，把「下次會再遇到」的東西寫成一檔一事：

- codex 二審抓過的 finding 類型與修法模式
- 踩過的坑（root cause + 正確做法），含 fail-on-old 證據指標
- 值得重用的驗證手法 / fixture 形狀

格式：kebab-case 檔名、開頭一行 TL;DR、附 issue/PR 連結。**intake 與 planning 開工前先搜這裡**（`ccxray-intake` skill 的第一步）——第 50 張 issue 要比第 1 張快，靠的是這個目錄。

規則類的修訂不放這裡：改 `docs/issue-authoring.md` / `docs/issue-pipeline-runbook.md` 本體（經 PR）。
