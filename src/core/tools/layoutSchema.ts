import { z } from 'zod';

export const GraphLayoutSchema = z.object({
    direction: z.enum(['RIGHT', 'DOWN']).optional().describe('子流程内的主方向；默认 RIGHT，DOWN 从上往下展开'),
    maxRowWidth: z.number().finite().min(1000).max(100000).optional().describe('横向流程超过此宽度折到下一行，默认 3600；同层分支不会拆开'),
    nodeSizes: z.record(z.object({
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
    })).optional().describe('可选的网关页面实测卡片尺寸，以节点 ID 为键'),
}).describe('自动排版选项。更新时传 {} 明确重新排版；省略则保留已有坐标。节点 cfg.layoutGroup 可指定分区，cfg.layoutOrder 指定分区顺序');
