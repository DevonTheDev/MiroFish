# Jump to a heading in saved reports

Open a report in **Saved reports**, or choose a saved report observation JSON file and explicitly **Open** it in **Report files**. Use **Headings in saved text** to choose a heading, then **Jump to heading** to focus and scroll to its literal line. Selecting alone does not move focus. The level and line number distinguish repeated titles.

The list recognizes one to six leading `#` markers followed by a space, tab or line end, with up to three leading spaces. It omits empty headings and headings inside plain backtick or tilde fences. This is a literal line index, not a full Markdown block parser: setext headings and explicit list/quote prefixes do not qualify; an otherwise matching continuation line inside list or HTML context can qualify. Inline markup and HTML remain text.

At most the first 200 recognized headings are listed. An excess notice appears only when another eligible heading exists. Labels show up to 160 Unicode code points plus an ellipsis when shortened. The complete saved body remains readable, searchable, copyable and downloadable, including original line endings.

Jump leaves Find's query, case choice and selected match intact. A later Find action, heading choice or Jump supersedes an earlier pending navigation. Moving focus to another control while a Jump is pending cancels that handoff. A focused heading fragment is outlined; if Find splits the heading, that fragment can contain only its initial portion. Find still highlights each complete match, including matches across lines.

Find and language changes preserve the heading choice. In Report files, reading or previewing a replacement, rejecting it or cancelling preserves the accepted report and its choice. Opening a replacement, clearing the accepted file, leaving the route or closing the reader retires that choice. Captured comparison slots keep their existing independent lifecycle.

This control describes headings recognized in saved text. It does not establish the report's completeness, accuracy or currentness. It makes no new network requests and does not change the saved observation, downloads, comparison content or URL.
