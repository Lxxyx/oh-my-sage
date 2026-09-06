import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphNode } from '../../src/core/types/graph';
import { findNodeOverlaps, getNodeSize, layoutNodes, preserveNodePositions, type NodePosition } from '../../src/core/tools/layout';
import { buildBlocks, graphEdges } from '../../src/core/tools/layoutModel';

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

test('同构流程纵向对照，长备注放在侧边且不打断主线', async () => {
    const nodes = [node('overview', 'nop'), node('a', 'onLoad', ['b.input']), node('b'), node('c', 'onLoad', ['d.input']), node('d')];
    nodes[0].cfg.pos = { x: -10, y: -100, width: 1200, height: 920 };
    const report = await layoutNodes(nodes);
    assert.equal(report.regions.length, 2);
    assert.ok(pos(nodes[0]).x > report.regions[0].x + report.regions[0].width);
    assert.equal(report.regions[0].y, 100);
    assert.ok(report.regions[1].y > report.regions[0].y + report.regions[0].height);
    assert.deepEqual(findNodeOverlaps(nodes), []);
});

test('分组提示不割裂连通流程，DOWN 保持纵向推进并保留元数据', async () => {
    const nodes = [node('a', 'onLoad', ['b.input']), node('b', 'delay', ['c.input']), node('c'), node('heading', 'nop')];
    nodes[0].cfg = { layoutGroup: 'first', layoutOrder: 1 };
    nodes[1].cfg = { layoutGroup: 'first', layoutOrder: 1 };
    nodes[2].cfg = { layoutGroup: 'second', layoutOrder: 2 };
    nodes[3].cfg = { layoutGroup: 'first', layoutOrder: 1, pos: { width: 900, height: 180 } };
    const before = business(nodes);
    const report = await layoutNodes(nodes, { direction: 'DOWN' });
    assert.deepEqual(business(nodes), before);
    assert.ok(pos(nodes[1]).y > pos(nodes[0]).y);
    assert.ok(pos(nodes[3]).x > pos(nodes[0]).x + pos(nodes[0]).width);
    assert.equal(report.regions.length, 1);
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
    assert.equal(pos(timer).x, pos(close).x);
    assert.ok(pos(write).x > pos(gate).x);
    assert.ok(pos(mark).x > pos(verify).x);
    assert.ok(pos(owned).x > pos(mark).x);
    assert.deepEqual(findNodeOverlaps(nodes, 40), []);
    assert.deepEqual(business(nodes), before);
});

test('长动作列旁能填入多个短流程，孤立卡片不会堆成一条长列', async () => {
    const actions = Array.from({ length: 10 }, (_, i) => node(`action${i}`, 'deviceOutput'));
    const nodes = [node('scene', 'onLoad', actions.map(n => `${n.id}.input`)), ...actions];
    for (let i = 0; i < 4; i++) nodes.push(node(`trigger${i}`, 'onLoad', [`delay${i}.input`]), node(`delay${i}`));
    for (let i = 0; i < 12; i++) nodes.push(node(`unused${i}`, 'deviceOutput'));
    const report = await layoutNodes(nodes);
    assert.ok(report.regions.filter(r => r.y < 2300 && r.x > 100).length > 1);
    assert.ok(Math.max(...nodes.map(n => pos(n).y + pos(n).height)) < 4000);
    assert.deepEqual(findNodeOverlaps(nodes, 40), []);
});
