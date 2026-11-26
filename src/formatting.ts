// Preserve literals as separate tokens so their spaces and punctuation stay significant.
export function formattingSignature(text: string): string {
  const tokens: string[] = [];
  let prose = "";
  const literal = (s: string) => { tokens.push(prose, s); prose = ""; };
  let closing = "", fenced = "";
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (closing || fenced) {
      literal(line);
      if (fenced ? new RegExp("^ {0,3}" + fenced[0] + "{" + fenced.length + ",}\\s*$").test(line)
                 : line.trim() === closing) { closing = ""; fenced = ""; }
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence || (n === 0 && line === "---") || line.trim() === "$$") {
      fenced = fence?.[1] ?? "";
      closing = fenced ? "" : line.trim();
      literal(line);
      continue;
    }
    if (/^(?: {4}|\t)/.test(line) && line.trim()) { literal(line); continue; }
    const body = line.replace(/^ {0,3}(?:>[ \t]?)+/, "").replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, "")
      .replace(/^\s*(?:[-+*]|\d{1,9}[.)])[ \t]+/, "");
    // Keep code, links, escapes, math and markup intact before normalizing prose.
    const protectedText = /(`+)([^\n]*?)\1|\\.|!?\[\[[^\n]*?\]\]|\]\([^\n]*?\)|https?:\/\/[^\s]+|\$[^$\n]+\$|<[^>\n]+>/g;
    let pos = 0;
    function append(s: string) {
      prose += s.replace(/(\*{1,3})(?=\S)([^*\n]*?\S)\1/g, "$2")
        .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)([^_\n]*?\S)\1(?![\p{L}\p{N}_])/gu, "$2")
        .replace(/\s+/g, "");
    }
    for (const part of body.matchAll(protectedText)) {
      append(body.slice(pos, part.index));
      literal(part[0]);
      pos = part.index! + part[0].length;
    }
    append(body.slice(pos));
  }
  return JSON.stringify([...tokens, prose]);
}
