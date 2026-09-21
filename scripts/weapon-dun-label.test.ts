import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const roster = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');
const profilePanel = readFileSync(new URL('../public/shared/profile-panel.js', import.meta.url), 'utf8');

// KRKG-0101: the axe's UI name is "dun" (Duńczyk), never "topór". The icon filenames and the
// weaponId keep their internal "topor"/"dunczyk" spelling - only the human-facing label changes.
test('the roster and profile drawer label the axe weapon "dun", not "topór"', () => {
  for (const source of [roster, profilePanel]) {
    assert.match(source, /dunczyk:\s*'dun'/);
    assert.doesNotMatch(source, /dunczyk:\s*'topór'/);
    assert.doesNotMatch(source, /dunczyk:\s*'DUN'/);
  }
});
