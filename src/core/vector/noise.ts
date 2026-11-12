/** SVG turbulence tables, derived from the algorithm specified in Filter Effects
 * https://www.w3.org/TR/SVG11/filters.html#feTurbulenceElement
 * Rows: permutation, then normalized R/G/B/A gradient vectors. */
export function turbulenceTable(inputSeed: number): Float32Array {
    if (!Number.isFinite(inputSeed))
        throw new Error('Turbulence seed must be finite');
    const modulus = 2147483647;
    let seed = Math.trunc(inputSeed);
    if (seed <= 0)
        seed = -(seed % (modulus - 1)) + 1;
    seed = Math.min(seed, modulus - 1);
    const random = () => {
        seed = (seed * 16807) % modulus;
        return seed;
    };
    const table = new Float32Array(256 * 5 * 4);
    const permutation = Array.from({ length: 256 }, (_, i) => i);
    for (let channel = 0; channel < 4; channel++) {
        for (let index = 0; index < 256; index++) {
            let x: number, y: number, magnitude: number;
            do {
                x = (random() % 512 - 256) / 256;
                y = (random() % 512 - 256) / 256;
                magnitude = Math.hypot(x, y);
            } while (!magnitude);
            const offset = ((channel + 1) * 256 + index) * 4;
            table[offset] = x / magnitude;
            table[offset + 1] = y / magnitude;
        }
    }
    for (let index = 255; index > 0; index--) {
        const next = random() % 256;
        [permutation[index], permutation[next]] = [permutation[next], permutation[index]];
    }
    for (let index = 0; index < 256; index++)
        table[index * 4] = permutation[index];
    return table;
}
