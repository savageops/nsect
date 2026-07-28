export function htmlToMarkdown(html) {
  let md = html;
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n");
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n");
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n");
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n");
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, "##### $1\n\n");
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, "###### $1\n\n");
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
  md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
  md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
  md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, "```\n$1\n```\n");
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  md = md.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, "> $1\n\n");
  md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
  md = md.replace(/<hr\s*\/?>/gi, "---\n\n");
  md = md.replace(/<[^>]+>/g, "");
  md = md.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  md = md.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  return md;
}

/**
 * Format page content for output. The unified envelope contract:
 *   - text/html/markdown → returns a string.
 *   - json → returns a parsed object (NOT a stringified JSON string).
 *   - links → returns a parsed array of {href, text} (NOT a joined string).
 *
 * The CLI layer stringifies structured outputs for stdout; the HTTP API
 * serializes them naturally in the JSON response. Callers reading the envelope
 * check `result.format` to know whether `output` is a string or structured.
 */
export function formatOutput(data, format) {
  switch (format) {
    case "text":
      return data.text || "(no text content)";
    case "html":
      return data.html;
    case "markdown":
      // Prefer defuddle's pre-rendered markdown (DOM-scored, boilerplate-stripped)
      // over the regex converter. Fall back to regex only if defuddle returned none.
      return data.markdown || htmlToMarkdown(data.html);
    case "links":
      // Structured: parsed array, not a joined string.
      return data.links;
    case "json":
      // Structured: parsed object, not a stringified JSON string. Includes the
      // schema.org structured data and bibliographic fields when available.
      return {
        title: data.title,
        url: data.url,
        text: data.text,
        markdown: data.markdown,
        links: data.links,
        meta: data.meta,
        ...(data.author ? { author: data.author } : {}),
        ...(data.published ? { published: data.published } : {}),
        ...(data.schemaOrg?.length ? { schemaOrg: data.schemaOrg } : {}),
      };
    default:
      return data.text;
  }
}

/**
 * Format search results. Mirrors the envelope contract: `json` returns the
 * parsed array (not stringified), `links` returns a parsed array of URL
 * strings, text/markdown return prose strings.
 */
export function formatGoogleResults(results, format) {
  switch (format) {
    case "json":
      return results;
    case "links":
      return results.map((r) => r.url);
    case "text":
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
    case "markdown":
      return results
        .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   > ${r.snippet}`)
        .join("\n\n");
    default:
      return results;
  }
}
