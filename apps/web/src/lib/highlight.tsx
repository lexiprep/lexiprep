import type { ReactNode } from "react";

// Locate a studied word (and its surface forms) inside a context line so it can be bolded.
// Mirror @lexiprep/core's tokenizer: a token is a run of letters (any script) with internal
// apostrophes, normalized by lowercasing, unifying curly apostrophes, dropping a trailing
// possessive `'s`, and stripping edge apostrophes/hyphens.
const WORD_RE = /\p{L}[\p{L}\p{M}'’]*/gu;

export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/'s$/, "")
    .replace(/^['-]+|['-]+$/g, "");
}

/** Render a context snippet, bolding every token that is one of `forms` (normalized). */
export function highlightForms(text: string, forms: ReadonlySet<string>): ReactNode {
  if (forms.size === 0) return text;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    if (!forms.has(normalizeWord(m[0]))) continue;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <strong key={key++} className="ctx-hl">
        {m[0]}
      </strong>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Build the normalized form-set to bold: the word plus any extra surface forms. */
export function formSetOf(...words: (string | null | undefined)[]): Set<string> {
  const s = new Set<string>();
  for (const w of words) {
    if (!w) continue;
    const n = normalizeWord(w);
    if (n.length > 1) s.add(n);
  }
  return s;
}
