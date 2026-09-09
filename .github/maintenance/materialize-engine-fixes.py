"""Apply the reviewed, hash-checked engine edits in an isolated checkout."""
from pathlib import Path
import hashlib
import json
import os
import subprocess

BASE = '2631df5d1330f18d18b9ef6ceb1e31c477053646'
MANIFEST = '54cfe1a3d97aba9cd4922bc6c2c94f04be9f5954f8700f5f24cec6d6b9e25272'
root = Path.cwd().resolve()
files = []
for file in sorted((root / '.github/maintenance').glob('engine-regression-edits-*.json')):
    payload = json.loads(file.read_text(encoding='utf-8'))
    assert payload['base_commit'] == BASE, 'Unexpected source revision'
    files.extend(payload['files'])
assert len(files) == 51, 'Incomplete edit set'
# Correct the JSON escape representation of JS word-boundary regexes before
# checking the resulting source hash; no source is accepted without its hash.
for file in files:
    for edit in file['edits']:
        edit[2] = edit[2].replace(chr(8), chr(92) + 'b')
records = [(f['path'], f['before'], f['after']) for f in files]
assert hashlib.sha256(json.dumps(records, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest() == MANIFEST, 'Manifest differs from local validation'
subprocess.run(['git', 'merge-base', '--is-ancestor', BASE, 'HEAD'], check=True)
prepared = {}
for file in files:
    relative = Path(file['path'])
    assert not relative.is_absolute() and '..' not in relative.parts
    assert relative.parts[0] == 'world-engine' and 'output' not in relative.parts
    target = root / relative
    assert target.resolve().is_relative_to(root) and not target.is_symlink()
    assert str(relative) not in prepared, 'Duplicate target'
    if file['before'] is None:
        assert not target.exists(), f'New file already exists: {relative}'
        original = ''
    else:
        original = target.read_text(encoding='utf-8')
        assert hashlib.sha256(original.encode()).hexdigest() == file['before'], f'Base content mismatch: {relative}'
    previous_end = 0
    for start, end, replacement in file['edits']:
        assert isinstance(start, int) and isinstance(end, int)
        assert previous_end <= start <= end <= len(original)
        assert isinstance(replacement, str)
        previous_end = end
    result = original
    for start, end, replacement in reversed(file['edits']):
        result = result[:start] + replacement + result[end:]
    assert hashlib.sha256(result.encode()).hexdigest() == file['after'], f'Result differs from tested source: {relative}'
    prepared[str(relative)] = result
# Validate the entire edit set before writing even one file.
for relative, text in prepared.items():
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')
    print('VERIFIED', relative)
(Path(os.environ['RUNNER_TEMP']) / 'engine-fix-paths.txt').write_text('\n'.join(prepared) + '\n', encoding='utf-8')
