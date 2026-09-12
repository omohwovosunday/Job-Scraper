/**
 * worker/lib/text.ts
 *
 * Turning board HTML into the plain text the scorer reads.
 *
 * RemoteOK returns descriptions as entity-encoded HTML — the literal characters
 * `&lt;h3&gt;` rather than `<h3>`. Left alone, two things go wrong: the model spends
 * its context on markup, and the 4,000-character truncation in the scorer prompt
 * cuts away tags instead of prose, so eligibility language buried at the foot of a
 * long listing never reaches it. That language is the most common disqualifier, so
 * this is not cosmetic.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  middot: '·',
  bull: '•',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Inline base64 payloads. Listings embed logos as `data:image/png;base64,...`, and
 * one seen in the wild ran to tens of kilobytes inside an `<img>` tag that was
 * never closed. Two problems: an unterminated tag defeats `<[^>]+>`, and a blob
 * that size would swallow the scorer's whole 4,000-character budget on data that
 * says nothing about the job. Strip the payload before touching tags.
 */
function stripDataUris(input: string): string {
  return input.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, ' ');
}

/**
 * Block-level tags become newlines so list items and paragraphs stay separated.
 *
 * Every rule requires a letter or slash straight after the `<`. A permissive
 * `<[^>]+>` looks correct and quietly destroys prose: "Teams of <10 engineers.
 * Salary >$80k." has a `<`, arbitrary text, and a later `>`, so the whole span
 * matches and the sentence loses its middle. Listings write "<3 years" and
 * ">$80k" often enough that this is real data loss, and it is silent.
 */
function stripTags(input: string): string {
  return (
    input
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^<>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|blockquote|section)\s*>/gi, '\n')
      .replace(/<li\b[^<>]*>/gi, '\n- ')
      .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, ' ')
      // A tag left unterminated by truncated source has no closing bracket for the
      // rule above to find. Only strip a remnant that actually looks like a tag —
      // one carrying an attribute — so trailing prose such as "costs <a lot"
      // survives.
      .replace(/<\/?[a-z][a-z0-9-]*(?:\s+[a-z-]+\s*=\s*[^<>]*)?$/i, ' ')
  );
}

function collapseWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Decode, strip, decode again. The second pass matters: the first turns
 * `&lt;p&gt;` into a real tag, and entities that were double-encoded inside the
 * text (`&amp;amp;` for a literal ampersand) only resolve after the markup is gone.
 */
export function htmlToText(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const once = stripTags(stripDataUris(decodeEntities(input)));
  const text = collapseWhitespace(decodeEntities(once));
  return text.length === 0 ? null : text;
}

/** Empty strings and whitespace-only values from board feeds become null. */
export function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
