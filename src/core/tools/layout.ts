/**
 * 极客版布局：先识别业务行列，再由 ELK 安排局部形状之间的关系。
 * 网关只接受 cfg.pos 并自行画线；这里不伪造可供网关使用的连线路由。
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { GraphNode } from '../types/graph';
import { buildBlocks, COLUMN_GAP, connectedComponents, graphEdges, ROW_GAP,
    type LayoutBlock, type LayoutEdge } from './layoutModel';
import { improvePortClearance, improveSectionClearance, improveRegionContents, improveNoteClearance, improveSectionSpacing, portY } from './layoutQuality';
import { blockBranchBands, branchBands, enforceBranchOrder } from './layoutBranches';

export interface NodeSize { width: number; height: number }
export interface NodePosition extends NodeSize { x: number; y: number }
export interface GraphLayoutOptions {
    direction?: 'RIGHT' | 'DOWN';
    /** 期望行宽，不拆开条件表、模式行或动作列；完整局部形状允许超宽。 */
    maxRowWidth?: number;
    /** 网关页面实测尺寸优先于类型估计与历史占位。 */
    nodeSizes?: Record<string, NodeSize>;
}
export interface LayoutRegion extends NodePosition { id: string; nodeIds: string[]; noteIds?: string[] }
export interface LayoutReport { regions: LayoutRegion[]; overlaps: Array<[string, string]> }

const REGION_GAP = 160;
const MARGIN = 100;
const elk = new ELK();

function positive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 网关 all_cards 的原生尺寸。按端口数增长，不再把逻辑节点扩大到设备卡片大小。 */
const NATIVE_SIZES: Record<string, NodeSize> = {
    alarmClock: { width: 416, height: 112 }, timeRange: { width: 438, height: 112 },
    delay: { width: 288, height: 112 }, statusLast: { width: 288, height: 119 },
    eventSequence: { width: 524, height: 140 }, condition: { width: 300, height: 140 },
    loop: { width: 510, height: 140 }, onlyNTimes: { width: 382, height: 140 },
    counter: { width: 328, height: 140 }, modeSwitch: { width: 160, height: 180 },
    signalOr: { width: 160, height: 180 }, logicAnd: { width: 160, height: 180 },
    logicOr: { width: 160, height: 180 }, logicNot: { width: 160, height: 100 },
    register: { width: 160, height: 140 }, onLoad: { width: 160, height: 98 },
    varGet: { width: 532, height: 120 }, varChange: { width: 444, height: 152 },
    varSetNumber: { width: 740, height: 112 }, varSetString: { width: 712, height: 112 },
    deviceGetSetVar: { width: 566, height: 164 }, deviceInputSetVar: { width: 554, height: 204 },
};

export function getNodeSize(node: GraphNode, measured?: NodeSize): NodeSize {
    const old = node.cfg?.pos as Partial<NodePosition> | undefined;
    // 简洁模式由网关按内容收缩；已经保存的实际尺寸不能被普通卡片下限覆盖。
    if (node.cfg?.simplified === true) return {
        width: positive(measured?.width) ? measured.width : positive(old?.width) ? old.width : 360,
        height: positive(measured?.height) ? measured.height : positive(old?.height) ? old.height : 148,
    };
    const ports = Math.max(Object.keys(node.inputs || {}).length, Object.keys(node.outputs || {}).length);
    const props = node.props || {};
    let size = { ...(NATIVE_SIZES[node.type] || { width: 528, height: 164 }) };
    if (['modeSwitch', 'signalOr', 'logicAnd', 'logicOr'].includes(node.type)) size.height = 100 + ports * 40;
    if (node.type === 'deviceGet') size = { width: props.operator === 'between' ? 850 : 740, height: 164 };
    if (node.type === 'deviceInput') {
        const event = props.eiid !== undefined;
        const args = Array.isArray(props.arguments) ? props.arguments : [];
        size = event ? { width: args.length ? 436 : 280, height: 204 + Math.max(0, args.length - 1) * 48 }
            : { width: 584, height: 206 };
    }
    if (node.type === 'deviceOutput') {
        const action = props.aiid !== undefined;
        const args = Array.isArray(props.ins) ? props.ins : [];
        size = action ? { width: args.length ? 684 : 280, height: 164 + Math.max(0, args.length - 1) * 40 }
            : { width: typeof props.value === 'boolean' ? 528 : 556, height: 164 };
        // 枚举选择器与数值输入器宽度不同；图中已保存的这两种原生尺寸都有效。
        if (!action && [528, 556].includes(old?.width || 0) && old?.height === 164) size.width = old!.width!;
    }
    if (['varSetNumber', 'varSetString'].includes(node.type)) {
        const elements = Array.isArray(props.elements) ? props.elements : [];
        const characters = elements.reduce((length: number, element: Record<string, unknown>) =>
            length + String(element.value ?? element.id ?? '').length, 0);
        size.height += Math.max(0, Math.ceil(characters / 65) - 1) * 32;
    }
    if (node.type === 'nop') {
        const contents = Array.isArray(node.cfg?.contents) ? node.cfg.contents : [];
        const text = contents.map((part: { insert?: string }) => part.insert || '').join('');
        size = { width: positive(old?.width) ? old.width : 800,
            height: positive(old?.height) ? old.height : Math.max(60, text.split('\n').reduce((lines: number, line: string) =>
                lines + Math.max(1, Math.ceil(line.length / 35)), 0) * 28 + 24) };
    }
    // 旧版算法写入的通用/保守占位不是实测尺寸，否则重排永远无法恢复紧凑卡片。
    const legacy = (old?.width === 528 && old.height === 164) ||
        (old?.width === 600 && [220, 240].includes(old.height || 0)) ||
        (node.type === 'deviceGet' && old?.width === 740 && old.height === 220) ||
        (['varSetNumber', 'varSetString'].includes(node.type) && old?.width === 760);
    return {
        width: positive(measured?.width) ? measured.width : Math.max(size.width, !legacy && positive(old?.width) ? old.width : 0),
        height: positive(measured?.height) ? measured.height : Math.max(size.height, !legacy && positive(old?.height) ? old.height : 0),
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

function bounds(positions: Iterable<NodePosition>): NodePosition {
    const values = [...positions];
    if (!values.length) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.min(...values.map(p => p.x));
    const y = Math.min(...values.map(p => p.y));
    return { x, y, width: Math.max(...values.map(p => p.x + p.width)) - x,
        height: Math.max(...values.map(p => p.y + p.height)) - y };
}

function blockPorts(block: LayoutBlock, direction: 'RIGHT' | 'DOWN'): ElkPort[] {
    return block.nodes.flatMap(node => {
        const pos = block.positions.get(node.id)!;
        return (['WEST', 'EAST'] as const).flatMap(side => {
            const names = Object.keys((side === 'WEST' ? node.inputs : node.outputs) || {});
            return names.map((name, i) => ({ id: `${node.id}.${side}.${name}`, width: 0, height: 0,
                x: direction === 'DOWN' ? pos.x + pos.width * (i + 1) / (names.length + 1) : pos.x + (side === 'WEST' ? 0 : pos.width),
                y: direction === 'DOWN' ? pos.y + (side === 'WEST' ? 0 : pos.height) : pos.y + portY(node, name, side === 'WEST' ? 'input' : 'output', pos.height),
                layoutOptions: { 'elk.port.side': direction === 'DOWN' ? side === 'WEST' ? 'NORTH' : 'SOUTH' : side },
            }));
        });
    });
}

/** 只在完整形状之间、单一主流程连线的切口折行；共享条件与控制回路不被切断。 */
function foldSimpleBridges(children: ElkNode[], edges: LayoutEdge[], owners: Map<string, LayoutBlock>, maxWidth: number): void {
    const columns: Array<{ left: number; right: number; children: ElkNode[] }> = [];
    for (const child of [...children].sort((a, b) => a.x! - b.x!)) {
        const last = columns[columns.length - 1];
        if (last && child.x! < last.right) {
            last.children.push(child);last.right = Math.max(last.right, child.x! + child.width!);
        } else columns.push({ left: child.x!, right: child.x! + child.width!, children: [child] });
    }
    const rowGroups: typeof columns[] = [];
    let row: typeof columns = [];
    const before = new Set<string>();
    for (const column of columns) {
        const crossing = edges.filter(edge => before.has(owners.get(edge.source)!.id) !== before.has(owners.get(edge.target)!.id));
        const safe = crossing.length === 1 && crossing[0].kind === 'flow';
        if (row.length && column.right - row[0].left > maxWidth && safe) {
            rowGroups.push(row);row = [];
        }
        row.push(column);
        for (const child of column.children) before.add(child.id);
    }
    if (row.length) rowGroups.push(row);
    if (rowGroups.length < 2) return;
    let top = 0;
    for (const group of rowGroups) {
        const items = group.flatMap(column => column.children);
        const minY = Math.min(...items.map(child => child.y!));
        const height = Math.max(...items.map(child => child.y! + child.height!)) - minY;
        for (const child of items) { child.x = child.x! - group[0].left;child.y = child.y! - minY + top; }
        top += height + 2 * REGION_GAP;
    }
}

interface ComponentLayout extends NodeSize {
    nodes: GraphNode[];
    positions: Map<string, NodePosition>;
    signature: string;
}

async function layoutComponent(nodes: GraphNode[], edges: LayoutEdge[], sizes: Map<string, NodeSize>,
    options: GraphLayoutOptions): Promise<ComponentLayout> {
    const direction = options.direction || 'RIGHT';
    const blocks = buildBlocks(nodes, edges, sizes, direction === 'RIGHT');
    const owners = new Map(blocks.flatMap(block => block.nodes.map(node => [node.id, block] as const)));
    const forward = new Map(blocks.map(block => [block.id, new Set<string>()]));
    for (const edge of edges) if (edge.kind === 'flow' || edge.kind === 'state') {
        forward.get(owners.get(edge.source)!.id)!.add(owners.get(edge.target)!.id);
    }
    const reachable = (start: string, end: string): boolean => {
        const pending = [start];const seen = new Set<string>();
        while (pending.length) {
            const current = pending.pop()!;
            if (current === end) return true;
            if (seen.has(current)) continue;
            seen.add(current);pending.push(...forward.get(current)!);
        }
        return false;
    };
    const graph: ElkNode = {
        id: 'layoutRoot',
        layoutOptions: {
            'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.edgeRouting': 'ORTHOGONAL',
            'elk.spacing.nodeNode': String(ROW_GAP), 'elk.layered.spacing.nodeNodeBetweenLayers': String(COLUMN_GAP),
            'elk.spacing.edgeNode': '24', 'elk.layered.spacing.edgeNodeBetweenLayers': '24',
            'elk.spacing.edgeEdge': '20', 'elk.layered.spacing.edgeEdgeBetweenLayers': '20',
            'elk.layered.cycleBreaking.strategy': 'GREEDY',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            'elk.randomSeed': '1', 'elk.padding': '[top=0,left=0,bottom=0,right=0]',
        },
        children: blocks.map(block => ({ id: block.id, width: block.width, height: block.height,
            ports: blockPorts(block, direction), layoutOptions: { 'elk.portConstraints': 'FIXED_POS' } })),
        edges: edges.flatMap((edge, i) => {
            const source = owners.get(edge.source)!;
            const target = owners.get(edge.target)!;
            if (source === target) return [];
            // 已有主线连接的反馈不重复参与排序，否则长返回边会把成功步骤拉离确认节点。
            if (edge.kind === 'feedback' && (reachable(source.id, target.id) || reachable(target.id, source.id) ||
                edges.some(other => other.source === edge.source && (other.kind === 'flow' || other.kind === 'escape')))) return [];
            // stop/zero/reset 不推进执行层级，但反向的布局约束仍把控制端放在受控节点附近。
            return [{ id: `edge${i}`,
                sources: ['feedback', 'escape'].includes(edge.kind) ? [target.id] : [`${edge.source}.EAST.${edge.sourcePort}`],
                targets: ['feedback', 'escape'].includes(edge.kind) ? [source.id] : [`${edge.target}.WEST.${edge.targetPort}`] }];
        }),
    };
    const result = await elk.layout(graph);
    const children = result.children || [];
    if (direction === 'RIGHT') {
        // 默认保持完整流程，极长流程才尝试安全折行；显式宽度同样只是偏好。
        const width = positive(options.maxRowWidth) ? options.maxRowWidth : 6000;
        if ((result.width || 0) > width * (options.maxRowWidth ? 1 : 2)) foldSimpleBridges(children, edges, owners, width);
    }
    const positions = new Map<string, NodePosition>();
    if (direction === 'RIGHT') {
        const rectangles = new Map(children.map(child => [child.id, { x: child.x || 0, y: child.y || 0,
            width: child.width!, height: child.height! }]));
        enforceBranchOrder(blockBranchBands(nodes, edges, blocks), rectangles);
        for (const child of children) Object.assign(child, rectangles.get(child.id));
    }
    for (const child of children) for (const [id, pos] of blocks.find(block => block.id === child.id)!.positions) {
        positions.set(id, { ...pos, x: (child.x || 0) + pos.x, y: (child.y || 0) + pos.y });
    }
    if (direction === 'RIGHT') improvePortClearance(nodes, edges, blocks, positions);
    const box = bounds(positions.values());
    for (const [id, pos] of positions) positions.set(id, { ...pos, x: pos.x - box.x, y: pos.y - box.y });
    // 同构的独立配方保持相同行列（例如三个按键的照明档位）。值和设备 ID 不参与判断。
    const signature = JSON.stringify({ blocks: blocks.map(block => [block.kind, block.nodes.map(n => n.type)]).sort(),
        types: nodes.map(n => n.type).sort(), ports: edges.map(e => [e.sourcePort, e.targetPort, e.kind]).sort() });
    return { nodes, positions, width: box.width, height: box.height, signature };
}

/** 同构配方纵向对照，再以完整矩形填充空位；孤立卡片不把无关流程撑高。 */
function packComponents(components: ComponentLayout[], positions: Map<string, NodePosition>, options: GraphLayoutOptions): LayoutRegion[] {
    const families = new Map<string, ComponentLayout[]>();
    for (const component of components) {
        const order = Math.min(...component.nodes.map(n => typeof n.cfg?.layoutOrder === 'number' ? n.cfg.layoutOrder : Infinity));
        const key = `${Number.isFinite(order) ? order : ''}:${component.signature}:${component.nodes.length === 1 ? component.nodes[0].id : ''}`;
        if (!families.has(key)) families.set(key, []);
        families.get(key)!.push(component);
    }
    const familyList = [...families.values()].map(family => ({ family,
        width: Math.max(...family.map(c => c.width)),
        height: family.reduce((sum, c) => sum + c.height, 0) + (family.length - 1) * REGION_GAP,
        order: Math.min(...family.flatMap(c => c.nodes.map(n => typeof n.cfg?.layoutOrder === 'number' ? n.cfg.layoutOrder : Infinity))),
        isolated: family.every(c => c.nodes.length === 1),
    })).sort((a, b) => a.order - b.order || Number(a.isolated) - Number(b.isolated) || b.height - a.height || b.width - a.width);
    const area = familyList.reduce((sum, item) => sum + item.width * item.height, 0);
    const preferredWidth = Math.max(0, ...familyList.map(item => item.width),
        positive(options.maxRowWidth) ? options.maxRowWidth : Math.max(4200, Math.sqrt(area * 1.8)));
    const occupied: NodePosition[] = [];
    const regions: LayoutRegion[] = [];
    for (const { family, width, height } of familyList) {
        const xs = [...new Set([0, ...occupied.map(p => p.x + p.width + REGION_GAP)])];
        const ys = [...new Set([0, ...occupied.map(p => p.y + p.height + REGION_GAP)])];
        const candidates = ys.flatMap(y => xs.map(x => ({ x, y, width, height }))).filter(p =>
            p.x + width <= preferredWidth && (options.direction !== 'DOWN' || p.x === 0) &&
            occupied.every(q => p.x >= q.x + q.width + REGION_GAP || q.x >= p.x + width + REGION_GAP ||
                p.y >= q.y + q.height + REGION_GAP || q.y >= p.y + height + REGION_GAP));
        candidates.sort((a, b) => a.y - b.y || a.x - b.x);
        const place = candidates[0];
        occupied.push(place);
        const x = place.x + MARGIN;
        const y = place.y + MARGIN;
        let top = y;
        for (const component of family) {
            for (const [id, pos] of component.positions) positions.set(id, { ...pos, x: x + pos.x, y: top + pos.y });
            regions.push({ id: `flow${regions.length + 1}`, nodeIds: component.nodes.map(n => n.id),
                x, y: top, width: component.width, height: component.height });
            top += component.height + REGION_GAP;
        }
    }
    return regions;
}

/** 流程分区绑定对应备注，整块向下展开；区块内部才做紧凑排版和端口避让。 */
export async function layoutNodes(nodes: GraphNode[], options: GraphLayoutOptions = {}): Promise<LayoutReport> {
    if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('布局失败：节点 ID 重复');
    const sizes = new Map(nodes.map(node => [node.id, getNodeSize(node, options.nodeSizes?.[node.id])]));
    const content = nodes.filter(node => node.type !== 'nop');
    const edges = graphEdges(content);
    const positions = new Map<string, NodePosition>();
    const groupName = (node: GraphNode): string | undefined => typeof node.cfg?.layoutGroup === 'string' && node.cfg.layoutGroup.trim() || undefined;
    const groups = new Map<string, GraphNode[]>();
    for (const node of content) {
        const name = groupName(node);
        if (!name) continue;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(node);
    }
    const ungrouped = content.filter(n => !groupName(n));
    const loose: GraphNode[] = [];
    const uniqueGroup = (prefix: string): string => {
        let id = prefix;let suffix = 1;
        while (groups.has(id)) id = `${prefix}${suffix++}`;
        return id;
    };
    for (const component of connectedComponents(ungrouped, edges.filter(e => ungrouped.some(n => n.id === e.source) && ungrouped.some(n => n.id === e.target)))) {
        if (component.length === 1) loose.push(...component);
        else groups.set(uniqueGroup('flow'), component);
    }
    if (loose.length) groups.set(uniqueGroup('unconnected'), loose);
    const preferred = [...groups].sort((a, b) => {
        const order = (ns: GraphNode[]): number => Math.min(...ns.map(n => typeof n.cfg.layoutOrder === 'number' ? n.cfg.layoutOrder : Infinity));
        return order(a[1]) - order(b[1]);
    });
    const groupOf = new Map([...groups].flatMap(([id, members]) => members.map(n => [n.id, id] as const)));
    const precedence = new Map([...groups.keys()].map(id => [id, new Set<string>()]));
    for (const band of branchBands(content, edges)) {
        const upper = new Set(band.upper.map(id => groupOf.get(id)!));
        const lower = new Set(band.lower.map(id => groupOf.get(id)!));
        for (const a of upper) for (const b of lower) if (!lower.has(a) && !upper.has(b)) precedence.get(b)!.add(a);
    }
    const ordered: typeof preferred = [];
    const remaining = [...preferred];
    while (remaining.length) {
        const next = remaining.findIndex(([id]) => [...precedence.get(id)!].every(before => !remaining.some(([other]) => other === before)));
        ordered.push(...remaining.splice(next >= 0 ? next : 0, 1));
    }
    const notes = nodes.filter(node => node.type === 'nop').sort((a, b) => {
        const order = (n: GraphNode): number => typeof n.cfg.layoutOrder === 'number' ? n.cfg.layoutOrder : -1;
        return order(a) - order(b);
    });
    const noteGroups = new Map<string, string>();
    for (const note of notes) {
        const explicit = groupName(note);
        if (explicit) { if (groups.has(explicit)) noteGroups.set(note.id, explicit);continue; }
        // 已有显式分区说明时，未分组的说明保留为整图总览。
        if (notes.some(other => groupName(other))) continue;
        const old = note.cfg.pos as NodePosition | undefined;
        if (!old || !Number.isFinite(old.x) || !Number.isFinite(old.y)) continue;
        const boxes = [...groups].flatMap(([id, members]) => {
            const saved = members.map(n => n.cfg.pos as NodePosition | undefined).filter((p): p is NodePosition =>
                !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && positive(p.width) && positive(p.height));
            return saved.length ? [{ id, box: bounds(saved) }] : [];
        });
        // 位于所有流程上方的备注是总览；其他无标记备注沿用原图的空间邻近关系。
        if (!boxes.length || old.y + sizes.get(note.id)!.height <= Math.min(...boxes.map(item => item.box.y))) continue;
        const distance = (b: NodePosition): number => Math.hypot(Math.max(b.x - old.x - sizes.get(note.id)!.width, old.x - b.x - b.width, 0),
            2 * Math.max(b.y - old.y - sizes.get(note.id)!.height, old.y - b.y - b.height, 0));
        boxes.sort((a, b) => distance(a.box) - distance(b.box));noteGroups.set(note.id, boxes[0].id);
    }
    let top = MARGIN;
    const putNotes = (list: GraphNode[]): void => {
        for (const note of list) {
            const size = sizes.get(note.id)!;
            positions.set(note.id, { x: MARGIN, y: top, ...size });top += size.height + ROW_GAP;
        }
    };
    putNotes(notes.filter(n => !noteGroups.has(n.id)));
    const regions: LayoutRegion[] = [];
    for (const [id, members] of ordered) {
        const labels = notes.filter(n => noteGroups.get(n.id) === id);
        const labelWidth = labels.length ? Math.max(...labels.map(n => sizes.get(n.id)!.width)) + REGION_GAP : 0;
        const labelHeight = labels.reduce((sum, n) => sum + sizes.get(n.id)!.height + ROW_GAP, 0) - (labels.length ? ROW_GAP : 0);
        let labelTop = top;
        for (const label of labels) {
            const size = sizes.get(label.id)!;
            positions.set(label.id, { x: MARGIN, y: labelTop, ...size });labelTop += size.height + ROW_GAP;
        }
        const ids = new Set(members.map(n => n.id));
        const internal = edges.filter(e => ids.has(e.source) && ids.has(e.target));
        let component: ComponentLayout;
        if (!internal.length && members.length > 1) {
            const singles: ComponentLayout[] = [];
            for (const member of members) singles.push(await layoutComponent([member], [], sizes, options));
            const packed = new Map<string, NodePosition>();
            packComponents(singles, packed, options);
            const box = bounds(packed.values());
            component = { nodes: members, signature: '', width: box.width, height: box.height,
                positions: new Map([...packed].map(([id, p]) => [id, { ...p, x: p.x - box.x, y: p.y - box.y }])) };
        } else component = await layoutComponent(members, internal, sizes, options);
        for (const [nodeId, p] of component.positions) positions.set(nodeId, { ...p, x: p.x + MARGIN + labelWidth, y: p.y + top });
        const height = Math.max(component.height, labelHeight);
        regions.push({ id, nodeIds: members.map(n => n.id), noteIds: labels.map(n => n.id), x: MARGIN, y: top, width: component.width + labelWidth, height });
        top += height + REGION_GAP * 2;
    }
    if (options.direction !== 'DOWN') {
        improveSectionClearance(nodes, edges, regions, positions);
        improveNoteClearance(nodes, edges, regions, positions);
        improveSectionSpacing(nodes, edges, regions, positions);
        improveRegionContents(nodes, edges, regions, positions);
        improveSectionClearance(nodes, edges, regions, positions);
        improveNoteClearance(nodes, edges, regions, positions);
    }
    // 完成后才写回，任何失败都不留下半张已改动的图。
    const candidate = nodes.map(node => ({ ...node, cfg: { ...node.cfg, pos: positions.get(node.id)! } }));
    const overlaps = findNodeOverlaps(candidate);
    if (overlaps.length) throw new Error(`布局失败：${overlaps.length} 对卡片重叠`);
    for (const node of nodes) {
        const pos = positions.get(node.id)!;
        node.cfg = { ...node.cfg, pos: { ...pos, x: Math.round(pos.x), y: Math.round(pos.y) } };
    }
    return { regions, overlaps };
}

/** 更新固定旧卡片，新增卡片按真实尺寸寻找空位。 */
export function preserveNodePositions(nodes: GraphNode[], fixed: Map<string, unknown>): void {
    const occupied: NodePosition[] = [];
    const valid = (pos: NodePosition | undefined): pos is NodePosition => !!pos && Number.isFinite(pos.x) && Number.isFinite(pos.y);
    for (const node of nodes) {
        const pos = fixed.get(node.id) as NodePosition | undefined;
        if (!valid(pos)) continue;
        node.cfg.pos = pos;occupied.push({ ...pos, ...getNodeSize(node) });
    }
    for (const node of nodes) {
        if (valid(fixed.get(node.id) as NodePosition | undefined)) continue;
        const old = node.cfg.pos as NodePosition | undefined;
        const pos = { x: Number.isFinite(old?.x) ? old!.x : MARGIN, y: Number.isFinite(old?.y) ? old!.y : MARGIN, ...getNodeSize(node) };
        for (;;) {
            const collisions = occupied.filter(other => pos.x < other.x + other.width + ROW_GAP && other.x < pos.x + pos.width + ROW_GAP &&
                pos.y < other.y + other.height + ROW_GAP && other.y < pos.y + pos.height + ROW_GAP);
            if (!collisions.length) break;
            pos.y = Math.max(...collisions.map(other => other.y + other.height + ROW_GAP));
        }
        node.cfg.pos = pos;occupied.push(pos);
    }
}
