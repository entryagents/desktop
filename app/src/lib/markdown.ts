/**
 * Tiny, safe markdown -> HTML (ported 1:1 from the legacy widget).
 * Everything is escaped before formatting.
 */
function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string;
  });
}

function inlineMd(s: string): string {
  return String(s)
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(
          /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
          '<a href="$2" data-eu-link rel="noopener">$1</a>',
        );
    })
    .join("");
}

interface ListItem {
  ordered: boolean;
  indent: number;
  text: string;
}

function renderList(items: ListItem[]): string {
  let html = "";
  const stack: ListItem[] = [];
  items.forEach((it) => {
    const type = it.ordered ? "ol" : "ul";
    while (stack.length && it.indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop()!.type}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      html += `<${type}>`;
      stack.push({ type, indent: it.indent, text: "", ordered: it.ordered });
    } else {
      html += "</li>";
    }
    html += `<li>${inlineMd(it.text)}`;
  });
  while (stack.length) html += `</li></${stack.pop()!.type}>`;
  return html;
}

export function mdToHtml(src: unknown, baseLevel = 1): string {
  const base = baseLevel;
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let items: ListItem[] = [];
  let fence: string[] | null = null;
  const flushP = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushL = () => {
    if (items.length) {
      out.push(renderList(items));
      items = [];
    }
  };
  for (const raw of lines) {
    if (fence) {
      if (/^\s*```/.test(raw)) {
        out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flushP();
      flushL();
      fence = [];
      continue;
    }
    if (!raw.trim()) {
      flushP();
      flushL();
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flushP();
      flushL();
      out.push("<hr>");
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) {
      flushP();
      flushL();
      const lv = Math.min(6, h[1].length + base - 1);
      out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      flushP();
      items.push({ indent: li[1].replace(/\t/g, "  ").length, ordered: /\d/.test(li[2]), text: li[3] });
      continue;
    }
    if (items.length && /^\s+/.test(raw)) {
      items[items.length - 1].text += " " + raw.trim();
      continue;
    }
    flushL();
    para.push(raw.trim());
  }
  if (fence) out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
  flushP();
  flushL();
  return out.join("\n");
}

export { esc };
