import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayClient } from '../../src/core/gateway/client';
import { findDeviceUsage } from '../../src/core/tools/graph';

const DEV_LIST = {
    devList: {
        lampA: { name: '客厅吸顶灯', model: 'pmfbj.light.a', modelName: '松下吸顶灯', online: true, roomName: '客厅', urn: 'urn:a' },
        sensorA: { name: '客厅人在传感器', model: 'linp.sensor.es5', modelName: '领普存在传感器', online: true, roomName: '客厅', urn: 'urn:b' },
        speakerA: { name: '主卧音箱', model: 'xiaomi.speaker', modelName: '小米音箱', online: true, roomName: '主卧', urn: 'urn:c' },
    },
};

const GRAPH_LIST = [
    { id: 'g1', enable: true, userData: { name: '客厅灯控' } },
    { id: 'g2', enable: false, userData: { name: '旧规则_BAK' } },
    { id: 'g3', enable: true, userData: { name: '主卧播报' } },
];

const GRAPHS: Record<string, { nodes: Array<Record<string, unknown>> }> = {
    g1: {
        nodes: [
            { id: 'trig', type: 'deviceInput', cfg: {}, props: { did: 'sensorA', siid: 2, piid: 1078 }, inputs: {}, outputs: {} },
            { id: 'read', type: 'deviceGet', cfg: {}, props: { did: 'lampA', siid: 2, piid: 1 }, inputs: {}, outputs: {} },
            { id: 'on', type: 'deviceOutput', cfg: {}, props: { did: 'lampA', siid: 2, piid: 1 }, inputs: {}, outputs: {} },
            { id: 'wait', type: 'delay', cfg: {}, props: { timeout: 1000 }, inputs: {}, outputs: {} },
        ],
    },
    g2: {
        nodes: [
            { id: 'ghost', type: 'deviceOutput', cfg: {}, props: { did: 'deletedCam', siid: 10, piid: 2 }, inputs: {}, outputs: {} },
        ],
    },
    g3: {
        nodes: [
            { id: 'say', type: 'deviceOutput', cfg: {}, props: { did: 'speakerA', siid: 7, aiid: 3 }, inputs: {}, outputs: {} },
        ],
    },
};

function stubGateway(overrides: { unreadable?: string[] } = {}): GatewayClient {
    return {
        callApi: async (method: string, params?: Record<string, unknown>) => {
            if (method === 'getDevList') return DEV_LIST;
            if (method === 'getGraphList') return GRAPH_LIST;
            if (method === 'getGraph') {
                const id = String(params?.id);
                if (overrides.unreadable?.includes(id)) throw new Error('timeout');
                return GRAPHS[id];
            }
            throw new Error(`unexpected method ${method}`);
        },
    } as unknown as GatewayClient;
}

test('按 did 查询命中规则、节点与角色', async () => {
    const result = await findDeviceUsage(stubGateway(), { dids: ['lampA'] });
    assert.equal(result.success, true);
    if (!result.success) return;

    const lamp = result.data!.devices.find((device) => device.did === 'lampA');
    assert.equal(lamp?.found, true);
    assert.equal(lamp?.name, '客厅吸顶灯');
    assert.equal(lamp?.nodeCount, 2);
    assert.equal(lamp?.graphs.length, 1);
    assert.equal(lamp?.graphs[0].graphId, 'g1');
    assert.equal(lamp?.graphs[0].enable, true);
    assert.deepEqual(lamp?.graphs[0].nodes, [
        { nodeId: 'read', nodeType: 'deviceGet', role: 'read', target: 'siid=2 piid=1' },
        { nodeId: 'on', nodeType: 'deviceOutput', role: 'write', target: 'siid=2 piid=1' },
    ]);
    assert.equal(result.data!.scannedGraphs, 3);
});

test('非设备节点不计入引用', async () => {
    const result = await findDeviceUsage(stubGateway(), { dids: ['lampA'] });
    assert.equal(result.success, true);
    if (!result.success) return;
    const nodeIds = result.data!.devices[0].graphs[0].nodes.map((node) => node.nodeId);
    assert.equal(nodeIds.includes('wait'), false);
});

test('deviceInput 记为 trigger，动作节点 target 含 aiid', async () => {
    const result = await findDeviceUsage(stubGateway(), { dids: ['sensorA', 'speakerA'] });
    assert.equal(result.success, true);
    if (!result.success) return;

    const sensor = result.data!.devices.find((device) => device.did === 'sensorA');
    assert.equal(sensor?.graphs[0].nodes[0].role, 'trigger');
    assert.equal(sensor?.graphs[0].nodes[0].target, 'siid=2 piid=1078');

    const speaker = result.data!.devices.find((device) => device.did === 'speakerA');
    assert.equal(speaker?.graphs[0].nodes[0].target, 'siid=7 aiid=3');
});

test('query 按名称/房间模糊匹配，不区分大小写', async () => {
    const byName = await findDeviceUsage(stubGateway(), { query: '吸顶灯' });
    assert.equal(byName.success, true);
    if (!byName.success) return;
    assert.deepEqual(byName.data!.devices.map((device) => device.did), ['lampA']);

    const byModel = await findDeviceUsage(stubGateway(), { query: 'LINP' });
    assert.equal(byModel.success, true);
    if (!byModel.success) return;
    assert.deepEqual(byModel.data!.devices.map((device) => device.did), ['sensorA']);
});

test('已删除设备的 did 仍可扫描，found=false 且能查出残留引用', async () => {
    const result = await findDeviceUsage(stubGateway(), { dids: ['deletedCam'] });
    assert.equal(result.success, true);
    if (!result.success) return;

    const ghost = result.data!.devices[0];
    assert.equal(ghost.found, false, '设备表中不存在必须标记 found=false');
    assert.equal(ghost.graphs.length, 1);
    assert.equal(ghost.graphs[0].name, '旧规则_BAK');
    assert.equal(ghost.graphs[0].enable, false);
    assert.deepEqual(result.data!.orphans, [{ did: 'deletedCam', graphs: ['旧规则_BAK'] }]);
});

test('无引用的设备返回空规则列表而不是报错', async () => {
    const gateway = {
        callApi: async (method: string) => {
            if (method === 'getDevList') return DEV_LIST;
            if (method === 'getGraphList') return [];
            throw new Error(`unexpected method ${method}`);
        },
    } as unknown as GatewayClient;

    const result = await findDeviceUsage(gateway, { dids: ['lampA'] });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data!.devices[0].graphs.length, 0);
    assert.equal(result.data!.devices[0].nodeCount, 0);
    assert.equal(result.data!.scannedGraphs, 0);
});

test('单条规则读取失败时记入 unreadableGraphs 而不中断扫描', async () => {
    const result = await findDeviceUsage(stubGateway({ unreadable: ['g1'] }), { dids: ['lampA', 'speakerA'] });
    assert.equal(result.success, true);
    if (!result.success) return;

    assert.deepEqual(result.data!.unreadableGraphs, ['g1']);
    const speaker = result.data!.devices.find((device) => device.did === 'speakerA');
    assert.equal(speaker?.graphs.length, 1, '其余规则必须照常扫描');
});

test('dids 与 query 都未提供时报错', async () => {
    const result = await findDeviceUsage(stubGateway(), {});
    assert.equal(result.success, false);
    if (result.success) return;
    assert.match(result.error, /必须提供 dids 或 query/);
});

test('query 无匹配时报错并提示改用设备列表', async () => {
    const result = await findDeviceUsage(stubGateway(), { query: '不存在的设备' });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.match(result.error, /没有匹配/);
});
