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
