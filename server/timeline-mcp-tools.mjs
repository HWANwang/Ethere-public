import { randomUUID } from 'node:crypto';

const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
export const TIMELINE_MCP_TOOL_NAMES = Object.freeze([
  'ethere_timeline_categories_context',
  'ethere_timeline_events_query',
  'ethere_timeline_events_batch_create',
  'ethere_timeline_event_update',
  'ethere_timeline_event_archive',
  'ethere_timeline_review_set',
  'ethere_timeline_category_propose',
]);

export function createTimelineMcpTools({ timelineStore }) {
  if (!timelineStore) throw new Error('缺少时间轴存储');
  const tools = [
    {
      name: 'ethere_timeline_category_propose',
      description: '向用户提交新增事件标签建议。优先建议新增二级标签，避免为一次性事件新增标签，也不要重复建议已有同名标签。',
      inputSchema: objectSchema({
        level: { type: 'string', enum: ['primary', 'secondary'], description: '建议新增一级分类或二级分类。通常优先 secondary。' },
        name: { type: 'string', minLength: 1, maxLength: 40, description: '简短且可长期复用的分类名称。' },
        parentCategoryId: { type: 'string', description: '新增二级分类时必填，必须是 categories_context 中的有效一级分类 ID。' },
        color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: '新增一级分类时可选的十六进制颜色。' },
        reason: { type: 'string', minLength: 1, maxLength: 200, description: '用一句话解释现有分类为何不够，以及该分类会覆盖哪些重复活动。' },
      }, ['level', 'name', 'reason']),
      annotations: { readOnlyHint: true },
      async call(args) {
        const taxonomy = await timelineStore.listCategories();
        const normalizedName = String(args.name || '').trim();
        const duplicate = taxonomy.categories.some((category) => (
          category.name === normalizedName || category.children.some((child) => child.name === normalizedName)
        ));
        if (duplicate) throw toolError('CATEGORY_ALREADY_EXISTS', `分类“${normalizedName}”已经存在，请直接使用现有分类`);
        if (args.level === 'secondary' && !taxonomy.categories.some((category) => category.id === args.parentCategoryId)) {
          throw toolError('PARENT_CATEGORY_NOT_FOUND', '建议新增二级分类时必须提供有效的 parentCategoryId');
        }
        return {
          pendingApproval: true,
          proposal: {
            level: args.level,
            name: normalizedName,
            ...(args.level === 'secondary' ? { parentCategoryId: args.parentCategoryId } : {}),
            ...(args.level === 'primary' && args.color ? { color: args.color } : {}),
            reason: String(args.reason || '').trim(),
          },
        };
      },
    },
    {
      name: 'ethere_timeline_categories_context',
      description: '返回当前有效的时间轴一级分类、二级分类及 categoryRevision。首次写入、分类不确定或 CATEGORY_REVISION_CHANGED 后调用；同一分类版本可在当前线程复用，不要逐条事件重复读取。',
      inputSchema: objectSchema({}, []),
      annotations: { readOnlyHint: true },
      async call() {
        const taxonomy = await timelineStore.listCategories();
        return {
          categoryRevision: taxonomy.revision,
          categories: taxonomy.categories.map((category) => ({
            id: category.id,
            name: category.name,
            children: category.children.map((child) => ({ id: child.id, name: child.name })),
          })),
        };
      },
    },
    {
      name: 'ethere_timeline_events_query',
      description: '按北京时间日期范围查询时间轴事件及稳定 eventId、revision。更新或软删除既有事件前调用；用尽量小的日期范围和 keyword 定位，候选不唯一时不要猜。',
      inputSchema: objectSchema({
        start: { type: 'string', pattern: DATE_PATTERN, description: '开始日期，YYYY-MM-DD。' },
        end: { type: 'string', pattern: DATE_PATTERN, description: '结束日期，YYYY-MM-DD；省略时等于 start。' },
        keyword: { type: 'string', maxLength: 100, description: '可选，匹配标题、备注或分类名称。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回多少条，默认 30。' },
      }, ['start']),
      annotations: { readOnlyHint: true },
      async call(args) {
        const [events, taxonomy] = await Promise.all([
          timelineStore.query({ start: args.start, end: args.end || args.start }),
          timelineStore.listCategories({ includeInactive: true }),
        ]);
        const categoryMap = new Map(taxonomy.categories.map((item) => [item.id, item]));
        const keyword = String(args.keyword || '').trim().toLocaleLowerCase('zh-CN');
        const limit = Number.isInteger(args.limit) ? args.limit : 30;
        const matches = events.filter((event) => {
          if (!keyword) return true;
          const parent = categoryMap.get(event.categoryId);
          const child = parent?.children.find((item) => item.id === event.subcategoryId);
          return [event.title, event.note, parent?.name, child?.name]
            .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(keyword));
        });
        return {
          start: args.start,
          end: args.end || args.start,
          count: matches.length,
          truncated: matches.length > limit,
          events: matches.slice(0, limit).map((event) => compactEvent(event, categoryMap)),
        };
      },
    },
    {
      name: 'ethere_timeline_events_batch_create',
      description: '一次新增一条或多条时间轴事件。批量补记必须合并到一次调用；使用 categories_context 返回的有效 categoryRevision、categoryId 和 subcategoryId。工具成功返回前不得声称已写入。',
      inputSchema: objectSchema({
        categoryRevision: { type: 'integer', minimum: 1, description: '最近读取到的分类版本。' },
        events: {
          type: 'array', minItems: 1, maxItems: 50,
          items: objectSchema({
            startedAt: { type: 'string', description: '含时区的 ISO 8601 开始时间，例如 2026-10-29T09:00:00+08:00。' },
            endedAt: { type: 'string', description: '含时区的 ISO 8601 结束时间，必须晚于开始时间。' },
            title: { type: 'string', minLength: 1, maxLength: 200, description: '简短、可回看的事件标题。' },
            note: { type: 'string', maxLength: 12000, description: '可选的详细备注。' },
            categoryId: { type: 'string', description: '一级分类 ID。' },
            subcategoryId: { type: 'string', description: '二级分类 ID。' },
          }, ['startedAt', 'endedAt', 'title', 'categoryId', 'subcategoryId']),
        },
      }, ['categoryRevision', 'events']),
      annotations: { readOnlyHint: false, destructiveHint: false },
      async call(args) {
        const requestId = randomUUID();
        const events = args.events.map((event, index) => ({
          ...event,
          author: 'ai',
          source: { type: 'mcp' },
          mutationId: `mcp-create-${requestId}-${index + 1}`,
        }));
        const created = await timelineStore.createEvents(events, { categoryRevision: args.categoryRevision });
        return { created: created.map(compactWrittenEvent), count: created.length };
      },
    },
    {
      name: 'ethere_timeline_event_update',
      description: '按稳定 eventId 和最新 baseRevision 更新一条时间轴事件；eventId/revision 来自创建结果或 events_query。修改分类时还必须提供最新 categoryRevision，并同时提供 categoryId 与 subcategoryId。',
      inputSchema: objectSchema({
        eventId: { type: 'string', minLength: 1, description: '要更新的稳定事件 ID。' },
        baseRevision: { type: 'integer', minimum: 1, description: '最近读取到的事件 revision。' },
        categoryRevision: { type: 'integer', minimum: 1, description: '仅在修改分类时必填。' },
        patch: objectSchema({
          startedAt: { type: 'string', description: '可选，含时区的 ISO 8601 开始时间；当前版本不可跨日期移动。' },
          endedAt: { type: 'string', description: '可选，含时区的 ISO 8601 结束时间。' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          note: { type: 'string', maxLength: 12000 },
          categoryId: { type: 'string', description: '新的一级分类 ID；修改分类时与 subcategoryId 一起提供。' },
          subcategoryId: { type: 'string', description: '新的二级分类 ID；修改分类时与 categoryId 一起提供。' },
        }, []),
      }, ['eventId', 'baseRevision', 'patch']),
      annotations: { readOnlyHint: false, destructiveHint: false },
      async call(args) {
        const changesCategory = args.patch.categoryId !== undefined || args.patch.subcategoryId !== undefined;
        if (changesCategory && (!args.patch.categoryId || !args.patch.subcategoryId)) {
          throw toolError('CATEGORY_PAIR_REQUIRED', '修改分类时必须同时提供 categoryId 和 subcategoryId');
        }
        if (changesCategory && !Number.isInteger(args.categoryRevision)) {
          throw toolError('CATEGORY_REVISION_REQUIRED', '修改分类时必须提供 categoryRevision');
        }
        const event = await timelineStore.updateEventWithCategoryRevision(args.eventId, args.patch, {
          baseRevision: args.baseRevision,
          categoryRevision: args.categoryRevision,
          mutationId: `mcp-update-${randomUUID()}`,
        });
        return { updated: compactWrittenEvent(event) };
      },
    },
    {
      name: 'ethere_timeline_event_archive',
      description: '按稳定 eventId 和最新 baseRevision 软删除一条时间轴事件，记录仍可恢复。eventId/revision 来自创建结果或 events_query；候选不唯一时先询问用户。',
      inputSchema: objectSchema({
        eventId: { type: 'string', minLength: 1, description: '要软删除的稳定事件 ID。' },
        baseRevision: { type: 'integer', minimum: 1, description: '最近读取到的事件 revision。' },
      }, ['eventId', 'baseRevision']),
      annotations: { readOnlyHint: false, destructiveHint: true },
      async call(args) {
        const event = await timelineStore.archiveEvent(args.eventId, {
          baseRevision: args.baseRevision,
          mutationId: `mcp-archive-${randomUUID()}`,
        });
        return { archived: compactWrittenEvent(event) };
      },
    },
    {
      name: 'ethere_timeline_review_set',
      description: '用完整 Markdown 覆盖写入某一天的当日回顾。每次调用都会替换当天旧回顾，工具成功返回前不得声称已写入。',
      inputSchema: objectSchema({
        date: { type: 'string', pattern: DATE_PATTERN, description: '北京时间日期，YYYY-MM-DD。' },
        text: { type: 'string', maxLength: 12000, description: '完整的当日回顾 Markdown；空字符串表示清空。' },
      }, ['date', 'text']),
      annotations: { readOnlyHint: false, destructiveHint: false },
      async call(args) {
        const current = await timelineStore.getReview(args.date);
        const review = await timelineStore.setReview(args.date, {
          text: args.text,
          author: 'ai',
          baseRevision: current?.revision || 0,
          mutationId: `mcp-review-${randomUUID()}`,
        });
        return {
          date: args.date,
          review: review ? { revision: review.revision, updatedAt: review.updatedAt } : null,
          cleared: !review,
        };
      },
    },
  ];

  return {
    list() {
      return tools.map(({ call, ...tool }) => tool);
    },
    async call(name, args = {}) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw toolError('UNKNOWN_TOOL', `未知工具：${name}`);
      return tool.call(args && typeof args === 'object' ? args : {});
    },
  };
}

function compactEvent(event, categoryMap) {
  const parent = categoryMap.get(event.categoryId);
  const child = parent?.children.find((item) => item.id === event.subcategoryId);
  return {
    eventId: event.id,
    revision: event.revision,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    title: event.title,
    ...(event.note ? { note: event.note } : {}),
    categoryId: event.categoryId,
    subcategoryId: event.subcategoryId,
    category: `${parent?.name || event.categoryId} / ${child?.name || event.subcategoryId}`,
  };
}

function compactWrittenEvent(event) {
  return {
    eventId: event.id,
    revision: event.revision,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    title: event.title,
    categoryId: event.categoryId,
    subcategoryId: event.subcategoryId,
    archived: Boolean(event.deletedAt),
  };
}

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
