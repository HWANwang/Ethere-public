import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBossSession, reloadBossPage } from '../scripts/boss-browser-session.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapter = join(projectRoot, 'scripts', 'boss-readonly.py');
const defaultPython = join(projectRoot, 'local-data', 'integrations', 'boss-cli-venv', 'Scripts', 'python.exe');
const field = (description, maxLength = 80) => ({ type: 'string', minLength: 1, maxLength, description });

export function createBossMcpTools({ dataRoot, run = runBossReadOnly }) {
  if (!dataRoot) throw new Error('缺少 Ethere 数据目录');
  const credentialFile = join(dataRoot, 'integrations', 'boss-cli', 'credential.json');
  const tools = [
    {
      name: 'ethere_boss_search_jobs',
      description: '只读搜索 BOSS 直聘职位，返回 securityId 与可打开的官方 jobUrl。可按城市、薪资、经验、学历等筛选；不打招呼、不投递。需要找工作时才调用，不要后台扫岗。若提示未登录，请用户在专用窗口授权；不得读取或输出 Cookie。',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['keyword'], properties: {
          keyword: field('职位关键词，如产品经理、数据分析', 80),
          city: field('城市中文名，默认全国', 20),
          page: { type: 'integer', minimum: 1, maximum: 5, description: '页码，默认 1，每页最多 15 个。' },
          salary: field('薪资范围，如 10-15K、15-20K、20-30K', 20),
          experience: field('经验要求，如 应届、1-3年、3-5年', 20),
          degree: field('学历要求，如 本科、硕士', 20),
          industry: field('行业，如 互联网、人工智能', 30),
          scale: field('公司规模，如 100-499人、1000-9999人', 30),
          stage: field('融资阶段，如 A轮、已上市', 30),
          jobType: field('职位类型：全职、兼职或实习', 10),
        },
      },
      annotations: { readOnlyHint: true },
      call: (args) => run({ ...args, operation: 'search' }, { credentialFile, dataRoot }),
    },
    {
      name: 'ethere_boss_job_detail',
      description: '只读查看 BOSS 职位详情。传入搜索结果原样的 securityId（可能含 + / = 等字符），可附带 encryptJobId 以保留官方职位链接；不会打招呼、投递或读取聊天/简历。',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['securityId'], properties: {
          securityId: field('搜索结果中的 securityId；不是职位标题。', 1024),
          encryptJobId: field('可选，搜索结果中的 encryptJobId，用于生成官方职位链接。', 128),
        },
      },
      annotations: { readOnlyHint: true },
      call: (args) => run({ operation: 'detail', securityId: args.securityId, encryptJobId: args.encryptJobId }, { credentialFile, dataRoot }),
    },
  ];
  return {
    list: () => tools.map(({ call, ...tool }) => tool),
    async call(name, args = {}) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw Object.assign(new Error(`未知工具：${name}`), { code: 'UNKNOWN_TOOL' });
      return tool.call(args && typeof args === 'object' ? args : {});
    },
  };
}

export async function runBossReadOnly(request, {
  credentialFile, dataRoot = resolve(dirname(credentialFile), '..', '..'),
  python = process.env.ETHERE_BOSS_PYTHON || defaultPython,
  refreshSession = importBossSession, reloadPage = reloadBossPage, execute = executeBossAdapter,
} = {}) {
  if (!existsSync(python)) throw Object.assign(new Error('BOSS 只读组件尚未安装'), { code: 'BOSS_NOT_INSTALLED' });
  if (!existsSync(credentialFile)) throw Object.assign(new Error('BOSS 尚未完成专用浏览器登录'), { code: 'BOSS_NOT_LOGGED_IN' });
  // Browser-side JS can refresh BOSS's short-lived security cookie. Never rely on
  // the old seven-day TTL in boss-cli, and never read cookies from other browsers.
  await refreshSession({ dataRoot, launchIfMissing: true });
  try { return await execute(request, { credentialFile, python }); }
  catch (error) {
    if (error.code !== 'BOSS_SESSION_EXPIRED') throw error;
    // One browser reload/renewal only; a verification page needs the user, not a loop.
    await reloadPage();
    await refreshSession({ dataRoot, launchIfMissing: false });
    return execute(request, { credentialFile, python });
  }
}

function executeBossAdapter(request, { credentialFile, python }) {
  const body = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const child = spawn(python, [adapter], {
      cwd: projectRoot, shell: false, windowsHide: true,
      env: { ...process.env, ETHERE_BOSS_CREDENTIAL_FILE: credentialFile, PYTHONUTF8: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 45_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (part) => {
      stdout += part;
      if (stdout.length > 1_000_000) child.kill();
    });
    child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-2000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(stdout.trim()); } catch {
        return reject(Object.assign(new Error('BOSS 只读查询未返回有效数据'), { code: 'BOSS_FAILED' }));
      }
      if (!result.ok) return reject(Object.assign(new Error(result.error || 'BOSS 查询失败'), {
        code: /安全校验未通过（37）/.test(result.error || '') ? 'BOSS_SESSION_EXPIRED' : 'BOSS_QUERY_FAILED',
      }));
      resolve(result.data);
    });
    child.stdin.end(body);
  });
}
