/**
 * URL Detection Tests
 *
 * The UrlRegexProvider over a real terminal's buffer: plain text URLs are
 * found with ranges in cells.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { ILink } from './interfaces';
import { UrlRegexProvider } from './providers/url-regex-provider';
import type { Terminal } from './terminal';
import { terminalFixture } from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;

beforeEach(() => {
  term = fixture.open({ cols: 80, rows: 5 }).term;
});

function linksOn(row: number): ILink[] | undefined {
  let result: ILink[] | undefined;
  new UrlRegexProvider(term).provideLinks(row, (links) => {
    result = links;
  });
  return result;
}

/** Write a line and return the links found on it. */
function getLinks(text: string): ILink[] | undefined {
  term.write(text);
  return linksOn(term.buffer.active.baseY + term.buffer.active.cursorY);
}

const texts = (links: ILink[] | undefined) => links?.map((l) => l.text);

describe('URL Detection', () => {
  test('detects HTTPS URLs with an inclusive cell range', () => {
    const links = getLinks('Visit https://github.com for code');
    expect(texts(links)).toEqual(['https://github.com']);
    expect(links?.[0].range).toEqual({ start: { x: 6, y: 0 }, end: { x: 23, y: 0 } });
  });

  test('detects http, ftp and mailto links', () => {
    expect(texts(getLinks('Check http://example.com'))).toEqual(['http://example.com']);
    term.reset();
    expect(texts(getLinks('Get ftp://files.example.com/file'))).toEqual([
      'ftp://files.example.com/file',
    ]);
    term.reset();
    expect(texts(getLinks('Email: mailto:test@example.com'))).toEqual(['mailto:test@example.com']);
  });

  test('ignores schemes links may not open', () => {
    expect(getLinks('ssh://user@host git://h/r.git tel:+1234 javascript:alert(1)')).toBeUndefined();
  });

  test('strips trailing punctuation', () => {
    expect(texts(getLinks('Check https://example.com. See https://a.org, https://b.org!'))).toEqual(
      ['https://example.com', 'https://a.org', 'https://b.org']
    );
  });

  test('strips a closing parenthesis only when it is unbalanced', () => {
    expect(texts(getLinks('(see https://example.com/a)'))).toEqual(['https://example.com/a']);
    term.reset();
    expect(texts(getLinks('https://en.wikipedia.org/wiki/Foo_(bar) and more'))).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    term.reset();
    expect(texts(getLinks("(https://en.wikipedia.org/wiki/Foo_(bar)), it's"))).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  test('keeps query strings, fragments, ports and quotes inside the URL', () => {
    expect(
      texts(getLinks("https://example.com:8080/p?foo=bar&baz=qux#sec https://x.org/it's"))
    ).toEqual(['https://example.com:8080/p?foo=bar&baz=qux#sec', "https://x.org/it's"]);
  });

  test('returns undefined when there is no URL, including paths and a bare scheme', () => {
    expect(getLinks('No URLs here /home/user/file.txt ./relative/path http://')).toBeUndefined();
  });

  test('columns after emoji and wide characters are cells, not code units', () => {
    const links = getLinks('🎉 日本 https://example.com');
    expect(texts(links)).toEqual(['https://example.com']);
    // 🎉 and 日本 take two cells each: "🎉 " is 3 cells, "日本 " is 5.
    expect(links?.[0].range.start.x).toBe(8);
    expect(links?.[0].range.end.x).toBe(26);
  });

  test('a URL that soft-wraps is one link spanning the rows', () => {
    term = fixture.open({ cols: 20, rows: 5 }).term;
    const url = 'https://example.com/a/very/long/path';
    term.write(`see ${url} end`);
    for (const row of [0, 1]) {
      const links = linksOn(row);
      expect(texts(links)).toEqual([url]);
      expect(links?.[0].range).toEqual({ start: { x: 4, y: 0 }, end: { x: 19, y: 1 } });
    }
    expect(linksOn(2)).toBeUndefined();
  });
});
