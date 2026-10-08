'use strict';

const DEFAULT_OPTS = {
  maxChunkSize: 1500,
  minChunkSize: 200,
  overlap: 150,
};

function estimateTokens(text) {
  return Math.ceil(text.length / 1.5);
}

function _splitByHeadings(text) {
  const lines = text.split('\n');
  const sections = [];
  let currentHeading = '';
  let currentLines = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      if (currentLines.length || currentHeading) {
        sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() });
      }
      currentHeading = m[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length || currentHeading) {
    sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() });
  }
  return sections.filter(s => s.text.length > 0);
}

function _splitParagraphsIntoChunks(text, maxSize) {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if (buf.length + p.length + 2 <= maxSize) {
      buf += (buf ? '\n\n' : '') + p;
    } else {
      if (buf) chunks.push(buf);
      if (p.length > maxSize) {
        let i = 0;
        while (i < p.length) {
          chunks.push(p.slice(i, i + maxSize));
          i += maxSize;
        }
        buf = '';
      } else {
        buf = p;
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function _mergeSmallChunks(chunks, minSize) {
  if (chunks.length <= 1) return chunks;
  const result = [];
  let buf = '';
  for (const c of chunks) {
    if (!buf) {
      buf = c;
    } else if (buf.length < minSize) {
      buf += '\n\n' + c;
    } else {
      result.push(buf);
      buf = c;
    }
  }
  if (buf) {
    if (result.length > 0 && buf.length < minSize) {
      result[result.length - 1] += '\n\n' + buf;
    } else {
      result.push(buf);
    }
  }
  return result;
}

function _addOverlapWithinGroup(chunkTexts, overlap) {
  if (chunkTexts.length <= 1 || overlap <= 0) return chunkTexts;
  const result = [];
  for (let i = 0; i < chunkTexts.length; i++) {
    let text = chunkTexts[i];
    const actualOverlap = Math.min(overlap, Math.floor(text.length * 0.3));
    if (actualOverlap <= 0) { result.push(text); continue; }
    let left = '';
    let right = '';
    if (i > 0) left = chunkTexts[i - 1].slice(-actualOverlap);
    if (i < chunkTexts.length - 1) right = chunkTexts[i + 1].slice(0, actualOverlap);
    result.push(left + text + right);
  }
  return result;
}

function chunkDocument(text, opts) {
  const o = Object.assign({}, DEFAULT_OPTS, opts || {});
  text = (text || '').toString().trim();
  if (!text) return [];

  let sections = _splitByHeadings(text);
  if (sections.length === 0) sections = [{ heading: '', text }];

  const allChunks = [];
  for (const sec of sections) {
    let sectionChunks;
    if (sec.text.length <= o.maxChunkSize) {
      sectionChunks = [sec.text];
    } else {
      sectionChunks = _splitParagraphsIntoChunks(sec.text, o.maxChunkSize);
      sectionChunks = _mergeSmallChunks(sectionChunks, o.minChunkSize);
    }
    sectionChunks = _addOverlapWithinGroup(sectionChunks, o.overlap);
    for (const t of sectionChunks) {
      allChunks.push({ heading: sec.heading, text: t, tokens: estimateTokens(t) });
    }
  }

  return allChunks.map((c, idx) => ({ id: idx, heading: c.heading, text: c.text, tokens: c.tokens }));
}

module.exports = { chunkDocument, estimateTokens };
