/** Only the saturated magenta screen has been calibrated for this pass. */
export function supportsMotionKeySpillCleanup(keyColor) {
    return /^#(?:FF00FF|F0F)$/i.test(keyColor);
}
function magentaExcess(data, offset) {
    return Math.min(data[offset], data[offset + 2]) - data[offset + 1];
}
/** Sample the visible video screen rather than using the generated canvas padding. */
function sampleScreen(source, keyed, width, height) {
    const bins = new Map();
    let dominant;
    for (let y = 0; y < height; y += 8) {
        for (let x = 0; x < width; x += 8) {
            const p = (y * width + x) * 4;
            if (keyed[p + 3] !== 0 || source[p + 3] === 0 || magentaExcess(source, p) < 95)
                continue;
            const r = source[p], g = source[p + 1], b = source[p + 2];
            // The padding is precisely the requested key color. Use it only as a fallback.
            if (r === 255 && g === 0 && b === 255)
                continue;
            const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            const entry = bins.get(bin) ?? { count: 0, r: 0, g: 0, b: 0 };
            entry.count++;
            entry.r += r;
            entry.g += g;
            entry.b += b;
            bins.set(bin, entry);
            if (!dominant || entry.count > dominant.count)
                dominant = entry;
        }
    }
    return dominant && dominant.count >= 8
        ? [dominant.r, dominant.g, dominant.b].map(sum => sum / dominant.count)
        : [255, 0, 255];
}
/** Recover fractional coverage and clean edge color from a local foreground color. */
function fitEdge(source, screen, reference, width, height, x, y) {
    const p = (y * width + x) * 4;
    let bestScore = Infinity, bestOffset = -1, bestAlpha = 0;
    for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
            const nx = x + dx, ny = y + dy, distance = dx * dx + dy * dy;
            if (!distance || distance > 25 || nx < 0 || nx >= width || ny < 0 || ny >= height)
                continue;
            const i = ny * width + nx;
            if (!reference[i])
                continue;
            const q = i * 4;
            const fr = source[q] - screen[0], fg = source[q + 1] - screen[1], fb = source[q + 2] - screen[2];
            const pr = source[p] - screen[0], pg = source[p + 1] - screen[1], pb = source[p + 2] - screen[2];
            const alpha = (pr * fr + pg * fg + pb * fb) / (fr * fr + fg * fg + fb * fb);
            if (alpha < 0.05 || alpha > 1.02)
                continue;
            const error = (pr - alpha * fr) ** 2 + (pg - alpha * fg) ** 2 + (pb - alpha * fb) ** 2;
            const score = error + distance * 5;
            if (error > 34 ** 2 || score >= bestScore)
                continue;
            bestScore = score;
            bestOffset = q;
            bestAlpha = alpha;
        }
    }
    return { offset: bestOffset, alpha: bestAlpha };
}
const edgeNeighbors = (() => {
    const offsets = [];
    for (let y = -11; y <= 11; y++) {
        for (let x = -11; x <= 11; x++) {
            const distance = x * x + y * y;
            if (distance > 0 && distance <= 121)
                offsets.push({ x, y, distance });
        }
    }
    return offsets.sort((a, b) => a.distance - b.distance);
})();
/** Recover pixels where initial despill turned the screen brown but left too much alpha. */
function recoverWarmEdges(rgba, source, width, height) {
    const baseline = rgba.slice();
    let removedPixels = 0, correctedPixels = 0;
    for (let p = 0; p < rgba.length; p += 4) {
        const alpha = baseline[p + 3], excess = magentaExcess(source, p);
        if (alpha === 0 || alpha >= 240 || excess < 30 || magentaExcess(baseline, p) >= 15)
            continue;
        if (baseline[p] - baseline[p + 1] < 9 && baseline[p] - baseline[p + 2] < 16)
            continue;
        const x = (p / 4) % width, y = Math.floor(p / 4 / width);
        if (x < 8 || x + 8 >= width || y < 8 || y + 8 >= height)
            continue;
        const samples = [];
        let nearScreen = false;
        for (const neighbor of edgeNeighbors) {
            if (neighbor.distance > 49)
                break;
            const q = ((y + neighbor.y) * width + x + neighbor.x) * 4;
            if (baseline[q + 3] !== 0 || source[q + 3] !== 255 || magentaExcess(source, q) < 95)
                continue;
            nearScreen ||= neighbor.distance <= 16;
            samples.push(q);
            if (samples.length === 16)
                break;
        }
        if (!nearScreen || samples.length < 3)
            continue;
        const screen = [0, 0, 0];
        const strongest = samples.sort((a, b) => magentaExcess(source, b) - magentaExcess(source, a)).slice(0, 8);
        for (const q of strongest) {
            for (let c = 0; c < 3; c++)
                screen[c] += source[q + c] / strongest.length;
        }
        const screenExcess = Math.min(screen[0], screen[2]) - screen[1];
        if (excess < screenExcess * .25)
            continue;
        const screenDistance = screen.reduce((sum, value, c) => sum + (value - source[p + c]) ** 2, 0);
        let bestScore = Infinity, bestOffset = -1, coverage = 0;
        for (const neighbor of edgeNeighbors) {
            if (neighbor.distance > 64)
                break;
            const q = ((y + neighbor.y) * width + x + neighbor.x) * 4;
            if (baseline[q + 3] < 210 || magentaExcess(baseline, q) > 10 || magentaExcess(source, q) > 50)
                continue;
            // A partially opaque anchor is useful only when it is already a dark outline.
            if (baseline[q + 3] < 228 && Math.max(baseline[q], baseline[q + 1], baseline[q + 2]) > 50)
                continue;
            const foregroundExcess = magentaExcess(baseline, q);
            const fit = Math.max(0, (screenExcess - excess) / (screenExcess - foregroundExcess));
            if (fit >= alpha / 255 - .024)
                continue;
            const error = screen.reduce((sum, value, c) => sum + (source[p + c] - (fit * baseline[q + c] + (1 - fit) * value)) ** 2, 0);
            const score = error + neighbor.distance * 5;
            if (error >= 43 ** 2 || score >= bestScore)
                continue;
            bestScore = score;
            bestOffset = q;
            coverage = fit;
        }
        // With no foreground fit, clear only pixels almost identical to actual screen.
        if (bestOffset < 0 && screenDistance >= 27 ** 2)
            continue;
        if (screenDistance < 30 ** 2)
            coverage = Math.min(.12, coverage);
        const nextAlpha = coverage < .035 ? 0 : Math.round(coverage * 255);
        for (let c = 0; c < 3; c++)
            rgba[p + c] = nextAlpha ? baseline[bestOffset + c] : 0;
        rgba[p + 3] = nextAlpha;
        if (nextAlpha)
            correctedPixels++;
        else
            removedPixels++;
    }
    return { removedPixels, correctedPixels };
}
function screenDistance(source, p, screen) {
    return (source[p] - screen[0]) ** 2 + (source[p + 1] - screen[1]) ** 2 + (source[p + 2] - screen[2]) ** 2;
}
/** Use the original screen pixels to resolve background caught between limbs. */
function recoverMotionGaps(rgba, source, width, height, screen) {
    const pixels = width * height;
    const matchesScreen = new Uint8Array(pixels);
    const transparentScreen = new Uint8Array(pixels);
    const foreground = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
        const p = i * 4, alpha = rgba[p + 3], tint = magentaExcess(source, p);
        if (source[p + 3] === 255 && tint >= 122 && screenDistance(source, p, screen) <= 38 ** 2) {
            matchesScreen[i] = 1;
            const isPadding = source[p] === 255 && source[p + 1] === 0 && source[p + 2] === 255;
            transparentScreen[i] = Number(alpha === 0 && !isPadding);
        }
        const darkOutline = alpha >= 210 && tint < 50 && magentaExcess(rgba, p) <= 9
            && Math.max(rgba[p], rgba[p + 1], rgba[p + 2]) < 54;
        foreground[i] = Number((alpha >= 229 && tint <= 13) || darkOutline);
    }
    const localScreen = (x, y) => {
        const sum = [0, 0, 0];
        let count = 0;
        for (const n of edgeNeighbors) {
            const nx = x + n.x, ny = y + n.y;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height)
                continue;
            const i = ny * width + nx;
            if (!transparentScreen[i])
                continue;
            const p = i * 4;
            for (let c = 0; c < 3; c++)
                sum[c] += source[p + c];
            if (++count === 24)
                break;
        }
        return count >= 4 ? sum.map(value => value / count) : screen;
    };
    const gapEdges = new Uint8Array(pixels);
    let removedPixels = 0, correctedPixels = 0;
    for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
            const i = y * width + x, p = i * 4, alpha = rgba[p + 3];
            if (!matchesScreen[i] || alpha < 40 || alpha >= 240)
                continue;
            let matched = 0;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++)
                    matched += matchesScreen[i + dy * width + dx];
            }
            if (matched < 5 || screenDistance(source, p, localScreen(x, y)) > 33 ** 2)
                continue;
            rgba.fill(0, p, p + 4);
            removedPixels++;
            // Limit the second fit to the newly exposed boundary, including short holes.
            for (let dy = -9; dy <= 9; dy++) {
                const row = y + dy;
                if (row < 0 || row >= height)
                    continue;
                const dx = Math.floor(Math.sqrt(81 - dy * dy));
                gapEdges.fill(1, row * width + Math.max(0, x - dx), row * width + Math.min(width, x + dx + 1));
            }
        }
    }
    if (!removedPixels)
        return { removedPixels, correctedPixels };
    for (let i = 0; i < pixels; i++) {
        if (!gapEdges[i] || foreground[i])
            continue;
        const p = i * 4, alpha = rgba[p + 3];
        if (alpha === 0 || alpha >= 240 || magentaExcess(source, p) < 26)
            continue;
        const x = i % width, y = Math.floor(i / width), color = localScreen(x, y);
        const pr = source[p] - color[0], pg = source[p + 1] - color[1], pb = source[p + 2] - color[2];
        let bestScore = Infinity, anchor = -1, coverage = 0;
        for (const n of edgeNeighbors) {
            const nx = x + n.x, ny = y + n.y;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || !foreground[ny * width + nx])
                continue;
            const q = (ny * width + nx) * 4;
            const fr = rgba[q] - color[0], fg = rgba[q + 1] - color[1], fb = rgba[q + 2] - color[2];
            const fit = Math.max(0, (pr * fr + pg * fg + pb * fb) / (fr * fr + fg * fg + fb * fb));
            if (fit >= alpha / 255 - .023)
                continue;
            const error = (pr - fit * fr) ** 2 + (pg - fit * fg) ** 2 + (pb - fit * fb) ** 2;
            const score = error + n.distance * 4;
            if (error <= 42 ** 2 && score < bestScore) {
                bestScore = score;
                anchor = q;
                coverage = fit;
            }
        }
        if (anchor < 0)
            continue;
        if (coverage < 7 / 255) {
            rgba.fill(0, p, p + 4);
            removedPixels++;
        }
        else {
            rgba.set(rgba.subarray(anchor, anchor + 3), p);
            rgba[p + 3] = Math.round(coverage * 255);
            correctedPixels++;
        }
    }
    return { removedPixels, correctedPixels };
}
/** Refit contaminated coverage against the raw video, while leaving clean pixels alone. */
export function cleanMotionKeySpill(rgba, width, height, keyColor, raw) {
    let removedPixels = 0;
    let correctedPixels = 0;
    if (!supportsMotionKeySpillCleanup(keyColor))
        return { removedPixels, correctedPixels };
    if (rgba.length !== width * height * 4 || (raw && raw.length !== rgba.length)) {
        throw new Error("Motion cleanup requires matching RGBA canvases");
    }
    const source = raw ?? rgba.slice();
    const screen = sampleScreen(source, rgba, width, height);
    const pixels = width * height;
    const definite = new Uint8Array(pixels);
    const background = new Uint8Array(pixels);
    const reference = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
        const p = i * 4;
        const excess = magentaExcess(source, p);
        const alpha = rgba[p + 3];
        const strong = Math.min(source[p], source[p + 2]) >= 128 && excess >= 84
            && Math.abs(source[p] - source[p + 2]) <= 88 && magentaExcess(rgba, p) >= 35;
        definite[i] = Number(alpha > 0 && strong);
        background[i] = Number(alpha === 0 || strong);
        reference[i] = Number(alpha >= 230 && excess <= 8);
    }
    for (let i = 0; i < pixels; i++) {
        const p = i * 4;
        const alpha = rgba[p + 3], excess = magentaExcess(rgba, p);
        if (alpha === 0 || excess < 15 || magentaExcess(source, p) < 15)
            continue;
        const x = i % width, y = Math.floor(i / width);
        let adjacentScreen = 0;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const nx = x + dx, ny = y + dy;
                if ((dx || dy) && nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    adjacentScreen += background[ny * width + nx];
                }
            }
        }
        if (!definite[i] && adjacentScreen === 0)
            continue;
        const fit = fitEdge(source, screen, reference, width, height, x, y);
        const edgeCoverage = Math.min(alpha, Math.round(fit.alpha * 255));
        if (definite[i] && (fit.offset < 0 || edgeCoverage < 36 || adjacentScreen >= 21)) {
            rgba[p] = rgba[p + 1] = rgba[p + 2] = rgba[p + 3] = 0;
            removedPixels++;
            continue;
        }
        if (fit.offset >= 0 && edgeCoverage >= 12 && edgeCoverage < alpha - 6) {
            const q = fit.offset;
            for (let c = 0; c < 3; c++)
                rgba[p + c] = source[q + c];
            rgba[p + 3] = edgeCoverage;
        }
        else {
            // A clean foreground sample may be absent at isolated narrow tips.
            const spill = excess - 6;
            rgba[p] -= spill;
            rgba[p + 2] -= spill;
        }
        correctedPixels++;
    }
    if (raw) {
        const warm = recoverWarmEdges(rgba, raw, width, height);
        const gaps = recoverMotionGaps(rgba, raw, width, height, screen);
        removedPixels += warm.removedPixels + gaps.removedPixels;
        correctedPixels += warm.correctedPixels + gaps.correctedPixels;
    }
    return { removedPixels, correctedPixels };
}
