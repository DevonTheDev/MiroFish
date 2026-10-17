"""Run isolated recipe reader/API tests and record their real response bytes."""
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
fixture = evidence / 'backend-input-recipe.json'
assert not fixture.exists(), "Refuse to overwrite generated evidence."
work = evidence / 'tmp'
work.mkdir()
os.environ.update({'TMPDIR': str(work), 'PYTHON_DOTENV_DISABLED': '1',
                   'MIROFISH_RECIPE_FIXTURE_OUTPUT': str(fixture)})
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
        raise AssertionError('recipe tests forbid ' + event)
sys.addaudithook(deny_event)
def forbid_thread(*args, **kwargs):
    denied.append('thread.start')
    raise AssertionError('recipe tests forbid thread start')
threading.Thread.start = forbid_thread

sys.path.insert(0, str(ROOT / 'backend/tests'))
suite = unittest.defaultTestLoader.loadTestsFromNames(['test_project_input_recipe', 'test_project_input_recipe_api'])
assert suite.countTestCases() == 32
result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
unexpected = [name for name in sys.modules if name == 'app' or name.startswith('app.')
              or name.split('.')[0] in {'openai', 'zep_cloud', 'oasis', 'torch', 'transformers'}]
successful = result.wasSuccessful() and result.testsRun == 32 and not result.skipped and not denied and not unexpected
if successful:
    assert fixture.is_file() and fixture.stat().st_size <= 2 * 1024**2
    fixture.with_suffix('.sha256').write_text(hashlib.sha256(fixture.read_bytes()).hexdigest() + '  backend-input-recipe.json\n')
print(json.dumps({'tests_run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
                  'skipped': len(result.skipped), 'successful': successful,
                  'denied_actions': denied, 'unexpected_imports': unexpected}))
raise SystemExit(0 if successful else 1)
