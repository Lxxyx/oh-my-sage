import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphNode } from '../../src/core/types/graph';
import { findNodeOverlaps, getNodeSize, layoutNodes, preserveNodePositions, type NodePosition } from '../../src/core/tools/layout';
import { buildBlocks, graphEdges } from '../../src/core/tools/layoutModel';
import { branchBands } from '../../src/core/tools/layoutBranches';
import { measureLayoutQuality, portY } from '../../src/core/tools/layoutQuality';

function node(id: string, type = 'delay', targets: string[] = []): GraphNode {
    return { id, type, cfg: {}, props: {}, inputs: { input: null }, outputs: { output: targets } };
}
function pos(node: GraphNode): NodePosition { return node.cfg.pos as NodePosition; }
function business(nodes: GraphNode[]): unknown {
    return nodes.map(({ cfg, ...rest }) => { const { pos: ignored, ...config } = cfg; return { ...rest, cfg: config }; });
}

test('环路及其下游都能排版，业务数据不变且结果可重复', async () => {
    const nodes = [node('start', 'onLoad', ['loop.input']), node('loop', 'loop', ['counter.input', 'query.input']),
        node('counter', 'counter', ['loop.input']), node('query', 'deviceGet', ['action.input']), node('action', 'deviceOutput')];
    const before = business(nodes);
    await layoutNodes(nodes, { maxRowWidth: 20000 });
    assert.deepEqual(business(nodes), before);
    assert.deepEqual(findNodeOverlaps(nodes, 40), []);
    assert.ok(pos(nodes[3]).x > pos(nodes[1]).x);
    assert.ok(pos(nodes[4]).x > pos(nodes[3]).x);
    const first = structuredClone(nodes);
    await layoutNodes(nodes, { maxRowWidth: 20000 });
    assert.deepEqual(nodes, first);
});

test('真实尺寸估计覆盖设备查询和变量运算，尊重更大的卡片与备注', () => {
    for (const type of ['deviceGet', 'varSetNumber']) assert.equal(getNodeSize(node('n', type)).width, 740);
    assert.equal(getNodeSize(node('n', 'varSetString')).width, 712);
    assert.deepEqual(getNodeSize(node('n', 'delay')), { width: 288, height: 112 });
    assert.ok(getNodeSize(node('n', 'deviceInput')).height >= 206);
    const note = node('note', 'nop');note.cfg.pos = { x: 0, y: 0, width: 1200, height: 920 };
    assert.deepEqual(getNodeSize(note), { width: 1200, height: 920 });
    assert.deepEqual(getNodeSize(note, { width: 1300, height: 950 }), { width: 1300, height: 950 });
});

test('独立流程上下分区，整图说明在上方且不打断主线', async () => {
    const nodes = [node('overview', 'nop'), node('a', 'onLoad', ['b.input']), node('b'), node('c', 'onLoad', ['d.input']), node('d')];
    nodes[0].cfg.pos = { x: -10, y: -100, width: 1200, height: 920 };
    const report = await layoutNodes(nodes);
    assert.equal(report.regions.length, 2);
    assert.equal(pos(nodes[0]).y, 100);
    assert.ok(report.regions[0].y >= pos(nodes[0]).y + pos(nodes[0]).height + 60);
    assert.ok(report.regions[1].y > report.regions[0].y + report.regions[0].height);
    assert.deepEqual(findNodeOverlaps(nodes), []);
});

test('显式分区及其备注一起排列，DOWN 保持区内纵向推进并保留元数据', async () => {
    const nodes = [node('a', 'onLoad', ['b.input']), node('b', 'delay', ['c.input']), node('c'), node('heading', 'nop')];
    nodes[0].cfg = { layoutGroup: 'first', layoutOrder: 1 };
    nodes[1].cfg = { layoutGroup: 'first', layoutOrder: 1 };
    nodes[2].cfg = { layoutGroup: 'second', layoutOrder: 2 };
    nodes[3].cfg = { layoutGroup: 'first', layoutOrder: 1, pos: { width: 900, height: 180 } };
    const before = business(nodes);
    const report = await layoutNodes(nodes, { direction: 'DOWN' });
    assert.deepEqual(business(nodes), before);
    assert.ok(pos(nodes[1]).y > pos(nodes[0]).y);
    assert.ok(pos(nodes[3]).x + pos(nodes[3]).width < pos(nodes[0]).x);
    assert.equal(report.regions.length, 2);
    assert.deepEqual(report.regions[0].noteIds, ['heading']);
    assert.ok(pos(nodes[2]).y > pos(nodes[1]).y + pos(nodes[1]).height);
    assert.deepEqual(report.overlaps, []);
});

test('分支与汇合、同节点多端口、自环、纯环均能排版', async () => {
    const cases = [
        [node('a', 'onLoad', ['b.input', 'c.input']), node('b', 'delay', ['d.input']), node('c', 'delay', ['d.input']), node('d')],
        [node('a', 'onLoad', ['b.input', 'b.reset']), { ...node('b'), inputs: { input: null, reset: null } }],
        [node('a', 'loop', ['a.input'])],
        [node('a', 'loop', ['b.input']), node('b', 'counter', ['a.input'])],
    ];
    for (const nodes of cases) {
        await layoutNodes(nodes);
        assert.deepEqual(findNodeOverlaps(nodes), []);
        assert.ok(nodes.every(n => Object.values(pos(n)).every(Number.isFinite)));
    }
});

test('固定旧卡片后，为新增卡片重新寻找空位', async () => {
    const nodes = [node('fixed'), node('new'), node('other')];
    await layoutNodes(nodes);
    const fixed = { ...pos(nodes[1]) };
    preserveNodePositions(nodes, new Map([['fixed', fixed]]));
    assert.deepEqual(pos(nodes[0]), fixed);
    assert.deepEqual(findNodeOverlaps(nodes, 40), []);
});

test('实测尺寸会参与避让，重复 ID 拒绝且不留下半张改动的图', async () => {
    const nodes = [node('a', 'onLoad', ['b.input']), node('b')];
    await layoutNodes(nodes, { nodeSizes: { a: { width: 1500, height: 900 } } });
    assert.equal(pos(nodes[0]).width, 1500);
    assert.ok(pos(nodes[1]).x >= pos(nodes[0]).x + 1500 + 100);
    const duplicate = [node('same'), node('same')];
    await assert.rejects(layoutNodes(duplicate), /ID 重复/);
    assert.ok(duplicate.every(n => !n.cfg.pos));
    assert.deepEqual((await layoutNodes([])).regions, []);
});

test('长链按完整层折行并向下延伸，折行后仍无卡片重叠', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node(`n${i}`, 'delay', i < 9 ? [`n${i + 1}.input`] : []));
    await layoutNodes(nodes, { maxRowWidth: 2400 });
    assert.ok(pos(nodes[9]).y > pos(nodes[0]).y);
    assert.ok(Math.max(...nodes.map(n => pos(n).x + pos(n).width)) < 2600);
    assert.deepEqual(findNodeOverlaps(nodes, 60), []);
});

test('简洁模式保留网关实测尺寸，普通卡片恢复类型尺寸，显式测量优先', () => {
    const compact = node('compact', 'deviceGet');
    compact.cfg = { simplified: true, pos: { x: 0, y: 0, width: 229.68, height: 148 } };
    assert.deepEqual(getNodeSize(compact), { width: 229.68, height: 148 });
    assert.deepEqual(getNodeSize(compact, { width: 300, height: 160 }), { width: 300, height: 160 });
    const old = node('old', 'delay');old.cfg.pos = { x: 0, y: 0, width: 528, height: 164 };
    assert.deepEqual(getNodeSize(old), { width: 288, height: 112 });
    old.cfg.pos = { x: 0, y: 0, width: 900, height: 300 };
    assert.deepEqual(getNodeSize(old), { width: 900, height: 300 });
});

function query(id: string, subject = 'setting'): GraphNode {
    return { ...node(id, 'varGet'), props: { scope: 'local', id: subject, varType: 'number' }, outputs: { output: [], output2: [] } };
}

test('同一变量的 if/else-if 排成条件表，命中动作在对应行，汇合点不被吸收', async () => {
    const nodes = Array.from({ length: 3 }, (_, i) => query(`q${i}`));
    for (let i = 0; i < 3; i++) {
        nodes[i].props.v1 = i;
        nodes[i].outputs.output = [`a${i}.input`];
        nodes[i].outputs.output2 = i < 2 ? [`q${i + 1}.input`] : [];
        nodes.push(node(`a${i}`, 'deviceOutput', ['join.input']));
    }
    nodes.push(node('join'));
    const before = business(nodes);
    await layoutNodes(nodes, { maxRowWidth: 1000 });
    for (let i = 0; i < 3; i++) {
        assert.equal(pos(nodes[i]).x, pos(nodes[0]).x);
        assert.equal(pos(nodes[i + 3]).x, pos(nodes[3]).x);
        assert.equal(pos(nodes[i]).y + pos(nodes[i]).height / 2, pos(nodes[i + 3]).y + pos(nodes[i + 3]).height / 2);
        if (i) assert.ok(pos(nodes[i]).y > pos(nodes[i - 1]).y);
    }
    assert.ok(pos(nodes[6]).x > pos(nodes[3]).x);
    assert.deepEqual(findNodeOverlaps(nodes, 40), []);
    assert.deepEqual(business(nodes), before);
});

test('不同属性或缺少属性信息的判断不会误合并为条件表', () => {
    for (const missing of [false, true]) {
        const a = query('a');const b = query('b', 'another');a.outputs.output2 = ['b.input'];
        if (missing) { a.props = {};b.props = {}; }
        const nodes = [a, b];
        const blocks = buildBlocks(nodes, graphEdges(nodes), new Map(nodes.map(n => [n.id, getNodeSize(n)])));
        assert.ok(blocks.every(b => b.kind !== 'choices'));
    }
});

test('模式的动作链按输出端口排列成行，多次重排保持相同坐标', async () => {
    const mode = node('mode', 'modeSwitch');
    mode.outputs = { output0: ['on.input'], output1: ['off.input'] };
    const nodes = [mode, node('on', 'deviceOutput', ['brightness.input']), node('brightness', 'deviceOutput', ['temperature.input']),
        node('temperature', 'deviceOutput'), node('off', 'deviceOutput')];
    const before = business(nodes);
    await layoutNodes(nodes);
    assert.equal(pos(nodes[1]).y, pos(nodes[2]).y);
    assert.equal(pos(nodes[2]).y, pos(nodes[3]).y);
    assert.equal(pos(nodes[1]).x, pos(nodes[4]).x);
    assert.ok(pos(nodes[4]).y > pos(nodes[1]).y);
    const first = structuredClone(nodes);
    await layoutNodes(nodes);
    assert.deepEqual(nodes, first);
    assert.deepEqual(business(nodes), before);
});

test('并行动作列遵循输出数组次序，不受节点数组次序影响', async () => {
    const nodes = [node('root', 'onLoad', ['c.input', 'a.input', 'b.input']),
        node('a', 'deviceOutput'), node('b', 'deviceOutput'), node('c', 'deviceOutput')];
    await layoutNodes(nodes);
    assert.equal(pos(nodes[1]).x, pos(nodes[2]).x);
    assert.equal(pos(nodes[2]).x, pos(nodes[3]).x);
    assert.ok(pos(nodes[3]).y < pos(nodes[1]).y && pos(nodes[1]).y < pos(nodes[2]).y);
});

test('循环、确认和退出形成局部形状，初始化复位不反转成功主线', async () => {
    const start = node('start', 'onLoad', ['loop.start', 'counter.zero', 'owned.setFalse']);
    const loop = node('loop', 'loop', ['counter.input', 'gate.input']);loop.inputs = { start: null, stop: null };
    const counter = node('counter', 'counter', ['loop.stop']);counter.inputs = { input: null, zero: null };
    const gate = query('gate');gate.outputs.output = ['write.input'];gate.outputs.output2 = ['reset.input'];
    const write = node('write', 'deviceOutput', ['delay.input']);write.props = { did: 'test', siid: 2, piid: 1, value: true };
    const delay = node('delay', 'delay', ['verify.input']);
    const verify = node('verify', 'deviceGet', ['mark.input']);verify.props = { did: 'test', siid: 2, piid: 1, operator: '=', v1: true };
    const mark = node('mark', 'varSetNumber', ['loop.stop', 'owned.setTrue']);
    const owned = node('owned', 'register', ['timer.input']);owned.inputs = { setTrue: null, setFalse: null };
    const timer = node('timer', 'statusLast', ['still.input']);
    const still = query('still');still.outputs.output = ['close.input'];
    const close = node('close', 'deviceOutput', ['owned.setFalse']);
    const reset = node('reset', 'varSetNumber', ['loop.stop', 'counter.zero']);
    const nodes = [start, loop, counter, gate, write, delay, verify, mark, owned, timer, still, close, reset];
    const before = business(nodes);
    const blocks = buildBlocks(nodes, graphEdges(nodes), new Map(nodes.map(n => [n.id, getNodeSize(n)])));
    assert.deepEqual(blocks.filter(b => ['retry', 'verification', 'cleanup'].includes(b.kind)).map(b => b.kind), ['retry', 'verification', 'cleanup']);
    await layoutNodes(nodes);
    assert.equal(pos(loop).x, pos(counter).x);
    assert.equal(pos(write).x, pos(delay).x);
    assert.equal(pos(delay).x, pos(verify).x);
    assert.equal(pos(timer).x + pos(timer).width, pos(close).x + pos(close).width);
    assert.ok(pos(write).x > pos(gate).x);
    assert.ok(pos(mark).x > pos(verify).x);
    assert.ok(pos(owned).x > pos(mark).x);
    assert.deepEqual(findNodeOverlaps(nodes, 40), []);
    assert.deepEqual(business(nodes), before);
});

test('长动作列和其他流程上下分区，孤立卡片仅在自己的区块内装箱', async () => {
    const actions = Array.from({ length: 10 }, (_, i) => node(`action${i}`, 'deviceOutput'));
    const nodes = [node('scene', 'onLoad', actions.map(n => `${n.id}.input`)), ...actions];
    for (let i = 0; i < 4; i++) nodes.push(node(`trigger${i}`, 'onLoad', [`delay${i}.input`]), node(`delay${i}`));
    for (let i = 0; i < 12; i++) nodes.push(node(`unused${i}`, 'deviceOutput'));
    const report = await layoutNodes(nodes);
    assert.equal(report.regions.length, 6);
    for (let i = 1; i < report.regions.length; i++) assert.ok(report.regions[i].y >= report.regions[i - 1].y + report.regions[i - 1].height + 160);
    const loose = report.regions.find(r => r.id === 'unconnected')!;
    assert.equal(loose.nodeIds.length, 12);
    assert.ok(loose.height < 1000);
    assert.deepEqual(findNodeOverlaps(nodes, 40), []);
});

test('是分支整体在否分支上方，汇合点不强行归入任一分支', async () => {
    const root = query('root');
    root.outputs = { output2: ['no.input'], output: ['yes.input'] };
    const nodes = [root, node('no', 'delay', ['no2.input']), node('join'), node('yes', 'deviceOutput', ['yes2.input']),
        node('yes2', 'delay', ['join.input']), node('no2', 'delay', ['join.input'])];
    const before = business(nodes);
    assert.deepEqual(branchBands(nodes, graphEdges(nodes)), [{ upper: ['yes', 'yes2'], lower: ['no', 'no2'] }]);
    await layoutNodes(nodes);
    assert.ok(Math.max(...[nodes[3], nodes[4]].map(n => pos(n).y + pos(n).height)) + 40 <=
        Math.min(...[nodes[1], nodes[5]].map(n => pos(n).y)));
    assert.deepEqual(business(nodes), before);
    const first = structuredClone(nodes);await layoutNodes(nodes);assert.deepEqual(nodes, first);
});

test('跨分区分支顺序优先于提示序号，备注始终位于自己的流程左侧', async () => {
    const root = query('root');root.outputs = { output: ['yes.input'], output2: ['no.input'] };
    const yes = node('yes');const no = node('no');const noteYes = node('noteYes', 'nop');const noteNo = node('noteNo', 'nop');
    root.cfg = { layoutGroup: 'entry', layoutOrder: 0 };
    for (const n of [yes, noteYes]) n.cfg = { layoutGroup: 'yes', layoutOrder: 9 };
    for (const n of [no, noteNo]) n.cfg = { layoutGroup: 'no', layoutOrder: 1 };
    const nodes = [root, no, noteNo, yes, noteYes];const before = business(nodes);
    const report = await layoutNodes(nodes);
    assert.deepEqual(report.regions.map(r => r.id), ['entry', 'yes', 'no']);
    assert.ok(pos(yes).y + pos(yes).height < pos(no).y);
    for (const [label, target] of [[noteYes, yes], [noteNo, no]]) {
        assert.ok(pos(label).x + pos(label).width < pos(target).x);
        const region = report.regions.find(r => r.nodeIds.includes(target.id))!;
        assert.ok(pos(label).y >= region.y && pos(label).y + pos(label).height <= region.y + region.height);
    }
    assert.deepEqual(business(nodes), before);
});

test('无分区标记的就近备注跟随原来的流程，自动分区名称不覆盖显式分区', async () => {
    const a = node('a', 'onLoad', ['b.input']);const b = node('b');
    a.cfg.pos = { x: 1000, y: 2000, width: 160, height: 98 };b.cfg.pos = { x: 1300, y: 2000, width: 288, height: 112 };
    const label = node('label', 'nop');label.cfg.pos = { x: 0, y: 2000, width: 800, height: 140 };
    const explicit = node('explicit');explicit.cfg.layoutGroup = 'flow';
    const isolated = node('isolated');isolated.cfg.layoutGroup = 'unconnected';
    const nodes = [a, b, label, explicit, isolated, node('unused')];
    const report = await layoutNodes(nodes);
    assert.equal(report.regions.flatMap(r => r.nodeIds).length, 5);
    assert.ok(report.regions.find(r => r.nodeIds.includes('a'))!.noteIds!.includes('label'));
    assert.ok(pos(label).x + pos(label).width < pos(a).x);
    const first = structuredClone(nodes);await layoutNodes(nodes);assert.deepEqual(nodes, first);
});

test('真实端口模型区分上下输出，检测穿过备注和第三张卡片的连线', () => {
    const source = query('source');source.outputs = { output2: [], output: ['target.input'] };
    assert.equal(portY(source, 'output', 'output', 120), 58);
    assert.equal(portY(source, 'output2', 'output', 120), 98);
    const event = node('event', 'deviceInput');event.props = { eiid: 1, arguments: [] };
    assert.equal(getNodeSize(event).height, 204);
    const target = node('target');const note = node('note', 'nop');const nodes = [source, target, note];
    const positions = new Map<string, NodePosition>([
        ['source', { x: 0, y: 0, width: 532, height: 120 }], ['target', { x: 1600, y: 0, width: 288, height: 112 }],
        ['note', { x: 900, y: 0, width: 400, height: 140 }],
    ]);
    assert.deepEqual(measureLayoutQuality(nodes, graphEdges(nodes), positions).obstacles, [{ source: 'source', target: 'target', card: 'note' }]);
    positions.get('note')!.y = 300;
    assert.equal(measureLayoutQuality(nodes, graphEdges(nodes), positions).penetrations, 0);
    assert.equal(measureLayoutQuality([], [], new Map()).width, 0);
});

test('两条分支确认相同属性时也不能合并并反转成功失败顺序', async () => {
    const root = query('root');root.outputs = { output: ['yesWrite.input'], output2: ['noWrite.input'] };
    const make = (prefix: string): GraphNode[] => {
        const write = node(`${prefix}Write`, 'deviceOutput', [`${prefix}Delay.input`]);
        write.props = { did: 'test', siid: 2, piid: 1, value: true };
        const delay = node(`${prefix}Delay`, 'delay', [`${prefix}Verify.input`]);
        const verify = node(`${prefix}Verify`, 'deviceGet');
        verify.props = { did: 'test', siid: 2, piid: 1, operator: '=', v1: true };
        return [write, delay, verify];
    };
    const no = make('no');const yes = make('yes');const nodes = [root, ...no, ...yes];
    const blocks = buildBlocks(nodes, graphEdges(nodes), new Map(nodes.map(n => [n.id, getNodeSize(n)])));
    assert.equal(blocks.filter(b => b.kind === 'verification').length, 2);
    await layoutNodes(nodes);
    assert.ok(Math.max(...yes.map(n => pos(n).y + pos(n).height)) + 40 <= Math.min(...no.map(n => pos(n).y)));
    assert.deepEqual(findNodeOverlaps(nodes, 40), []);
});
