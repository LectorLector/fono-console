// Generates the small room-scan fixtures with known bounding boxes (deterministic; run by tests/run.mjs).
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(dir, { recursive: true });

// a 4.2 (length) x 3.1 (width) x 2.5 (height) m room: 8 corners + a few interior points
const corners = (a, b, c) => { const v = []; for (const x of [0, a]) for (const y of [0, b]) for (const z of [0, c]) v.push([x, y, z]); v.push([a / 2, b / 2, c / 2], [a / 3, b / 3, c / 3]); return v; };
const obj = (v, k = 1) => '# fixture\no room\n' + v.map(p => `v ${p.map(x => (x * k).toFixed(4)).join(' ')}`).join('\n') + '\nvn 0 1 0\nvt 0 0\nf 1 2 4 3\n';

// y-up (OBJ default for most scanners): x = length, y = height, z = width
const yUp = corners(4.2, 2.5, 3.1);
writeFileSync(join(dir, 'room-m.obj'), obj(yUp));
writeFileSync(join(dir, 'room-cm.obj'), obj(yUp, 100));                    // centimetre scale
writeFileSync(join(dir, 'room-mm.obj'), obj(yUp, 1000));                   // millimetre scale
writeFileSync(join(dir, 'room-zup.obj'), obj(corners(4.2, 3.1, 2.5)));     // z-up: x length, y width, z height
writeFileSync(join(dir, 'empty.obj'), '# no vertices\nf 1 2 3\n');

const gltf = () => ({
  asset: { version: '2.0' },
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [4.2, 2.5, 3.1] }],
});
writeFileSync(join(dir, 'room.gltf'), JSON.stringify(gltf()));
{
  let json = JSON.stringify(gltf()); while (json.length % 4) json += ' ';
  const jb = Buffer.from(json), bin = Buffer.alloc(8 * 12);
  const total = 12 + 8 + jb.length + 8 + bin.length, b = Buffer.alloc(total); let o = 0;
  b.writeUInt32LE(0x46546C67, o); b.writeUInt32LE(2, o + 4); b.writeUInt32LE(total, o + 8); o += 12;
  b.writeUInt32LE(jb.length, o); b.writeUInt32LE(0x4E4F534A, o + 4); jb.copy(b, o + 8); o += 8 + jb.length;
  b.writeUInt32LE(bin.length, o); b.writeUInt32LE(0x004E4942, o + 4); bin.copy(b, o + 8);
  writeFileSync(join(dir, 'room.glb'), b);
}
writeFileSync(join(dir, 'bad.glb'), Buffer.from('this is not a glb file at all, just text'));
// 1x1 PNG / JPEG-ish fixtures for the wallpaper upload test
writeFileSync(join(dir, 'wall.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(join(dir, 'not-image.png'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
console.log('fixtures written to', dir);
