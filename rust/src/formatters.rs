use regex::Regex;

use crate::models::{PageContent, SearchResultItem};

/// Compiled-once formatter regexes. Previously every `html_to_markdown` call
/// recompiled 20 regexes from scratch (point 8); caching them in LazyLock
/// eliminates that per-call compilation cost.
static FORMATTER_REGEXES: std::sync::LazyLock<Vec<(&'static str, &'static str, Regex)>> =
    std::sync::LazyLock::new(|| {
        [
            (r"(?i)<h1[^>]*>(.*?)</h1>", "# $1\n\n"),
            (r"(?i)<h2[^>]*>(.*?)</h2>", "## $1\n\n"),
            (r"(?i)<h3[^>]*>(.*?)</h3>", "### $1\n\n"),
            (r"(?i)<h4[^>]*>(.*?)</h4>", "#### $1\n\n"),
            (r"(?i)<h5[^>]*>(.*?)</h5>", "##### $1\n\n"),
            (r"(?i)<h6[^>]*>(.*?)</h6>", "###### $1\n\n"),
            (r"(?i)<p[^>]*>(.*?)</p>", "$1\n\n"),
            (r"(?i)<br\s*/?>", "\n"),
            (r"(?i)<strong[^>]*>(.*?)</strong>", "**$1**"),
            (r"(?i)<b[^>]*>(.*?)</b>", "**$1**"),
            (r"(?i)<em[^>]*>(.*?)</em>", "*$1*"),
            (r"(?i)<i[^>]*>(.*?)</i>", "*$1*"),
            (r"(?i)<code[^>]*>(.*?)</code>", "`$1`"),
            (r"(?is)<pre[^>]*>(.*?)</pre>", "```\n$1\n```\n"),
            (r#"(?i)<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>"#, "[$2]($1)"),
            (r"(?i)<li[^>]*>(.*?)</li>", "- $1\n"),
            (r"(?is)<blockquote[^>]*>(.*?)</blockquote>", "> $1\n\n"),
            (
                r#"(?i)<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>"#,
                "![$1]($2)",
            ),
            (r"(?i)<hr\s*/?>", "---\n\n"),
            (r"(?is)<[^>]+>", ""),
        ]
        .into_iter()
        .map(|(pattern, replacement)| {
            let regex = Regex::new(pattern).expect("valid formatter regex");
            (pattern, replacement, regex)
        })
        .collect()
    });

static COLLAPSE_NEWLINES: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"\n{3,}").expect("valid collapse regex"));

pub fn html_to_markdown(html: &str) -> String {
    let mut md = html.to_string();

    for (_pattern, replacement, regex) in FORMATTER_REGEXES.iter() {
        md = regex.replace_all(&md, *replacement).to_string();
    }

    md = md
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");

    COLLAPSE_NEWLINES
        .replace_all(md.trim(), "\n\n")
        .to_string()
}

/// Format page content. Unified envelope: returns a Value::String for
/// text/html/markdown, Value::Array for links, Value::Object for json. Callers
/// check the format to know which variant to expect.
pub fn format_page_output(data: &PageContent, format: &str) -> serde_json::Value {
    match format {
        "text" => {
            if data.text.trim().is_empty() {
                serde_json::Value::String("(no text content)".to_string())
            } else {
                serde_json::Value::String(data.text.clone())
            }
        }
        "html" => serde_json::Value::String(data.html.clone()),
        "markdown" => serde_json::Value::String(html_to_markdown(&data.html)),
        "links" => serde_json::Value::Array(
            data.links
                .iter()
                .map(|link| serde_json::to_value(link).unwrap_or(serde_json::Value::Null))
                .collect(),
        ),
        "json" => serde_json::json!({
            "title": data.title,
            "url": data.url,
            "text": data.text,
            "links": data.links,
            "meta": data.meta,
        }),
        _ => serde_json::Value::String(data.text.clone()),
    }
}

pub fn format_search_results(results: &[SearchResultItem], format: &str) -> serde_json::Value {
    match format {
        "json" => serde_json::to_value(results).expect("results should serialize"),
        "links" => serde_json::Value::Array(
            results
                .iter()
                .map(|result| serde_json::Value::String(result.url.clone()))
                .collect(),
        ),
        "text" => serde_json::Value::String(
            results
                .iter()
                .enumerate()
                .map(|(index, result)| {
                    format!(
                        "{}. {}\n   {}\n   {}",
                        index + 1,
                        result.title,
                        result.url,
                        result.snippet
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        ),
        "markdown" => serde_json::Value::String(
            results
                .iter()
                .enumerate()
                .map(|(index, result)| {
                    format!(
                        "{}. [{}]({})\n   > {}",
                        index + 1,
                        result.title,
                        result.url,
                        result.snippet
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        ),
        _ => serde_json::to_value(results).expect("results should serialize"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DiscoveredLink, PageContent};
    use std::collections::BTreeMap;

    fn make_page(html: &str, text: &str) -> PageContent {
        PageContent {
            title: "Test".to_string(),
            url: "https://example.com".to_string(),
            text: text.to_string(),
            html: html.to_string(),
            links: vec![],
            meta: BTreeMap::new(),
            schema_org: vec![],
        }
    }

    // --- html_to_markdown ---

    #[test]
    fn converts_headings() {
        assert!(html_to_markdown("<h1>Title</h1>").contains("# Title"));
        assert!(html_to_markdown("<h2>Sub</h2>").contains("## Sub"));
        assert!(html_to_markdown("<h3>Sub2</h3>").contains("### Sub2"));
    }

    #[test]
    fn converts_paragraphs() {
        let result = html_to_markdown("<p>Hello world</p>");
        assert!(result.contains("Hello world"));
    }

    #[test]
    fn converts_bold_and_italic() {
        assert!(html_to_markdown("<strong>bold</strong>").contains("**bold**"));
        assert!(html_to_markdown("<b>bold</b>").contains("**bold**"));
        assert!(html_to_markdown("<em>italic</em>").contains("*italic*"));
        assert!(html_to_markdown("<i>italic</i>").contains("*italic*"));
    }

    #[test]
    fn converts_code_and_pre() {
        assert!(html_to_markdown("<code>var x</code>").contains("`var x`"));
        let result = html_to_markdown("<pre>block code</pre>");
        assert!(result.contains("```\nblock code\n```"));
    }

    #[test]
    fn converts_links() {
        let result = html_to_markdown(r#"<a href="https://example.com">Link</a>"#);
        assert!(result.contains("[Link](https://example.com)"));
    }

    #[test]
    fn converts_lists() {
        let result = html_to_markdown("<li>Item 1</li><li>Item 2</li>");
        assert!(result.contains("- Item 1"));
        assert!(result.contains("- Item 2"));
    }

    #[test]
    fn converts_blockquote() {
        let result = html_to_markdown("<blockquote>Quote text</blockquote>");
        assert!(result.contains("> Quote text"));
    }

    #[test]
    fn converts_hr() {
        assert!(html_to_markdown("<hr/>").contains("---"));
    }

    #[test]
    fn converts_br() {
        let result = html_to_markdown("line1<br/>line2");
        assert!(result.contains("line1\nline2"));
    }

    #[test]
    fn decodes_html_entities() {
        assert!(html_to_markdown("<p>a &amp; b</p>").contains("a & b"));
        assert!(html_to_markdown("<p>&lt;tag&gt;</p>").contains("<tag>"));
        assert!(html_to_markdown(r#"<p>&quot;hello&quot;</p>"#).contains("\"hello\""));
        assert!(html_to_markdown("<p>it&#39;s</p>").contains("it's"));
    }

    #[test]
    fn strips_remaining_html_tags() {
        let result = html_to_markdown("<div><span>text</span></div>");
        assert!(!result.contains("<div>"));
        assert!(!result.contains("</span>"));
    }

    #[test]
    fn collapses_excessive_newlines() {
        let result = html_to_markdown("<p>a</p>\n\n\n\n\n<p>b</p>");
        assert!(!result.contains("\n\n\n"));
    }

    #[test]
    fn handles_empty_string() {
        assert_eq!(html_to_markdown(""), "");
    }

    #[test]
    fn handles_plain_text() {
        assert_eq!(html_to_markdown("Just plain text"), "Just plain text");
    }

    #[test]
    fn handles_nested_tags() {
        let result = html_to_markdown("<strong><em>bold italic</em></strong>");
        assert!(result.contains("*"));
        assert!(result.contains("bold italic"));
    }

    // --- format_page_output ---

    #[test]
    fn format_text_returns_text() {
        let page = make_page("<p>hi</p>", "Hello world");
        match format_page_output(&page, "text") {
            serde_json::Value::String(s) => assert_eq!(s, "Hello world"),
            _ => panic!("expected string"),
        }
    }

    #[test]
    fn format_text_returns_fallback_for_empty() {
        let page = make_page("", "");
        match format_page_output(&page, "text") {
            serde_json::Value::String(s) => assert_eq!(s, "(no text content)"),
            _ => panic!("expected string"),
        }
    }

    #[test]
    fn format_html_returns_raw_html() {
        let page = make_page("<p>raw</p>", "text");
        match format_page_output(&page, "html") {
            serde_json::Value::String(s) => assert_eq!(s, "<p>raw</p>"),
            _ => panic!("expected string"),
        }
    }

    #[test]
    fn format_markdown_converts_html() {
        let page = make_page("<h2>Title</h2>", "text");
        match format_page_output(&page, "markdown") {
            serde_json::Value::String(s) => assert!(s.contains("## Title")),
            _ => panic!("expected string"),
        }
    }

    #[test]
    fn format_links_returns_array() {
        let page = PageContent {
            title: "T".to_string(),
            url: "https://e.com".to_string(),
            text: "t".to_string(),
            html: "<p>t</p>".to_string(),
            links: vec![
                DiscoveredLink { text: "L1".to_string(), href: "https://e.com/1".to_string() },
                DiscoveredLink { text: "L2".to_string(), href: "https://e.com/2".to_string() },
            ],
            meta: BTreeMap::new(),
            schema_org: vec![],
        };
        match format_page_output(&page, "links") {
            serde_json::Value::Array(arr) => assert_eq!(arr.len(), 2),
            _ => panic!("expected array"),
        }
    }

    #[test]
    fn format_json_returns_object() {
        let page = make_page("<p>t</p>", "text content");
        match format_page_output(&page, "json") {
            serde_json::Value::Object(obj) => {
                assert_eq!(obj.get("title").and_then(|v| v.as_str()), Some("Test"));
                assert_eq!(obj.get("url").and_then(|v| v.as_str()), Some("https://example.com"));
            }
            _ => panic!("expected object"),
        }
    }

    #[test]
    fn format_unknown_defaults_to_text() {
        let page = make_page("<p>t</p>", "default text");
        match format_page_output(&page, "bogus") {
            serde_json::Value::String(s) => assert_eq!(s, "default text"),
            _ => panic!("expected string"),
        }
    }

    // --- format_search_results ---

    fn sample_results() -> Vec<SearchResultItem> {
        vec![
            SearchResultItem {
                title: "Result 1".to_string(),
                url: "https://one.com".to_string(),
                snippet: "First".to_string(),
            },
            SearchResultItem {
                title: "Result 2".to_string(),
                url: "https://two.com".to_string(),
                snippet: "Second".to_string(),
            },
        ]
    }

    #[test]
    fn search_text_format() {
        match format_search_results(&sample_results(), "text") {
            serde_json::Value::String(s) => {
                assert!(s.contains("1. Result 1"));
                assert!(s.contains("https://one.com"));
            }
            _ => panic!("expected string"),
        }
    }

    #[test]
    fn search_links_format() {
        match format_search_results(&sample_results(), "links") {
            serde_json::Value::Array(arr) => {
                assert_eq!(arr.len(), 2);
                assert_eq!(arr[0].as_str(), Some("https://one.com"));
            }
            _ => panic!("expected array"),
        }
    }

    #[test]
    fn search_json_format() {
        match format_search_results(&sample_results(), "json") {
            serde_json::Value::Array(arr) => {
                assert_eq!(arr.len(), 2);
                assert!(arr[0].is_object());
            }
            _ => panic!("expected array"),
        }
    }

    #[test]
    fn search_markdown_format() {
        match format_search_results(&sample_results(), "markdown") {
            serde_json::Value::String(s) => {
                assert!(s.contains("[Result 1](https://one.com)"));
            }
            _ => panic!("expected string"),
        }
    }

    #[test]
    fn search_unknown_defaults_to_json() {
        match format_search_results(&sample_results(), "bogus") {
            serde_json::Value::Array(arr) => assert_eq!(arr.len(), 2),
            _ => panic!("expected array"),
        }
    }

    #[test]
    fn search_empty_results() {
        let empty: Vec<SearchResultItem> = vec![];
        match format_search_results(&empty, "json") {
            serde_json::Value::Array(arr) => assert!(arr.is_empty()),
            _ => panic!("expected array"),
        }
    }
}
