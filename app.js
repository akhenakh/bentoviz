import * as LiteGraphModule from 'https://cdn.jsdelivr.net/npm/@comfyorg/litegraph@0.17.2/dist/litegraph.es.js';

const { LiteGraph, LGraph, LGraphCanvas, LGraphNode } = LiteGraphModule;

// This intercepts specific Litegraph rendering methods to prevent 
// them from shrinking the background canvas on High-DPI screens.
// it fixes the connections to disappear if displayed on the right part of the canvas
(function applyLitegraphDPIFix() {
    const { DragAndScale } = LiteGraphModule;

    function patchMethod(prototype, methodName) {
        if (!prototype || !prototype[methodName]) return;
        const original = prototype[methodName];
        prototype[methodName] = function(...args) {
            const originalRatio = window.devicePixelRatio;
            // Force devicePixelRatio to 1 to stop Litegraph from scaling the background down
            Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
            try {
                return original.apply(this, args);
            } finally {
                // Instantly restore it so the rest of your app isn't affected
                Object.defineProperty(window, 'devicePixelRatio', { value: originalRatio, configurable: true });
            }
        };
    }

    patchMethod(LGraphCanvas.prototype, 'drawFrontCanvas');
    patchMethod(LGraphCanvas.prototype, 'drawBackCanvas');
    patchMethod(LGraphCanvas.prototype, 'centerOnNode');
    patchMethod(DragAndScale.prototype, 'fitToBounds');
    patchMethod(DragAndScale.prototype, 'animateToBounds');
})();


let graph = null;
let canvas = null;
let bentoSchema = null;
const nodeTypes = { input: {}, processor: {}, output: {} };
const nodeDescriptions = { input: {}, processor: {}, output: {} };

const COLORS = {
    input: '#238636',
    processor: '#6e40c9',
    output: '#1f6feb',
    resource: '#9e6a03'
};

class BentoInputNode extends LGraphNode {
    constructor(nodeName) {
        super(nodeName);
        this.addOutput('out', 'message');
        this.bentoType = 'input';
        this.bentoName = nodeName;
        this.color = COLORS.input;
        this.boxcolor = COLORS.input;
    }
    
    onExecute() {}
}

class BentoProcessorNode extends LGraphNode {
    constructor(nodeName) {
        super(nodeName);
        this.addInput('in', 'message');
        this.addOutput('out', 'message');
        this.bentoType = 'processor';
        this.bentoName = nodeName;
        this.color = COLORS.processor;
        this.boxcolor = COLORS.processor;
        this.addWidget('text', 'label', '', 'label');
    }
    
    onExecute() {}
}

class BranchNode extends BentoProcessorNode {
    constructor() {
        super('branch');
        this.title = 'Branch';
        this.bentoName = 'branch';
        this.addOutput('processors', 'message');
        this.processorsAnchor = true;
        this.addWidget('text', 'request_map', '', 'request_map', { multiline: true });
        this.addWidget('text', 'result_map', '', 'result_map', { multiline: true });
    }
}

class RetryNode extends BentoProcessorNode {
    constructor() {
        super('retry');
        this.title = 'Retry';
        this.bentoName = 'retry';
        this.addOutput('processors', 'message');
        this.processorsAnchor = true;
        this.addWidget('number', 'max_retries', 0, 'max_retries', { step: 1 });
        this.addWidget('toggle', 'parallel', false, 'parallel');
    }
}

class GroupByNode extends BentoProcessorNode {
    constructor() {
        super('group_by');
        this.title = 'Group By';
        this.bentoName = 'group_by';
        this.switchNode = true;
        this.cases = [];
        const self = this;
        this.addWidget('button', '+ Add Group', null, function() {
            self.addGroup();
        });
    }
    
    addGroup(check = '') {
        const groupIndex = this.cases.length;
        this.cases.push({ check });
        const outputName = `group_${groupIndex}`;
        this.addOutput(outputName, 'message');
        this.addWidget('text', `check_${groupIndex}`, check, `check_${groupIndex}`, { multiline: true });
        this.size = this.computeSize();
        this.setDirtyCanvas(true, true);
    }
    
    onSerialize(o) {
        o.cases = this.cases.map((c, i) => ({ check: this.getWidgetValue(`check_${i}`) || c.check }));
    }
    
    onConfigure(o) {
        if (o.cases && o.cases.length > 0) {
            this.cases = [];
            o.cases.forEach(c => this.addGroup(c.check));
        }
    }
}

class SwitchNode extends BentoProcessorNode {
    constructor() {
        super('switch');
        this.title = 'Switch';
        this.bentoName = 'switch';
        this.switchNode = true;
        this.cases = [];
        console.log('SwitchNode constructor called');
        const self = this;
        this.addWidget('button', '+ Add Case', null, function() {
            self.addCase();
        });
    }
    
    addCase(check = '') {
        const caseIndex = this.cases.length;
        this.cases.push({ check });
        const outputName = `case_${caseIndex}`;
        this.addOutput(outputName, 'message');
        this.addWidget('text', `check_${caseIndex}`, check, `check_${caseIndex}`, { multiline: true });
        this.size = this.computeSize();
        this.setDirtyCanvas(true, true);
    }
    
    onSerialize(o) {
        o.cases = this.cases.map((c, i) => ({ check: this.getWidgetValue(`check_${i}`) || c.check }));
    }
    
    onConfigure(o) {
        if (o.cases && o.cases.length > 0) {
            this.cases = [];
            o.cases.forEach(c => this.addCase(c.check));
        }
    }
}

class BentoOutputNode extends LGraphNode {
    constructor(nodeName) {
        super(nodeName);
        this.addInput('in', 'message');
        this.bentoType = 'output';
        this.bentoName = nodeName;
        this.color = COLORS.output;
        this.boxcolor = COLORS.output;
    }
    
    onExecute() {}
}

function extractProperties(schemaObj) {
    if (!schemaObj || !schemaObj.properties) return [];
    
    const props = [];
    for (const [name, def] of Object.entries(schemaObj.properties)) {
        props.push({
            name,
            type: def.type || 'string',
            description: def.description || '',
            default: def.default,
            examples: def.examples,
            enum: def.enum
        });
    }
    return props;
}

function createWidgetForProperty(node, prop) {
    const name = prop.name;
    const tooltip = prop.description ? prop.description.substring(0, 200) + (prop.description.length > 200 ? '...' : '') : '';
    
    if (prop.enum) {
        const widget = node.addWidget('combo', name, prop.default || prop.enum[0], name, { values: prop.enum });
        if (tooltip) widget.tooltip = tooltip;
    } else if (prop.type === 'boolean') {
        const widget = node.addWidget('toggle', name, prop.default || false, name);
        if (tooltip) widget.tooltip = tooltip;
    } else if (prop.type === 'integer') {
        const widget = node.addWidget('number', name, prop.default || 0, name, { step: 1 });
        if (tooltip) widget.tooltip = tooltip;
    } else if (prop.type === 'number') {
        const widget = node.addWidget('number', name, prop.default || 0, name, { step: 0.01 });
        if (tooltip) widget.tooltip = tooltip;
    } else if (prop.type === 'array' || prop.type === 'object') {
        const widget = node.addWidget('text', name, prop.default ? JSON.stringify(prop.default) : '', name);
        if (tooltip) widget.tooltip = tooltip;
    } else {
        // Check if this is a mapping/bloblang field (multiline Bloblang code)
        if (name === 'mapping' || name === 'bloblang' || name === 'query' || name === 'sql') {
            const widget = node.addWidget('text', name, prop.default || '', name);
            widget.options = { multiline: true };
            if (tooltip) widget.tooltip = tooltip;
        } else {
            const widget = node.addWidget('text', name, prop.default || '', name);
            if (tooltip) widget.tooltip = tooltip;
        }
    }
}

function registerInputNodes() {
    const inputSchema = bentoSchema?.properties?.input?.properties;
    if (!inputSchema) {
        console.log('No input schema found, using fallback nodes');
        registerFallbackInputNodes();
        return;
    }
    
    console.log('Found', Object.keys(inputSchema).length, 'input types');
    
    for (const [inputName, inputDef] of Object.entries(inputSchema)) {
        if (inputDef.type !== 'object') continue;
        
        const nodeType = `bento/input/${inputName}`;
        const nodeTitle = inputName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const description = inputDef.description || '';
        
        class InputNode extends BentoInputNode {
            constructor() {
                super(inputName);
                this.title = nodeTitle;
                this.description = description;
                
                const props = extractProperties(inputDef);
                for (const prop of props) {
                    createWidgetForProperty(this, prop);
                }
            }
        }
        
        InputNode.title = nodeTitle;
        LiteGraph.registerNodeType(nodeType, InputNode);
        nodeTypes.input[inputName] = { title: nodeTitle, type: nodeType };
        nodeDescriptions.input[inputName] = description;
    }
}

function registerFallbackInputNodes() {
    class InputStdin extends BentoInputNode {
        constructor() {
            super('stdin');
            this.title = 'Stdin';
            this.addWidget('text', 'codec', 'lines', 'codec');
        }
    }
    LiteGraph.registerNodeType('bento/input/stdin', InputStdin);
    nodeTypes.input['stdin'] = { title: 'Stdin', type: 'bento/input/stdin' };
    
    class InputHTTPServer extends BentoInputNode {
        constructor() {
            super('http_server');
            this.title = 'HTTP Server';
            this.addWidget('text', 'address', '0.0.0.0:4195', 'address');
            this.addWidget('text', 'path', '/post', 'path');
        }
    }
    LiteGraph.registerNodeType('bento/input/http_server', InputHTTPServer);
    nodeTypes.input['http_server'] = { title: 'HTTP Server', type: 'bento/input/http_server' };
}

function registerProcessorNodes() {
    const processorsSchema = bentoSchema?.properties?.pipeline?.properties?.processors?.items?.properties;
    
    if (!processorsSchema) {
        console.log('No processors schema found, using fallback nodes');
        registerFallbackProcessorNodes();
        return;
    }
    
    console.log('Found', Object.keys(processorsSchema).length, 'processor types');
    console.log('Has switch?', 'switch' in processorsSchema);
    console.log('Switch type:', processorsSchema?.switch?.type);
    
    for (const [procName, procDef] of Object.entries(processorsSchema)) {
        // Handle special processors first, before type filtering
        if (procName === 'branch') {
            LiteGraph.registerNodeType('bento/processor/branch', BranchNode);
            nodeTypes.processor['branch'] = { title: 'Branch', type: 'bento/processor/branch' };
            nodeDescriptions.processor['branch'] = procDef.description || '';
            continue;
        }
        
        if (procName === 'retry') {
            LiteGraph.registerNodeType('bento/processor/retry', RetryNode);
            nodeTypes.processor['retry'] = { title: 'Retry', type: 'bento/processor/retry' };
            nodeDescriptions.processor['retry'] = procDef.description || '';
            continue;
        }
        
        if (procName === 'group_by') {
            LiteGraph.registerNodeType('bento/processor/group_by', GroupByNode);
            nodeTypes.processor['group_by'] = { title: 'Group By', type: 'bento/processor/group_by' };
            nodeDescriptions.processor['group_by'] = procDef.description || '';
            continue;
        }
        
        if (procName === 'switch') {
            console.log('Registering custom SwitchNode for switch processor');
            LiteGraph.registerNodeType('bento/processor/switch', SwitchNode);
            nodeTypes.processor['switch'] = { title: 'Switch', type: 'bento/processor/switch' };
            nodeDescriptions.processor['switch'] = procDef.description || '';
            continue;
        }
        
        if (procDef.type === 'object' && !procDef.properties) continue;
        if (procDef.type !== 'object' && procDef.type !== 'string') continue;
        
        const nodeType = `bento/processor/${procName}`;
        const nodeTitle = procName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const description = procDef.description || '';
        
        class ProcessorNode extends BentoProcessorNode {
            constructor() {
                super(procName);
                this.title = nodeTitle;
                this.description = description;
                
                if (procDef.type === 'string') {
                    // String-type processors like 'mapping' and 'bloblang'
                    // Use 'text' widget - when clicked, it opens a multiline dialog
                    const w = this.addWidget('text', procName, '', procName);
                    w.options = { multiline: true };
                } else if (procDef.properties) {
                    const props = extractProperties(procDef);
                    for (const prop of props) {
                        createWidgetForProperty(this, prop);
                    }
                }
            }
        }
        
        ProcessorNode.title = nodeTitle;
        LiteGraph.registerNodeType(nodeType, ProcessorNode);
        nodeTypes.processor[procName] = { title: nodeTitle, type: nodeType };
        nodeDescriptions.processor[procName] = description;
    }
}

function registerFallbackProcessorNodes() {
    class ProcMapping extends BentoProcessorNode {
        constructor() {
            super('mapping');
            this.title = 'Mapping';
            const w = this.addWidget('text', 'mapping', 'root = this', 'mapping');
            w.options = { multiline: true };
        }
    }
    LiteGraph.registerNodeType('bento/processor/mapping', ProcMapping);
    nodeTypes.processor['mapping'] = { title: 'Mapping', type: 'bento/processor/mapping' };
    
    class ProcSleep extends BentoProcessorNode {
        constructor() {
            super('sleep');
            this.title = 'Sleep';
            this.addWidget('text', 'duration', '1s', 'duration');
        }
    }
    LiteGraph.registerNodeType('bento/processor/sleep', ProcSleep);
    nodeTypes.processor['sleep'] = { title: 'Sleep', type: 'bento/processor/sleep' };
}

function registerOutputNodes() {
    const outputSchema = bentoSchema?.properties?.output?.properties;
    if (!outputSchema) {
        console.log('No output schema found, using fallback nodes');
        registerFallbackOutputNodes();
        return;
    }
    
    console.log('Found', Object.keys(outputSchema).length, 'output types');
    
    for (const [outputName, outputDef] of Object.entries(outputSchema)) {
        if (outputDef.type !== 'object') continue;
        
        const nodeType = `bento/output/${outputName}`;
        const nodeTitle = outputName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const description = outputDef.description || '';
        
        class OutputNode extends BentoOutputNode {
            constructor() {
                super(outputName);
                this.title = nodeTitle;
                this.description = description;
                
                const props = extractProperties(outputDef);
                for (const prop of props) {
                    createWidgetForProperty(this, prop);
                }
            }
        }
        
OutputNode.title = nodeTitle;
        LiteGraph.registerNodeType(nodeType, OutputNode);
        nodeTypes.output[outputName] = { title: nodeTitle, type: nodeType };
        nodeDescriptions.output[outputName] = description;
    }
}

function registerFallbackOutputNodes() {
    class OutputStdout extends BentoOutputNode {
        constructor() {
            super('stdout');
            this.title = 'Stdout';
            this.addWidget('text', 'codec', 'lines', 'codec');
        }
    }
    LiteGraph.registerNodeType('bento/output/stdout', OutputStdout);
    nodeTypes.output['stdout'] = { title: 'Stdout', type: 'bento/output/stdout' };
    
    class OutputHTTPClient extends BentoOutputNode {
        constructor() {
            super('http_client');
            this.title = 'HTTP Client';
            this.addWidget('text', 'url', 'http://localhost:8080/post', 'url');
            this.addWidget('text', 'verb', 'POST', 'verb');
            this.addWidget('text', 'timeout', '5s', 'timeout');
        }
    }
    LiteGraph.registerNodeType('bento/output/http_client', OutputHTTPClient);
    nodeTypes.output['http_client'] = { title: 'HTTP Client', type: 'bento/output/http_client' };
}

function registerNodes() {
    if (!bentoSchema) {
        console.log('No schema loaded, using fallback nodes');
        registerFallbackInputNodes();
        registerFallbackProcessorNodes();
        registerFallbackOutputNodes();
        return;
    }
    
    registerInputNodes();
    registerProcessorNodes();
    registerOutputNodes();
}

function createNodePalette() {
    const palette = document.getElementById('nodePalette');
    const searchTerm = document.getElementById('nodeSearch').value.toLowerCase();
    palette.innerHTML = '';
    
    const categories = [
        { name: 'Inputs', nodes: nodeTypes.input, className: 'input', descriptions: nodeDescriptions.input },
        { name: 'Processors', nodes: nodeTypes.processor, className: 'processor', descriptions: nodeDescriptions.processor },
        { name: 'Outputs', nodes: nodeTypes.output, className: 'output', descriptions: nodeDescriptions.output }
    ];
    
    for (const category of categories) {
        const filteredNodes = Object.entries(category.nodes)
            .filter(([name, def]) => 
                name.toLowerCase().includes(searchTerm) || 
                def.title.toLowerCase().includes(searchTerm)
            );
        
        if (filteredNodes.length === 0) continue;
        
        const categoryEl = document.createElement('div');
        categoryEl.className = 'node-category';
        
        const categoryName = document.createElement('div');
        categoryName.className = 'node-category-name';
        categoryName.textContent = category.name;
        categoryEl.appendChild(categoryName);
        
        for (const [name, def] of filteredNodes) {
            const nodeEl = document.createElement('div');
            nodeEl.className = `node-item ${category.className}`;
            nodeEl.textContent = def.title;
            nodeEl.draggable = true;
            nodeEl.dataset.nodeType = def.type;
            
            // Add description as tooltip
            const desc = category.descriptions[name];
            if (desc) {
                nodeEl.dataset.tooltip = desc.substring(0, 500) + (desc.length > 500 ? '...' : '');
            }
            
            nodeEl.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('node-type', def.type);
            });
            
            nodeEl.addEventListener('dblclick', () => {
                const node = LiteGraph.createNode(def.type);
                if (node) {
                    node.pos = [100 + Math.random() * 200, 100 + Math.random() * 200];
                    graph.add(node);
                    console.log('Created node:', def.type);
                }
            });
            
            // Add hover tooltip
            nodeEl.addEventListener('mouseenter', showTooltip);
            nodeEl.addEventListener('mouseleave', hideTooltip);
            
            categoryEl.appendChild(nodeEl);
        }
        
        palette.appendChild(categoryEl);
    }
    
    if (palette.children.length === 0) {
        palette.innerHTML = '<p class="empty-state">No matching nodes found</p>';
    }
}

function initGraph() {
    graph = new LGraph();
    
    const canvasEl = document.querySelector('#graph-canvas');
    const container = document.querySelector('#canvas-container');
    
    if (!canvasEl) {
        console.error('Canvas element not found');
        return;
    }
    
    canvas = new LGraphCanvas(canvasEl, graph);
    
    canvas.background_image = null;
    canvas.clear_background_color = '#0d1117';
    canvas.default_connection_color = '#58a6ff';
    canvas.default_link_color = '#58a6ff';
    canvas.highquality_render = true;
    canvas.render_shadows = false;
    canvas.render_curved_connections = true;
    canvas.render_title_on_connections = false;
    
    LiteGraph.NODE_DEFAULT_COLOR = '#21262d';
    LiteGraph.NODE_DEFAULT_BGCOLOR = '#161b22';
    LiteGraph.NODE_SELECTED_TITLE_COLOR = '#58a6ff';
    LiteGraph.WIDGET_BGCOLOR = '#21262d';
    LiteGraph.WIDGET_FGCOLOR = '#e6edf3';
    LiteGraph.WIDGET_SECONDARY_FGCOLOR = '#8b949e';
    LiteGraph.NODE_DEFAULT_SHAPE = 'round';
    LiteGraph.NODE_TEXT_COLOR = '#e6edf3';
    LiteGraph.NODE_SUBTEXT_SIZE = 12;
    LiteGraph.NODE_TEXT_SIZE = 14;
    LiteGraph.NODE_TITLE_HEIGHT = 20;
    
    canvas.autoresize = true;
    canvas.resize();
    
    const resizeObserver = new ResizeObserver(() => {
        canvas.resize();
    });
    resizeObserver.observe(container);
    
    window.addEventListener('resize', () => {
        canvas.resize();
    });
}

function extractNodeConfig(node) {
    const config = {};
    let labelValue = '';
    
    if (node.widgets) {
        for (const widget of node.widgets) {
            let value = widget.value;
            if (typeof value === 'string') {
                if (value.trim() === '') continue;
                try {
                    const parsed = JSON.parse(value);
                    value = parsed;
                } catch {
                    // Keep as string
                }
            }
            if (widget.name === 'label') {
                labelValue = value;
            } else {
                config[widget.name] = value;
            }
        }
    }
    
    // For string-type processors (mapping, bloblang), wrap in object to include label
    if (node.bentoType === 'processor' && node.widgets && node.widgets.length <= 2) {
        const nonLabelWidgets = node.widgets.filter(w => w.name !== 'label');
        if (nonLabelWidgets.length === 1 && nonLabelWidgets[0].name === node.bentoName) {
            let value = nonLabelWidgets[0].value;
            if (typeof value === 'string' && value.trim() !== '') {
                if (labelValue) {
                    return { label: labelValue, [node.bentoName]: value };
                }
                return value;
            }
        }
    }
    
    // Add label if present
    if (labelValue) {
        config.label = labelValue;
    }
    
    return config;
}

function collectBranchProcessors(branchNode) {
    const processors = [];
    const processorsOutput = branchNode.outputs && branchNode.outputs.find(o => o.name === 'processors');
    if (!processorsOutput) return processors;
    
    const outputSlotIndex = branchNode.outputs.indexOf(processorsOutput);
    if (outputSlotIndex === -1) return processors;
    
    if (branchNode.outputs && branchNode.outputs[outputSlotIndex] && branchNode.outputs[outputSlotIndex].links && branchNode.outputs[outputSlotIndex].links.length > 0) {
        const firstLinkId = branchNode.outputs[outputSlotIndex].links[0];
        const link = graph.links[firstLinkId];
        if (link) {
            const targetNode = graph.getNodeById(link.target_id);
            if (targetNode && targetNode.bentoType === 'processor') {
                return followProcessorChain(targetNode);
            }
        }
    }
    
    return processors;
}

function collectSwitchCases(switchNode) {
    const cases = [];
    if (!switchNode.outputs) return cases;
    
    for (let i = 0; i < switchNode.outputs.length; i++) {
        const output = switchNode.outputs[i];
        if (!output.name.startsWith('case_')) continue;
        
        const caseIndex = parseInt(output.name.split('_')[1]);
        const checkWidget = switchNode.widgets && switchNode.widgets.find(w => w.name === `check_${caseIndex}`);
        const check = checkWidget ? checkWidget.value : '';
        
        const caseData = { check };
        
        if (output.links && output.links.length > 0) {
            const linkId = output.links[0];
            const link = graph.links[linkId];
            if (link) {
                const targetNode = graph.getNodeById(link.target_id);
                if (targetNode && targetNode.bentoType === 'processor') {
                    caseData.processors = followProcessorChain(targetNode);
                }
            }
        }
        
        cases.push(caseData);
    }
    
    return cases;
}

function followProcessorChain(startNode) {
    const processors = [];
    const visited = new Set();
    let current = startNode;
    
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        
        const procConfig = {};
        if (current.processorsAnchor) {
            const config = extractNodeConfig(current);
            const branchProcessors = collectBranchProcessors(current);
            if (branchProcessors.length > 0) {
                config.processors = branchProcessors;
            }
            procConfig[current.bentoName] = config;
        } else if (current.switchNode) {
            const cases = collectSwitchCases(current);
            procConfig[current.bentoName] = cases.length > 0 ? cases : [];
        } else {
            procConfig[current.bentoName] = extractNodeConfig(current);
        }
        processors.push(procConfig);
        
        if (current.outputs && current.outputs[0] && current.outputs[0].links && current.outputs[0].links.length > 0) {
            const linkId = current.outputs[0].links[0];
            const link = graph.links[linkId];
            if (link) {
                const nextNode = graph.getNodeById(link.target_id);
                if (nextNode && nextNode.bentoType === 'processor') {
                    current = nextNode;
                    continue;
                }
            }
        }
        break;
    }
    
    return processors;
}

function compileGraph() {
    const allNodes = graph._nodes || [];
    const inputNodes = allNodes.filter(n => n.bentoType === 'input');
    const outputNodes = allNodes.filter(n => n.bentoType === 'output');
    
    if (inputNodes.length === 0) {
        showToast('No input node found! Add an input node to the graph.', 'error');
        return null;
    }
    
    const config = {
        input: {},
        pipeline: { processors: [] },
        output: {}
    };
    
    const inputNode = inputNodes[0];
    config.input[inputNode.bentoName] = extractNodeConfig(inputNode);
    
    const visited = new Set();
    let current = inputNode;
    
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        
        if (current.outputs && current.outputs[0] && current.outputs[0].links) {
            for (const linkId of current.outputs[0].links) {
                const link = graph.links[linkId];
                if (!link) continue;
                
                const nextNode = graph.getNodeById(link.target_id);
                if (!nextNode) continue;
                
                if (nextNode.bentoType === 'processor') {
                    if (nextNode.processorsAnchor) {
                        const branchConfig = extractNodeConfig(nextNode);
                        const branchProcessors = collectBranchProcessors(nextNode);
                        if (branchProcessors.length > 0) {
                            branchConfig.processors = branchProcessors;
                        }
                        config.pipeline.processors.push({ [nextNode.bentoName]: branchConfig });
                    } else if (nextNode.switchNode) {
                        const cases = collectSwitchCases(nextNode);
                        config.pipeline.processors.push({ [nextNode.bentoName]: cases });
                    } else {
                        config.pipeline.processors.push({ [nextNode.bentoName]: extractNodeConfig(nextNode) });
                    }
                    current = nextNode;
                    break;
                } else if (nextNode.bentoType === 'output') {
                    config.output[nextNode.bentoName] = extractNodeConfig(nextNode);
                    current = null;
                    break;
                }
            }
        } else {
            break;
        }
    }
    
    return config;
}

function toYAML(obj, indent = 0) {
    const spaces = '  '.repeat(indent);
    
    if (obj === null || obj === undefined) {
        return 'null';
    }
    
    if (typeof obj === 'string') {
        if (obj.includes('\n')) {
            const lines = obj.split('\n');
            return '|\n' + lines.map(l => spaces + '  ' + l).join('\n');
        }
        if (obj.includes(':') || obj.includes('#') || obj.includes("'") || obj.includes('"') || obj.includes('[') || obj.includes(']') || obj.includes('{') || obj.includes('}') || obj === '') {
            const escaped = obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `"${escaped}"`;
        }
        return obj;
    }
    
    if (typeof obj === 'number' || typeof obj === 'boolean') {
        return String(obj);
    }
    
    if (Array.isArray(obj)) {
        if (obj.length === 0) return '[]';
        return obj.map(item => {
            const val = toYAML(item, indent + 1);
            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                const lines = val.split('\n');
                return '- ' + lines[0] + '\n' + lines.slice(1).map(l => spaces + '  ' + l).join('\n');
            }
            return '- ' + val;
        }).join('\n');
    }
    
    if (typeof obj === 'object') {
        const entries = Object.entries(obj).filter(([k, v]) => {
            // Skip empty objects and empty arrays
            if (typeof v === 'object' && v !== null) {
                if (Array.isArray(v) && v.length === 0) return false;
                if (!Array.isArray(v) && Object.keys(v).length === 0) return false;
            }
            return true;
        });
        if (entries.length === 0) return '';
        
        return entries.map(([key, value]) => {
            const val = toYAML(value, indent + 1);
            
            if (typeof value === 'object' && value !== null) {
                if (Object.keys(value).length === 0 || (Array.isArray(value) && value.length === 0)) {
                    return `${key}: ${val}`;
                }
                const lines = val.split('\n');
                if (lines.length === 1) {
                    return `${key}: ${val}`;
                }
                return `${key}:\n${lines.map(l => spaces + '  ' + l).join('\n')}`;
            }
            
            return `${key}: ${val}`;
        }).join('\n');
    }
    
    return String(obj);
}

function previewConfig() {
    const config = compileGraph();
    if (!config) return;
    
    const preview = document.getElementById('config-preview');
    const yaml = toYAML(config);
    preview.innerHTML = `<code>${escapeHtml(yaml)}</code>`;
    showToast('Configuration compiled', 'success');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function copyConfig() {
    const config = compileGraph();
    if (!config) return;
    
    const yaml = toYAML(config);
    navigator.clipboard.writeText(yaml)
        .then(() => showToast('Configuration copied to clipboard', 'success'))
        .catch(() => showToast('Failed to copy to clipboard', 'error'));
}

function getApiUrl() {
    return window.location.origin;
}

async function deployStream() {
    const config = compileGraph();
    if (!config) return;
    
    const streamId = document.getElementById('streamId').value.trim();
    
    if (!streamId) {
        showToast('Please enter a Stream ID', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${getApiUrl()}/streams/${streamId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        
        if (response.ok) {
            showToast(`Stream '${streamId}' deployed successfully!`, 'success');
            refreshStreams();
        } else {
            const errorData = await response.json();
            showApiError('Failed to deploy stream', errorData);
        }
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function stopStream() {
    const streamId = document.getElementById('streamId').value.trim();
    
    if (!streamId) {
        showToast('Please enter a Stream ID', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${getApiUrl()}/streams/${streamId}`, { method: 'DELETE' });
        
        if (response.ok) {
            showToast(`Stream '${streamId}' stopped`, 'success');
            refreshStreams();
        } else {
            showToast(`Failed to stop stream '${streamId}'`, 'error');
        }
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function refreshStreams() {
    const streamsList = document.getElementById('streamsList');
    
    try {
        const response = await fetch(`${getApiUrl()}/streams`);
        
        if (response.ok) {
            const streams = await response.json();
            renderStreamsList(streams);
        } else {
            const errorData = await response.json();
            showApiError('Failed to refresh streams', errorData);
            streamsList.innerHTML = '<p class="empty-state">Unable to fetch streams</p>';
        }
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        streamsList.innerHTML = '<p class="empty-state">API unavailable</p>';
    }
}

function renderStreamsList(streams) {
    const streamsList = document.getElementById('streamsList');
    
    if (!streams || Object.keys(streams).length === 0) {
        streamsList.innerHTML = '<p class="empty-state">No active streams</p>';
        return;
    }
    
    streamsList.innerHTML = '';
    
    for (const [id, info] of Object.entries(streams)) {
        const item = document.createElement('div');
        item.className = 'stream-item';
        item.innerHTML = `
            <div>
                <div class="stream-name">${escapeHtml(id)}</div>
                <div class="stream-status ${info.active ? 'running' : 'stopped'}">
                    ${info.active ? 'Running' : 'Stopped'}
                </div>
            </div>
            <div class="stream-actions">
                <button data-stream="${escapeHtml(id)}" data-action="select" title="Edit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                </button>
                <button data-stream="${escapeHtml(id)}" data-action="delete" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `;
        streamsList.appendChild(item);
    }
}

function selectStream(streamId) {
    document.getElementById('streamId').value = streamId;
}

async function deleteStreamById(streamId) {
    try {
        const response = await fetch(`${getApiUrl()}/streams/${streamId}`, { method: 'DELETE' });
        
        if (response.ok) {
            showToast(`Stream '${streamId}' deleted`, 'success');
            refreshStreams();
        } else {
            showToast(`Failed to delete stream '${streamId}'`, 'error');
        }
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.remove();
    }, 4000);
}

function showApiError(title, error) {
    const message = error.message || JSON.stringify(error, null, 2);
    showToast(`${title}: ${message.substring(0, 100)}`, 'error');
    console.error('API Error:', error);
}

function showModal(title, body, buttons) {
    const modal = document.getElementById('modal');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = body;
    
    const footer = document.getElementById('modal-footer');
    footer.innerHTML = '';
    
    for (const btn of buttons || []) {
        const button = document.createElement('button');
        button.className = `btn ${btn.class || 'btn-secondary'}`;
        button.textContent = btn.text;
        button.onclick = btn.onClick;
        footer.appendChild(button);
    }
    
    modal.classList.add('active');
}

function closeModal() {
    document.getElementById('modal').classList.remove('active');
}


function setupEventListeners() {
    document.getElementById('nodeSearch').addEventListener('input', createNodePalette);
    
    document.getElementById('btnPreview').addEventListener('click', () => {
        previewConfig();
        const panel = document.getElementById('config-panel');
        panel.classList.remove('collapsed');
    });
    document.getElementById('btnShowConfig').addEventListener('click', () => {
        const panel = document.getElementById('config-panel');
        panel.classList.toggle('collapsed');
        canvas.resize();
    });
    document.getElementById('btnHideConfig').addEventListener('click', () => {
        const panel = document.getElementById('config-panel');
        panel.classList.add('collapsed');
        canvas.resize();
    });
    document.getElementById('btnDeploy').addEventListener('click', deployStream);
    document.getElementById('btnStop').addEventListener('click', stopStream);
    document.getElementById('btnRefresh').addEventListener('click', refreshStreams);
    document.getElementById('btnCopy').addEventListener('click', copyConfig);
    document.getElementById('btnCloseModal').addEventListener('click', closeModal);
    
    // --- Advanced Modal Event Listeners ---
    document.getElementById('btnSaveMapping').addEventListener('click', () => {
        if (advancedEditorCallback) {
            advancedEditorCallback(aceMappingEditor.getValue());
            if (graph) graph.setDirtyCanvas(true, true);
        }
        document.getElementById('advanced-editor-modal').classList.remove('active');
    });
    
    document.getElementById('btnCloseAdvancedEditor').addEventListener('click', () => {
        document.getElementById('advanced-editor-modal').classList.remove('active');
    });
    // ----------------------------------------
    
    document.getElementById('streamsList').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        
        const streamId = btn.dataset.stream;
        const action = btn.dataset.action;
        
        if (action === 'select') {
            selectStream(streamId);
        } else if (action === 'delete') {
            deleteStreamById(streamId);
        }
    });
    
    document.getElementById('canvas-container').addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    
    document.getElementById('canvas-container').addEventListener('drop', (e) => {
        e.preventDefault();
        const nodeType = e.dataTransfer.getData('node-type');
        if (nodeType) {
            const node = LiteGraph.createNode(nodeType);
            if (node) {
                node.pos = canvas.convertEventToCanvasOffset(e);
                graph.add(node);
            }
        }
    });
}

let tooltipEl = null;

function showTooltip(e) {
    const text = e.target.dataset.tooltip;
    if (!text) return;
    
    if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'tooltip';
        document.body.appendChild(tooltipEl);
    }
    
    tooltipEl.textContent = text;
    tooltipEl.classList.add('visible');
    
    const rect = e.target.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    
    let left = rect.right + 10;
    let top = rect.top;
    
    // Adjust if overflowing right edge
    if (left + tooltipRect.width > window.innerWidth - 10) {
        left = rect.left - tooltipRect.width - 10;
    }
    
    // Adjust if overflowing bottom edge
    if (top + tooltipRect.height > window.innerHeight - 10) {
        top = window.innerHeight - tooltipRect.height - 10;
    }
    
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
}

function hideTooltip() {
    if (tooltipEl) {
        tooltipEl.classList.remove('visible');
    }
}

async function loadSchema() {
    try {
        const response = await fetch('schema.json');
        bentoSchema = await response.json();
    } catch (error) {
        console.warn('Failed to load schema, using fallback nodes:', error);
        showToast('Could not load schema.json - using minimal nodes', 'warning');
    }
}

async function init() {
    try {
        await loadSchema();
        console.log('Schema loaded:', bentoSchema ? 'yes' : 'no');
    } catch (err) {
        console.error('Failed to load schema:', err);
    }

    await loadBloblangSyntax();
    
    initGraph();registerNodes();
    console.log('Nodes registered:', nodeTypes);
    createNodePalette();
    refreshStreams();
    setupEventListeners();
    console.log('App initialized');
}

document.addEventListener('DOMContentLoaded', init);

/* --- Advanced Bloblang Playground Integration --- */

let BLOBLANG_SYNTAX = { keywords: [], functions: {}, methods: {} };

async function loadBloblangSyntax() {
    try {
        const response = await fetch('/syntax');
        if (response.ok) {
            BLOBLANG_SYNTAX = await response.json();
            console.log(`Loaded ${Object.keys(BLOBLANG_SYNTAX.functions).length} functions and ${Object.keys(BLOBLANG_SYNTAX.methods).length} methods dynamically.`);
        }
    } catch (error) {
        console.warn('Failed to load dynamic bloblang syntax from server:', error);
    }
}

function createDocumentationHTML(spec, isMethod) {
    const signature = `${isMethod ? "." : ""}${spec.name}()`;
    
    // Process Benthos markdown descriptions into HTML
    let desc = spec.description || "No description available.";
    desc = desc.replace(/```([a-z]*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    desc = desc.replace(/`([^`]+)`/g, '<code>$1</code>');
    desc = desc.replace(/:::([a-zA-Z]+)\n([\s\S]*?):::/g, '<div style="margin: 8px 0; padding: 8px; border-left: 3px solid var(--accent-blue); background: var(--bg-primary);">$2</div>');

    return `
    <div class="ace-doc">
      <div class="ace-doc-signature">${signature}</div>
      <div class="ace-doc-description">${desc}</div>
    </div>`;
}

const bloblangCompleter = {
    getCompletions: function(editor, session, pos, prefix, callback) {
        const line = session.getLine(pos.row);
        const beforeCursor = line.substring(0, pos.column).trim();
        const isMethod = /\.\w*$/.test(beforeCursor);
        let completions = [];

        if (isMethod) {
            Object.values(BLOBLANG_SYNTAX.methods || {}).forEach(spec => {
                completions.push({
                    caption: spec.name,
                    value: `${spec.name}()`,
                    meta: "method",
                    score: 1000,
                    docHTML: createDocumentationHTML(spec, true)
                });
            });
        } else {
            Object.values(BLOBLANG_SYNTAX.functions || {}).forEach(spec => {
                completions.push({
                    caption: spec.name,
                    value: `${spec.name}()`,
                    meta: "function",
                    score: 900,
                    docHTML: createDocumentationHTML(spec, false)
                });
            });
            (BLOBLANG_SYNTAX.keywords || []).forEach(kw => {
                if (kw.name.startsWith(prefix.toLowerCase())) {
                    completions.push({
                        caption: kw.name,
                        value: kw.name,
                        meta: "keyword",
                        score: 800,
                        docHTML: createDocumentationHTML(kw, false)
                    });
                }
            });
        }
        callback(null, completions);
    }
};

let advancedEditorCallback = null;
let aceMappingEditor = null;
let aceInputEditor = null;

function initAdvancedEditor() {
    if (aceMappingEditor) return;
    
    ace.require("ace/ext/language_tools");
    
    aceInputEditor = ace.edit("ace-input");
    aceInputEditor.session.setMode("ace/mode/json");
    aceInputEditor.setTheme("ace/theme/tomorrow_night_eighties");
    aceInputEditor.setValue('{\n  "message": "hello world"\n}', -1);
    
    aceMappingEditor = ace.edit("ace-mapping");
    aceMappingEditor.session.setMode("ace/mode/coffee"); 
    aceMappingEditor.setTheme("ace/theme/tomorrow_night_eighties");

    aceMappingEditor.setOptions({
        enableBasicAutocompletion: [bloblangCompleter],
        enableLiveAutocompletion: true,
        enableSnippets: false
    });

    const onChange = debounce(validateAdvancedMapping, 500);
    aceInputEditor.on("change", onChange);
    aceMappingEditor.on("change", onChange);
}

// Intercept prompt events for big text areas natively across LiteGraph
(function patchLitegraphPrompt() {
    const originalPrompt = LGraphCanvas.prototype.prompt;
    LGraphCanvas.prototype.prompt = function(title, value, callback, event, multiline) {
        if (multiline) {
            openAdvancedEditorForCallback(title, value, callback);
        } else {
            originalPrompt.apply(this, arguments);
        }
    };
})();

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

async function validateAdvancedMapping() {
    const mapping = aceMappingEditor.getValue();
    const input = aceInputEditor.getValue();
    const outputEl = document.getElementById('ace-output');
    
    outputEl.className = 'output-container';
    outputEl.textContent = 'Validating...';

    try { JSON.parse(input); } catch(e) {
        outputEl.className = 'output-container error';
        outputEl.textContent = 'Test Input Error: Invalid JSON\n' + e.message;
        return;
    }

    try {
        const response = await fetch('/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: input, mapping: mapping })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const data = await response.json();
        
        if (data.parse_error) {
            outputEl.className = 'output-container error';
            outputEl.textContent = `Parse Error:\n${data.parse_error}`;
        } else if (data.mapping_error) {
            outputEl.className = 'output-container error';
            outputEl.textContent = `Mapping Execution Error:\n${data.mapping_error}`;
        } else {
            outputEl.className = 'output-container success';
            let resStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
            outputEl.textContent = resStr || 'Success (No Output Data Generated)';
        }
    } catch (err) {
        outputEl.className = 'output-container error';
        outputEl.textContent = `Validation Request Failed: ${err.message}`;
    }
}

function openAdvancedEditorForCallback(title, value, callback) {
    document.getElementById('advanced-editor-modal').classList.add('active');
    document.getElementById('advanced-editor-title').textContent = `Editing Field: ${title}`;
    advancedEditorCallback = callback;
    
    initAdvancedEditor();
    aceMappingEditor.setValue(value || '', -1);
    document.getElementById('ace-output').textContent = '';
    validateAdvancedMapping();
}

window.app = { previewConfig, copyConfig, deployStream, stopStream, refreshStreams, selectStream, deleteStreamById, showToast, showModal, closeModal, compileGraph, getGraph: () => graph, getCanvas: () => canvas };
