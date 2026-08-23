/**
 * Core - 规则类型定义
 */

/** 规则节点 */
export interface GraphNode {
    id: string;
    type: string;
    cfg: Record<string, unknown>;
    props: Record<string, unknown>;
    inputs: Record<string, unknown>;
    outputs: Record<string, string[]>;
}

/** 规则配置 */
export interface GraphConfig {
    id: string;
    enable: boolean;
    uiType: string;
    userData: {
        name: string;
        lastUpdateTime: number;
        transform: {
            x: number;
            y: number;
            scale: number;
            rotate: number;
        };
    };
}

/** 规则 */
export interface Graph {
    id: string;
    nodes: GraphNode[];
    cfg: GraphConfig;
}

/** 规则摘要 */
export interface GraphSummary {
    id: string;
    name: string;
    enable: boolean;
    createTime?: number;
    updateTime?: number;
}

/** 创建规则输入 */
export interface CreateGraphInput {
    graphId?: string;
    name: string;
    nodes: GraphNode[];
    enable?: boolean;
    variables?: Array<{
        id: string;
        type: 'number' | 'string';
        value: number | string;
        name?: string;
    }>;
}

export type UpdateGraphInput = Partial<Pick<CreateGraphInput, 'name' | 'nodes' | 'enable'>>;

/** 校验错误 */
export interface ValidationError {
    nodeId: string;
    type: string;
    level: 'error' | 'warn';
    message: string;
}

/** 设备在某个节点上的使用方式 */
export interface DeviceUsageNode {
    nodeId: string;
    nodeType: string;
    /** trigger=被订阅触发, read=被读取判断, write=被写入控制 */
    role: 'trigger' | 'read' | 'write';
    /** 命中的 MIOT 定位，如 "siid=2 piid=1" */
    target: string;
}

/** 单条规则中对某设备的引用 */
export interface DeviceUsageGraph {
    graphId: string;
    name: string;
    enable: boolean;
    nodes: DeviceUsageNode[];
}

/** 单个设备的引用汇总 */
export interface DeviceUsage {
    did: string;
    name: string;
    /** 该 did 是否存在于网关设备表；false 表示设备已被删除但规则仍在引用 */
    found: boolean;
    nodeCount: number;
    graphs: DeviceUsageGraph[];
}

/** 设备引用扫描报告 */
export interface DeviceUsageReport {
    devices: DeviceUsage[];
    /** 规则引用了但网关设备表中已不存在的 did */
    orphans: Array<{ did: string; graphs: string[] }>;
    scannedGraphs: number;
    /** 读取失败的规则，其引用情况未知 */
    unreadableGraphs: string[];
}
