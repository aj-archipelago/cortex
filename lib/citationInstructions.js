const MARKDOWN_CITATIONS = `For Markdown prose (chat replies, digests and summaries), cite search results with :cd_source[searchResultId]. Copy each searchResultId exactly from the result. Put each directive after the claim it supports. Cite multiple sources with separate directives. Do not add duplicate source links alongside these directives.`;

const HTML_CITATIONS = `For HTML documents, reports, widgets and HTML files written with tools, use ordinary HTML links to cite sources. Link the source name near the supported claim, or use numbered anchors leading to a Sources section with working source links. Copy each destination URL from the actual source record; never invent a URL or derive one from a searchResultId. Escape HTML attributes. Do not put :cd_source[...] directives or Markdown link syntax in displayed HTML prose. If a source has no usable URL, identify it by its supplied title and state that a link is unavailable. Keep citations readable in both themes and in RTL. Literal code examples and Markdown response data passed to a native citation renderer may contain directives; displayed HTML prose may not.`;

/** Select at the output boundary, not from source material or prior reports. */
export function buildGroundingInstructions(format = 'markdown') {
    const heading = '# Grounding responses\n\nCite sourced factual claims using the format of the content being produced. These rules also apply to generated artifacts and override citation-format instructions copied from an earlier report. Never fabricate sources.\n\n';
    if (format === 'html') return `${heading}The requested output is HTML.\n\n${HTML_CITATIONS}`;
    if (format === 'mixed') return `${heading}The requested output contains multiple formats. Apply the rules separately to each field: summary is Markdown; html and widgetHtml are HTML documents. JSON is only the envelope.\n\n${MARKDOWN_CITATIONS}\n\n${HTML_CITATIONS}`;
    return `${heading}${MARKDOWN_CITATIONS}\n\nWhen a Markdown conversation creates an HTML artifact, apply the following rules inside that artifact only:\n${HTML_CITATIONS}`;
}
