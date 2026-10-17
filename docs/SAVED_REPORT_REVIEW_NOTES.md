# Portable report review notes / 可移植报告审阅笔记

## English

Open a completed saved report, or open its observation JSON in Report files, and choose **Review this report**. The app captures the accepted observation and independently computes SHA-256 over its literal UTF-8 body. Choose **Open review** to start. An empty completed body supports whole-report notes; unavailable or other recorded statuses cannot be reviewed.

Add up to 32 plain-text notes, each 1–2,000 Unicode code points with non-whitespace content. Attach a note to the whole report or one of the first 200 headings recognized by the existing reader. **Show section** moves to that exact heading without changing Find or the report text. Repeated titles remain distinct by raw UTF-16 line-start offset. Save commits an edit; Cancel/Discard abandons it. Text, including line endings, is never trimmed or normalized. Over-limit input is rejected while the previous draft remains.

The workspace, notes and one unfinished editor remain in this tab's memory across ordinary app navigation. They are not autosaved. Reload, tab closure or another device does not restore them. A best-effort browser warning is registered while notes or authored draft text exist, even on another app page; the browser decides whether to show it. Downloading does not disable the warning or prove that a file was saved to disk.

Download **report observation JSON** and **review notes JSON** to continue later. Save or discard the editor first. Reopen the report observation (or the same saved report), capture it for review, then choose the notes file. Check the preview and explicitly **Open notes**. Import replaces the whole list, including when the imported list is empty. Cancel, a bad file or a stale operation preserves accepted notes. Starting another review also requires explicit replacement; current notes/edits require a current discard choice. No notes are silently moved to new report text.

The separate v1 notes envelope is:

```json
{"format":"mirofish-report-review-notes","version":1,"source":{"report_id":"report_A","text_sha256":"<64 lowercase hex characters>","text_bytes":123},"notes":[{"heading_start":null,"text":"Check this assumption."}]}
```

The notes file contains no report body or copied report metadata. It matches the captured report ID, independently computed SHA-256 and exact byte length. Different line endings or body text do not match. Observation timestamps and other metadata may differ; the active workspace keeps its own captured metadata. The status, metadata and identity in an imported observation remain unverified claims. Matching bytes verifies neither authorship nor accuracy. Existing observation v1, copy, comparison, Find and heading behavior remain unchanged.

Files are limited to 524,288 actual bytes, strict UTF-8, exact keys, parser depth 4 and 256 values. Unknown fields/versions, duplicate decoded keys, malformed Unicode, invalid numeric anchors, absent headings and mismatching bindings reject the whole file. One escaped spelling of an allowed JSON key is valid; a duplicate alias is not. New byte and offset fields reject negative zero. Notes are literal text, not HTML or Markdown. Nothing enters chat, prompts, browser storage or a backend. No new network request or dependency is used.

The existing portable observation serializer must accept the captured source before authoring is enabled. Missing or failing browser SHA-256 support rejects capture visibly. Otherwise unbounded metadata strings are shortened for display to 160 code points plus an ellipsis; stored source strings are unchanged. Imported filenames use the existing filename bounds; downloads use only the validated report ID and a fixed suffix.

## 中文

打开已完成的已保存报告，或在“报告文件”中打开观察 JSON，然后选择“审阅此报告”。应用会捕获已接受的观察记录，并独立计算原始 UTF-8 正文的 SHA-256。确认“打开审阅”后即可撰写笔记。空正文的已完成报告支持针对整个报告的笔记；正文不可用或其他记录状态不支持此流程。

最多可添加 32 条纯文本笔记，每条 1–2,000 个 Unicode 码点，并至少包含一个非空白字符。笔记可针对整个报告或阅读器识别的前 200 个标题。“查看章节”定位到精确标题，不改变查找状态或报告正文。相同标题文字按原始 UTF-16 行起始位置区分。保存提交编辑，取消或放弃编辑则保留原笔记。文本和换行原样保留；超限输入会被拒绝，之前的草稿仍保留。

工作区、笔记和一个未完成的编辑仅保存在此标签页内存中，应用内切换页面不会清空。没有自动保存；刷新、关闭标签页或更换设备不会恢复。存在笔记或已输入草稿内容时，应用尝试注册离开警告，是否显示由浏览器决定。下载请求不会证明磁盘保存成功，也不会关闭警告。

日后继续需要同时下载“报告观察 JSON”和“审阅笔记 JSON”。请先保存或放弃当前编辑。重新打开匹配的报告并捕获审阅快照后，选择笔记文件，检查预览并明确“打开笔记”。导入替换整个笔记列表，即使新列表为空也如此。取消、无效文件或过期操作不会改变现有笔记。替换报告或清空工作区时，必须明确选择放弃当前笔记和编辑；笔记不会自动迁移。

笔记文件不包含报告正文或复制的报告元数据，必须匹配报告 ID、独立计算的 SHA-256 和精确字节数。换行或正文变化均不匹配。时间戳及其他元数据可以不同，当前工作区仍显示自己的快照。匹配不证明作者或报告准确性。文件实际大小不超过 524,288 字节，采用严格 UTF-8、精确字段、解析深度 4 和最多 256 个值。未知字段、重复解码键、无效 Unicode、无效标题位置或绑定不匹配会使整个文件被拒绝。笔记按纯文本呈现，不进入聊天、提示词、浏览器存储或后端。

## Validation scope

The finite source proposal consists of eight pure-contract groups, six real Vue/router synthetic interaction groups and focused compatibility suites. Synthetic hosts can verify lifecycle, listener ownership and download initiation, not native delivery, keyboard/layout behavior or the browser's actual reload warning. No native browser qualification is claimed by source preparation.
