"""Run isolated candidate reader/API cases and retain actual workflow bytes."""
import hashlib
import json
import os
from pathlib import Path
import resource
import sys
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
assert len(sys.argv) == 2, "Supply a new runner-owned evidence directory."
evidence = Path(sys.argv[1]).resolve(strict=True)
for name in ('backend-input-candidates.json', 'backend-input-recipe.json'):
    assert not (evidence / name).exists(), "Refuse to overwrite generated evidence."
work = evidence / 'tmp'
work.mkdir()
os.environ.update({'TMPDIR': str(work), 'PYTHON_DOTENV_DISABLED': '1',
                   'MIROFISH_CANDIDATE_FIXTURE_DIR': str(evidence)})
resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024**2, 16 * 1024**2))
resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))

denied = []
def deny_event(event, args):
    if event in {'subprocess.Popen', 'os.system', 'os.fork', 'os.forkpty', 'os.posix_spawn', 'os.exec',
                 'socket.connect', 'socket.bind', 'socket.getaddrinfo', 'socket.gethostbyname',
                 'socket.gethostbyaddr', 'socket.getnameinfo', 'socket.sendto', 'socket.sendmsg'}:
        denied.append(event)
        raise AssertionError('candidate tests forbid ' + event)
sys.addaudithook(deny_event)
def forbid_thread(*args, **kwargs):
    denied.append('thread.start')
    raise AssertionError('candidate tests forbid thread start')
threading.Thread.start = forbid_thread

sys.path.insert(0, str(ROOT / 'backend/tests'))
suite = unittest.defaultTestLoader.loadTestsFromNames(['test_project_input_candidates', 'test_project_input_candidates_api'])
assert suite.countTestCases() == 42
result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
unexpected = [name for name in sys.modules if name == 'app' or name.startswith('app.')
              or name.split('.')[0] in {'openai', 'zep_cloud', 'oasis', 'torch', 'transformers'}]
successful = result.wasSuccessful() and result.testsRun == 42 and not result.skipped and not denied and not unexpected
if successful:
    for name, ceiling in [('backend-input-candidates', 256 * 1024), ('backend-input-recipe', 2 * 1024**2)]:
        fixture = evidence / (name + '.json')
        assert fixture.is_file() and fixture.stat().st_size <= ceiling
        assert fixture.with_suffix('.sha256').read_text().split()[0] == hashlib.sha256(fixture.read_bytes()).hexdigest()
print(json.dumps({'tests_run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
                  'skipped': len(result.skipped), 'successful': successful,
                  'denied_actions': denied, 'unexpected_imports': unexpected}))
raise SystemExit(0 if successful else 1)
