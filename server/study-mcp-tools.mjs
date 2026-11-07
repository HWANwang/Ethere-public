const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });

export function createStudyMcpTools({ studyPlanStore }) {
  if (!studyPlanStore) throw new Error('缺少学习计划存储');
  const tools = [
    {
      name: 'ethere_study_plans_list',
      description: '用户想继续学习、询问学到哪里或准备新建课程时，先列出已有学习计划，避免重复创建。只返回简短进度。',
      inputSchema: object({ includeArchived: { type: 'boolean', description: '默认不含已归档计划。' } }),
      annotations: { readOnlyHint: true },
      call: async ({ includeArchived }) => ({ plans: await studyPlanStore.list({ includeArchived: includeArchived === true }) }),
    },
    {
      name: 'ethere_study_plan_get',
      description: '读取完整课程大纲、当前课节、暂停点和 revision。续学前或修改计划前调用；从暂停点继续，不重复已讲内容。',
      inputSchema: object({ planId: text(80) }, ['planId']),
      annotations: { readOnlyHint: true },
      call: async ({ planId }) => ({ plan: await requiredPlan(studyPlanStore, planId) }),
    },
    {
      name: 'ethere_study_plan_create',
      description: '仅在用户明确要按课程持续学习一个主题时创建学习计划；先 list 查重。拟定短小、顺序清楚的课节大纲，直接保存，无需审批。普通一次性问答不要建计划。',
      inputSchema: object({
        title: text(80), goal: { type: 'string', maxLength: 400 },
        lessons: { type: 'array', minItems: 1, maxItems: 24, items: text(100), description: '按学习顺序排列的课节标题。' },
      }, ['title', 'lessons']),
      call: async (args) => ({ plan: await studyPlanStore.create(args) }),
    },
    {
      name: 'ethere_study_plan_update',
      description: '更新已有计划。每次实际讲到的暂停点用 checkpoint 自动保存；只有用户表示学完、掌握或要求下一节，才用 complete_lesson。可按用户要求改大纲、重命名、暂停或归档。先 get 获取最新 revision，冲突后重读，不要覆盖进度。',
      inputSchema: object({
        planId: text(80), baseRevision: { type: 'integer', minimum: 1 },
        action: { type: 'string', enum: ['checkpoint', 'complete_lesson', 'focus_lesson', 'revise_outline', 'rename', 'pause', 'archive', 'resume'] },
        lessonId: { type: 'string' }, note: { type: 'string', maxLength: 500 }, summary: { type: 'string', maxLength: 500 },
        title: { type: 'string', maxLength: 80 }, goal: { type: 'string', maxLength: 400 },
        lessons: { type: 'array', minItems: 1, maxItems: 24, items: object({ id: { type: 'string' }, title: text(100) }, ['title']), description: '修订大纲时保留已有课节 id；新增课节不填 id。' },
      }, ['planId', 'baseRevision', 'action']),
      call: async ({ planId, ...change }) => ({ plan: await studyPlanStore.update(planId, change) }),
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

async function requiredPlan(store, id) {
  const plan = await store.get(id);
  if (!plan) throw Object.assign(new Error('学习计划不存在'), { statusCode: 404 });
  return plan;
}
