const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function inlineMarkdown(value) {
  const tokens = [];
  const hold = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let text = String(value || '')
    .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`));
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
}

function tableCells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableDivider(line) {
  const cells = tableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function startsBlock(lines, index) {
  const line = lines[index] || '';
  return !line.trim()
    || /^```/.test(line.trim())
    || /^#{1,6}\s+/.test(line)
    || /^\s*([-*+]\s+|\d+[.)]\s+)/.test(line)
    || /^>\s?/.test(line)
    || /^\s*(---+|___+|\*\*\*+)\s*$/.test(line)
    || (line.includes('|') && isTableDivider(lines[index + 1] || ''));
}

export function markdownMarkup(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      html.push(`<pre><code${language ? ` class="language-${language}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { const level = heading[1].length; html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); index += 1; continue; }
    if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
      html.push(`<div class="markdown-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const listMatch = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const start = ordered ? Number.parseInt(listMatch[1], 10) : 1;
      const items = [];
      while (index < lines.length) {
        if (!lines[index].trim()) {
          let next = index + 1;
          while (next < lines.length && !lines[next].trim()) next += 1;
          const nextMatch = lines[next]?.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
          if (!nextMatch || /^\d/.test(nextMatch[1]) !== ordered) break;
          index = next;
        }
        const match = lines[index].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
        if (!match || /^\d/.test(match[1]) !== ordered) break;
        const task = match[2].match(/^\[([ xX])\]\s+(.+)$/);
        items.push(task
          ? `<li class="task-list-item"><input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''} aria-label="${task[1].toLowerCase() === 'x' ? '已完成' : '未完成'}">${inlineMarkdown(task[2])}</li>`
          : `<li>${inlineMarkdown(match[2])}</li>`);
        index += 1;
      }
      html.push(ordered ? `<ol${start === 1 ? '' : ` start="${start}"`}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${quote.map((part) => inlineMarkdown(part)).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) { html.push('<hr>'); index += 1; continue; }
    const paragraph = [];
    while (index < lines.length && !startsBlock(lines, index)) paragraph.push(lines[index++]);
    if (!paragraph.length) paragraph.push(lines[index++]);
    html.push(`<p>${paragraph.map((part) => inlineMarkdown(part)).join('<br>')}</p>`);
  }
  return html.join('');
}
