/** 网关从左右端口自行画线；避让必须针对这些曲线，而不是 ELK 未被采用的路由。 */
import type { GraphNode } from '../types/graph';
import type { LayoutRegion, NodePosition } from './layout';
import { buildBlocks, type LayoutBlock, type LayoutEdge } from './layoutModel';
import { blockBranchBands, branchOrderValid } from './layoutBranches';

interface Point { x: number; y: number }
export interface LayoutQuality {
    penetrations: number; crossings: number; edgeLength: number; width: number; height: number;
    obstacles: Array<{ source: string; target: string; card: string }>;
}

function forwardClearance(nodes: GraphNode[], edges: LayoutEdge[], positions: Map<string, NodePosition>): () => boolean {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const distance = (e: LayoutEdge): number => {
        const a = positions.get(e.source)!;const b = positions.get(e.target)!;
        return Math.abs(a.y + portY(byId.get(e.source)!, e.sourcePort, 'output', a.height) -
            b.y - portY(byId.get(e.target)!, e.targetPort, 'input', b.height));
    };
    const limits = new Map(edges.map(e => [e, ['deviceGet', 'varGet', 'condition'].includes(byId.get(e.source)!.type) &&
        byId.get(e.target)!.type === 'deviceOutput' ? Math.max(128, distance(e)) : Infinity]));
    return () => edges.every(e => positions.get(e.source)!.x + positions.get(e.source)!.width + 32 <= positions.get(e.target)!.x &&
        distance(e) <= limits.get(e)! + 1);
}

/** 网关普通卡片的端口纵坐标，来自实际 DOM 测量。简洁模式使用缩略卡片估计。 */
export function portY(node: GraphNode, port: string, side: 'input' | 'output', height: number): number {
    const names = node.type === 'condition' ? side === 'input' ? ['trigger', 'condition'] : ['met', 'unmet'] :
        side === 'output' && ['deviceGet', 'varGet'].includes(node.type) ? ['output', 'output2'] :
            Object.keys(side === 'input' ? node.inputs : node.outputs);
    const index = Math.max(0, names.indexOf(port));
    if (node.cfg?.simplified) return Math.min(height - 16, height / 2 + index * 20);
    if (node.type === 'deviceGet') return side === 'input' ? 100 : 80 + 40 * index;
    if (node.type === 'varGet') return side === 'input' ? 78 : 58 + 40 * index;
    if (node.type === 'deviceInput') return height / 2 + 44;
    if (node.type === 'deviceOutput') return height - 38;
    if (['varSetNumber', 'varSetString'].includes(node.type)) return height - 36;
    if (node.type === 'condition' || (node.type === 'modeSwitch' && side === 'output')) return 68 + 40 * index;
    if (['loop', 'counter', 'register', 'eventSequence', 'signalOr', 'logicAnd', 'logicOr', 'modeSwitch', 'onlyNTimes'].includes(node.type)) {
        return side === 'input' ? 68 + 40 * index : height / 2 + 18;
    }
    return height / 2 + 18;
}

/** 普通前向边为三次曲线；同列/返回边走两张卡片间的水平通道。 */
function route(a: NodePosition, b: NodePosition, sy: number, ty: number): Point[] {
    const start = { x: a.x + a.width, y: a.y + sy };
    const end = { x: b.x - 8, y: b.y + ty };
    const dx = b.x - start.x;
    if (dx >= 32) {
        const c1 = { x: start.x + dx / 4, y: start.y };
        const c2 = { x: b.x - dx / 4, y: end.y };
        return Array.from({ length: 25 }, (_, i) => {
            const t = i / 24;const s = 1 - t;
            return { x: s ** 3 * start.x + 3 * s ** 2 * t * c1.x + 3 * s * t ** 2 * c2.x + t ** 3 * end.x,
                y: s ** 3 * start.y + 3 * s ** 2 * t * c1.y + 3 * s * t ** 2 * c2.y + t ** 3 * end.y };
        });
    }
    const middle = b.y >= a.y + a.height ? (a.y + a.height + b.y) / 2 :
        a.y >= b.y + b.height ? (b.y + b.height + a.y) / 2 : Math.max(a.y + a.height, b.y + b.height) + 32;
    return [start, { x: start.x + 16, y: start.y }, { x: start.x + 16, y: middle },
        { x: b.x - 16, y: middle }, { x: b.x - 16, y: end.y }, end];
}

function segmentHits(a: Point, b: Point, r: NodePosition): boolean {
    const left = r.x + 2;const right = r.x + r.width - 2;
    const top = r.y + 2;const bottom = r.y + r.height - 2;
    if (Math.max(a.x, b.x) <= left || Math.min(a.x, b.x) >= right || Math.max(a.y, b.y) <= top || Math.min(a.y, b.y) >= bottom) return false;
    let low = 0;let high = 1;
    for (const [v, delta, min, max] of [[a.x, b.x - a.x, left, right], [a.y, b.y - a.y, top, bottom]]) {
        if (delta === 0) { if (v <= min || v >= max) return false;continue; }
        const t1 = (min - v) / delta;const t2 = (max - v) / delta;
        low = Math.max(low, Math.min(t1, t2));high = Math.min(high, Math.max(t1, t2));
        if (low >= high) return false;
    }
    return true;
}

export function measureLayoutQuality(nodes: GraphNode[], edges: LayoutEdge[], positions: Map<string, NodePosition>): LayoutQuality {
    const byId = new Map(nodes.map(n => [n.id, n]));
    let penetrations = 0;let edgeLength = 0;
    const obstacles: LayoutQuality['obstacles'] = [];
    const paths: Point[][] = [];
    for (const edge of edges) {
        const a = positions.get(edge.source)!;const b = positions.get(edge.target)!;
        const points = route(a, b, portY(byId.get(edge.source)!, edge.sourcePort, 'output', a.height),
            portY(byId.get(edge.target)!, edge.targetPort, 'input', b.height));
        paths.push(points);
        for (let i = 1; i < points.length; i++) edgeLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        for (const [id, rect] of positions) {
            if (id === edge.source || id === edge.target) continue;
            if (points.some((p, i) => i > 0 && segmentHits(points[i - 1], p, rect))) {
                penetrations++;obstacles.push({ source: edge.source, target: edge.target, card: id });
            }
        }
    }
    const cross = (p: Point, q: Point, r: Point): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    let crossings = 0;
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
        const a = edges[i];const b = edges[j];
        if ((a.source === b.source && a.sourcePort === b.sourcePort) || (a.target === b.target && a.targetPort === b.targetPort)) continue;
        let found = false;
        for (let m = 1; m < paths[i].length && !found; m++) for (let n = 1; n < paths[j].length; n++) {
            const p = paths[i][m - 1];const q = paths[i][m];const r = paths[j][n - 1];const s = paths[j][n];
            if (Math.max(p.x, q.x) < Math.min(r.x, s.x) || Math.max(r.x, s.x) < Math.min(p.x, q.x) ||
                Math.max(p.y, q.y) < Math.min(r.y, s.y) || Math.max(r.y, s.y) < Math.min(p.y, q.y)) continue;
            if (cross(p, q, r) * cross(p, q, s) < 0 && cross(r, s, p) * cross(r, s, q) < 0) { found = true;break; }
        }
        if (found) crossings++;
    }
    const rects = [...positions.values()];
    return { penetrations, crossings, edgeLength, obstacles,
        width: rects.length ? Math.max(...rects.map(r => r.x + r.width)) - Math.min(...rects.map(r => r.x)) : 0,
        height: rects.length ? Math.max(...rects.map(r => r.y + r.height)) - Math.min(...rects.map(r => r.y)) : 0 };
}

/** 有限、确定性的局部搜索，移动完整业务形状，为实际端口连线留出通道。 */
export function improvePortClearance(nodes: GraphNode[], edges: LayoutEdge[], blocks: LayoutBlock[], positions: Map<string, NodePosition>): void {
    // 大图避免同步优化拖慢工具；ELK 结果仍可使用。
    if (nodes.length < 3 || nodes.length > 100 || edges.length > 180) return;
    const owner = new Map(blocks.flatMap(b => b.nodes.map(n => [n.id, b.id] as const)));
    const bands = blockBranchBands(nodes, edges, blocks);
    const initial = measureLayoutQuality(nodes, edges, positions);
    const maxY = initial.height + Math.max(800, initial.height / 2);
    const forward = edges.filter(e => e.kind === 'flow' && owner.get(e.source) !== owner.get(e.target) &&
        positions.get(e.source)!.x + positions.get(e.source)!.width < positions.get(e.target)!.x);
    const preservesForward = forwardClearance(nodes, forward, positions);
    const score = (q: LayoutQuality): number => q.penetrations * 1000000 + q.crossings * 2000 + q.edgeLength / 50 + q.width * q.height / 30000 + q.width / 4;
    let bestScore = score(initial);
    const blockRect = (block: LayoutBlock): NodePosition => {
        const first = block.nodes[0].id;const local = block.positions.get(first)!;const pos = positions.get(first)!;
        return { x: pos.x - local.x, y: pos.y - local.y, width: block.width, height: block.height };
    };
    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (const block of blocks) {
            const start = blockRect(block);
            const neighbors = blocks.filter(b => b !== block).map(blockRect);
            const ys = [start.y - 128, start.y + 128, start.y + 160, start.y + 192, start.y - 160, start.y - 192, start.y - 320, start.y + 320, 0,
                ...neighbors.flatMap(r => [r.y - block.height - 64, r.y + r.height + 64])];
            const xs = [start.x - 112, start.x + 112, start.x - 320, 0];
            const candidates = [...new Set(ys.map(Math.round))].map(y => ({ ...start, y })).concat(
                [...new Set(xs.map(Math.round))].map(x => ({ ...start, x })),
                [-320, -112, 112, 320].flatMap(dx => [-256, -128, 128, 256].map(dy => ({ ...start, x: start.x + dx, y: start.y + dy }))));
            let chosen = start;
            for (const candidate of candidates) {
                if (candidate.x < 0 || candidate.y < 0 || candidate.y + candidate.height > maxY ||
                    neighbors.some(r => candidate.x < r.x + r.width + 40 && r.x < candidate.x + candidate.width + 40 &&
                        candidate.y < r.y + r.height + 40 && r.y < candidate.y + candidate.height + 40)) continue;
                for (const [id, local] of block.positions) positions.set(id, { ...local, x: candidate.x + local.x, y: candidate.y + local.y });
                if (!branchOrderValid(bands, new Map(blocks.map(b => [b.id, blockRect(b)])))) continue;
                if (!preservesForward()) continue;
                const candidateScore = score(measureLayoutQuality(nodes, edges, positions));
                if (candidateScore < bestScore - 0.01) { bestScore = candidateScore;chosen = candidate;changed = true; }
            }
            for (const [id, local] of block.positions) positions.set(id, { ...local, x: chosen.x + local.x, y: chosen.y + local.y });
        }
        if (!changed) break;
    }
}

/** 分区始终上下分开；仅整块横移，为跨区状态/复位线寻找空白通道，备注随区块移动。 */
export function improveSectionClearance(nodes: GraphNode[], edges: LayoutEdge[], regions: LayoutRegion[],
    positions: Map<string, NodePosition>): void {
    if (nodes.length > 100 || edges.length > 180 || regions.length < 2) return;
    const initial = measureLayoutQuality(nodes, edges, positions);
    const score = (q: LayoutQuality): number => q.penetrations * 1000000 + q.crossings * 2000 + q.edgeLength / 20 + q.width * q.height / 20000;
    let best = score(initial);
    for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (const region of regions) {
            const members = new Set(region.nodeIds);
            for (const id of region.noteIds || []) members.add(id);
            const originals = new Map([...members].map(id => [id, { ...positions.get(id)! }]));
            const deltas = [0, 100 - region.x, -320, 320, -640, 640];
            for (const edge of edges) if (members.has(edge.source) !== members.has(edge.target)) {
                const a = positions.get(edge.source)!;const b = positions.get(edge.target)!;
                const sign = members.has(edge.source) ? 1 : -1;
                deltas.push(sign * (b.x - a.x), sign * (b.x - a.x - a.width - 112),
                    sign * (b.x + b.width + 112 - a.x));
            }
            let chosen = 0;
            for (const dx of [...new Set(deltas.map(Math.round))]) {
                if (region.x + dx < 100 || region.x + dx + region.width > 100 + initial.width * 2) continue;
                for (const [id, p] of originals) positions.set(id, { ...p, x: p.x + dx });
                const value = score(measureLayoutQuality(nodes, edges, positions));
                if (value < best - 0.01) { best = value;chosen = dx;changed = true; }
            }
            for (const [id, p] of originals) positions.set(id, { ...p, x: p.x + chosen });
            region.x += chosen;
        }
        if (!changed) break;
    }
}

/** 跨区边也参与局部避让，但卡片只能在所属区块及其预留空白内移动。 */
export function improveRegionContents(nodes: GraphNode[], edges: LayoutEdge[], regions: LayoutRegion[],
    positions: Map<string, NodePosition>): void {
    if (nodes.length > 100 || edges.length > 180 || regions.length < 2) return;
    const sizes = new Map([...positions].map(([id, p]) => [id, { width: p.width, height: p.height }]));
    const blocks = regions.flatMap(region => {
        const members = nodes.filter(n => region.nodeIds.includes(n.id));
        return buildBlocks(members, edges.filter(e => region.nodeIds.includes(e.source) && region.nodeIds.includes(e.target)), sizes)
            .map(block => ({ ...block, id: `${region.id}/${block.id}`, region }));
    });
    const bands = blockBranchBands(nodes.filter(n => n.type !== 'nop'), edges, blocks);
    const rect = (block: LayoutBlock): NodePosition => {
        const first = block.nodes[0].id;const p = positions.get(first)!;const local = block.positions.get(first)!;
        return { x: p.x - local.x, y: p.y - local.y, width: block.width, height: block.height };
    };
    const owner = new Map(blocks.flatMap(b => b.nodes.map(n => [n.id, b.id] as const)));
    const forward = edges.filter(e => e.kind === 'flow' && owner.get(e.source) !== owner.get(e.target) &&
        blocks.find(b => b.id === owner.get(e.source))?.region === blocks.find(b => b.id === owner.get(e.target))?.region &&
        positions.get(e.source)!.x + positions.get(e.source)!.width < positions.get(e.target)!.x);
    const preservesForward = forwardClearance(nodes, forward, positions);
    const score = (q: LayoutQuality): number => q.penetrations * 1000000 + q.crossings * 2000 + q.edgeLength / 20 + q.width * q.height / 20000;
    let best = score(measureLayoutQuality(nodes, edges, positions));
    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (const block of blocks) {
            const start = rect(block);const group = block.region;
            const originals = new Map(block.nodes.map(n => [n.id, { ...positions.get(n.id)! }]));
            const others = [...positions].filter(([id]) => !originals.has(id)).map(([, p]) => p);
            const peers = blocks.filter(b => b.region === group && b !== block).map(rect);
            const left = Math.min(...group.nodeIds.map(id => positions.get(id)!.x));
            const ys = [group.y, start.y - 128, start.y + 128, start.y + 160, start.y + 192, start.y - 160, start.y - 192, start.y + 256,
                ...peers.flatMap(p => [p.y - block.height - 64, p.y + p.height + 64])];
            const xs = [left, start.x - 112, start.x + 112, ...peers.flatMap(p => [p.x - block.width - 112, p.x + p.width + 112])];
            const candidates = [...new Set(ys.map(Math.round))].map(y => ({ ...start, y })).concat(
                [...new Set(xs.map(Math.round))].map(x => ({ ...start, x })),
                [-320, -112, 112, 320].flatMap(dx => [-256, -128, 128, 256].map(dy => ({ ...start, x: start.x + dx, y: start.y + dy }))));
            let chosen = start;
            for (const candidate of candidates) {
                if (candidate.x < left || candidate.x + candidate.width > group.x + group.width + 160 ||
                    candidate.y < group.y || candidate.y + candidate.height > group.y + group.height + 160) continue;
                const dx = candidate.x - start.x;const dy = candidate.y - start.y;
                const moved = [...originals].map(([id, p]) => [id, { ...p, x: p.x + dx, y: p.y + dy }] as const);
                if (moved.some(([, p]) => others.some(q => p.x < q.x + q.width + 40 && q.x < p.x + p.width + 40 &&
                    p.y < q.y + q.height + 40 && q.y < p.y + p.height + 40))) continue;
                for (const [id, p] of moved) positions.set(id, p);
                if (!branchOrderValid(bands, new Map(blocks.map(b => [b.id, rect(b)]))) ||
                    !preservesForward()) continue;
                const value = score(measureLayoutQuality(nodes, edges, positions));
                if (value < best - 0.01) { best = value;chosen = candidate;changed = true; }
            }
            for (const [id, p] of originals) positions.set(id, { ...p, x: p.x + chosen.x - start.x, y: p.y + chosen.y - start.y });
        }
        if (!changed) break;
    }
    // 穿卡有时需要同时移动障碍和它的邻居；单步贪心会在两个等价障碍之间停住。
    const offsets = [[0, -256], [0, -128], [0, 128], [0, 256], [-112, 0], [112, 0], [-320, 0], [320, 0]];
    const snapshot = (): Map<string, NodePosition> => new Map([...positions].map(([id, p]) => [id, { ...p }]));
    const restore = (saved: Map<string, NodePosition>): void => { for (const [id, p] of saved) positions.set(id, { ...p }); };
    const move = (block: typeof blocks[number], dx: number, dy: number): boolean => {
        const before = rect(block);const group = block.region;
        const left = Math.min(...group.nodeIds.map(id => positions.get(id)!.x));
        if (before.x + dx < left || before.x + dx + block.width > group.x + group.width + 160 ||
            before.y + dy < group.y || before.y + dy + block.height > group.y + group.height + 160) return false;
        const ids = new Set(block.nodes.map(n => n.id));
        for (const id of ids) { const p = positions.get(id)!;positions.set(id, { ...p, x: p.x + dx, y: p.y + dy }); }
        if (block.nodes.some(n => {
            const p = positions.get(n.id)!;
            return [...positions].some(([id, q]) => !ids.has(id) && p.x < q.x + q.width + 40 && q.x < p.x + p.width + 40 &&
                p.y < q.y + q.height + 40 && q.y < p.y + p.height + 40);
        })) return false;
        return preservesForward() && branchOrderValid(bands, new Map(blocks.map(b => [b.id, rect(b)])));
    };
    let evaluations = 0;
    for (let pass = 0; pass < 2; pass++) {
        const quality = measureLayoutQuality(nodes, edges, positions);
        if (!quality.penetrations || evaluations >= 1200) break;
        const saved = snapshot();let selected = saved;const scoreBefore = best;
        const affected = (q: LayoutQuality): typeof blocks => {
            const ids = new Set(q.obstacles.flatMap(o => [owner.get(o.source), owner.get(o.target), owner.get(o.card)]));
            return blocks.filter(b => ids.has(b.id));
        };
        search: for (const a of affected(quality)) for (const [dx, dy] of offsets) {
            restore(saved);
            if (!move(a, dx, dy)) continue;
            const intermediate = measureLayoutQuality(nodes, edges, positions);evaluations++;
            if (intermediate.penetrations > quality.penetrations + 1) continue;
            const afterFirst = snapshot();
            for (const b of affected(intermediate)) if (b !== a) for (const [bx, by] of offsets) {
                restore(afterFirst);
                if (!move(b, bx, by)) continue;
                const q = measureLayoutQuality(nodes, edges, positions);evaluations++;
                const value = score(q);
                if (value < best - 0.01) { best = value;selected = snapshot(); }
                if (!q.penetrations || evaluations >= 1200) break search;
            }
        }
        restore(selected);
        if (best >= scoreBefore - 0.01) break;
    }
    for (const region of regions) {
        region.width = Math.max(region.width, ...region.nodeIds.map(id => positions.get(id)!.x + positions.get(id)!.width - region.x));
        region.height = Math.max(region.height, ...region.nodeIds.map(id => positions.get(id)!.y + positions.get(id)!.height - region.y));
    }
}

/** 备注留在本区块左侧，必要时沿区块上下移动，让进入流程的长线通过空白。 */
export function improveNoteClearance(nodes: GraphNode[], edges: LayoutEdge[], regions: LayoutRegion[], positions: Map<string, NodePosition>): void {
    if (nodes.length > 100 || edges.length > 180) return;
    for (const region of regions) for (const id of region.noteIds || []) {
        const start = positions.get(id)!;
        let chosen = start;let best = measureLayoutQuality(nodes, edges, positions).penetrations;
        for (const y of [region.y, region.y + (region.height - start.height) / 2, region.y + region.height - start.height]) {
            if (y < region.y) continue;
            const candidate = { ...start, y };
            if ([...positions].some(([other, p]) => other !== id && candidate.x < p.x + p.width + 40 && p.x < candidate.x + candidate.width + 40 &&
                candidate.y < p.y + p.height + 40 && p.y < candidate.y + candidate.height + 40)) continue;
            positions.set(id, candidate);
            const value = measureLayoutQuality(nodes, edges, positions).penetrations;
            if (value < best) { best = value;chosen = candidate; }
        }
        positions.set(id, chosen);
    }
}

/** 网关返回线的水平段取两端之间的中点；调整区间留白，使中点落在区块间的空白处。 */
export function improveSectionSpacing(nodes: GraphNode[], edges: LayoutEdge[], regions: LayoutRegion[], positions: Map<string, NodePosition>): void {
    if (nodes.length > 100 || edges.length > 180 || regions.length < 2) return;
    const initial = measureLayoutQuality(nodes, edges, positions);
    const score = (q: LayoutQuality): number => q.penetrations * 1000000 + q.crossings * 2000 + q.edgeLength / 20 + q.width * q.height / 20000;
    let best = score(initial);
    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (let i = 1; i < regions.length; i++) {
            const previous = regions[i - 1];const group = regions[i];
            const ids = new Set(regions.slice(i).flatMap(r => [...r.nodeIds, ...r.noteIds || []]));
            const saved = new Map([...ids].map(id => [id, { ...positions.get(id)! }]));
            let chosen = 0;
            for (const dy of [-256, -128, -64, -32, 32, 64, 128, 256, 512]) {
                if (group.y + dy < previous.y + previous.height + 160 ||
                    regions[regions.length - 1].y + regions[regions.length - 1].height + dy > initial.height * 1.5 + 100) continue;
                for (const [id, p] of saved) positions.set(id, { ...p, y: p.y + dy });
                const value = score(measureLayoutQuality(nodes, edges, positions));
                if (value < best - 0.01) { best = value;chosen = dy;changed = true; }
            }
            for (const [id, p] of saved) positions.set(id, { ...p, y: p.y + chosen });
            for (const region of regions.slice(i)) region.y += chosen;
        }
        if (!changed) break;
    }
}
