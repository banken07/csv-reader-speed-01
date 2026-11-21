// Entry program (program/v1, Node 22): read every case from the input
// directory, answer each one with run() from solve.js, and write the
// answers as a JSON array to the output directory, in case order.
// Input/output locations default to /input and /output; the harness may
// override them with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR.
import { setFlagsFromString } from 'node:v8';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './solve.js';

setFlagsFromString('--no-incremental-marking');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const answers = cases.map((c) => run(c.input));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
