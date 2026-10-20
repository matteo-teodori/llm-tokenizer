/**
 * The logo's T, at icon size, from icon.png itself: what the extension's pages
 * show in their tabs, and the editor title shows for Show Claude Code Usage.
 *
 *   node scripts/logo-icons.mjs    rewrite media/logo-dark.png and logo-light.png
 *
 * Run it whenever icon.png changes. A T drawn again by hand was not the logo's:
 * these are the logo's own pixels, its dark ground made transparent (each pixel
 * split into the colour that, over the ground, gives it, and how much of it),
 * then averaged down. The dark-theme icon keeps the neon glow; on a light theme
 * the faint glow, made for a dark ground, only blurs the strokes, so it is
 * dropped there and the strokes kept, each pixel darkened to its own hue: the
 * logo's light blue and violet were made to shine on its dark ground, and on a
 * light tab bar measured 2.2:1 at the median, under the 3:1 an icon needs.
 *
 * Node built-ins only: it reads and writes 8-bit PNGs itself.
 */

import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

/** Device pixels for a 16 px icon at 4x, so that the editor scales down, never up. */
const SIZE = 64;
/** The square of the logo the T and its glow fit in, centred: 3 logo pixels per icon pixel. */
const CROP = { x: 31, y: 31, size: 192 };
/** Light themes: opacity below `low` is glow and goes, above `high` is stroke and stays. */
const LIGHT = { low: 0.22, high: 0.62 };
/** Light themes: no colour lighter than this relative luminance, 4.5:1 on a #F3F3F3 tab bar. */
const LIGHT_MAX_LUMINANCE = 0.16;

const logo = readPng('icon.png');
const ground = groundColour(logo);
assertCropHoldsTheT(logo, ground);
const icon = averageDown(logo, ground);
writePng('media/logo-dark.png', icon);
writePng('media/logo-light.png', icon.map(([r, g, b, a]) => [...darkened([r, g, b]), crisp(a)]));
console.log(`media/logo-dark.png and media/logo-light.png: ${SIZE} x ${SIZE}, from icon.png on ${ground.map(c => c.toFixed(1)).join(', ')}`);

/** The colour of the logo's ground: its outer border, averaged. */
function groundColour({ width, height, pixel }) {
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (x < 8 || y < 8 || x >= width - 8 || y >= height - 8) {
                pixel(x, y).forEach((v, c) => (sum[c] += v));
                n++;
            }
        }
    }
    return sum.map(v => v / n);
}

/** A new logo whose T no longer fits the crop fails here, rather than losing a stroke. */
function assertCropHoldsTheT({ width, height, pixel }, bg) {
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const inside = x >= CROP.x && x < CROP.x + CROP.size && y >= CROP.y && y < CROP.y + CROP.size;
            if (!inside && pixel(x, y).some((v, c) => v - bg[c] > 12)) {
                throw new Error(`icon.png has part of its T at ${x},${y}, outside the crop: adjust CROP`);
            }
        }
    }
}

/**
 * The colour and opacity that, over the ground, give `p`. Only light added to
 * the ground counts: the logo's faint shadow, darker than the ground, would
 * otherwise be a grey smudge on a light theme.
 */
function unblend(p, bg) {
    let alpha = 0;
    for (let c = 0; c < 3; c++) {
        if (p[c] > bg[c] + 3) {
            alpha = Math.max(alpha, (p[c] - bg[c]) / (255 - bg[c]));
        }
    }
    if (alpha === 0) {
        return { colour: [0, 0, 0], alpha: 0 };
    }
    return { colour: [0, 1, 2].map(c => Math.max(0, (p[c] - bg[c]) / alpha + bg[c])), alpha };
}

/** The crop, unblended and averaged down to SIZE, in premultiplied colour so that edges keep their hue. */
function averageDown({ pixel }, bg) {
    const k = CROP.size / SIZE;
    const out = [];
    for (let oy = 0; oy < SIZE; oy++) {
        for (let ox = 0; ox < SIZE; ox++) {
            const sum = [0, 0, 0];
            let alpha = 0;
            for (let y = CROP.y + oy * k; y < CROP.y + (oy + 1) * k; y++) {
                for (let x = CROP.x + ox * k; x < CROP.x + (ox + 1) * k; x++) {
                    const u = unblend(pixel(x, y), bg);
                    alpha += u.alpha;
                    u.colour.forEach((v, c) => (sum[c] += v * u.alpha));
                }
            }
            const colour = alpha > 0 ? sum.map(v => Math.min(255, Math.round(v / alpha))) : [0, 0, 0];
            out.push([...colour, Math.min(255, Math.round((alpha / (k * k)) * 255))]);
        }
    }
    return out;
}

/** The same hue, no lighter than LIGHT_MAX_LUMINANCE: every channel scaled alike, in linear light. */
function darkened(rgb) {
    const linear = rgb.map(v => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    const k = luminance > LIGHT_MAX_LUMINANCE ? LIGHT_MAX_LUMINANCE / luminance : 1;
    return linear.map(v => {
        const s = v * k;
        return Math.round(255 * (s <= 0.0031308 ? s * 12.92 : 1.055 * s ** (1 / 2.4) - 0.055));
    });
}

function crisp(a) {
    const t = a / 255;
    return Math.round((t <= LIGHT.low ? 0 : t >= LIGHT.high ? 1 : (t - LIGHT.low) / (LIGHT.high - LIGHT.low)) * 255);
}

/** An 8-bit RGB or RGBA, non-interlaced PNG, as a pixel reader. */
function readPng(file) {
    const data = readFileSync(file);
    let pos = 8;
    let header;
    const idat = [];
    while (pos < data.length) {
        const length = data.readUInt32BE(pos);
        const kind = data.toString('latin1', pos + 4, pos + 8);
        const chunk = data.subarray(pos + 8, pos + 8 + length);
        if (kind === 'IHDR') {
            header = { width: chunk.readUInt32BE(0), height: chunk.readUInt32BE(4), depth: chunk[8], type: chunk[9], interlace: chunk[12] };
        } else if (kind === 'IDAT') {
            idat.push(chunk);
        }
        pos += 12 + length;
    }
    const { width, height, depth, type, interlace } = header;
    if (depth !== 8 || interlace !== 0 || (type !== 2 && type !== 6)) {
        throw new Error(`${file}: only 8-bit, non-interlaced RGB or RGBA is read here`);
    }
    const bpp = type === 2 ? 3 : 4;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const rows = [];
    let previous = Buffer.alloc(stride);
    for (let y = 0, i = 0; y < height; y++) {
        const filter = raw[i++];
        const line = Buffer.from(raw.subarray(i, i + stride));
        i += stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? line[x - bpp] : 0;
            const b = previous[x];
            const c = x >= bpp ? previous[x - bpp] : 0;
            const p = a + b - c;
            const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
            line[x] = (line[x] + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
        }
        rows.push(line);
        previous = line;
    }
    return { width, height, pixel: (x, y) => [0, 1, 2].map(c => rows[y][x * bpp + c]) };
}

/** A SIZE x SIZE RGBA PNG. */
function writePng(file, pixels) {
    const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
    pixels.forEach((p, i) => {
        const y = Math.floor(i / SIZE);
        const x = i % SIZE;
        p.forEach((v, c) => (raw[y * (1 + SIZE * 4) + 1 + x * 4 + c] = v));
    });
    const header = Buffer.alloc(13);
    header.writeUInt32BE(SIZE, 0);
    header.writeUInt32BE(SIZE, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const chunk = (kind, body) => {
        const out = Buffer.alloc(12 + body.length);
        out.writeUInt32BE(body.length, 0);
        out.write(kind, 4, 'latin1');
        body.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
        return out;
    };
    writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]));
}

function crc32(bytes) {
    let crc = ~0;
    for (const byte of bytes) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    return ~crc >>> 0;
}
