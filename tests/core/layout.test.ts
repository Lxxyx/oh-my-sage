import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphNode } from '../../src/core/types/graph';
import { findNodeOverlaps, getNodeSize, layoutNodes, preserveNodePositions, type NodePosition } from '../../src/core/tools/layout';

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
    for (const type of ['deviceGet', 'varSetNumber', 'varSetString']) assert.ok(getNodeSize(node('n', type)).width >= 740);
    assert.ok(getNodeSize(node('n', 'deviceInput')).height >= 206);
    const note = node('note', 'nop');note.cfg.pos = { x: 0, y: 0, width: 1200, height: 920 };
    assert.deepEqual(getNodeSize(note), { width: 1200, height: 920 });
    assert.deepEqual(getNodeSize(note, { width: 1300, height: 950 }), { width: 1300, height: 950 });
});

test('独立流程上下分区，备注放在流程上方且不会缩为普通节点', async () => {
    const nodes = [node('overview', 'nop'), node('a', 'onLoad', ['b.input']), node('b'), node('c', 'onLoad', ['d.input']), node('d')];
    nodes[0].cfg.pos = { x: -10, y: -100, width: 1200, height: 920 };
    const report = await layoutNodes(nodes);
    assert.equal(report.regions.length, 2);
    assert.ok(pos(nodes[0]).y + 920 < report.regions[0].y);
    assert.ok(report.regions[1].y > report.regions[0].y + report.regions[0].height);
    assert.deepEqual(findNodeOverlaps(nodes), []);
});

test('显式业务分区可包含跨区连线，分区标题与内容按顺序向下展开', async () => {
    const nodes = [node('a', 'onLoad', ['b.input']), node('b', 'delay', ['c.input']), node('c'), node('heading', 'nop')];
    nodes[0].cfg = { layoutGroup: 'first', layoutOrder: 1 };
    nodes[1].cfg = { layoutGroup: 'first', layoutOrder: 1 };
    nodes[2].cfg = { layoutGroup: 'second', layoutOrder: 2 };
    nodes[3].cfg = { layoutGroup: 'first', layoutOrder: 1, pos: { width: 900, height: 180 } };
    const before = business(nodes);
    const report = await layoutNodes(nodes, { direction: 'DOWN' });
    assert.deepEqual(business(nodes), before);
    assert.ok(pos(nodes[1]).y > pos(nodes[0]).y);
    assert.ok(pos(nodes[3]).y + pos(nodes[3]).height < pos(nodes[0]).y);
    assert.equal(report.regions[0].id, 'first');
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
    assert.ok(pos(nodes[4]).y > pos(nodes[0]).y);
    assert.ok(Math.max(...nodes.map(n => pos(n).x + pos(n).width)) < 2600);
    assert.deepEqual(findNodeOverlaps(nodes, 60), []);
});
