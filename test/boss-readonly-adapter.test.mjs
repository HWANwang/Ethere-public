import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = join(projectRoot, 'local-data', 'integrations', 'boss-cli-venv', 'Scripts', 'python.exe');

test('BOSS search IDs with base64 punctuation open detail and both results include official links', { skip: !existsSync(python) }, () => {
  const script = `
import importlib.util
spec = importlib.util.spec_from_file_location('boss_readonly', 'scripts/boss-readonly.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
class FakeClient:
    def __init__(self, *args, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def search_jobs(self, **kwargs):
        return {'jobList': [{'securityId': 'a+b/c==', 'encryptJobId': 'c5764d5bbddb9a570nZ529i6ElRR', 'jobName': '测试职位'}]}
    def get_job_detail(self, security_id):
        assert security_id == 'a+b/c=='
        return {'jobInfo': {'jobName': '测试职位', 'postDescription': '测试职责', 'encryptJobId': 'c5764d5bbddb9a570nZ529i6ElRR'}}
b.load_credential = lambda: object()
b.BossClient = FakeClient
jobs = b.run_readonly({'operation': 'search', 'keyword': '测试'})['jobs']
assert jobs[0]['jobUrl'] == 'https://www.zhipin.com/job_detail/c5764d5bbddb9a570nZ529i6ElRR.html'
detail = b.run_readonly({'operation': 'detail', 'securityId': jobs[0]['securityId']})
assert detail['job']['postDescription'] == '测试职责'
assert detail['job']['jobUrl'] == jobs[0]['jobUrl']
assert b.official_job_url('https://not-boss.example/') is None
`;
  const result = spawnSync(python, ['-c', script], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});
