/** 输出端口的上下顺序是阅读约束，避让连线时也不能交换两个分支。 */
import type { GraphNode } from '../types/graph';
import type { NodePosition } from './layout';
import type { LayoutBlock, LayoutEdge } from './layoutModel';

export interface BranchBand { upper: string[]; lower: string[] }

export function branchBands(nodes: GraphNode[], edges: LayoutEdge[]): BranchBand[] {
    const result: BranchBand[] = [];
    const forward = edges.filter(e => e.kind === 'flow' || e.kind === 'escape');
    for (const node of nodes) {
        const ports = node.type === 'condition' ? ['met', 'unmet'] :
            ['deviceGet', 'varGet'].includes(node.type) ? ['output', 'output2'] : Object.keys(node.outputs);
        const paths = ports.map(port => {
            const seen = new Set<string>();
            const pending = forward.filter(e => e.source === node.id && e.sourcePort === port).map(e => e.target);
            while (pending.length) {
                const id = pending.pop()!;
                if (id === node.id || seen.has(id)) continue;
                seen.add(id);pending.push(...forward.filter(e => e.source === id).map(e => e.target));
            }
            return seen;
        }).filter(path => path.size);
        // 共同汇合点不属于任何单一分支，循环回到分叉点时也停止传播。
        const exclusive = paths.map(path => [...path].filter(id => paths.filter(other => other.has(id)).length === 1));
        for (let i = 0; i < exclusive.length - 1; i++) for (let j = i + 1; j < exclusive.length; j++) {
            if (exclusive[i].length && exclusive[j].length) result.push({ upper: exclusive[i], lower: exclusive[j] });
        }
    }
    return result;
}

/** 将节点分支提升为完整布局形状的顺序，内部已经排成条件表的形状保持不动。 */
export function blockBranchBands(nodes: GraphNode[], edges: LayoutEdge[], blocks: LayoutBlock[]): BranchBand[] {
    const owners = new Map(blocks.flatMap(block => block.nodes.map(n => [n.id, block.id] as const)));
    return branchBands(nodes, edges).flatMap(band => {
        const upper = new Set(band.upper.map(id => owners.get(id)!));
        const lower = new Set(band.lower.map(id => owners.get(id)!));
        const a = [...upper].filter(id => !lower.has(id));
        const b = [...lower].filter(id => !upper.has(id));
        return a.length && b.length ? [{ upper: a, lower: b }] : [];
    });
}

export function branchOrderValid(bands: BranchBand[], rectangles: Map<string, NodePosition>, gap = 40): boolean {
    return bands.every(band => Math.max(...band.upper.map(id => rectangles.get(id)!.y + rectangles.get(id)!.height)) + gap <=
        Math.min(...band.lower.map(id => rectangles.get(id)!.y)));
}

/** 以差分约束向下移动整块，保留每个分支内部的相对位置。 */
export function enforceBranchOrder(bands: BranchBand[], rectangles: Map<string, NodePosition>): void {
    const dependencies = new Map([...rectangles.keys()].map(id => [id, new Set<string>()]));
    const reaches = (from: string, to: string): boolean => {
        const pending = [from];const seen = new Set<string>();
        while (pending.length) {
            const id = pending.pop()!;
            if (id === to) return true;
            if (seen.has(id)) continue;
            seen.add(id);pending.push(...dependencies.get(id)!);
        }
        return false;
    };
    for (const band of bands) for (const a of band.upper) for (const b of band.lower) {
        if (!reaches(b, a)) dependencies.get(a)!.add(b);
    }
    // 横向相交的无关形状保留当前上下次序，防止下移分支后重叠。
    const entries = [...rectangles];
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
        const [a, x] = entries[i];const [b, y] = entries[j];
        if (x.x >= y.x + y.width + 40 || y.x >= x.x + x.width + 40 || reaches(a, b) || reaches(b, a)) continue;
        dependencies.get(x.y <= y.y ? a : b)!.add(x.y <= y.y ? b : a);
    }
    const done = new Set<string>();
    const place = (id: string): void => {
        if (done.has(id)) return;
        done.add(id);
        const rect = rectangles.get(id)!;
        for (const [before, after] of dependencies) if (after.has(id)) {
            place(before);const other = rectangles.get(before)!;
            rect.y = Math.max(rect.y, other.y + other.height + 64);
        }
    };
    for (const id of rectangles.keys()) place(id);
}
