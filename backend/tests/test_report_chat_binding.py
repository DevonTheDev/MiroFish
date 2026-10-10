"""Real persisted reports, Flask chat route and ReportAgent; inference is synthetic."""

from copy import deepcopy
import json
from types import SimpleNamespace

from flask import Flask
import pytest

from app.api.report import report_bp
from app.models.project import Project, ProjectManager, ProjectStatus
from app.services.report_agent import Report, ReportAgent, ReportManager, ReportStatus
from app.services.simulation_manager import SimulationManager, SimulationState
from app.utils.locale import t


@pytest.fixture
def chat(tmp_path, monkeypatch):
    root = tmp_path / 'reports'
    root.mkdir()
    monkeypatch.setattr(ReportManager, 'REPORTS_DIR', str(root))
    monkeypatch.setattr(ProjectManager, 'PROJECTS_DIR', str(tmp_path / 'projects'))
    monkeypatch.setattr(SimulationManager, 'SIMULATION_DATA_DIR', str(tmp_path / 'simulations'))
    project = Project('project_chat', 'Synthetic', ProjectStatus.GRAPH_COMPLETED,
                      '2026-01-01', '2026-01-01', graph_id='graph_chat',
                      simulation_requirement='Synthetic requirement')
    (tmp_path / 'projects' / project.project_id).mkdir(parents=True)
    ProjectManager.save_project(project)
    state = SimulationState('sim_chat', project.project_id, project.graph_id)
    SimulationManager()._save_simulation_state(state)
    calls, prompts, tools = [], [], []
    responses = []
    on_init = []

    def llm_chat(*, messages, **kwargs):
        prompts.append(deepcopy(messages))
        return responses.pop(0) if responses else 'Synthetic answer'

    def quick_search(**kwargs):
        tools.append(kwargs)
        return SimpleNamespace(to_text=lambda: 'Synthetic current graph result')

    original_init = ReportAgent.__init__

    def injected_init(self, *args, **kwargs):
        calls.append(kwargs.copy())
        for action in on_init:
            action()
        original_init(self, *args, **kwargs, llm_client=SimpleNamespace(chat=llm_chat),
                      zep_tools=SimpleNamespace(quick_search=quick_search))

    monkeypatch.setattr(ReportAgent, '__init__', injected_init)
    app = Flask(__name__)
    app.register_blueprint(report_bp, url_prefix='/api/report')
    client = app.test_client()

    def save(report_id, created_at, legacy=False, **overrides):
        report = Report(report_id, 'sim_chat', 'graph_chat', 'Synthetic requirement',
                        ReportStatus.COMPLETED,
                        markdown_content=f'Only saved text from {report_id}', created_at=created_at)
        for key, value in overrides.items():
            setattr(report, key, value)
        if legacy:
            (root / f'{report_id}.json').write_text(json.dumps(report.to_dict()))
        else:
            ReportManager.save_report(report)
        return report

    def post(**overrides):
        return client.post('/api/report/chat', json={
            'simulation_id': 'sim_chat', 'message': 'Explain the visible report', **overrides,
        })

    return SimpleNamespace(root=root, project=project, state=state, save=save, post=post,
                           calls=calls, prompts=prompts, tools=tools, responses=responses,
                           on_init=on_init)


@pytest.mark.parametrize('formats', [(False, False), (True, True), (False, True), (True, False)])
@pytest.mark.parametrize('explicit', [True, False])
def test_endpoint_prompt_selects_explicit_report_or_legacy_latest(chat, formats, explicit):
    older = chat.save('report_a', '2026-01-01', formats[0])
    newer = chat.save('report_b', '2026-01-02', formats[1])
    response = chat.post(**({'report_id': older.report_id} if explicit else {}))
    assert response.status_code == 200
    assert response.get_json()['data']['response'] == 'Synthetic answer'
    assert len(chat.calls) == len(chat.prompts) == 1
    selected, other = (older, newer) if explicit else (newer, older)
    assert selected.markdown_content in chat.prompts[0][0]['content']
    assert other.markdown_content not in chat.prompts[0][0]['content']


@pytest.mark.parametrize('report_id', [None, False, 0, 123, [], {}, '', ' ', '../report_a',
                                      'a/b', 'a\\b', 'CON', 'x' * 129])
def test_invalid_explicit_id_fails_before_agent_work(chat, report_id):
    chat.save('report_b', '2026-01-02')
    response = chat.post(report_id=report_id)
    assert response.status_code == 400
    assert response.get_json()['success'] is False
    assert chat.calls == chat.prompts == []


@pytest.mark.parametrize('legacy', [False, True])
@pytest.mark.parametrize('damage', ['missing', 'json', 'read', 'status', 'wrong_id',
                                    'wrong_simulation', 'empty_text', 'nonstring_text'])
def test_unusable_explicit_report_never_falls_back_or_constructs_agent(chat, legacy, damage):
    chat.save('report_b', '2026-01-02')
    if damage != 'missing':
        report = chat.save('report_a', '2026-01-01', legacy)
        path = chat.root / ('report_a.json' if legacy else 'report_a/meta.json')
        data = report.to_dict()
        if damage == 'json':
            path.write_text('{"report_id":')
        elif damage == 'read':
            path.unlink()
            path.mkdir()
        else:
            if damage == 'status':
                data['status'] = 'unknown'
            elif damage == 'wrong_id':
                data['report_id'] = 'report_b'
            elif damage == 'wrong_simulation':
                data['simulation_id'] = 'sim_other'
            elif damage == 'empty_text':
                data['markdown_content'] = ' \t'
            elif damage == 'nonstring_text':
                data['markdown_content'] = {'invalid': 'text'}
            path.write_text(json.dumps(data))
    response = chat.post(report_id='report_a')
    assert response.status_code == (404 if damage in {'missing', 'wrong_simulation'} else 500)
    assert response.get_json()['success'] is False
    assert chat.calls == chat.prompts == []


@pytest.mark.parametrize('status', [ReportStatus.PENDING, ReportStatus.PLANNING,
                                   ReportStatus.GENERATING, ReportStatus.FAILED])
def test_explicit_report_must_be_completed(chat, status):
    chat.save('report_a', '2026-01-01', status=status)
    chat.save('report_b', '2026-01-02')
    assert chat.post(report_id='report_a').status_code == 409
    assert chat.calls == chat.prompts == []


@pytest.mark.parametrize('legacy', [False, True])
def test_explicit_text_is_captured_before_agent_initialization_and_nested_tools(chat, legacy):
    older = chat.save('report_a', '2026-01-01', legacy)
    newer = chat.save('report_b', '2026-01-02')
    def regenerate():
        chat.save('report_a', '2026-01-01', legacy, markdown_content='Replaced A after validation')
        chat.save('report_c', '2026-01-03')
    chat.on_init.append(regenerate)
    chat.responses.extend([
        '<tool_call>{"name":"quick_search","parameters":{"query":"test"}}</tool_call>',
        'Synthetic answer',
    ])
    response = chat.post(report_id='report_a')
    assert response.status_code == 200
    assert len(chat.prompts) == 2
    assert len(chat.tools) == 1
    assert chat.tools[0] == {'graph_id': 'graph_chat', 'query': 'test', 'limit': 10}
    for prompt in chat.prompts:
        assert older.markdown_content in prompt[0]['content']
        assert newer.markdown_content not in prompt[0]['content']
        assert 'Only saved text from report_c' not in prompt[0]['content']
        assert 'Replaced A after validation' not in prompt[0]['content']


@pytest.mark.parametrize('stage', ['simulation_id', 'message', 'simulation', 'project', 'graph'])
def test_existing_validation_order_precedes_explicit_report_validation(chat, stage):
    body = {'report_id': '../invalid'}
    if stage == 'simulation_id':
        body['simulation_id'] = ''
        expected, error = 400, t('api.requireSimulationId')
    elif stage == 'message':
        body['message'] = ''
        expected, error = 400, t('api.requireMessage')
    elif stage == 'simulation':
        body['simulation_id'] = 'sim_absent'
        expected, error = 404, t('api.simulationNotFound', id='sim_absent')
    elif stage == 'project':
        chat.state.project_id = 'project_absent'
        SimulationManager()._save_simulation_state(chat.state)
        expected, error = 404, t('api.projectNotFound', id='project_absent')
    else:
        chat.project.graph_id = chat.state.graph_id = None
        ProjectManager.save_project(chat.project)
        SimulationManager()._save_simulation_state(chat.state)
        expected, error = 400, t('api.missingGraphId')
    response = chat.post(**body)
    assert response.status_code == expected
    assert response.get_json()['error'] == error
    assert chat.calls == chat.prompts == []


@pytest.mark.parametrize('explicit', [False, True])
def test_chat_keeps_report_context_and_history_limits(chat, explicit):
    text = 'a' * 15000 + 'EXCLUDED_TAIL'
    chat.save('report_a', '2026-01-01', markdown_content=text)
    history = [{'role': 'user', 'content': f'History {index}'} for index in range(12)]
    response = chat.post(chat_history=history, **({'report_id': 'report_a'} if explicit else {}))
    assert response.status_code == 200
    prompt = chat.prompts[0]
    assert text[:15000] in prompt[0]['content']
    assert 'EXCLUDED_TAIL' not in prompt[0]['content']
    assert '... [报告内容已截断] ...' in prompt[0]['content']
    assert prompt[1:-1] == history[-10:]


@pytest.mark.parametrize('legacy', [False, True])
def test_explicit_report_uses_existing_markdown_file_fallback(chat, legacy):
    report = chat.save('report_a', '2026-01-01', legacy, markdown_content='')
    folder = chat.root / report.report_id
    folder.mkdir(exist_ok=True)
    (folder / 'full_report.md').write_text('Stored fallback text from A')
    chat.save('report_b', '2026-01-02')
    assert chat.post(report_id='report_a').status_code == 200
    assert 'Stored fallback text from A' in chat.prompts[0][0]['content']
    assert 'Only saved text from report_b' not in chat.prompts[0][0]['content']


@pytest.mark.parametrize('legacy', [False, True])
def test_explicit_symlinked_report_is_rejected_by_storage_boundary(chat, tmp_path, legacy):
    outside = tmp_path / 'outside'
    outside.mkdir()
    target = chat.save('report_outside', '2026-01-01', True)
    if legacy:
        (chat.root / 'report_a.json').symlink_to(chat.root / 'report_outside.json')
    else:
        (outside / 'meta.json').write_text(json.dumps(target.to_dict()))
        (chat.root / 'report_a').symlink_to(outside, target_is_directory=True)
    chat.save('report_b', '2026-01-02')
    assert chat.post(report_id='report_a').status_code == 400
    assert chat.calls == chat.prompts == []


@pytest.mark.parametrize('damage', ['missing', 'broken', 'nonstring'])
def test_legacy_chat_keeps_best_effort_report_loading(chat, damage):
    if damage != 'missing':
        chat.save('report_b', '2026-01-02')
        path = chat.root / 'report_b/meta.json'
        if damage == 'broken':
            path.write_text('{')
        else:
            data = json.loads(path.read_text())
            data['markdown_content'] = 123
            path.write_text(json.dumps(data))
    assert chat.post().status_code == 200
    assert len(chat.calls) == len(chat.prompts) == 1
