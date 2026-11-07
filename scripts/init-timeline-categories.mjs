import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { TimelineStore } from '../server/timeline-store.mjs';

const dataRootIndex = process.argv.indexOf('--data-root');
if (dataRootIndex < 0 || !process.argv[dataRootIndex + 1]) throw new Error('缺少 --data-root');

const fileIndex = process.argv.indexOf('--file');
let input = '';
if (fileIndex >= 0 && process.argv[fileIndex + 1]) input = await readFile(resolve(process.argv[fileIndex + 1]), 'utf8');
else for await (const chunk of process.stdin) input += chunk;
const categories = JSON.parse(input);
if (!Array.isArray(categories) || categories.length === 0) throw new Error('分类必须是非空数组');

const dataRoot = resolve(process.argv[dataRootIndex + 1]);
const store = new TimelineStore({ dataRoot, initialCategories: categories });
const result = await store.initialize();
process.stdout.write(`时间轴分类已初始化：${result.categories.length} 个一级分类\n`);
