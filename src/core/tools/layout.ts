/**
 * 极客版布局：真实卡片尺寸 + ELK 分层/环路处理 + 独立子流程分区。
 * 网关只使用 cfg.pos，自行绘制连线；ELK 的 edge sections 不能写回冒充路由。
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { GraphNode } from '../types/graph';

export interface NodeSize { width: number; height: number }
export interface NodePosition extends NodeSize { x: number; y: number }
export interface GraphLayoutOptions {
    direction?: 'RIGHT' | 'DOWN';
    /** 横向主流程超过此宽度后折到下一行，默认 3600。 */
    maxRowWidth?: number;
    /** 由网关 DOM 实测的尺寸。只影响排版，不改变业务参数。 */
    nodeSizes?: Record<string, NodeSize>;
}
export interface LayoutRegion extends NodePosition { id: string; nodeIds: string[] }
export interface LayoutReport { regions: LayoutRegion[]; overlaps: Array<[string, string]> }

const GAP = 120;
const REGION_GAP = 280;
const MARGIN = 100;
const elk = new ELK();

function positive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 2026-09 网关 UI 实测：查询设备 740px、设备属性源 584×206、变量运算 740px。
 * 旧 cfg.pos 的 528×164 只是旧布局占位，不能当成实测尺寸。
 * 对可变内容预留空间；已知更大的尺寸（尤其备注）永不缩小。
 */
export function getNodeSize(node: GraphNode, measured?: NodeSize): NodeSize {
    const old = node.cfg?.pos as Partial<NodePosition> | undefined;
    const ports = Math.max(Object.keys(node.inputs || {}).length, Object.keys(node.outputs || {}).length);
    let width = 528;
    let height = Math.max(164, 84 + ports * 40);
    if (node.type.startsWith('device')) {
        width = node.type === 'deviceGet' || node.type === 'deviceGetSetVar' ? 740 : 600;
        height = node.type === 'deviceInput' || node.type === 'deviceInputSetVar' ? 240 : 220;
        const argumentsCount = Math.max(
            Array.isArray(node.props?.arguments) ? node.props.arguments.length : 0,
            Array.isArray(node.props?.ins) ? node.props.ins.length : 0,
        );
        height += Math.max(0, argumentsCount - 1) * 48;
    }
    if (node.type === 'varSetNumber' || node.type === 'varSetString') {
        width = 760;
        const textLength = JSON.stringify(node.props?.elements || []).length;
        height = Math.max(height, 120 + Math.ceil(textLength / 75) * 32);
    }
    if (node.type === 'nop') {
        width = positive(old?.width) ? old.width : 800;
        const text = JSON.stringify(node.cfg?.contents || '');
        height = positive(old?.height) ? old.height : Math.max(160, Math.ceil(text.length / 45) * 28);
    }
    return {
        width: positive(measured?.width) ? measured.width : Math.max(width, positive(old?.width) ? old.width : 0),
        height: positive(measured?.height) ? measured.height : Math.max(height, positive(old?.height) ? old.height : 0),
    };
}

export function findNodeOverlaps(nodes: GraphNode[], padding = 0): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i].cfg?.pos as NodePosition | undefined;
        if (!a) continue;
        for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j].cfg?.pos as NodePosition | undefined;
            if (b && a.x < b.x + b.width + padding && b.x < a.x + a.width + padding &&
                a.y < b.y + b.height + padding && b.y < a.y + a.height + padding) pairs.push([nodes[i].id, nodes[j].id]);
        }
    }
    return pairs;
}

function targetId(target: string): string { return target.slice(0, target.lastIndexOf('.')); }

function isFeedback(node: GraphNode | undefined, port: string): boolean {
    return (node?.type === 'loop' && port === 'stop') ||
        ((node?.type === 'counter' || node?.type === 'onlyNTimes') && port === 'zero') ||
        (node?.type === 'register' && port === 'setFalse');
}

/** 显式业务分区优先；其余按无向连通分量分区，避免不相干的流程混排。 */
function splitRegions(nodes: GraphNode[]): GraphNode[][] {
    const explicit = new Map<string, GraphNode[]>();
    const automatic = new Map<string, GraphNode>();
    for (const node of nodes) {
        const group = node.cfg?.layoutGroup;
        if (typeof group === 'string' && group.trim()) {
            if (!explicit.has(group)) explicit.set(group, []);
            explicit.get(group)!.push(node);
        } else if (node.type !== 'nop') automatic.set(node.id, node);
    }
    const adjacent = new Map([...automatic.keys()].map(id => [id, new Set<string>()]));
    for (const node of automatic.values()) {
        for (const targets of Object.values(node.outputs || {})) for (const target of targets) {
            const id = targetId(target);
            if (automatic.has(id)) { adjacent.get(node.id)!.add(id); adjacent.get(id)!.add(node.id); }
        }
    }
    const groups = [...explicit.values()];
    const visited = new Set<string>();
    for (const id of automatic.keys()) {
        if (visited.has(id)) continue;
        const pending = [id];
        const component: GraphNode[] = [];
        visited.add(id);
        while (pending.length) {
            const next = pending.pop()!;
            component.push(automatic.get(next)!);
            for (const other of adjacent.get(next)!) if (!visited.has(other)) { visited.add(other); pending.push(other); }
        }
        groups.push(component);
    }
    const originalOrder = new Map(nodes.map((node, i) => [node.id, i]));
    const order = (group: GraphNode[]): number => Math.min(...group.map(n =>
        typeof n.cfg?.layoutOrder === 'number' && Number.isFinite(n.cfg.layoutOrder) ? n.cfg.layoutOrder : originalOrder.get(n.id)! + 1000));
    groups.sort((a, b) => order(a) - order(b));
    return groups;
}

function elkPorts(node: GraphNode, size: NodeSize, direction: 'RIGHT' | 'DOWN'): ElkPort[] {
    const result: ElkPort[] = [];
    for (const [side, ports] of [['WEST', node.inputs], ['EAST', node.outputs]] as const) {
        const names = Object.keys(ports || {});
        names.forEach((port, i) => result.push({
            id: `${node.id}.${side}.${port}`,
            // DOWN 只使用上下端口建立紧凑分层；网关仍用原来的左右端口绘制回绕线。
            x: direction === 'DOWN' ? size.width * (i + 1) / (names.length + 1) : side === 'WEST' ? 0 : size.width,
            y: direction === 'DOWN' ? side === 'WEST' ? 0 : size.height : Math.min(size.height - 24, 80 + i * 40),
            width: 0, height: 0,
            layoutOptions: { 'elk.port.side': direction === 'DOWN' ? side === 'WEST' ? 'NORTH' : 'SOUTH' : side },
        }));
    }
    return result;
}

/** 按完整的层折行，不能把同层分支拆开；折行通道为网关的回绕线预留空白。 */
function wrapRows(children: ElkNode[], maxWidth: number): NodeSize {
    const columns: Array<{ left: number; right: number; nodes: ElkNode[] }> = [];
    for (const child of [...children].sort((a, b) => a.x! - b.x!)) {
        const last = columns[columns.length - 1];
        if (last && child.x! < last.right) {
            last.nodes.push(child);
            last.right = Math.max(last.right, child.x! + child.width!);
        } else columns.push({ left: child.x!, right: child.x! + child.width!, nodes: [child] });
    }
    const rows: typeof columns[] = [];
    for (const column of columns) {
        let row = rows[rows.length - 1];
        if (!row || (row.length && column.right - row[0].left > maxWidth)) {
            row = [];
            rows.push(row);
        }
        row.push(column);
    }
    let top = 40;
    let width = 0;
    for (const row of rows) {
        const content = row.flatMap(column => column.nodes);
        const minY = Math.min(...content.map(n => n.y!));
        const height = Math.max(...content.map(n => n.y! + n.height!)) - minY;
        for (const child of content) {
            child.x = child.x! - row[0].left + 40;
            child.y = child.y! - minY + top;
            width = Math.max(width, child.x + child.width! + 40);
        }
        top += height + Math.max(280, height);
    }
    return { width, height: children.length ? Math.max(...children.map(n => n.y! + n.height!)) + 40 : 0 };
}

/** 只修改坐标与包围盒，不改节点、端口、连线、变量、设备参数及启用状态。 */
export async function layoutNodes(nodes: GraphNode[], options: GraphLayoutOptions = {}): Promise<LayoutReport> {
    if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('布局失败：节点 ID 重复');
    const sizes = new Map(nodes.map(node => [node.id, getNodeSize(node, options.nodeSizes?.[node.id])]));
    const positions = new Map<string, NodePosition>();
    const regions: LayoutRegion[] = [];
    let top = MARGIN;
    // 总览备注在整个流程上方，保留它的独立尺寸，不参加拓扑排序。
    const overview = nodes.filter(n => n.type === 'nop' && !n.cfg?.layoutGroup);
    for (const note of overview) {
        const size = sizes.get(note.id)!;
        positions.set(note.id, { x: MARGIN, y: top, ...size });
        top += size.height + GAP;
    }
    for (const [index, group] of splitRegions(nodes).entries()) {
        const groupTop = top;
        const notes = group.filter(n => n.type === 'nop');
        const content = group.filter(n => n.type !== 'nop');
        let width = 0;
        for (const note of notes) {
            const size = sizes.get(note.id)!;
            positions.set(note.id, { x: MARGIN, y: top, ...size });
            top += size.height + GAP;
            width = Math.max(width, size.width);
        }
        const ids = new Set(content.map(n => n.id));
        const nodeById = new Map(content.map(n => [n.id, n]));
        const graph: ElkNode = {
            id: 'layoutRoot',
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': options.direction || 'RIGHT',
                'elk.edgeRouting': 'ORTHOGONAL',
                'elk.spacing.nodeNode': String(GAP),
                'elk.layered.spacing.nodeNodeBetweenLayers': '200',
                'elk.spacing.edgeNode': '48',
                'elk.layered.spacing.edgeNodeBetweenLayers': '48',
                'elk.spacing.edgeEdge': '32',
                'elk.layered.spacing.edgeEdgeBetweenLayers': '32',
                'elk.layered.cycleBreaking.strategy': 'GREEDY',
                'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
                'elk.randomSeed': '1',
                'elk.padding': '[top=40,left=40,bottom=40,right=40]',
            },
            children: content.map(node => ({
                id: node.id, ...sizes.get(node.id)!,
                ports: elkPorts(node, sizes.get(node.id)!, options.direction || 'RIGHT'),
                layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
            })),
            edges: content.flatMap(node => Object.entries(node.outputs || {}).flatMap(([port, targets]) =>
                // 停止、清零、状态复位是反馈控制，不决定主流程的前后层级。
                // 只从布局模型移除，原 outputs 完整保留供网关执行和显示。
                targets.flatMap((target, i) => ids.has(targetId(target)) &&
                    !isFeedback(nodeById.get(targetId(target)), target.slice(target.lastIndexOf('.') + 1)) ? [{
                    id: `${node.id}.${port}.${target}.${i}`,
                    sources: [`${node.id}.EAST.${port}`],
                    targets: [`${targetId(target)}.WEST.${target.slice(target.lastIndexOf('.') + 1)}`],
                }] : []))),
        };
        if (content.length) {
            const laidOut = await elk.layout(graph);
            const bounds = options.direction !== 'DOWN'
                ? wrapRows(laidOut.children || [], positive(options.maxRowWidth) ? options.maxRowWidth : 3600)
                : { width: laidOut.width || 0, height: laidOut.height || 0 };
            for (const child of laidOut.children || []) positions.set(child.id, {
                x: MARGIN + Math.round(child.x || 0), y: top + Math.round(child.y || 0), ...sizes.get(child.id)!,
            });
            width = Math.max(width, bounds.width);
            top += bounds.height;
        }
        regions.push({ id: String(group[0].cfg?.layoutGroup || `flow${index + 1}`), nodeIds: group.map(n => n.id),
            x: MARGIN, y: groupTop, width, height: top - groupTop });
        top += REGION_GAP;
    }
    // 所有布局完成才写入，避免布局错误留下半张已改动的图。
    const candidate = nodes.map(node => ({ ...node, cfg: { ...node.cfg, pos: positions.get(node.id)! } }));
    const overlaps = findNodeOverlaps(candidate);
    if (overlaps.length) throw new Error(`布局失败：${overlaps.length} 对卡片重叠`);
    for (const node of nodes) node.cfg = { ...node.cfg, pos: positions.get(node.id)! };
    return { regions, overlaps };
}

/** 更新时固定旧坐标；新增卡片只在空位落下，不能恢复旧坐标后再相互覆盖。 */
export function preserveNodePositions(nodes: GraphNode[], fixed: Map<string, unknown>): void {
    const occupied: NodePosition[] = [];
    for (const node of nodes) {
        const pos = fixed.get(node.id) as NodePosition | undefined;
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
        node.cfg.pos = pos;
        occupied.push({ ...pos, ...getNodeSize(node) });
    }
    for (const node of nodes) {
        const fixedPos = fixed.get(node.id) as NodePosition | undefined;
        if (fixedPos && Number.isFinite(fixedPos.x) && Number.isFinite(fixedPos.y)) continue;
        const pos = { ...(node.cfg.pos as NodePosition), ...getNodeSize(node) };
        for (;;) {
            const collisions = occupied.filter(other => pos.x < other.x + other.width + GAP && other.x < pos.x + pos.width + GAP &&
                pos.y < other.y + other.height + GAP && other.y < pos.y + pos.height + GAP);
            if (!collisions.length) break;
            pos.y = Math.max(...collisions.map(other => other.y + other.height + GAP));
        }
        node.cfg.pos = pos;
        occupied.push(pos);
    }
}
