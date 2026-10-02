"""Read-only simulation data endpoints against disposable SQLite fixtures."""

import sqlite3

from flask import Flask
import pytest

from app.api import simulation as api
from app.services.simulation_manager import SimulationManager


def make_database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.execute('CREATE TABLE post (post_id INTEGER, content TEXT, created_at INTEGER)')
        connection.execute('CREATE TABLE comment (comment_id INTEGER, post_id INTEGER, content TEXT, created_at INTEGER)')
        connection.executemany('INSERT INTO post VALUES (?, ?, ?)', [(1, 'first', 1), (2, 'second', 2), (3, 'third', 3)])
        connection.executemany('INSERT INTO comment VALUES (?, ?, ?, ?)', [(1, 1, 'first comment', 1), (2, 2, 'second comment', 2)])
    connection.close()


@pytest.fixture
def storage(tmp_path, monkeypatch):
    root = tmp_path / 'simulations'
    root.mkdir()
    monkeypatch.setattr(SimulationManager, 'SIMULATION_DATA_DIR', str(root))
    sim_id = 'sim_fixture'
    make_database(root / sim_id / 'reddit_simulation.db')
    app = Flask(__name__)
    app.register_blueprint(api.simulation_bp, url_prefix='/api/simulation')
    return app.test_client(), root, sim_id


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
def test_queries_read_the_manager_storage_root(storage, endpoint):
    client, root, sim_id = storage
    response = client.get(f'/api/simulation/{sim_id}/{endpoint}', query_string={'platform': 'reddit', 'limit': 1, 'offset': 1})
    assert response.status_code == 200
    rows = response.json['data'][endpoint]
    assert len(rows) == 1
    assert rows[0]['content'] == ('second' if endpoint == 'posts' else 'first comment')


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
def test_platform_cannot_select_an_external_sqlite_file(storage, tmp_path, endpoint):
    client, root, sim_id = storage
    outside = tmp_path / 'outside_simulation.db'
    make_database(outside)
    # The old path join accepts an absolute platform and exposes this fixture.
    response = client.get(f'/api/simulation/{sim_id}/{endpoint}', query_string={
        'platform': str(outside)[:-len('_simulation.db')],
    })
    assert response.status_code == 400, response.json
    assert response.json['success'] is False
    assert 'first' not in response.get_data(as_text=True)


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
@pytest.mark.parametrize('query', [
    {'limit': -1}, {'limit': 501}, {'limit': 'invalid'}, {'limit': ''},
    {'offset': -1}, {'offset': 2**63}, {'offset': '1.2'},
])
def test_invalid_or_unbounded_pagination_is_rejected(storage, endpoint, query):
    client, root, sim_id = storage
    response = client.get(f'/api/simulation/{sim_id}/{endpoint}', query_string={'platform': 'reddit', **query})
    assert response.status_code == 400
    assert response.json['success'] is False


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
@pytest.mark.parametrize('simulation_id', ['..', r'..\outside', 'sim:stream', 'sim_fixture.', 'CON', 'lpt1'])
def test_unsafe_simulation_components_are_rejected(storage, endpoint, simulation_id):
    client, root, _ = storage
    response = client.get(f'/api/simulation/{simulation_id}/{endpoint}', query_string={'platform': 'reddit'})
    assert response.status_code == 400
    assert response.json['success'] is False


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
@pytest.mark.parametrize('kind', ['directory', 'database', 'state'])
def test_resolved_storage_escapes_are_rejected(storage, tmp_path, monkeypatch, endpoint, kind):
    client, root, sim_id = storage
    outside = tmp_path / 'outside'
    outside.mkdir()
    make_database(outside / 'reddit_simulation.db')
    (outside / 'state.json').write_text('{}')
    query = {'platform': 'reddit'}
    if kind == 'directory':
        sim_id = 'sim_link'
        link, target = root / sim_id, outside
    elif kind == 'database':
        link, target = root / sim_id / 'reddit_simulation.db', outside / 'reddit_simulation.db'
        link.unlink()
    else:
        link, target = root / sim_id / 'state.json', outside / 'state.json'
        query = {}

        def must_not_load_state(*args):
            pytest.fail('must reject before the state loader reads an external path')
        monkeypatch.setattr(api, '_get_default_platform', must_not_load_state)
    try:
        link.symlink_to(target, target_is_directory=kind == 'directory')
    except (OSError, NotImplementedError):
        pytest.skip('symlinks unavailable on this platform')

    response = client.get(f'/api/simulation/{sim_id}/{endpoint}', query_string=query)
    assert response.status_code == 400
    assert response.json['success'] is False


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
def test_missing_simulation_reads_create_no_files_or_directories(storage, endpoint):
    client, root, _ = storage
    before = set(root.rglob('*'))
    response = client.get(f'/api/simulation/sim_missing/{endpoint}')
    assert response.status_code == 200
    assert response.json['data'][endpoint] == []
    assert set(root.rglob('*')) == before


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
def test_queries_open_readonly_and_close_connections(storage, monkeypatch, endpoint):
    client, root, sim_id = storage
    original = sqlite3.connect
    connections = []

    def inspect_connection(*args, **kwargs):
        connection = original(*args, **kwargs)
        connections.append(connection)
        with pytest.raises(sqlite3.OperationalError, match='readonly'):
            connection.execute('CREATE TABLE must_not_write (value INTEGER)')
        return connection

    monkeypatch.setattr(sqlite3, 'connect', inspect_connection)
    response = client.get(f'/api/simulation/{sim_id}/{endpoint}', query_string={'platform': 'reddit'})
    assert response.status_code == 200
    assert response.json['data']['count'] > 0
    assert len(connections) == 1
    with pytest.raises(sqlite3.ProgrammingError, match='closed'):
        connections[0].execute('SELECT 1')


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
def test_unexpected_query_errors_still_close_connections(storage, monkeypatch, endpoint):
    client, root, sim_id = storage
    original = sqlite3.connect
    connections = []

    class BrokenCursor(sqlite3.Cursor):
        def execute(self, *args, **kwargs):
            raise RuntimeError('synthetic unexpected query failure')

    class BrokenConnection(sqlite3.Connection):
        def cursor(self, *args, **kwargs):
            return super().cursor(factory=BrokenCursor)

    def broken_connection(*args, **kwargs):
        connection = original(*args, **kwargs, factory=BrokenConnection)
        connections.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, 'connect', broken_connection)
    response = client.get(f'/api/simulation/{sim_id}/{endpoint}', query_string={'platform': 'reddit'})
    assert response.status_code == 500
    assert len(connections) == 1
    with pytest.raises(sqlite3.ProgrammingError, match='closed'):
        connections[0].execute('SELECT 1')


def test_default_platform_honors_saved_simulation_state(storage):
    from app.services.simulation_manager import SimulationState
    client, root, sim_id = storage
    manager = SimulationManager()
    manager._save_simulation_state(SimulationState(
        simulation_id=sim_id, project_id='project_fixture', graph_id='graph_fixture',
        enable_twitter=True, enable_reddit=False,
    ))
    make_database(root / sim_id / 'twitter_simulation.db')
    response = client.get(f'/api/simulation/{sim_id}/posts')
    assert response.status_code == 200
    assert response.json['data']['platform'] == 'twitter'
    assert response.json['data']['total'] == 3


def test_zero_limit_maximum_offset_and_post_filters_remain_supported(storage):
    client, root, sim_id = storage
    response = client.get(f'/api/simulation/{sim_id}/posts', query_string={'limit': 0})
    assert response.json['data']['count'] == 0
    assert response.json['data']['total'] == 3
    response = client.get(f'/api/simulation/{sim_id}/posts', query_string={'limit': 500, 'offset': 2**63 - 1})
    assert response.status_code == 200
    assert response.json['data']['posts'] == []
    response = client.get(f'/api/simulation/{sim_id}/comments', query_string={'post_id': 1})
    assert response.json['data']['count'] == 1
    assert response.json['data']['comments'][0]['content'] == 'first comment'
    response = client.get(f'/api/simulation/{sim_id}/comments', query_string={'post_id': '1 OR 1=1'})
    assert response.json['data']['comments'] == []


def test_readonly_queries_see_committed_live_wal_data(storage):
    client, root, sim_id = storage
    connection = sqlite3.connect(root / sim_id / 'reddit_simulation.db')
    try:
        assert connection.execute('PRAGMA journal_mode=WAL').fetchone()[0] == 'wal'
        connection.execute('PRAGMA wal_autocheckpoint=0')
        connection.execute('INSERT INTO post VALUES (4, "live committed post", 4)')
        connection.commit()
        response = client.get(f'/api/simulation/{sim_id}/posts')
        assert response.status_code == 200
        assert response.json['data']['posts'][0]['content'] == 'live committed post'
        assert response.json['data']['total'] == 4
    finally:
        connection.close()


def test_uri_escapes_storage_directory_characters(storage, tmp_path, monkeypatch):
    client, root, sim_id = storage
    special_root = tmp_path / 'simulations # ? café'
    make_database(special_root / sim_id / 'reddit_simulation.db')
    monkeypatch.setattr(SimulationManager, 'SIMULATION_DATA_DIR', str(special_root))
    response = client.get(f'/api/simulation/{sim_id}/posts')
    assert response.status_code == 200
    assert response.json['data']['count'] == 3


@pytest.mark.parametrize('endpoint', ['posts', 'comments'])
def test_disappearing_database_is_not_recreated_by_a_read(storage, monkeypatch, endpoint):
    client, root, sim_id = storage
    database = root / sim_id / 'reddit_simulation.db'
    original = sqlite3.connect

    def removed_before_open(*args, **kwargs):
        database.unlink()  # Only this test's temporary SQLite fixture.
        return original(*args, **kwargs)

    monkeypatch.setattr(sqlite3, 'connect', removed_before_open)
    response = client.get(f'/api/simulation/{sim_id}/{endpoint}', query_string={'platform': 'reddit'})
    assert response.status_code == 500
    assert response.json['success'] is False
    assert not database.exists()
