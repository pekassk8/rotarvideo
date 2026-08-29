// Prueba del núcleo de RotarVideo (app.js) contra los MP4/MOV sintéticos.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '../app.js'), 'utf8');
new Function(appSrc)();
const core = globalThis.RotarCore;
if (!core) throw new Error('RotarCore no quedó expuesto');

// Ejecutar antes: python3 tests/gen_test_mp4.py tests/media
const manifest = JSON.parse(readFileSync(join(here, 'media/manifest.json'), 'utf8'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('  ✗ ' + msg); }
}

// --- Prueba unitaria de matrixBytes contra valores calculados a mano ---
const FX = 65536, W30 = 0x40000000;
const handTable = {
  0:   [FX, 0, 0, 0, FX, 0, 0, 0, W30],
  90:  [0, FX, 0, -FX, 0, 0, 1080 * FX, 0, W30],
  180: [-FX, 0, 0, 0, -FX, 0, 1920 * FX, 1080 * FX, W30],
  270: [0, -FX, 0, FX, 0, 0, 0, 1920 * FX, W30],
};
for (const [ang, vals] of Object.entries(handTable)) {
  const got = new DataView(core.matrixBytes(Number(ang), 1920, 1080).buffer);
  vals.forEach((v, i) => check(got.getInt32(i * 4) === v, `matrixBytes(${ang})[${i}] = ${got.getInt32(i * 4)}, esperado ${v}`));
}
console.log('matrixBytes: tabla verificada');

// deltaCW equivalente a N toques de giro antihorario (como en la app)
const deltaFromTaps = taps => (360 - (taps * 90) % 360) % 360;

for (const entry of manifest) {
  const raw = readFileSync(join(here, 'media', entry.name));
  const input = new File([raw], entry.name, {
    type: entry.name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4',
  });

  console.log(`\n== ${entry.name} (${entry.note}) ==`);
  const info = await core.analyzeVideo(input);

  check(info.tracks.length === entry.matrixOffsets.length,
    `tracks de video: ${info.tracks.length}, esperado ${entry.matrixOffsets.length}`);
  check(info.angle === entry.angle, `ángulo detectado ${info.angle}, esperado ${entry.angle}`);
  check(info.tracks[0].codedW === entry.W && info.tracks[0].codedH === entry.H,
    `dims ${info.tracks[0].codedW}x${info.tracks[0].codedH}, esperado ${entry.W}x${entry.H}`);
  info.tracks.forEach((t, i) =>
    check(t.matrixAbs === entry.matrixOffsets[i],
      `offset matriz ${t.matrixAbs}, esperado ${entry.matrixOffsets[i]}`));

  for (const taps of [0, 1, 2, 3]) {
    const delta = deltaFromTaps(taps);
    const out = core.buildRotated(input, info, delta);
    const outBuf = Buffer.from(await out.arrayBuffer());
    const expectedAngle = (entry.angle + delta) % 360;

    check(out.size === input.size, `[taps=${taps}] tamaño ${out.size} ≠ ${input.size}`);
    check(out.type === input.type, `[taps=${taps}] tipo ${out.type}`);
    check(/-girado\.(mp4|mov)$/i.test(out.name), `[taps=${taps}] nombre ${out.name}`);

    // Bytes fuera de las regiones editadas: idénticos al original
    const edited = new Set();
    for (const off of entry.matrixOffsets)
      for (let k = 0; k < 44; k++) edited.add(off + k);
    let diffOutside = 0;
    for (let i = 0; i < raw.length; i++)
      if (!edited.has(i) && raw[i] !== outBuf[i]) diffOutside++;
    check(diffOutside === 0, `[taps=${taps}] ${diffOutside} bytes alterados fuera de la matriz`);

    // Matriz y ancho/alto escritos correctamente
    for (const [i, off] of entry.matrixOffsets.entries()) {
      const t = info.tracks[i];
      const expect = Buffer.from(core.matrixBytes(expectedAngle, t.codedW, t.codedH));
      check(outBuf.subarray(off, off + 36).equals(expect), `[taps=${taps}] matriz escrita incorrecta`);
      check(outBuf.readUInt32BE(off + 36) === t.codedW * FX, `[taps=${taps}] ancho tkhd`);
      check(outBuf.readUInt32BE(off + 40) === t.codedH * FX, `[taps=${taps}] alto tkhd`);
    }

    // El resultado se puede volver a analizar y refleja el nuevo ángulo
    const reInfo = await core.analyzeVideo(out);
    check(reInfo.angle === expectedAngle,
      `[taps=${taps}] reanálisis: ángulo ${reInfo.angle}, esperado ${expectedAngle}`);

    if (taps === 3) console.log(`  taps=3 → ${entry.angle}° + ${delta}° CW = ${expectedAngle}° ✓`);
  }
  console.log('  taps 0-3 verificados (tamaño, bytes intactos, matriz, reanálisis)');
}

// --- Caso de error: archivo que no es MP4 ---
try {
  await core.analyzeVideo(new File([Buffer.from('esto no es un mp4, solo texto de relleno......')], 'x.txt', { type: 'text/plain' }));
  check(false, 'analyzeVideo aceptó un archivo no MP4');
} catch (e) {
  console.log('\narchivo no MP4 rechazado correctamente: "' + e.message + '"');
}

console.log(failures === 0 ? '\nTODAS LAS PRUEBAS PASARON ✅' : `\n${failures} FALLOS ❌`);
process.exit(failures === 0 ? 0 : 1);
