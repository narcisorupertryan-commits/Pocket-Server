'use strict';

/* A QR Code encoder small enough to ship with the dashboard: byte mode, error
 * correction level M, versions 1 to 10 (up to ~210 characters).
 *
 * It exists because of where the panel runs. The public address is created on the
 * device, and the device is often on a network with no internet at all — a QR image
 * cannot come from a web service. Everything below is self-contained: Reed-Solomon
 * over GF(256), the mask patterns from the specification with their penalty rules,
 * and an SVG renderer.
 *
 * Usage:
 *   qrCode.matrix('https://example.trycloudflare.com')  -> { version, size, mask, modules }
 *   qrCode.svg('https://example.trycloudflare.com')     -> '<svg …>'
 *
 * The same file is served to the browser and required by scripts/verify-panel-sites.mjs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.qrCode = api;
})(typeof window === 'undefined' ? null : window, function () {
  // Level M: error correction codewords per block, then [blocks, data codewords] groups.
  const BLOCKS = {
    1: [10, [[1, 16]]],
    2: [16, [[1, 28]]],
    3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],
    5: [24, [[2, 43]]],
    6: [16, [[4, 27]]],
    7: [18, [[4, 31]]],
    8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]],
    10: [26, [[4, 43], [1, 44]]],
  };

  // Alignment pattern centres, per version.
  const ALIGNMENT = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };

  const MAX_VERSION = 10;
  const BYTE_MODE = 0b0100;
  // Error correction level M is 0b00 in the format information.
  const LEVEL_M_BITS = 0b00;

  const EXP = new Array(512);
  const LOG = new Array(256);
  (function initGalois() {
    let value = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP[i] = value;
      LOG[value] = i;
      value <<= 1;
      if (value & 0x100) value ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  })();

  function multiply(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function dataCodewords(version) {
    let total = 0;
    for (const [count, size] of BLOCKS[version][1]) total += count * size;
    return total;
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder === 'function') return Array.from(new TextEncoder().encode(text));
    const bytes = [];
    const escaped = unescape(encodeURIComponent(text));
    for (let i = 0; i < escaped.length; i += 1) bytes.push(escaped.charCodeAt(i));
    return bytes;
  }

  /** The smallest version whose data area holds this many bytes, or 0. */
  function pickVersion(byteLength) {
    for (let version = 1; version <= MAX_VERSION; version += 1) {
      const countBits = version < 10 ? 8 : 16;
      if (4 + countBits + byteLength * 8 <= dataCodewords(version) * 8) return version;
    }
    return 0;
  }

  function encodeData(version, bytes) {
    const capacityBits = dataCodewords(version) * 8;
    const bits = [];
    const push = (value, length) => {
      for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
    };

    push(BYTE_MODE, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);

    push(0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);

    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      let word = 0;
      for (let j = 0; j < 8; j += 1) word = (word << 1) | bits[i + j];
      words.push(word);
    }
    // Alternating pad bytes, as the specification asks.
    for (let pad = 0xec; words.length < dataCodewords(version); pad ^= 0xec ^ 0x11) words.push(pad);
    return words;
  }

  function generatorPolynomial(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= multiply(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function remainder(data, degree) {
    const generator = generatorPolynomial(degree);
    const rest = new Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ rest[0];
      rest.shift();
      rest.push(0);
      for (let i = 0; i < degree; i += 1) rest[i] ^= multiply(generator[i + 1], factor);
    }
    return rest;
  }

  /** Splits the data into blocks, appends each block's EC codewords, interleaves both. */
  function assembleCodewords(version, data) {
    const [ecLength, groups] = BLOCKS[version];
    const blocks = [];
    let offset = 0;
    for (const [count, size] of groups) {
      for (let i = 0; i < count; i += 1) {
        const chunk = data.slice(offset, offset + size);
        offset += size;
        blocks.push({ data: chunk, ec: remainder(chunk, ecLength) });
      }
    }

    const longest = blocks.reduce((max, block) => Math.max(max, block.data.length), 0);
    const words = [];
    for (let i = 0; i < longest; i += 1) {
      for (const block of blocks) if (i < block.data.length) words.push(block.data[i]);
    }
    for (let i = 0; i < ecLength; i += 1) {
      for (const block of blocks) words.push(block.ec[i]);
    }
    return words;
  }

  function maskBit(mask, row, column) {
    switch (mask) {
      case 0:
        return (row + column) % 2 === 0;
      case 1:
        return row % 2 === 0;
      case 2:
        return column % 3 === 0;
      case 3:
        return (row + column) % 3 === 0;
      case 4:
        return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
      case 5:
        return ((row * column) % 2) + ((row * column) % 3) === 0;
      case 6:
        return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
      default:
        return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
    }
  }

  function buildMatrix(version, codewords) {
    const size = 17 + version * 4;
    const modules = [];
    const reserved = [];
    for (let row = 0; row < size; row += 1) {
      modules.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }

    function set(row, column, dark) {
      modules[row][column] = dark ? 1 : 0;
      reserved[row][column] = true;
    }

    function drawFinder(top, left) {
      for (let dy = -1; dy <= 7; dy += 1) {
        for (let dx = -1; dx <= 7; dx += 1) {
          const row = top + dy;
          const column = left + dx;
          if (row < 0 || row >= size || column < 0 || column >= size) continue;
          const ring =
            (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
            (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6));
          const core = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
          set(row, column, ring || core);
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i += 1) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    const centres = ALIGNMENT[version];
    const last = centres.length - 1;
    for (let i = 0; i < centres.length; i += 1) {
      for (let j = 0; j < centres.length; j += 1) {
        // The three corners already hold finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            set(centres[i] + dy, centres[j] + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // Reserve both format information copies (the values are written per mask below).
    for (let i = 0; i <= 8; i += 1) {
      if (i === 6) continue;
      set(8, i, false);
      set(i, 8, false);
    }
    for (let i = 0; i < 8; i += 1) {
      set(8, size - 1 - i, false);
      set(size - 1 - i, 8, false);
    }

    if (version >= 7) {
      let rest = version;
      for (let i = 0; i < 12; i += 1) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
      const bits = (version << 12) | rest;
      for (let i = 0; i < 18; i += 1) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(b, a, dark);
        set(a, b, dark);
      }
    }

    // Data modules, two columns at a time, upwards then downwards, skipping column 6.
    const totalBits = codewords.length * 8;
    let index = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < size; step += 1) {
        const row = upward ? size - 1 - step : step;
        for (let k = 0; k < 2; k += 1) {
          const column = right - k;
          if (reserved[row][column]) continue;
          const bit =
            index < totalBits ? (codewords[index >> 3] >>> (7 - (index & 7))) & 1 : 0;
          modules[row][column] = bit;
          index += 1;
        }
      }
      upward = !upward;
    }

    function writeFormat(grid, mask) {
      const data = (LEVEL_M_BITS << 3) | mask;
      let rest = data;
      for (let i = 0; i < 10; i += 1) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
      const bits = ((data << 10) | rest) ^ 0x5412;
      const bit = (i) => (bits >>> i) & 1;

      for (let i = 0; i <= 5; i += 1) grid[i][8] = bit(i);
      grid[7][8] = bit(6);
      grid[8][8] = bit(7);
      grid[8][7] = bit(8);
      for (let i = 9; i < 15; i += 1) grid[8][14 - i] = bit(i);
      for (let i = 0; i < 8; i += 1) grid[8][size - 1 - i] = bit(i);
      for (let i = 8; i < 15; i += 1) grid[size - 15 + i][8] = bit(i);
      grid[size - 8][8] = 1;
    }

    function withMask(mask) {
      const grid = modules.map((row) => row.slice());
      for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
          if (!reserved[row][column] && maskBit(mask, row, column)) grid[row][column] ^= 1;
        }
      }
      writeFormat(grid, mask);
      return grid;
    }

    let best = null;
    let bestMask = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask += 1) {
      const grid = withMask(mask);
      const score = penalty(grid);
      if (score < bestScore) {
        best = grid;
        bestMask = mask;
        bestScore = score;
      }
    }

    return { size, mask: bestMask, modules: best };
  }

  const RUN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const RUN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

  function linePenalty(line) {
    let score = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);

    for (let i = 0; i + 11 <= line.length; i += 1) {
      let first = true;
      let second = true;
      for (let j = 0; j < 11; j += 1) {
        if (line[i + j] !== RUN_A[j]) first = false;
        if (line[i + j] !== RUN_B[j]) second = false;
      }
      if (first || second) score += 40;
    }
    return score;
  }

  /** The four penalty rules; only used to pick the least noisy of the eight masks. */
  function penalty(grid) {
    const size = grid.length;
    let score = 0;

    for (let i = 0; i < size; i += 1) {
      score += linePenalty(grid[i]);
      const column = [];
      for (let j = 0; j < size; j += 1) column.push(grid[j][i]);
      score += linePenalty(column);
    }

    for (let row = 0; row < size - 1; row += 1) {
      for (let column = 0; column < size - 1; column += 1) {
        const value = grid[row][column];
        if (
          value === grid[row][column + 1] &&
          value === grid[row + 1][column] &&
          value === grid[row + 1][column + 1]
        ) {
          score += 3;
        }
      }
    }

    let dark = 0;
    for (const row of grid) for (const value of row) dark += value;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }

  function matrix(text) {
    const bytes = utf8Bytes(String(text));
    const version = pickVersion(bytes.length);
    if (version === 0) {
      const limit = dataCodewords(MAX_VERSION) - 3;
      throw new Error(`Too long for this QR encoder: ${bytes.length} bytes, limit ${limit}.`);
    }
    const words = assembleCodewords(version, encodeData(version, bytes));
    const built = buildMatrix(version, words);
    return { version, size: built.size, mask: built.mask, modules: built.modules };
  }

  function svg(text, options) {
    const settings = options || {};
    const margin = Number.isInteger(settings.margin) && settings.margin >= 0 ? settings.margin : 4;
    const result = matrix(text);
    const total = result.size + margin * 2;

    let path = '';
    for (let row = 0; row < result.size; row += 1) {
      for (let column = 0; column < result.size; column += 1) {
        if (result.modules[row][column]) {
          path += `M${column + margin} ${row + margin}h1v1h-1z`;
        }
      }
    }

    const dark = settings.dark || '#0f172a';
    const light = settings.light || '#ffffff';
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
      'width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      `<rect width="${total}" height="${total}" fill="${light}"/>` +
      `<path d="${path}" fill="${dark}"/></svg>`
    );
  }

  return { matrix, svg };
});
