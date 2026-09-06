/**
 * 从执行结构识别可读的局部形状。所有合并只存在于布局模型中，原节点与连线不变。
 * 不依赖房间名、节点 ID、设备型号或具体变量值。
 */
import type { GraphNode } from '../types/graph';
import type { NodePosition, NodeSize } from './layout';
import { branchBands } from './layoutBranches';

export interface LayoutEdge {
    source: string;
    target: string;
    sourcePort: string;
    targetPort: string;
    kind: 'flow' | 'state' | 'feedback' | 'escape';
}

export interface LayoutBlock extends NodeSize {
    id: string;
    kind: 'node' | 'choices' | 'guards' | 'modes' | 'actions' | 'retry' | 'verification' | 'cleanup';
    nodes: GraphNode[];
    positions: Map<string, NodePosition>;
}

export const COLUMN_GAP = 112;
export const ROW_GAP = 64;

export function graphEdges(nodes: GraphNode[]): LayoutEdge[] {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const edges: LayoutEdge[] = nodes.flatMap(node => Object.entries(node.outputs || {}).flatMap(([sourcePort, targets]) =>
        targets.flatMap(target => {
            const dot = target.lastIndexOf('.');
            const targetId = target.slice(0, dot);
            const targetPort = target.slice(dot + 1);
            const other = byId.get(targetId);
            if (!other || dot < 1 || !Object.prototype.hasOwnProperty.call(other.inputs || {}, targetPort)) return [];
            const feedback = (other.type === 'loop' && targetPort === 'stop') ||
                (['counter', 'onlyNTimes'].includes(other.type) && targetPort === 'zero') ||
                (other.type === 'register' && targetPort === 'setFalse');
            const state = targetPort === 'condition' || ['logicAnd', 'logicOr', 'logicNot'].includes(other.type);
            return [{ source: node.id, target: targetId, sourcePort, targetPort,
                kind: feedback ? 'feedback' as const : state ? 'state' as const : 'flow' as const }];
        })));
    // 条件失败进入纯复位节点是退出支路，不应把复位节点推到整条主流程的末端。
    const resets = new Set(nodes.filter(node => ['varSetNumber', 'varSetString'].includes(node.type) &&
        edges.some(e => e.source === node.id) && edges.filter(e => e.source === node.id).every(e => e.kind === 'feedback')).map(n => n.id));
    for (const edge of edges) if (resets.has(edge.target) && ['output2', 'unmet'].includes(edge.sourcePort)) edge.kind = 'escape';
    return edges;
}

export function connectedComponents(nodes: GraphNode[], edges: LayoutEdge[]): GraphNode[][] {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const adjacent = new Map(nodes.map(node => [node.id, new Set<string>()]));
    for (const edge of edges) {
        adjacent.get(edge.source)?.add(edge.target);
        adjacent.get(edge.target)?.add(edge.source);
    }
    const seen = new Set<string>();
    const result: GraphNode[][] = [];
    for (const node of nodes) {
        if (seen.has(node.id)) continue;
        const pending = [node.id];
        const ids = new Set<string>();
        seen.add(node.id);
        while (pending.length) {
            const id = pending.pop()!;
            ids.add(id);
            for (const next of adjacent.get(id) || []) if (!seen.has(next)) {
                seen.add(next);pending.push(next);
            }
        }
        // 保留模型次序，不能让 DFS 反转并行动作在 outputs 中的顺序。
        result.push([...byId.values()].filter(candidate => ids.has(candidate.id)));
    }
    return result;
}

function isQuery(node: GraphNode): boolean { return ['deviceGet', 'varGet', 'condition'].includes(node.type); }
function successPort(node: GraphNode): string { return node.type === 'condition' ? 'met' : 'output'; }
function failurePort(node: GraphNode): string { return node.type === 'condition' ? 'unmet' : 'output2'; }
function subject(node: GraphNode): string | undefined {
    const p = node.props;
    if (node.type === 'varGet' && p.id !== undefined && p.scope !== undefined) return JSON.stringify(['variable', p.scope, p.id, p.varType]);
    if (node.type === 'deviceGet' && p.did !== undefined && p.siid !== undefined && p.piid !== undefined) return JSON.stringify(['property', p.did, p.siid, p.piid, p.dtype]);
    return undefined;
}

/** 一个按钮多种模式、一列判定多个取值、一串启动前检查、同时执行的动作清单。 */
export function buildBlocks(nodes: GraphNode[], edges: LayoutEdge[], sizes: Map<string, NodeSize>,
    semantic = true): LayoutBlock[] {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const outgoing = new Map(nodes.map(node => [node.id, edges.filter(e => e.source === node.id && e.kind === 'flow')]));
    const incoming = new Map(nodes.map(node => [node.id, edges.filter(e => e.target === node.id && e.kind === 'flow')]));
    const used = new Set<string>();
    const blocks: LayoutBlock[] = [];
    const from = (node: GraphNode, port?: string): LayoutEdge[] => (outgoing.get(node.id) || []).filter(e => !port || e.sourcePort === port);
    const add = (kind: LayoutBlock['kind'], members: GraphNode[], positions: Map<string, NodePosition>): void => {
        for (const member of members) used.add(member.id);
        blocks.push({ id: `block${blocks.length}`, kind, nodes: members, positions,
            width: Math.max(...[...positions.values()].map(p => p.x + p.width)),
            height: Math.max(...[...positions.values()].map(p => p.y + p.height)) });
    };
    const put = (positions: Map<string, NodePosition>, node: GraphNode, x: number, y: number): void => {
        positions.set(node.id, { x, y, ...sizes.get(node.id)! });
    };
    // 只吸收独占的动作尾链；汇合点、外部触发点和嵌套判断仍交给全局布局。
    const tail = (edge: LayoutEdge, reserved: Set<string>): GraphNode[] => {
        const result: GraphNode[] = [];
        let next: LayoutEdge | undefined = edge;
        while (next) {
            const node = byId.get(next.target);
            if (!node || used.has(node.id) || reserved.has(node.id) || incoming.get(node.id)!.length !== 1 ||
                !['deviceOutput', 'varSetNumber', 'varSetString', 'delay'].includes(node.type)) break;
            result.push(node);reserved.add(node.id);
            const forward = from(node);
            next = forward.length === 1 ? forward[0] : undefined;
        }
        return result;
    };
    const chainSize = (chain: GraphNode[]): NodeSize => ({
        width: chain.reduce((width, node, i) => width + sizes.get(node.id)!.width + (i ? COLUMN_GAP : 0), 0),
        height: Math.max(0, ...chain.map(node => sizes.get(node.id)!.height)),
    });
    const putChain = (positions: Map<string, NodePosition>, chain: GraphNode[], x: number, y: number, rowHeight: number): void => {
        for (const node of chain) {
            const size = sizes.get(node.id)!;
            put(positions, node, x, y + (rowHeight - size.height) / 2);
            x += size.width + COLUMN_GAP;
        }
    };

    if (semantic) {
        const putColumn = (kind: LayoutBlock['kind'], members: GraphNode[]): void => {
            const positions = new Map<string, NodePosition>();
            const width = Math.max(...members.map(n => sizes.get(n.id)!.width));
            let y = 0;
            // 退出动作会向上回绕，右边界对齐后不会穿过同列更宽的状态查询卡片。
            for (const member of members) {
                put(positions, member, kind === 'cleanup' ? width - sizes.get(member.id)!.width : 0, y);
                y += sizes.get(member.id)!.height + ROW_GAP;
            }
            add(kind, members, positions);
        };
        // 循环与它自己的次数上限是一块控制单元，清零、停止线都在局部闭合。
        for (const loop of nodes) {
            if (loop.type !== 'loop' || used.has(loop.id)) continue;
            const counters = edges.filter(e => e.source === loop.id).map(e => byId.get(e.target)!).filter(counter =>
                counter.type === 'counter' && !used.has(counter.id) && edges.some(e => e.source === counter.id &&
                    e.target === loop.id && e.targetPort === 'stop'));
            if (counters.length === 1) putColumn('retry', [loop, counters[0]]);
        }
        // 写入、短延时、查询相同属性确认：纵向组成一个完整确认步骤。
        for (const write of nodes) {
            if (write.type !== 'deviceOutput' || write.props.piid === undefined || used.has(write.id)) continue;
            const first = from(write);
            const delay = first.length === 1 ? byId.get(first[0].target) : undefined;
            if (!delay || delay.type !== 'delay' || used.has(delay.id) || incoming.get(delay.id)!.length !== 1) continue;
            const second = from(delay);
            const query = second.length === 1 ? byId.get(second[0].target) : undefined;
            if (!query || query.type !== 'deviceGet' || used.has(query.id) || incoming.get(query.id)!.length !== 1) continue;
            const a = write.props;const b = query.props;
            const confirms = b.operator === '=' ? b.v1 === a.value : b.operator === 'include' && Array.isArray(b.v1) && b.v1.includes(a.value);
            if (a.did === b.did && a.siid === b.siid && a.piid === b.piid && confirms) putColumn('verification', [write, delay, query]);
        }
        // 持续计时、检查所有权/状态、关闭设备：定时退出作为一列靠近所属状态。
        for (const timer of nodes) {
            if (timer.type !== 'statusLast' || used.has(timer.id)) continue;
            const chain = [timer];
            const visited = new Set([timer.id]);
            let current = timer;
            for (;;) {
                const forward = from(current, isQuery(current) ? successPort(current) : undefined);
                const next = forward.length === 1 ? byId.get(forward[0].target) : undefined;
                if (!next || used.has(next.id) || visited.has(next.id) || incoming.get(next.id)!.length !== 1 ||
                    (!isQuery(next) && next.type !== 'deviceOutput')) break;
                chain.push(next);visited.add(next.id);current = next;
                if (next.type === 'deviceOutput') break;
            }
            if (chain.length >= 3 && current.type === 'deviceOutput' &&
                edges.some(e => e.source === current.id && e.kind === 'feedback')) putColumn('cleanup', chain);
        }
        // 同一被测属性的 if / else-if：继续判断向下，命中的动作向右。
        for (const root of nodes) {
            const key = subject(root);
            if (!key || used.has(root.id)) continue;
            if (incoming.get(root.id)!.some(e => {
                const previous = byId.get(e.source)!;
                return !used.has(previous.id) && subject(previous) === key && e.sourcePort === failurePort(previous);
            })) continue;
            const queries: GraphNode[] = [];
            const visited = new Set<string>();
            let current: GraphNode | undefined = root;
            while (current && !visited.has(current.id) && !used.has(current.id) && subject(current) === key) {
                queries.push(current);visited.add(current.id);
                const forward: LayoutEdge[] = from(current, failurePort(current));
                const candidate: GraphNode | undefined = forward.length === 1 ? byId.get(forward[0].target) : undefined;
                current = candidate && incoming.get(candidate.id)!.length === 1 ? candidate : undefined;
            }
            if (queries.length < 2) continue;
            const queryWidth = Math.max(...queries.map(node => sizes.get(node.id)!.width));
            const positions = new Map<string, NodePosition>();
            const members: GraphNode[] = [];
            const reserved = new Set(queries.map(node => node.id));
            let y = 0;
            for (const query of queries) {
                const hit = from(query, successPort(query));
                const chain = hit.length === 1 ? tail(hit[0], reserved) : [];
                const rowHeight = Math.max(sizes.get(query.id)!.height, chainSize(chain).height);
                put(positions, query, 0, y + (rowHeight - sizes.get(query.id)!.height) / 2);
                putChain(positions, chain, queryWidth + COLUMN_GAP, y, rowHeight);
                members.push(query, ...chain);y += rowHeight + ROW_GAP;
            }
            add('choices', members, positions);
        }

        // 模式的独占动作链作为完整一行；关灯分支紧随对应的开灯设置。
        for (const root of nodes) {
            if (used.has(root.id) || root.type !== 'modeSwitch') continue;
            const branches = Object.keys(root.outputs).map(port => from(root, port));
            if (branches.filter(branch => branch.length).length < 2 || branches.some(branch => branch.length > 1)) continue;
            const reserved = new Set([root.id]);
            const chains = branches.filter(branch => branch.length).map(branch => tail(branch[0], reserved));
            if (chains.some(chain => !chain.length)) continue;
            const positions = new Map<string, NodePosition>();
            let y = 0;
            for (const chain of chains) {
                const height = chainSize(chain).height;
                putChain(positions, chain, sizes.get(root.id)!.width + COLUMN_GAP, y, height);
                y += height + ROW_GAP;
            }
            put(positions, root, 0, Math.max(0, (y - ROW_GAP - sizes.get(root.id)!.height) / 2));
            add('modes', [root, ...chains.flat()], positions);
        }

        // 串联门槛是一列检查清单，不把每个判断拉成一个新的横向层级。
        for (const root of nodes) {
            if (used.has(root.id) || !isQuery(root)) continue;
            if (incoming.get(root.id)!.some(e => {
                const previous = byId.get(e.source)!;
                return !used.has(previous.id) && isQuery(previous) && e.sourcePort === successPort(previous) && from(previous, e.sourcePort).length === 1;
            })) continue;
            const chain: GraphNode[] = [];
            const visited = new Set<string>();
            let current: GraphNode | undefined = root;
            while (current && !used.has(current.id) && !visited.has(current.id) && isQuery(current)) {
                chain.push(current);visited.add(current.id);
                const forward: LayoutEdge[] = from(current, successPort(current));
                const candidate: GraphNode | undefined = forward.length === 1 ? byId.get(forward[0].target) : undefined;
                current = candidate && incoming.get(candidate.id)!.length === 1 ? candidate : undefined;
            }
            if (chain.length < 2) continue;
            const positions = new Map<string, NodePosition>();
            let y = 0;
            for (const query of chain) { put(positions, query, 0, y);y += sizes.get(query.id)!.height + ROW_GAP; }
            add('guards', chain, positions);
        }

        // 同一个输出端口同时控制多个设备：严格按端口数组次序排成动作列。
        for (const root of nodes) for (const port of Object.keys(root.outputs)) {
            const targets = [...new Set(from(root, port).map(edge => byId.get(edge.target)!))];
            if (targets.length < 2 || targets.some(node => used.has(node.id) || node.type !== 'deviceOutput' ||
                incoming.get(node.id)!.length !== 1 || from(node).length)) continue;
            const positions = new Map<string, NodePosition>();
            let y = 0;
            for (const node of targets) { put(positions, node, 0, y);y += sizes.get(node.id)!.height + ROW_GAP; }
            add('actions', targets, positions);
        }
    }
    for (const node of nodes) if (!used.has(node.id)) {
        add('node', [node], new Map([[node.id, { x: 0, y: 0, ...sizes.get(node.id)! }]]));
    }
    // 独立入口确认同一个动作时，共用执行列；避免仅因上游长度不同而错开整条支路。
    const reachable = (a: LayoutBlock, b: LayoutBlock): boolean => {
        const pending = a.nodes.map(n => n.id);const targets = new Set(b.nodes.map(n => n.id));const seen = new Set<string>();
        while (pending.length) {
            const id = pending.pop()!;
            if (targets.has(id)) return true;
            if (seen.has(id)) continue;
            seen.add(id);pending.push(...edges.filter(e => e.source === id && (e.kind === 'flow' || e.kind === 'state')).map(e => e.target));
        }
        return false;
    };
    const merged = new Set<string>();
    const branches = branchBands(nodes, edges);
    const separateBranches = (a: LayoutBlock, b: LayoutBlock): boolean => branches.some(band =>
        (a.nodes.some(n => band.upper.includes(n.id)) && b.nodes.some(n => band.lower.includes(n.id))) ||
        (b.nodes.some(n => band.upper.includes(n.id)) && a.nodes.some(n => band.lower.includes(n.id))));
    return blocks.flatMap(block => {
        if (merged.has(block.id)) return [];
        if (block.kind !== 'verification') return [block];
        const key = (b: LayoutBlock): string => {
            const p = b.nodes[0].props;return JSON.stringify([p.did, p.siid, p.piid, p.value]);
        };
        const peers = [block];
        for (const other of blocks) if (other !== block && !merged.has(other.id) && other.kind === 'verification' && key(other) === key(block) &&
            peers.every(peer => !reachable(peer, other) && !reachable(other, peer) && !separateBranches(peer, other))) peers.push(other);
        if (peers.length === 1) return [block];
        peers.sort((a, b) => Number(a.nodes[0].cfg.layoutOrder ?? 0) - Number(b.nodes[0].cfg.layoutOrder ?? 0));
        const positions = new Map<string, NodePosition>();
        let y = 0;
        for (const peer of peers) {
            merged.add(peer.id);
            for (const [id, p] of peer.positions) positions.set(id, { ...p, y: p.y + y });
            y += peer.height + ROW_GAP * 2;
        }
        return [{ ...block, nodes: peers.flatMap(p => p.nodes), positions,
            width: Math.max(...peers.map(p => p.width)), height: y - ROW_GAP * 2 }];
    });
}
