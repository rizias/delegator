import type { ParserPreset } from './registry.js';

export const genericLinesParser: ParserPreset = {
  parseLine(line, stream) {
    const raw = line.length > 4000 ? line.slice(0, 4000) : line;
    return { ts: Date.now(), stream, kind: 'output', raw };
  },

  finalSummary(stdoutTail) {
    const lines = stdoutTail.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-30).join('\n');
  },

  finalUsage() {
    return {};
  },
};
