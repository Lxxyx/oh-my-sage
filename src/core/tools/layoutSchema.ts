import { z } from 'zod';

export const GraphLayoutSchema = z.object({
    direction: z.enum(['RIGHT', 'DOWN']).optional().describe('子流程内的主方向；默认 RIGHT，DOWN 从上往下展开'),
    maxRowWidth: z.number().finite().min(1000).max(100000).optional().describe('期望横向宽度；只在单一主线切口折行，不拆条件表、模式行、共享条件或控制回路，完整局部结构可能超宽'),
    nodeSizes: z.record(z.object({
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
    })).optional().describe('可选的网关页面实测卡片尺寸，以节点 ID 为键'),
}).describe('按条件表、模式行、动作列和循环局部结构自动排版。更新时传 {} 重新排版；省略则保留已有坐标。cfg.layoutOrder 为独立流程排序提示，layoutGroup 元数据保留但不强制切断主线');
